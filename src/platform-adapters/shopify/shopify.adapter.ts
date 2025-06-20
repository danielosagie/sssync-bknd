import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ShopifyApiClient, ShopifyLocationNode } from './shopify-api-client.service';
import { ShopifyMapper, CanonicalProduct, CanonicalProductVariant } from './shopify.mapper';
import { PlatformConnection, PlatformConnectionsService } from '../../platform-connections/platform-connections.service';
import { BaseAdapter, BaseSyncLogic } from '../base-adapter.interface';
import { ProductsService } from '../../canonical-data/products.service';
import { InventoryService, CanonicalInventoryLevel } from '../../canonical-data/inventory.service';
import { PlatformProductMappingsService, PlatformProductMapping } from '../../platform-product-mappings/platform-product-mappings.service';
import { Product, ProductVariant as SupabaseProductVariant } from '../../common/types/supabase.types';
import { AiGenerationService } from '../../products/ai-generation/ai-generation.service';
import { SyncEventsService } from '../../sync-engine/sync-events.service';

// Facade for Shopify interactions
@Injectable()
export class ShopifyAdapter implements BaseAdapter { // <<< Implement interface
    private readonly logger = new Logger(ShopifyAdapter.name); // Added logger

    constructor(
        private readonly shopifyApiClient: ShopifyApiClient,
        private readonly shopifyMapper: ShopifyMapper,
        private readonly productsService: ProductsService,
        private readonly inventoryService: InventoryService,
        private readonly mappingsService: PlatformProductMappingsService,
        private readonly connectionsService: PlatformConnectionsService,
        private readonly aiGenerationService: AiGenerationService,
        private readonly syncEventsService: SyncEventsService,
    ) {}

    // Return the configured client instance
    getApiClient(connection: PlatformConnection): ShopifyApiClient {
        // Initialization might be handled by the client itself if it stores tokens per shop
        // or if connectionsService provides fresh tokens for each call contextually.
        // For now, assuming shopifyApiClient can get credentials from connection if needed.
        return this.shopifyApiClient;
    }

    // Return the mapper instance
    getMapper(): ShopifyMapper {
        return this.shopifyMapper;
    }

    // Return specific sync logic handler
    getSyncLogic(): BaseSyncLogic {
        return {
            shouldDelist: (canonicalQuantity: number) => {
                // Shopify typically allows setting quantity to 0 for active products
                return canonicalQuantity <= 0; // Or specific Shopify logic if 0 means delist
            },
        };
    }

