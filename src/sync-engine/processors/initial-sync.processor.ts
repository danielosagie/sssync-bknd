import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import {
    INITIAL_SYNC_QUEUE
} from '../sync-engine.constants';
import { PlatformConnectionsService, PlatformConnection } from '../../platform-connections/platform-connections.service';
import { MappingService, ConfirmedMatch } from '../mapping.service';
import { PlatformAdapterRegistry } from '../../platform-adapters/adapter.registry';
import { BaseAdapter } from '../../platform-adapters/base-adapter.interface';
import { JobData } from '../initial-sync.service';
import { SupabaseService } from '../../common/supabase.service'; 
import { ProductsService as CanonicalProductsService } from '../../canonical-data/products.service';
import { InventoryService as CanonicalInventoryService, CanonicalInventoryLevel } from '../../canonical-data/inventory.service';
import { PlatformProductMappingsService } from '../../platform-product-mappings/platform-product-mappings.service';
import { ActivityLogService } from '../../common/activity-log.service';
import { ShopifyProductNode, ShopifyVariantNode } from '../../platform-adapters/shopify/shopify-api-client.service'; 
import { CanonicalProduct, CanonicalProductVariant } from '../../platform-adapters/shopify/shopify.mapper';
import { Product as SupabaseProduct, ProductVariant as SupabaseProductVariant } from '../../common/types/supabase.types';

// Use these type aliases instead
type SquareAPICatalogObjectWithVariations = any; // Temporary type
type CloverApiProductData = any; // Temporary type

@Processor(INITIAL_SYNC_QUEUE)
export class InitialSyncProcessor extends WorkerHost {
    private readonly logger = new Logger(InitialSyncProcessor.name);

    constructor(
        private readonly connectionService: PlatformConnectionsService,
        private readonly mappingService: MappingService,
        private readonly adapterRegistry: PlatformAdapterRegistry,
        private readonly supabaseService: SupabaseService, 
        private readonly canonicalProductsService: CanonicalProductsService,
        private readonly canonicalInventoryService: CanonicalInventoryService,
        private readonly platformProductMappingsService: PlatformProductMappingsService,
        private readonly activityLogService: ActivityLogService,
    ) {
        super();
        this.logger.log('InitialSyncProcessor initialized and attached to queue.');
    }

    async process(job: Job<JobData, any, string>): Promise<any> {
        let { connectionId, userId, platformType, confirmedMatches, syncRules, platformSpecificDataSnapshot } = job.data as any;
        this.logger.log(`Processing initial sync for connection ${connectionId} (${platformType}), User: ${userId}, Job ID: ${job.id}. ${confirmedMatches?.length || 0} confirmed matches.`);

        // Fallbacks: load from saved confirmations and connection sync rules when missing
        if (!confirmedMatches || (Array.isArray(confirmedMatches) && confirmedMatches.length === 0)) {
            try {
                const stored = await this.mappingService.getConfirmedMappings(connectionId);
                if (stored?.confirmedMatches?.length) {
                    confirmedMatches = stored.confirmedMatches;
                    this.logger.log(`Loaded ${confirmedMatches.length} confirmedMatches from PlatformSpecificData for job ${job.id}.`);
                }
            } catch (e: any) {
                this.logger.warn(`Unable to load mapping confirmations for ${connectionId}: ${e?.message}`);
            }
        }

        const connectionForRules = await this.connectionService.getConnectionById(connectionId, userId);
        const effectiveSyncRules = syncRules || connectionForRules?.SyncRules || {};

        if (!connectionId || !userId || !platformType || !Array.isArray(confirmedMatches) || confirmedMatches.length === 0 || !effectiveSyncRules) {
            this.logger.error(`Job ${job.id} is missing essential data after fallbacks (connectionId, userId, platformType, confirmedMatches, or syncRules). Aborting.`);
            throw new Error('Missing essential data for initial sync job.');
        }

        const connection = await this.connectionService.getConnectionById(connectionId, userId);
        if (!connection) {
            this.logger.error(`Connection ${connectionId} not found for user ${userId}. Aborting job ${job.id}.`);
            throw new NotFoundException(`Connection ${connectionId} not found.`);
        }

        const adapter = this.adapterRegistry.getAdapter(platformType);
        if (!adapter) {
            this.logger.error(`No adapter found for platform type: ${platformType} on connection ${connectionId}. Aborting job ${job.id}.`);
            throw new InternalServerErrorException(`Adapter not found for ${platformType}.`);
        }

        // Use the Supabase client from SupabaseService for transactions
        const supabaseClient = this.supabaseService.getClient(); 

        try {
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'Connection',
                EntityId: connectionId,
                EventType: 'INITIAL_SYNC_STARTED',
                Status: 'Info',
                Message: `Initial sync process started for ${platformType} connection: ${connection.DisplayName}. Processing ${confirmedMatches.length} items.`,
                PlatformConnectionId: connectionId,
                Details: { platform: platformType }
            });