    async syncFromPlatform(connection: PlatformConnection, userId: string): Promise<void> {
        this.logger.log(`Starting Shopify sync for connection ${connection.Id}, user ${userId}`);
        const apiClient = this.getApiClient(connection);

        // Update connection status to syncing
        await this.connectionsService.updateConnectionStatus(connection.Id, userId, 'syncing');

        try {
            const shopifyData = await apiClient.fetchAllRelevantData(connection);
            if (!shopifyData || shopifyData.products.length === 0) {
                this.logger.log('No products fetched from Shopify.');
                // Update to active even if no products found (successful sync)
                await this.connectionsService.updateConnectionStatus(connection.Id, userId, 'active');
                await this.connectionsService.updateLastSyncSuccess(connection.Id, userId);
                return;
            }

            const { 
                canonicalProducts, 
                canonicalVariants, 
                canonicalInventoryLevels 
            } = this.shopifyMapper.mapShopifyDataToCanonical(shopifyData, userId, connection.Id);

            // 4. AI-powered product matching for products without SKU matches
            this.logger.log('Starting AI-powered product matching for unmatched products...');
            
            // Get existing canonical products for this user to match against
            const existingCanonicalProducts = await this.productsService.getProductsWithVariantsByUserId(userId);
            const existingProductsForMatching = existingCanonicalProducts.map(p => ({
                id: p.Id,
                title: p.variants?.[0]?.Title || 'Untitled Product',
                sku: p.variants?.[0]?.Sku || undefined,
                price: p.variants?.[0]?.Price
            }));

            const platformProductsForMatching = canonicalProducts.map(cp => ({
                id: cp.Id!, // Shopify Product GID
                title: cp.Title || 'Untitled',
                sku: canonicalVariants.find(cv => cv.ProductId === cp.Id)?.Sku || undefined,
                price: canonicalVariants.find(cv => cv.ProductId === cp.Id)?.Price
            }));

            let aiMatches: Array<{ platformProduct: any; canonicalProduct: any; confidence: number; reason: string }> = [];
            if (existingProductsForMatching.length > 0 && platformProductsForMatching.length > 0) {
                try {
                    aiMatches = await this.aiGenerationService.findProductMatches(
                        platformProductsForMatching,
                        existingProductsForMatching,
                        0.8 // 80% confidence threshold
                    );
                    this.logger.log(`AI matching found ${aiMatches.length} potential matches`);
                    
                    // Log the matches for debugging
                    for (const match of aiMatches) {
                        this.logger.log(`AI Match: "${match.platformProduct.title}" -> "${match.canonicalProduct.title}" (${Math.round(match.confidence * 100)}% confidence: ${match.reason})`);
                    }
                } catch (error) {
                    this.logger.warn(`AI matching failed: ${error.message}`);
                }
            }

            const allInventoryToSave: CanonicalInventoryLevel[] = [];

            for (const cProduct of canonicalProducts) {
                // Attempt to find an existing canonical product by a platform identifier (e.g. platform product ID in mapping)
                // This logic assumes cProduct.Id is the platform's product ID at this stage from the mapper.
                const existingMappingBasedOnPlatformProductId = await this.mappingsService.getMappingByPlatformId(connection.Id, cProduct.Id!); // cProduct.Id is temp-product-shopifyGID
                
                let savedSupabaseProduct: Product | null = null;
                if (existingMappingBasedOnPlatformProductId && existingMappingBasedOnPlatformProductId.ProductVariantId) {
                    // If a mapping exists, try to get the associated SSSync Product
                    const associatedVariant = await this.productsService.getVariantById(existingMappingBasedOnPlatformProductId.ProductVariantId);
                    if (associatedVariant && associatedVariant.ProductId) {
                        savedSupabaseProduct = await this.productsService.getProductById(associatedVariant.ProductId);
                    }
                }

                if (!savedSupabaseProduct) {
                    // No existing SSSync product found, create a new one
                    const productToSave: Omit<Product, 'Id' | 'CreatedAt' | 'UpdatedAt'> = {
                        UserId: cProduct.UserId,
                        IsArchived: cProduct.IsArchived || false,
                        // Title and Description are not on the Product table according to supabase.types.ts
                    };
                    savedSupabaseProduct = await this.productsService.saveProduct(productToSave);
                }

                if (!savedSupabaseProduct) {
                    this.logger.error(`Failed to save or find product for canonical product ID ${cProduct.Id}. Skipping variants.`);
                    continue;
                }

                const variantsToSavePrepared = canonicalVariants
                    .filter(cv => cv.ProductId === cProduct.Id) // Filter variants for the current product
                    .map(cv => {
                        // Ensure SKU is not null or empty, as it's used for upsert conflict resolution
                        if (cv.Sku === null || cv.Sku === undefined || cv.Sku.trim() === '') {
                            this.logger.warn(`Canonical variant for product ${cProduct.Title} has a null or empty SKU. Original platform ID: ${cv.Id}. Skipping this variant.`);
                            return null; // Will be filtered out
                        }
                        return {
                            ProductId: savedSupabaseProduct!.Id, // Link to the saved/found SSSync Product ID
                            UserId: userId,
                            Sku: cv.Sku, // Must be present
                            Barcode: cv.Barcode,
                            Title: cv.Title,
                            Description: cv.Description,
                            Price: cv.Price,
                            CompareAtPrice: cv.CompareAtPrice,
                            Weight: cv.Weight,
                            WeightUnit: cv.WeightUnit,
                            Options: cv.Options,
                            RequiresShipping: cv.RequiresShipping !== undefined ? cv.RequiresShipping : true, // Defaulting
                            IsTaxable: cv.IsTaxable !== undefined ? cv.IsTaxable : true, // Defaulting
                            TaxCode: cv.TaxCode,
                            ImageId: cv.ImageId,
                            // Cost is not on SupabaseProductVariant, so not included here
                        };
                    })
                    .filter(Boolean) as Array<Omit<SupabaseProductVariant, 'Id' | 'CreatedAt' | 'UpdatedAt'>>;

                if (variantsToSavePrepared.length > 0) {
                    const savedSupabaseVariants = await this.productsService.saveVariants(variantsToSavePrepared);

                    // Map original canonical variants (which have platform IDs) to saved Supabase variants
                    const relevantOriginalCanonicalVariants = canonicalVariants.filter(cv => cv.ProductId === cProduct.Id && cv.Sku && cv.Sku.trim() !== '');

                    for (const originalCv of relevantOriginalCanonicalVariants) {
                        const savedSupabaseVariant = savedSupabaseVariants.find(sv => sv.Sku === originalCv.Sku && sv.ProductId === savedSupabaseProduct!.Id);
                        if (!savedSupabaseVariant) {
                            this.logger.warn(`Could not find saved Supabase variant for canonical variant SKU ${originalCv.Sku} of product ${cProduct.Title}`);
                            continue;
                        }
                        
                        // originalCv.Id is temp-variant-shopifyGID
                        const platformVariantIdForMapping = originalCv.Id!.replace(/^temp-variant-/, '');
                        const platformProductIdForMapping = cProduct.Id!.replace(/^temp-product-/, '');

                        // Check if mapping already exists for this specific platform variant ID
                        let existingVariantMapping = await this.mappingsService.getMappingByPlatformIdentifiers(
                            connection.Id, 
                            platformProductIdForMapping, 
                            platformVariantIdForMapping
                        );

                        const mappingData: Omit<PlatformProductMapping, 'Id' | 'CreatedAt' | 'UpdatedAt'> = {
                            PlatformConnectionId: connection.Id,
                            ProductVariantId: savedSupabaseVariant.Id, // SSSync Variant ID
                            PlatformProductId: platformProductIdForMapping, // Shopify Product GID
                            PlatformVariantId: platformVariantIdForMapping, // Shopify Variant GID
                            PlatformSku: originalCv.Sku,
                            PlatformSpecificData: originalCv.PlatformSpecificData,
                            LastSyncedAt: new Date().toISOString(),
                            SyncStatus: 'Success',
                            IsEnabled: !cProduct.IsArchived, // Based on product status from platform
                        };

                        if (existingVariantMapping) {
                            await this.mappingsService.updateMapping(existingVariantMapping.Id, mappingData);
                        } else {
                            await this.mappingsService.createMapping(mappingData);
                        }

                        // Prepare inventory levels for this variant
                        const relevantInventoryLevels = canonicalInventoryLevels.filter(cil => cil.ProductVariantId === originalCv.Id);
                        for (const cInvLevel of relevantInventoryLevels) {
                            allInventoryToSave.push({
                                ...cInvLevel,
                                ProductVariantId: savedSupabaseVariant.Id, // Link to SSSync Variant ID
                                PlatformConnectionId: connection.Id, // Ensure this is set correctly
                            });
                        }
                    }
                }
            }

            if (allInventoryToSave.length > 0) {
                await this.inventoryService.saveBulkInventoryLevels(allInventoryToSave);
                this.logger.log(`Saved ${allInventoryToSave.length} inventory levels for connection ${connection.Id}`);
            }

            this.logger.log(`Shopify sync completed for connection ${connection.Id}`);
            
            // Update connection status to active on successful completion
            await this.connectionsService.updateConnectionStatus(connection.Id, userId, 'active');
            await this.connectionsService.updateLastSyncSuccess(connection.Id, userId);
        } catch (error) {
            this.logger.error(`Error during Shopify sync for connection ${connection.Id}: ${error.message}`, error.stack);
            
            // Update connection status to error on failure
            await this.connectionsService.updateConnectionStatus(connection.Id, userId, 'error');
            
            throw new InternalServerErrorException(`Shopify sync failed: ${error.message}`);
        }
    }

    // --- Push to Platform Methods (Placeholders) ---
    async createProduct(
        connection: PlatformConnection,
        canonicalProduct: CanonicalProduct, 
        canonicalVariants: CanonicalProductVariant[], 
        canonicalInventoryLevels: CanonicalInventoryLevel[] 
    ): Promise<{ platformProductId: string; platformVariantIds: Record<string, string> }> {
        this.logger.log(`Attempting to create product on Shopify for connection ${connection.Id}, CanonicalProductID: ${canonicalProduct.Id}`);
        const apiClient = this.getApiClient(connection);
        const mapper = this.getMapper();

        // 1. Fetch Shopify location GIDs for the current connection
        let shopifyLocationGids: string[] = [];
        try {
            const shopifyLocations = await apiClient.getAllLocations(connection);
            shopifyLocationGids = shopifyLocations.map(loc => loc.id); // Assuming loc.id is the GID
            if (shopifyLocationGids.length === 0) {
                this.logger.warn(`No Shopify locations found for connection ${connection.Id}. Inventory will not be set.`);
                // Depending on requirements, you might throw an error or proceed without inventory.
            }
        } catch (locError) {
            this.logger.error(`Failed to fetch Shopify locations for connection ${connection.Id}: ${locError.message}`, locError.stack);
            throw new InternalServerErrorException(`Failed to fetch Shopify locations: ${locError.message}`);
        }

        // 2. Map canonical data to Shopify input format
        const shopifyInput = mapper.mapCanonicalProductToShopifyInput(
            canonicalProduct,
            canonicalVariants,
            canonicalInventoryLevels,
            shopifyLocationGids
        );

        // 3. Call API client to create product
        try {
            const result = await apiClient.createProductAsync(connection, shopifyInput);

            if (result.userErrors && result.userErrors.length > 0) {
                const errorMessages = result.userErrors.map(e => 
                    `${e.field && Array.isArray(e.field) ? e.field.join('.') : (e.field || 'General')}: ${e.message} (Code: ${e.code})`
                ).join('; ');
                this.logger.error(`Shopify product creation failed with user errors: ${errorMessages}. Input: ${JSON.stringify(shopifyInput)}`);
                throw new InternalServerErrorException(`Shopify product creation failed: ${errorMessages}`);
            }

            if (!result.productId) {
                this.logger.error(`Shopify product creation response missing product ID. OpID: ${result.operationId}, Status: ${result.status}`);
                throw new InternalServerErrorException('Shopify product creation succeeded but response was incomplete (missing product ID).');
            }

            const platformProductId = result.productId;
            const platformVariantIds: Record<string, string> = {};

            // Fetch the newly created product to get variant GIDs and SKUs
            const createdProducts = await apiClient.fetchProductsByIds(connection, [platformProductId]);
            if (!createdProducts || createdProducts.length === 0 || !createdProducts[0].variants?.edges) {
                this.logger.error(`Failed to fetch details of newly created Shopify product ${platformProductId} to map variant GIDs.`);
                // Return what we have, but variant mapping will be incomplete.
                // This might be acceptable if SyncCoordinator can handle mappings later or if we log a critical error.
                 return { platformProductId, platformVariantIds }; // Return with empty variant map, requires careful handling downstream
            }

            const createdShopifyProductNode = createdProducts[0];

            for (const variantEdge of createdShopifyProductNode.variants.edges) {
                const shopifyVariantNode = variantEdge.node;
                const originalCanonicalVariant = canonicalVariants.find(cv => cv.Sku === shopifyVariantNode.sku);
                if (originalCanonicalVariant && originalCanonicalVariant.Id) {
                    platformVariantIds[originalCanonicalVariant.Id] = shopifyVariantNode.id; // Map canonical ID to Shopify GID
                } else {
                     this.logger.warn(`Could not map created Shopify variant (SKU: ${shopifyVariantNode.sku}, GID: ${shopifyVariantNode.id}) back to a canonical variant by SKU.`);
                 }
             }
             
             if (Object.keys(platformVariantIds).length !== canonicalVariants.length) {
                  this.logger.warn(`Mismatch in number of canonical variants provided and Shopify variants mapped. Expected ${canonicalVariants.length}, Got ${Object.keys(platformVariantIds).length}. Some variants might not have been created or mapped correctly.`);
             }

             this.logger.log(`Successfully created product ${platformProductId} on Shopify for connection ${connection.Id}. Mapped variants: ${JSON.stringify(platformVariantIds)}`);
             return { platformProductId, platformVariantIds };

        } catch (error) {
            this.logger.error(`Error creating product on Shopify for connection ${connection.Id}: ${error.message}`, error.stack);
            if (error instanceof InternalServerErrorException) throw error;
            throw new InternalServerErrorException(`Failed to create product on Shopify: ${error.message}`);
        }
    }