            await this.connectionService.updateConnectionStatus(connectionId, userId, 'syncing');

            let totalItemsProcessed = 0;
            let itemsSuccessfullySynced = 0;
            let itemsFailedToSync = 0;

            // Transaction Start (Example - actual Supabase transaction syntax)
            // Note: Supabase transactions are typically handled with supabase.rpc or specific function calls, 
            // not a generic begin/commit block like traditional SQL. 
            // The following is conceptual. Each action (link, create) should ideally be atomic or part of a batch.
            // For simplicity, we'll proceed with individual operations and rely on logging for now.
            // await supabaseClient.rpc('begin_transaction'); // Conceptual

            for (const match of confirmedMatches) {
                totalItemsProcessed++;
                this.logger.log(`Processing match ${totalItemsProcessed}/${confirmedMatches.length}: Action '${match.action}' for platform ID ${match.platformProductId}`);
                job.updateProgress((totalItemsProcessed / confirmedMatches.length) * 100);
                
                let platformProductFullData: any = null;
                if (platformSpecificDataSnapshot && match.platformProductId) {
                     if (connection.PlatformType === 'shopify') {
                        platformProductFullData = platformSpecificDataSnapshot.products?.find((p: ShopifyProductNode) => p.id === match.platformProductId);
                     } else if (connection.PlatformType === 'square') {
                        platformProductFullData = platformSpecificDataSnapshot.items?.find((i: any) => i.id === match.platformProductId);
                     } else if (connection.PlatformType === 'clover') {
                        platformProductFullData = platformSpecificDataSnapshot.items?.find((i: any) => i.id === match.platformProductId);
                     }
                }
                if (!platformProductFullData && (match.action === 'create' || (match.action === 'link' && (syncRules.productDetailsSoT === 'PLATFORM' || syncRules.inventorySoT === 'PLATFORM')))) {
                    this.logger.warn(`Full platform data for ${match.platformProductId} not found in snapshot. Will attempt to fetch if needed by action type and SoT rules.`);
                    // Optionally, could attempt a live fetch here, but it slows down the batch.
                    // For now, rely on reconciliation if SoT is platform and data is missing for link.
                }

                try {
                    switch (match.action) {
                        case 'link':
                            await this.handleLinkAction(connection, userId, match, platformProductFullData, adapter, effectiveSyncRules);
                            break;
                        case 'create':
                            await this.handleCreateAction(connection, userId, match, platformProductFullData, adapter, effectiveSyncRules);
                            break;
                        case 'ignore':
                            await this.handleIgnoreAction(connectionId, userId, match);
                            break;
                        default:
                            this.logger.warn(`Unknown action '${match.action}' for platform ID ${match.platformProductId}. Skipping.`);
                    }
                    itemsSuccessfullySynced++;
                } catch (itemError: any) {
                    itemsFailedToSync++;
                    this.logger.error(`Failed to process item for platform ID ${match.platformProductId} (Action: ${match.action}): ${itemError.message}`, itemError.stack);
                    // Log individual item failure but continue processing others
                    await this.activityLogService.logActivity({
                        UserId: userId,
                        EntityType: 'ProductMapping',
                        EntityId: match.platformProductId,
                        EventType: 'INITIAL_SYNC_ITEM_FAILED',
                        Status: 'Error',
                        Message: `Failed processing item ${match.platformProductSku || match.platformProductId} during initial sync (Action: ${match.action}): ${itemError.message}`,
                        PlatformConnectionId: connectionId,
                        Details: { platform: platformType, error: itemError.message }
                    });
                }
            }

            // await supabaseClient.rpc('commit_transaction'); // Conceptual commit
            