    async updateProduct(
        connection: PlatformConnection,
        existingMapping: any, // PlatformProductMapping
        canonicalProduct: any, // CanonicalProduct
        canonicalVariants: any[], // CanonicalProductVariant[]
        canonicalInventoryLevels: any[], // CanonicalInventoryLevel[]
    ): Promise<any> {
        this.logger.warn(`updateProduct not implemented for Shopify. Connection: ${connection.Id}`);
        // TODO: Implement Shopify product update logic
        // 1. Map data to Shopify format
        // 2. Call shopifyApiClient.updateProduct
        throw new Error('Shopify updateProduct not implemented');
    }

    async deleteProduct(
        connection: PlatformConnection,
        existingMapping: any, // PlatformProductMapping
    ): Promise<void> {
        this.logger.warn(`deleteProduct not implemented for Shopify. Connection: ${connection.Id}`);
        // TODO: Implement Shopify product deletion logic (e.g., using productDelete mutation)
        throw new Error('Shopify deleteProduct not implemented');
    }

    async updateInventoryLevels(
        connection: PlatformConnection,
        inventoryUpdates: Array<{ mapping: any /* PlatformProductMapping */; level: any /* CanonicalInventoryLevel */ }>
    ): Promise<any> {
        this.logger.warn('ShopifyAdapter.updateInventoryLevels called but not fully implemented.');
        // Placeholder implementation
        return Promise.resolve({ successCount: 0, failureCount: inventoryUpdates.length, errors: ['Not implemented'] });
    }

    async processWebhook(
        connection: PlatformConnection,
        payload: any,
        headers: Record<string, string>,
        webhookId?: string
    ): Promise<void> {
        const shopifyTopic = headers['x-shopify-topic'];
        const shopDomain = headers['x-shopify-shop-domain'];
        const logPrefix = webhookId ? `[${webhookId}]` : '';
        
        this.logger.log(`${logPrefix} ShopifyAdapter: Processing webhook for topic '${shopifyTopic}' from shop '${shopDomain}' on connection ${connection.Id}`);
        this.logger.debug(`${logPrefix} Webhook payload: ${JSON.stringify(payload).substring(0, 500)}...`);

        // Handle different webhook topics
        if (shopifyTopic === 'products/update' || shopifyTopic === 'products/create' || shopifyTopic === 'products/delete') {
            const productId = payload.id; // Shopify product ID (numeric, needs GID conversion)
            const platformProductGid = `gid://shopify/Product/${productId}`;

            if (shopifyTopic === 'products/delete') {
                this.logger.log(`${logPrefix} Received Shopify products/delete webhook for GID ${platformProductGid}. Handling deletion...`);
                await this.handleProductDeletion(connection, platformProductGid, logPrefix, webhookId);
            } else {
                this.logger.log(`${logPrefix} Received Shopify ${shopifyTopic} webhook for GID ${platformProductGid}. Triggering sync and cross-platform propagation.`);
                await this.handleProductUpdate(connection, platformProductGid, shopifyTopic, logPrefix, webhookId);
            }
        } else if (shopifyTopic === 'inventory_levels/update') {
            const inventoryItemId = payload.inventory_item_id;
            const locationId = payload.location_id;
            const available = payload.available;
            
            this.logger.log(`${logPrefix} Received Shopify inventory_levels/update for item ${inventoryItemId}, location ${locationId}, available: ${available}`);
            await this.handleInventoryUpdate(connection, inventoryItemId, locationId, available, logPrefix, webhookId);
        } else if (shopifyTopic === 'products/paid_media') {
            this.logger.log(`${logPrefix} Received Shopify products/paid_media webhook - ignoring as not relevant for sync`);
        } else {
            this.logger.warn(`${logPrefix} ShopifyAdapter received unhandled webhook topic: ${shopifyTopic}`);
        }
    }