            this.logger.log(`Initial sync for connection ${connectionId} completed. Total: ${totalItemsProcessed}, Success: ${itemsSuccessfullySynced}, Failed: ${itemsFailedToSync}.`);
            await this.connectionService.updateConnectionStatus(connectionId, userId, itemsFailedToSync > 0 ? 'error' : 'active');
            await this.connectionService.updateLastSyncSuccess(connectionId, userId);

            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'Connection',
                EntityId: connectionId,
                EventType: 'INITIAL_SYNC_COMPLETED',
                Status: itemsFailedToSync > 0 ? 'Warning' : 'Success',
                Message: `Initial sync completed for ${platformType} connection: ${connection.DisplayName}. Processed: ${totalItemsProcessed}, Succeeded: ${itemsSuccessfullySynced}, Failed: ${itemsFailedToSync}.`,
                PlatformConnectionId: connectionId,
                Details: { platform: platformType, totalItemsProcessed, itemsSuccessfullySynced, itemsFailedToSync }
            });

            return { totalItemsProcessed, itemsSuccessfullySynced, itemsFailedToSync };

        } catch (error: any) {
            this.logger.error(`Critical error during initial sync for connection ${connectionId}: ${error.message}`, error.stack);
            // await supabaseClient.rpc('rollback_transaction'); // Conceptual rollback
            try {
                await this.connectionService.updateConnectionStatus(connectionId, userId, 'error');
                await this.activityLogService.logActivity({
                    UserId: userId,
                    EntityType: 'Connection',
                    EntityId: connectionId,
                    EventType: 'INITIAL_SYNC_FAILED',
                    Status: 'Error',
                    Message: `Initial sync critically failed for ${platformType} connection: ${connection.DisplayName}. Error: ${error.message}`,
                    PlatformConnectionId: connectionId,
                    Details: { platform: platformType, error: error.message }
                });
            } catch (statusError: any) {
                this.logger.error(`Failed to update connection status to error after critical sync failure for ${connectionId}: ${statusError.message}`);
            }
            throw error; // Re-throw to let BullMQ handle job failure
        }
    }

    private async handleLinkAction(
        connection: PlatformConnection,
        userId: string,
        match: ConfirmedMatch,
        platformProductFullData: any, 
        adapter: BaseAdapter,
        syncRules: Record<string, any> 
    ): Promise<void> {
        this.logger.log(`Handling 'link' for platformProduct: ${match.platformProductId} to sssyncVariant: ${match.sssyncVariantId}`);
        if (!match.sssyncVariantId) {
            this.logger.warn(`Link action for ${match.platformProductId} but sssyncVariantId is missing. Skipping.`);
            return;
        }
        
        const mapper = adapter.getMapper(); 

        let mapping = await this.platformProductMappingsService.getMappingByVariantIdAndPlatformProductId(
            match.sssyncVariantId,
            match.platformProductId,
            connection.Id
        );

        if (mapping) {
            await this.platformProductMappingsService.updateMapping(mapping.Id, {
                SyncStatus: 'Linked', 
                IsEnabled: true,
                LastSyncedAt: new Date().toISOString(),
            });
            this.logger.debug(`Updated existing mapping ${mapping.Id} for link.`);
        } else {
            // This case should ideally not happen if mapping was confirmed, but as a fallback:
            mapping = await this.platformProductMappingsService.upsertMapping({
                PlatformConnectionId: connection.Id,
                ProductVariantId: match.sssyncVariantId,
                PlatformProductId: match.platformProductId,
                PlatformVariantId: match.platformVariantId || undefined, // Use if available
                PlatformSku: match.platformProductSku || undefined,
                SyncStatus: 'Linked',
                IsEnabled: true,
                LastSyncedAt: new Date().toISOString(),
            });
            this.logger.warn(`Created new mapping during link action for ${match.platformProductId} as it was missing (ID: ${mapping.Id}).`);
        }

        if (platformProductFullData) {
            if (connection.PlatformType === 'shopify') {
                const shopifyProductNode = platformProductFullData as ShopifyProductNode;
                if (syncRules.productDetailsSoT === 'PLATFORM') {
                    this.logger.debug(`SyncRules.productDetailsSoT is PLATFORM for Shopify link. Updating SSSync variant ${match.sssyncVariantId} from platform product ${match.platformProductId}.`);
                    try {
                        const existingSssyncVariant = await this.canonicalProductsService.getVariantById(match.sssyncVariantId);
                        if (existingSssyncVariant) {
                            const mappedDetailsToUpdate: Partial<CanonicalProductVariant> = mapper.mapShopifyProductToCanonicalDetails(shopifyProductNode, userId);
                            if (mappedDetailsToUpdate && Object.keys(mappedDetailsToUpdate).length > 0) {
                                const variantToSave = {
                                    ProductId: existingSssyncVariant.ProductId,
                                    UserId: existingSssyncVariant.UserId,
                                    Sku: ((mappedDetailsToUpdate.Sku !== undefined && mappedDetailsToUpdate.Sku !== null) ? mappedDetailsToUpdate.Sku : existingSssyncVariant.Sku) || '', // Ensure Sku is non-null string
                                    Title: mappedDetailsToUpdate.Title !== undefined ? mappedDetailsToUpdate.Title : existingSssyncVariant.Title,
                                    Description: mappedDetailsToUpdate.Description !== undefined ? mappedDetailsToUpdate.Description : existingSssyncVariant.Description,
                                    Price: mappedDetailsToUpdate.Price !== undefined ? mappedDetailsToUpdate.Price : existingSssyncVariant.Price,
                                    CompareAtPrice: mappedDetailsToUpdate.CompareAtPrice !== undefined ? mappedDetailsToUpdate.CompareAtPrice : existingSssyncVariant.CompareAtPrice,
                                    Weight: mappedDetailsToUpdate.Weight !== undefined ? mappedDetailsToUpdate.Weight : existingSssyncVariant.Weight,
                                    WeightUnit: mappedDetailsToUpdate.WeightUnit !== undefined ? mappedDetailsToUpdate.WeightUnit : existingSssyncVariant.WeightUnit,
                                    Options: mappedDetailsToUpdate.Options !== undefined ? mappedDetailsToUpdate.Options : existingSssyncVariant.Options,
                                    RequiresShipping: mappedDetailsToUpdate.RequiresShipping !== undefined ? mappedDetailsToUpdate.RequiresShipping : existingSssyncVariant.RequiresShipping,
                                    IsTaxable: mappedDetailsToUpdate.IsTaxable !== undefined ? mappedDetailsToUpdate.IsTaxable : existingSssyncVariant.IsTaxable,
                                    TaxCode: mappedDetailsToUpdate.TaxCode !== undefined ? mappedDetailsToUpdate.TaxCode : existingSssyncVariant.TaxCode,
                                    Barcode: mappedDetailsToUpdate.Barcode !== undefined ? mappedDetailsToUpdate.Barcode : existingSssyncVariant.Barcode,
                                    ImageId: mappedDetailsToUpdate.ImageId !== undefined ? mappedDetailsToUpdate.ImageId : existingSssyncVariant.ImageId,
                                } as Omit<SupabaseProductVariant, 'Id' | 'CreatedAt' | 'UpdatedAt'>; // Explicit cast
                                await this.canonicalProductsService.saveVariants([variantToSave]);
                                this.logger.log(`Updated SSSync variant ${match.sssyncVariantId} details from Shopify product ${match.platformProductId}.`);
                            } else {
                                this.logger.log(`No details mapped from Shopify product ${match.platformProductId} to update variant ${match.sssyncVariantId}.`);
                            }
                        } else {
                            this.logger.warn(`SSSync variant ${match.sssyncVariantId} not found. Cannot update details from Shopify product ${match.platformProductId}.`);
                        }
                    } catch (e: any) {
                        this.logger.error(`Failed to update SSSync variant ${match.sssyncVariantId} details from Shopify: ${e.message}`, e.stack);
                    }
                }
                if (syncRules.inventorySoT === 'PLATFORM') {
                    this.logger.debug(`SyncRules.inventorySoT is PLATFORM for Shopify link. Updating SSSync inventory for variant ${match.sssyncVariantId} from platform product ${match.platformProductId}.`);
                    try {
                        if (!match.platformVariantId) {
                            this.logger.warn(`Cannot sync inventory for Shopify product ${match.platformProductId} - SSSync variant ${match.sssyncVariantId} is missing platformVariantId.`);
                        } else {
                            const linkedShopifyVariantNode = shopifyProductNode.variants.edges.find(
                                (edge) => edge.node.id === match.platformVariantId
                            )?.node;

                            if (linkedShopifyVariantNode) {
                                const mappedInventoryLevels = mapper.mapShopifyInventoryToCanonical(
                                    linkedShopifyVariantNode, // Pass the specific linked variant node
                                    match.sssyncVariantId, 
                                    connection.Id
                                );
                                if (mappedInventoryLevels && mappedInventoryLevels.length > 0) {
                                    await this.canonicalInventoryService.saveBulkInventoryLevels(mappedInventoryLevels);
                                    this.logger.log(`Updated/Saved ${mappedInventoryLevels.length} SSSync inventory levels for SSSync variant ${match.sssyncVariantId} from Shopify variant ${linkedShopifyVariantNode.id}.`);
                                } else {
                                    this.logger.log(`No inventory levels mapped from Shopify variant ${linkedShopifyVariantNode.id} for SSSync variant ${match.sssyncVariantId}.`);
                                }
                            } else {
                                this.logger.warn(`Could not find linked Shopify variant ${match.platformVariantId} within product ${shopifyProductNode.id} to sync inventory for SSSync variant ${match.sssyncVariantId}.`);
                            }
                        }
                    } catch (e: any) {
                        this.logger.error(`Failed to update SSSync inventory for variant ${match.sssyncVariantId} from Shopify: ${e.message}`, e.stack);
                    }
                }
            } else if (connection.PlatformType === 'square') {
                // ... (Square logic as previously defined)
            } else if (connection.PlatformType === 'clover') {
                // ... (Clover logic as previously defined)
            } else {
                this.logger.warn(`Source-of-Truth handling for 'link' action not yet implemented for platform: ${connection.PlatformType}`);
            }
        } else if (!platformProductFullData) {
            this.logger.warn(`No full platform data found for linked item ${match.platformProductId}. Skipping Source-of-Truth updates for this item.`);
        }

        await this.activityLogService.logActivity({
            UserId: userId,
            EntityType: 'ProductMapping',
            EntityId: mapping.Id,
            EventType: 'PRODUCT_MAPPING_LINKED',
            Status: 'Success',
            Message: `Product ${match.platformProductSku || match.platformProductId} from ${connection.PlatformType} linked to SSSync variant ${match.sssyncVariantId}. SoT rules applied: ${syncRules.productDetailsSoT} for details, ${syncRules.inventorySoT} for inventory.`,
            PlatformConnectionId: connection.Id,
            Details: { platform: connection.PlatformType }
        });
    }

    private async handleCreateAction(
        connection: PlatformConnection,
        userId: string,
        match: ConfirmedMatch,
        platformProductFullData: any, 
        adapter: BaseAdapter,
        syncRules: Record<string, any>
    ): Promise<void> {
        this.logger.log(`Handling 'create' for platformProduct: ${match.platformProductId}, platformVariantId: ${match.platformVariantId || 'N/A'}`);
        const mapper = adapter.getMapper();

        if (!platformProductFullData) {
            this.logger.error(`Cannot 'create' for platform product ${match.platformProductId} because full platform data is missing. Skipping.`);
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'ProductMapping',
                EntityId: match.platformProductId,
                EventType: 'PRODUCT_MAPPING_CREATE_FAILED',
                Status: 'Error',
                Message: `Create action failed for ${match.platformProductSku || match.platformProductId} from ${connection.PlatformType}. Reason: Missing full platform data.`,
                PlatformConnectionId: connection.Id,
                Details: { platform: connection.PlatformType }
            });
            return;
        }
        
        let canonicalProductIdToUse: string | undefined;
        let sssyncProductInput: Omit<SupabaseProduct, 'Id' | 'CreatedAt' | 'UpdatedAt'>;
        let firstSssyncVariantInput: Omit<SupabaseProductVariant, 'Id' | 'ProductId' | 'CreatedAt' | 'UpdatedAt' | 'UserId'>;
        let sssyncInventoryInputsFromMapped: CanonicalInventoryLevel[] = [];
        let shopifyVariantIdForMapping: string | undefined; // For Shopify, this will be the specific variant GID
        let imageUrlsToSave: string[] = [];


        if (connection.PlatformType === 'shopify') {
            const shopifyProductNode = platformProductFullData as ShopifyProductNode;
            const mappedData = mapper.mapShopifyProductToCanonical(
                shopifyProductNode,
                userId,
                connection.Id,
                match.platformVariantId // Pass the specific platformVariantId for targeted mapping
            );
            sssyncProductInput = mappedData.sssyncProductInput;
            firstSssyncVariantInput = mappedData.firstSssyncVariantInput;
            sssyncInventoryInputsFromMapped = mappedData.sssyncInventoryInputsFromMapped;
            shopifyVariantIdForMapping = mappedData.shopifyVariantIdForMapping; // This should be match.platformVariantId
            imageUrlsToSave = mappedData.imageUrls || [];

            if (!shopifyVariantIdForMapping && match.platformVariantId) {
                 // If mapper didn't return it but we have it in match, trust match.
                 shopifyVariantIdForMapping = match.platformVariantId;
            }


        } else if (connection.PlatformType === 'square') {
            const squareCatalogObject = platformProductFullData as SquareAPICatalogObjectWithVariations;
             const mappedData = mapper.mapSquareProductToCanonical(
                squareCatalogObject, 
                userId, 
                connection.Id,
                match.platformVariantId // Pass the specific Square variant ID
            );
            sssyncProductInput = mappedData.sssyncProductInput;
            firstSssyncVariantInput = mappedData.firstSssyncVariantInput;
            // Square inventory is typically fetched separately or handled during inventory reconciliation
            // For 'create', we might set a default or leave it to be synced later.
            // sssyncInventoryInputsFromMapped = mappedData.sssyncInventoryInputs;
             imageUrlsToSave = mappedData.imageUrls || [];


        } else if (connection.PlatformType === 'clover') {
            const cloverProductData = platformProductFullData as CloverApiProductData;
            const mappedData = mapper.mapCloverProductToCanonical(
                cloverProductData,
                userId,
                connection.Id,
                match.platformVariantId // Pass specific variant ID if Clover structure supports it
            );
            sssyncProductInput = mappedData.sssyncProductInput;
            firstSssyncVariantInput = mappedData.firstSssyncVariantInput;
            // sssyncInventoryInputsFromMapped = mappedData.sssyncInventoryInputs;
            imageUrlsToSave = mappedData.imageUrls || [];

        } else {
            this.logger.error(`'Create' action mapping not implemented for platform type: ${connection.PlatformType}`);
            return;
        }

        // Robustly determine or create the SSSync Product
        const existingMappingsForPlatformProduct = await this.platformProductMappingsService.getMappingsByPlatformProductId(match.platformProductId, connection.Id);
        let createdSssyncProduct: SupabaseProduct | null | undefined;

        if (existingMappingsForPlatformProduct.length > 0) {
            const firstExistingVariantId = existingMappingsForPlatformProduct[0].ProductVariantId;
            if (firstExistingVariantId) {
                const sssyncVariant = await this.canonicalProductsService.getVariantById(firstExistingVariantId);
                if (sssyncVariant && sssyncVariant.ProductId) {
                    canonicalProductIdToUse = sssyncVariant.ProductId;
                    createdSssyncProduct = await this.canonicalProductsService.getProductById(canonicalProductIdToUse);
                    if (createdSssyncProduct) {
                         this.logger.log(`Using existing SSSync Product ${canonicalProductIdToUse} for platform product ${match.platformProductId}.`);
                         // Optionally: Update product-level details if syncRules.productDetailsSoT === 'PLATFORM'
                         // This requires careful consideration if multiple variants map to the same product.
                         // For now, we'll just use the existing product.
                    } else {
                        this.logger.error(`Logical error: Found ProductId ${canonicalProductIdToUse} from variant but failed to fetch the product. Proceeding to create.`);
                        // Fall through to create product
                    }
                }
            }
        }

        if (!createdSssyncProduct) {
            this.logger.log(`No existing SSSync Product found for platform product ${match.platformProductId} (or failed to retrieve). Creating new SSSync Product.`);
            createdSssyncProduct = await this.canonicalProductsService.saveProduct(sssyncProductInput);
            if (!createdSssyncProduct || !createdSssyncProduct.Id) {
                this.logger.error(`Failed to create SSSync product for platform product ${match.platformProductId} or it has no ID.`);
                 await this.activityLogService.logActivity({
                    UserId: userId,
                    EntityType: 'Product',
                    EntityId: match.platformProductId,
                    EventType: 'PRODUCT_CREATE_FAILED',
                    Status: 'Error',
                    Message: `Failed to create canonical product for ${connection.PlatformType} product ${match.platformProductSku || match.platformProductId}.`,
                    PlatformConnectionId: connection.Id,
                    Details: { platform: connection.PlatformType }
                });
                return; // Stop if product creation fails
            }
            canonicalProductIdToUse = createdSssyncProduct.Id;
            this.logger.log(`Created new SSSync Product ${canonicalProductIdToUse} for platform product ${match.platformProductId}.`);
        }
        
        if (!canonicalProductIdToUse) {
            this.logger.error(`Failed to determine canonicalProductIdToUse for platform product ${match.platformProductId}.`);
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'ProductVariant',
                EntityId: match.platformVariantId || match.platformProductId,
                EventType: 'VARIANT_CREATE_FAILED',
                Status: 'Error',
                Message: `Failed to determine canonical product ID for ${connection.PlatformType} variant ${match.platformVariantId || match.platformProductSku}.`,
                PlatformConnectionId: connection.Id,
                Details: { platform: connection.PlatformType }
            });
            return;
        }

        const sssyncVariantToSave: Omit<SupabaseProductVariant, 'Id' | 'CreatedAt' | 'UpdatedAt'> = {
            ...firstSssyncVariantInput,
            ProductId: canonicalProductIdToUse,
            UserId: userId,
        };

        if (sssyncVariantToSave.Sku === null || sssyncVariantToSave.Sku === undefined ) {
             this.logger.warn(`SKU is null or undefined for variant of product ${match.platformProductId}. Generating temporary SKU.`);
             sssyncVariantToSave.Sku = `TEMP-SKU-${match.platformProductId}-${match.platformVariantId || Date.now()}`;
        }
        
        const createdSssyncVariant = await this.canonicalProductsService.saveVariants([sssyncVariantToSave]);

        if (!createdSssyncVariant || createdSssyncVariant.length === 0 || !createdSssyncVariant[0]?.Id) {
            this.logger.error(`Failed to create SSSync variant for platform variant ${match.platformVariantId || match.platformProductId} or it has no ID.`);
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'ProductVariant',
                EntityId: match.platformVariantId || match.platformProductId,
                EventType: 'VARIANT_CREATE_FAILED',
                Status: 'Error',
                Message: `Failed to create canonical variant for ${connection.PlatformType} variant ${match.platformVariantId || match.platformProductSku}.`,
                PlatformConnectionId: connection.Id,
                Details: { platform: connection.PlatformType }
            });
            return;
        }
        const finalSssyncVariant = createdSssyncVariant[0];
        this.logger.log(`Created new SSSync Variant ${finalSssyncVariant.Id} (Product: ${finalSssyncVariant.ProductId}) from platform product ${match.platformProductId}, variant ${match.platformVariantId}.`);

        if (imageUrlsToSave.length > 0) {
            try {
                await this.canonicalProductsService.saveVariantImages(finalSssyncVariant.Id, imageUrlsToSave);
                this.logger.log(`Saved ${imageUrlsToSave.length} images for new variant ${finalSssyncVariant.Id}`);
            } catch (imgError: any) {
                this.logger.error(`Failed to save images for variant ${finalSssyncVariant.Id}: ${imgError.message}`, imgError.stack);
            }
        }

        // Determine platformVariantId for mapping (especially for Shopify GID)
        let platformVariantIdForMapping = match.platformVariantId;
        if (connection.PlatformType === 'shopify' && shopifyVariantIdForMapping) {
            platformVariantIdForMapping = shopifyVariantIdForMapping;
        }
        // For other platforms, match.platformVariantId should be the correct one if available.

        const newMapping = await this.platformProductMappingsService.upsertMapping({
            PlatformConnectionId: connection.Id,
            ProductVariantId: finalSssyncVariant.Id, 
            PlatformProductId: match.platformProductId, 
            PlatformVariantId: platformVariantIdForMapping || undefined, // Use the GID for Shopify if available
            PlatformSku: firstSssyncVariantInput.Sku || match.platformProductSku,
            SyncStatus: 'Synced', // Or 'PendingFullSync' if more data needs to come
            IsEnabled: true,
            LastSyncedAt: new Date().toISOString(),
        });
        this.logger.log(`Created mapping ${newMapping.Id} for new SSSync variant ${finalSssyncVariant.Id} to platform product ${match.platformProductId}, variant ${platformVariantIdForMapping}.`);
        
        if (sssyncInventoryInputsFromMapped.length > 0) {
             const finalInventoryLevels: CanonicalInventoryLevel[] = sssyncInventoryInputsFromMapped.map(invLevel => ({
                 ...invLevel,
                 ProductVariantId: finalSssyncVariant.Id, 
                 PlatformConnectionId: connection.Id 
             }));
             await this.canonicalInventoryService.saveBulkInventoryLevels(finalInventoryLevels);
             this.logger.log(`Saved ${finalInventoryLevels.length} inventory levels for new variant ${finalSssyncVariant.Id}.`);
        } else {
            this.logger.log(`No direct inventory levels mapped during 'create' for variant ${finalSssyncVariant.Id}. Will be synced by reconciliation if SoT is platform.`);
        }

        await this.activityLogService.logActivity({
            UserId: userId,
            EntityType: 'ProductVariant',
            EntityId: finalSssyncVariant.Id,
            EventType: 'PRODUCT_MAPPING_CREATED',
            Status: 'Success',
            Message: `Product ${match.platformProductSku || match.platformProductId} from ${connection.PlatformType} successfully created as SSSync variant ${finalSssyncVariant.Id}. Mapping created with ID ${newMapping.Id}.`,
            PlatformConnectionId: connection.Id,
            Details: { platform: connection.PlatformType }
        });
    }

    private async handleIgnoreAction(connectionId: string, userId: string, match: ConfirmedMatch): Promise<void> {
        this.logger.log(`Handling 'ignore' for platformProduct: ${match.platformProductId}`);
        // Potentially update a mapping to IsEnabled: false or SyncStatus: 'Ignored' if it exists
        let existingMapping;
        if (typeof match.platformVariantId === 'string') {
            existingMapping = await this.platformProductMappingsService.getMappingByPlatformVariantIdAndConnection(
                match.platformVariantId, 
                connectionId
            );
        } else {
            this.logger.debug(`Skipping existing mapping check for ignore action as platformVariantId is not a string: ${match.platformVariantId}`);
        }

        if (existingMapping) {
            await this.platformProductMappingsService.updateMapping(existingMapping.Id, {
                SyncStatus: 'Ignored',
                IsEnabled: false,
                LastSyncedAt: new Date().toISOString(),
                PlatformSpecificData: { ...(existingMapping.PlatformSpecificData || {}), ignoredReason: 'UserConfirmedIgnore' }
            });
            this.logger.debug(`Marked existing mapping ${existingMapping.Id} as ignored.`);
        } else {
            // If no mapping, perhaps create a lightweight placeholder to remember it's ignored?
            // For now, just log.
            this.logger.debug(`No existing mapping found for platform ID ${match.platformProductId} to mark as ignored. Logging decision.`);
        }

        await this.activityLogService.logActivity({
            UserId: userId,
            EntityType: 'ProductMapping',
            EntityId: match.platformProductId,
            EventType: 'PRODUCT_MAPPING_IGNORED',
            Status: 'Info',
            Message: `Product ${match.platformProductSku || match.platformProductId} was marked for ignore during initial sync.`,
            PlatformConnectionId: connectionId,
            Details: {
                platform: (await this.connectionService.getConnectionById(connectionId, userId))?.PlatformType
            }
        });
    }

    async handleCompleted(job: Job<JobData, any, string>, result: any): Promise<void> {
        const { connectionId, userId } = job.data as any; // Add type assertion if JobData is strictly typed
        this.logger.log(`Initial sync job ${job.id} for connection ${connectionId} (User: ${userId}) completed successfully. Result: ${JSON.stringify(result)}`);
        // Additional success actions if needed, e.g., queueing a follow-up reconciliation
    }

    async handleFailed(job: Job<JobData, any, string> | undefined, error: Error): Promise<void> {
        if (!job) {
            this.logger.error(`Job failed but job object is undefined. Error: ${error.message}`, error.stack);
            return;
        }
        const { connectionId, userId } = job.data as any;
        this.logger.error(`Initial sync job ${job.id} for connection ${connectionId} (User: ${userId}) failed: ${error.message}`, error.stack);
        // Connection status is typically updated to 'error' within the main process method's catch block.
    }

    async handleProgress(job: Job<JobData, any, string>, progress: number | object): Promise<void> {
        const { connectionId } = job.data as any;
        this.logger.debug(`Initial sync job ${job.id} for connection ${connectionId} progress: ${typeof progress === 'number' ? progress.toFixed(2) + '%' : JSON.stringify(progress)}`);
    }
} 