    async syncSingleProductFromPlatform(connection: PlatformConnection, platformProductGid: string, userId: string): Promise<void> {
        this.logger.log(`Starting Shopify single product sync for GID: ${platformProductGid}, user ${userId}`);
        const apiClient = this.getApiClient(connection);
        const mapper = this.getMapper();

        try {
            // 1. Fetch the specific product
            const productNodes = await apiClient.fetchProductsByIds(connection, [platformProductGid]);
            if (!productNodes || productNodes.length === 0) {
                this.logger.warn(`Shopify product with GID ${platformProductGid} not found. Skipping sync.`);
                return;
            }
            const shopifyProductNode = productNodes[0];

            // 2. Fetch locations (needed by mapper for inventory levels)
            //    _fetchLocations is private, let's use getAllLocations if public or adapt.
            //    For now, assume getAllLocations is suitable and public.
            const shopifyLocations = await apiClient.getAllLocations(connection);
            const locationNodes: ShopifyLocationNode[] = shopifyLocations.map(loc => ({ id: loc.id, name: loc.name, isActive: loc.isActive }));


            // 3. Map to canonical format
            const { 
                canonicalProducts, 
                canonicalVariants, 
                canonicalInventoryLevels 
            } = mapper.mapShopifyDataToCanonical(
                { products: [shopifyProductNode], locations: locationNodes }, 
                userId, 
                connection.Id
            );

            const allInventoryToSave: CanonicalInventoryLevel[] = [];

            for (const cProduct of canonicalProducts) { // Should be only one product
                // cProduct.Id from mapper should be the Shopify Product GID
                if (cProduct.Id !== platformProductGid) {
                    this.logger.warn(`Mapped canonical product ID ${cProduct.Id} (from mapper) does not match requested platform GID ${platformProductGid}. This might indicate a mapper issue. Skipping product.`);
                    continue;
                }

                let savedSupabaseProduct: Product | null = null;
                const existingMappings = await this.mappingsService.getMappingsByPlatformProductId(connection.Id, platformProductGid);
                if (existingMappings.length > 0 && existingMappings[0].ProductVariantId) {
                    const associatedVariant = await this.productsService.getVariantById(existingMappings[0].ProductVariantId);
                    if (associatedVariant) {
                       savedSupabaseProduct = await this.productsService.getProductById(associatedVariant.ProductId);
                    }
                }

                if (!savedSupabaseProduct) {
                    this.logger.log(`No existing sssync product found for Shopify GID ${platformProductGid}. Creating new.`);
                    const productToSave: Omit<Product, 'Id' | 'CreatedAt' | 'UpdatedAt'> = {
                        UserId: userId,
                        IsArchived: cProduct.IsArchived,
                        // Title and Description for Product table could be set from cProduct if desired
                        // but canonical product variants store the detailed title/desc.
                    };
                    savedSupabaseProduct = await this.productsService.saveProduct(productToSave);
                } else {
                    this.logger.log(`Found existing sssync product ${savedSupabaseProduct.Id} for Shopify GID ${platformProductGid}. Updating.`);
                    // Update product fields if needed (e.g., if Shopify product status maps to IsArchived)
                    const productUpdates: Partial<Product> = {};
                    if (cProduct.IsArchived !== savedSupabaseProduct.IsArchived) {
                        productUpdates.IsArchived = cProduct.IsArchived;
                    }
                    if (Object.keys(productUpdates).length > 0) {
                         await this.productsService.updateProduct(savedSupabaseProduct.Id, productUpdates);
                    }
                }

                if (!savedSupabaseProduct) {
                    this.logger.error(`Failed to save or find sssync product for Shopify GID ${platformProductGid}. Skipping variants.`);
                    continue;
                }

                const variantsToSavePrepared = canonicalVariants
                    .filter(cv => cv.ProductId === cProduct.Id) // Ensure only variants for this product
                    .map(cv => {
                        if (!cv.Sku || cv.Sku.trim() === '') {
                            this.logger.warn(`Canonical variant for product ${cProduct.Title} has a null or empty SKU. Original platform GID: ${cv.Id}. Skipping.`);
                            return null;
                        }
                        return {
                            ProductId: savedSupabaseProduct!.Id,
                            UserId: userId,
                            Sku: cv.Sku,
                            Barcode: cv.Barcode,
                            Title: cv.Title,       // Title is on ProductVariants
                            Description: cv.Description,
                            Price: cv.Price,
                            CompareAtPrice: cv.CompareAtPrice,
                            Cost: cv.Cost,
                            Weight: cv.Weight,
                            WeightUnit: cv.WeightUnit,
                            Options: cv.Options,
                            RequiresShipping: cv.RequiresShipping !== undefined ? cv.RequiresShipping : true,
                            IsTaxable: cv.IsTaxable !== undefined ? cv.IsTaxable : true,
                            TaxCode: cv.TaxCode,
                            ImageId: cv.ImageId,
                            PlatformSpecificData: cv.PlatformSpecificData, // Store Shopify specific variant data
                        };
                    })
                    .filter(Boolean) as Array<Omit<SupabaseProductVariant, 'Id' | 'CreatedAt' | 'UpdatedAt'>>;

                if (variantsToSavePrepared.length > 0) {
                    const savedSupabaseVariants = await this.productsService.saveVariants(variantsToSavePrepared);
                    
                    const relevantOriginalCanonicalVariants = canonicalVariants.filter(cv => 
                        cv.ProductId === cProduct.Id && 
                        cv.Sku && cv.Sku.trim() !== ''
                    );

                    for (const originalCv of relevantOriginalCanonicalVariants) {
                        const savedSupabaseVariant = savedSupabaseVariants.find(sv => sv.Sku === originalCv.Sku && sv.ProductId === savedSupabaseProduct!.Id);
                        if (!savedSupabaseVariant) {
                            this.logger.warn(`Could not find saved Supabase variant for canonical variant SKU ${originalCv.Sku} of product ${cProduct.Title}`);
                            continue;
                        }
                        // originalCv.Id should be the Shopify Variant GID from the mapper
                        const platformVariantGidForMapping = originalCv.Id!;

                        let existingVariantMapping = await this.mappingsService.getMappingByPlatformIdentifiers(connection.Id, platformProductGid, platformVariantGidForMapping);
                        
                        const mappingData: Omit<PlatformProductMapping, 'Id' | 'CreatedAt' | 'UpdatedAt'> = {
                            PlatformConnectionId: connection.Id,
                            ProductVariantId: savedSupabaseVariant.Id,
                            PlatformProductId: platformProductGid, // Parent Product GID
                            PlatformVariantId: platformVariantGidForMapping, // Variant GID
                            PlatformSku: originalCv.Sku,
                            PlatformSpecificData: {
                                ...(originalCv.PlatformSpecificData || {}),
                                // Add Shopify specific inventory item ID if available from originalCv.PlatformSpecificData
                                // This is crucial for inventory_levels/update webhook
                                shopifyInventoryItemId: originalCv.PlatformSpecificData?.inventoryItemId || null 
                            },
                            LastSyncedAt: new Date().toISOString(),
                            SyncStatus: 'Success',
                            IsEnabled: !cProduct.IsArchived, 
                        };

                        if (existingVariantMapping) {
                            await this.mappingsService.updateMapping(existingVariantMapping.Id, mappingData);
                        } else {
                            await this.mappingsService.createMapping(mappingData);
                        }

                        const relevantInventoryLevels = canonicalInventoryLevels.filter(cil => cil.ProductVariantId === originalCv.Id);
                        for (const cInvLevel of relevantInventoryLevels) {
                            allInventoryToSave.push({
                                ...cInvLevel,
                                ProductVariantId: savedSupabaseVariant.Id,
                                PlatformConnectionId: connection.Id,
                                LastPlatformUpdateAt: cInvLevel.LastPlatformUpdateAt || new Date(),
                            });
                        }
                    }
                }
            }

            if (allInventoryToSave.length > 0) {
                await this.inventoryService.saveBulkInventoryLevels(allInventoryToSave);
                this.logger.log(`Saved/Updated ${allInventoryToSave.length} inventory levels for Shopify product ${platformProductGid}`);
            }

            this.logger.log(`Shopify single product sync completed for GID: ${platformProductGid}`);

        } catch (error) {
            this.logger.error(`Error during Shopify single product sync for ${platformProductGid}: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Shopify single product sync failed for ${platformProductGid}: ${error.message}`);
        }
    }

    // --- Helper methods for webhook processing ---

    private async handleProductDeletion(
        connection: PlatformConnection,
        platformProductGid: string,
        logPrefix: string,
        webhookId?: string,
    ): Promise<void> {
        try {
            // Find mapping, delete canonical product/variants, delete mapping
            const mappings = await this.mappingsService.getMappingsByPlatformProductId(connection.Id, platformProductGid);
            
            for (const mapping of mappings) {
                if (mapping.ProductVariantId) {
                    const variant = await this.productsService.getVariantById(mapping.ProductVariantId);
                    if (variant && variant.ProductId) {
                        // Check if this product has mappings to other platforms
                        const otherMappings = await this.mappingsService.getMappingsByProductIdAndConnection(variant.ProductId, connection.Id);
                        const hasOtherPlatformMappings = otherMappings.length > 1; // More than just this Shopify mapping
                        
                        if (hasOtherPlatformMappings) {
                            // Product exists on other platforms, emit deletion event to sync to others
                            this.logger.log(`${logPrefix} Product ${variant.ProductId} has other platform mappings. Emitting deletion sync event.`);
                            this.syncEventsService.emitProductSyncEvent({
                                type: 'PRODUCT_DELETED',
                                productId: variant.ProductId,
                                userId: connection.UserId,
                                sourceConnectionId: connection.Id,
                                sourcePlatform: 'shopify',
                                platformProductId: platformProductGid,
                                webhookId,
                            });
                        } else {
                            // No other platform mappings, safe to delete canonical product
                            await this.productsService.deleteProductAndVariants(variant.ProductId, connection.UserId);
                            this.logger.log(`${logPrefix} Deleted canonical product ${variant.ProductId} and its variants.`);
                        }
                    }
                }
                await this.mappingsService.deleteMapping(mapping.Id);
                this.logger.log(`${logPrefix} Deleted platform mapping ${mapping.Id}.`);
            }
        } catch (error) {
            this.logger.error(`${logPrefix} Error handling product deletion for ${platformProductGid}: ${error.message}`, error.stack);
            throw error;
        }
    }

    private async handleProductUpdate(
        connection: PlatformConnection,
        platformProductGid: string,
        shopifyTopic: string,
        logPrefix: string,
        webhookId?: string,
    ): Promise<void> {
        try {
            // First, sync the changes from Shopify to our canonical data
            await this.syncSingleProductFromPlatform(connection, platformProductGid, connection.UserId);
            
            // Find the canonical product that was just updated
            const mappings = await this.mappingsService.getMappingsByPlatformProductId(connection.Id, platformProductGid);
            
            for (const mapping of mappings) {
                if (mapping.ProductVariantId) {
                    const variant = await this.productsService.getVariantById(mapping.ProductVariantId);
                    if (variant && variant.ProductId) {
                        // Get sync rules for this connection to determine if we should propagate changes
                        const syncRules = connection.SyncRules || {};
                        const shouldPropagate = syncRules.propagateChanges !== false; // Default to true
                        
                        if (shouldPropagate) {
                            // Emit cross-platform sync event
                            this.logger.log(`${logPrefix} Emitting cross-platform sync event for product ${variant.ProductId} due to Shopify ${shopifyTopic}`);
                            
                            const eventType = shopifyTopic === 'products/create' ? 'PRODUCT_CREATED' : 'PRODUCT_UPDATED';
                            this.syncEventsService.emitProductSyncEvent({
                                type: eventType,
                                productId: variant.ProductId,
                                userId: connection.UserId,
                                sourceConnectionId: connection.Id,
                                sourcePlatform: 'shopify',
                                platformProductId: platformProductGid,
                                webhookId,
                            });
                        }
                        break; // Only need to process one mapping per product
                    }
                }
            }
        } catch (error) {
            this.logger.error(`${logPrefix} Error handling product update for ${platformProductGid}: ${error.message}`, error.stack);
            throw error;
        }
    }

    private async handleInventoryUpdate(
        connection: PlatformConnection,
        inventoryItemId: string,
        locationId: string,
        available: number,
        logPrefix: string,
        webhookId?: string,
    ): Promise<void> {
        try {
            const inventoryItemGid = `gid://shopify/InventoryItem/${inventoryItemId}`;
            const locationGid = `gid://shopify/Location/${locationId}`;
            
            // Find the mapping for this inventory item
            const mapping = await this.mappingsService.getMappingByPlatformVariantInventoryItemId(connection.Id, inventoryItemGid);
            
            if (mapping && mapping.ProductVariantId) {
                // Update canonical inventory
                await this.inventoryService.updateLevel({
                    ProductVariantId: mapping.ProductVariantId,
                    PlatformConnectionId: connection.Id,
                    PlatformLocationId: locationGid,
                    Quantity: available,
                    LastPlatformUpdateAt: new Date().toISOString(),
                });
                
                this.logger.log(`${logPrefix} Updated canonical inventory for variant ${mapping.ProductVariantId} at location ${locationGid} to ${available}`);
                
                // Check sync rules for inventory propagation
                const syncRules = connection.SyncRules || {};
                const shouldPropagateInventory = syncRules.propagateInventory !== false; // Default to true
                
                if (shouldPropagateInventory) {
                    // Emit cross-platform inventory sync event
                    this.logger.log(`${logPrefix} Emitting cross-platform inventory sync event for variant ${mapping.ProductVariantId}`);
                    
                    this.syncEventsService.emitInventorySyncEvent({
                        type: 'INVENTORY_UPDATED',
                        variantId: mapping.ProductVariantId,
                        userId: connection.UserId,
                        sourceConnectionId: connection.Id,
                        sourcePlatform: 'shopify',
                        locationId: locationGid,
                        newQuantity: available,
                        webhookId,
                    });
                }
            } else {
                this.logger.warn(`${logPrefix} No mapping found for Shopify InventoryItem GID ${inventoryItemGid} from inventory_levels/update webhook. Cannot update canonical inventory.`);
            }
        } catch (error) {
            this.logger.error(`${logPrefix} Error handling inventory update for item ${inventoryItemId}: ${error.message}`, error.stack);
            throw error;
        }
    }
}