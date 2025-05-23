import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { 
    CloverApiClient, 
    CloverItem, 
    CloverItemGroup, 
    CloverLocation, 
    CreateCloverProductResponse,
    CloverItemInput
} from './clover-api-client.service';
import { CloverMapper } from './clover.mapper';
import { PlatformConnection } from '../../platform-connections/platform-connections.service';
import { BaseAdapter, BaseSyncLogic } from '../base-adapter.interface';
import { ProductsService } from '../../canonical-data/products.service';
import { InventoryService } from '../../canonical-data/inventory.service';
import { PlatformProductMappingsService, PlatformProductMapping } from '../../platform-product-mappings/platform-product-mappings.service';
import { CanonicalProduct, CanonicalProductVariant } from '../shopify/shopify.mapper'; // Using common canonical types
import { Product, ProductVariant } from '../../common/types/supabase.types'; // Supabase specific types
import { CanonicalInventoryLevel } from '../../canonical-data/inventory.service';
import { CloverProductCreationBundle } from './clover.mapper'; // Import the bundle type

@Injectable()
export class CloverAdapter implements BaseAdapter {
    private readonly logger = new Logger(CloverAdapter.name);

    constructor(
        private readonly cloverApiClient: CloverApiClient,
        private readonly cloverMapper: CloverMapper,
        private readonly productsService: ProductsService,
        private readonly inventoryService: InventoryService,
        private readonly mappingsService: PlatformProductMappingsService,
    ) {}

    getApiClient(connection: PlatformConnection): CloverApiClient {
        this.cloverApiClient.initialize(connection);
        return this.cloverApiClient;
    }

    getMapper(): CloverMapper {
        return this.cloverMapper;
    }

    getSyncLogic(): BaseSyncLogic {
        return {
            shouldDelist: (canonicalQuantity: number) => canonicalQuantity <= 0,
        };
    }

    async syncFromPlatform(connection: PlatformConnection, userId: string): Promise<void> {
        this.logger.log(`Starting Clover sync for connection ${connection.Id}, user ${userId}`);
        const apiClient = this.getApiClient(connection);

        try {
            const cloverData = await apiClient.fetchAllRelevantData(connection);
            if (!cloverData || cloverData.items.length === 0) {
                this.logger.log('No items fetched from Clover.');
                return;
            }

            const { 
                canonicalProducts, 
                canonicalVariants, 
                canonicalInventoryLevels 
            } = this.cloverMapper.mapCloverDataToCanonical(cloverData, userId, connection.Id);

            const allInventoryToSave: CanonicalInventoryLevel[] = [];

            for (const cProduct of canonicalProducts) {
                let savedSupabaseProduct: Product | null = null;
                const existingProductMappingBasedOnPlatformProductId = await this.mappingsService.getMappingByPlatformId(connection.Id, cProduct.Id!);
                
                if (existingProductMappingBasedOnPlatformProductId && existingProductMappingBasedOnPlatformProductId.ProductVariantId) {
                    const associatedVariant = await this.productsService.getVariantById(existingProductMappingBasedOnPlatformProductId.ProductVariantId);
                    if (associatedVariant) {
                       savedSupabaseProduct = await this.productsService.getProductById(associatedVariant.ProductId);
                    }
                }

                if (!savedSupabaseProduct) {
                    const productToSave: Omit<Product, 'Id' | 'CreatedAt' | 'UpdatedAt'> = {
                        UserId: cProduct.UserId,
                        IsArchived: cProduct.IsArchived,
                    };
                    savedSupabaseProduct = await this.productsService.saveProduct(productToSave);
                }

                if (!savedSupabaseProduct) {
                    this.logger.error(`Failed to save or find product for canonical product ID ${cProduct.Id}. Skipping variants.`);
                    continue;
                }

                const variantsToSavePrepared = canonicalVariants
                    .filter(cv => cv.ProductId === cProduct.Id)
                    .map(cv => {
                        if (cv.Sku === null || cv.Sku === undefined || cv.Sku.trim() === '') {
                            this.logger.warn(`Canonical variant for product ${cProduct.Title} has a null or empty SKU. Original platform ID: ${cv.Id}. Skipping this variant.`);
                            return null;
                        }
                        return {
                            ProductId: savedSupabaseProduct!.Id,
                            UserId: userId,
                            Sku: cv.Sku,
                            Barcode: cv.Barcode,
                            Title: cv.Title,
                            Description: cv.Description,
                            Price: cv.Price,
                            CompareAtPrice: cv.CompareAtPrice,
                            Weight: cv.Weight,
                            WeightUnit: cv.WeightUnit,
                            Options: cv.Options,
                            RequiresShipping: cv.RequiresShipping !== undefined ? cv.RequiresShipping : true,
                            IsTaxable: cv.IsTaxable !== undefined ? cv.IsTaxable : true,
                            TaxCode: cv.TaxCode,
                            ImageId: cv.ImageId,
                        };
                    })
                    .filter(Boolean) as Array<Omit<ProductVariant, 'Id' | 'CreatedAt' | 'UpdatedAt'>>;

                if (variantsToSavePrepared.length > 0) {
                    const savedSupabaseVariants = await this.productsService.saveVariants(variantsToSavePrepared);

                    const relevantOriginalCanonicalVariants = canonicalVariants.filter(cv => cv.ProductId === cProduct.Id && cv.Sku && cv.Sku.trim() !== '');

                    for (const originalCv of relevantOriginalCanonicalVariants) {
                        const savedSupabaseVariant = savedSupabaseVariants.find(sv => sv.Sku === originalCv.Sku && sv.ProductId === savedSupabaseProduct.Id);
                        if (!savedSupabaseVariant) {
                            this.logger.warn(`Could not find saved Supabase variant for canonical variant SKU ${originalCv.Sku} of product ${cProduct.Title}`);
                            continue;
                        }

                        const platformVariantIdForMapping = originalCv.Id!.replace('clover-var-', '');

                        let existingVariantMapping = await this.mappingsService.getMappingByPlatformIdentifiers(connection.Id, cProduct.Id!, platformVariantIdForMapping);

                        const mappingData: Omit<PlatformProductMapping, 'Id' | 'CreatedAt' | 'UpdatedAt'> = {
                            PlatformConnectionId: connection.Id,
                            ProductVariantId: savedSupabaseVariant.Id,
                            PlatformProductId: cProduct.Id!,
                            PlatformVariantId: platformVariantIdForMapping,
                            PlatformSku: originalCv.Sku,
                            PlatformSpecificData: originalCv.PlatformSpecificData,
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
                            });
                        }
                    }
                }
            }

            if (allInventoryToSave.length > 0) {
                await this.inventoryService.saveBulkInventoryLevels(allInventoryToSave);
                this.logger.log(`Saved ${allInventoryToSave.length} inventory levels for connection ${connection.Id}`);
            }

            this.logger.log(`Clover sync completed for connection ${connection.Id}`);
        } catch (error) {
            this.logger.error(`Error during Clover sync for connection ${connection.Id}: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Clover sync failed: ${error.message}`);
        }
    }

    // --- Push to Platform Methods (Placeholders) ---
    async createProduct(
        connection: PlatformConnection,
        canonicalProduct: CanonicalProduct, 
        canonicalVariants: CanonicalProductVariant[], 
        // canonicalInventoryLevels are not directly used for creating the product structure on Clover via this method,
        // but they might be used for a subsequent inventory update call if needed.
        canonicalInventoryLevels: CanonicalInventoryLevel[] 
    ): Promise<{ platformProductId: string; platformVariantIds: Record<string, string> }> {
        this.logger.log(`Starting Clover createProduct for canonical product: ${canonicalProduct.Title} (ID: ${canonicalProduct.Id}) on connection ${connection.Id}`);
        const apiClient = this.getApiClient(connection);
        const mapper = this.getMapper();

        if (!canonicalVariants || canonicalVariants.length === 0) {
            this.logger.error('Cannot create Clover product: No canonical variants provided.');
            throw new InternalServerErrorException('No variants provided for Clover product creation.');
        }

        const creationBundle: CloverProductCreationBundle = mapper.mapCanonicalToCloverCreationBundle(
            canonicalProduct,
            canonicalVariants
        );

        if (!creationBundle.itemGroupPayload || creationBundle.variantItemPayloads.length === 0) {
            this.logger.error('Clover creation bundle is invalid (missing item group or variants). Cannot proceed with product creation.');
            throw new InternalServerErrorException('Failed to prepare valid data for Clover product creation.');
        }

        const cloverResponse: CreateCloverProductResponse = await apiClient.orchestrateCloverProductCreation(
            connection,
            creationBundle
        );

        if (!cloverResponse.success || !cloverResponse.itemGroupId) {
            this.logger.error(`Clover product creation failed or did not return an itemGroupId. Message: ${cloverResponse.message}`);
            this.logger.debug(`Clover raw response for failed creation: ${JSON.stringify(cloverResponse)}`);
            throw new InternalServerErrorException(`Clover product creation failed: ${cloverResponse.message || 'Unknown error from Clover API client'}`);
        }

        const platformProductId = cloverResponse.itemGroupId; // The item group ID is the parent product ID
        const platformVariantIds: Record<string, string> = {}; // Maps CanonicalVariantID to Clover Item (Variant) ID

        let successfullyMappedVariants = 0;
        for (const variantResp of cloverResponse.variantItemResponses) {
            if (variantResp.success && variantResp.cloverItemId) {
                const originalCanonicalVariant = canonicalVariants.find(cv => cv.Id === variantResp.canonicalVariantId);
                if (originalCanonicalVariant && originalCanonicalVariant.Id) {
                    platformVariantIds[originalCanonicalVariant.Id] = variantResp.cloverItemId;
                    successfullyMappedVariants++;
                    this.logger.log(`Successfully mapped canonical variant ${originalCanonicalVariant.Id} to Clover item ${variantResp.cloverItemId}`);
                } else {
                    this.logger.warn(`Could not find original canonical variant for ID ${variantResp.canonicalVariantId} from Clover response, or it lacked an ID.`);
                }
            } else {
                this.logger.warn(`Clover item creation for canonical variant ${variantResp.canonicalVariantId} failed or missing Clover item ID. Error: ${variantResp.error}, AssocError: ${variantResp.optionAssociationError}`);
            }
        }

        if (successfullyMappedVariants === 0 && cloverResponse.variantItemResponses.length > 0) {
            this.logger.error('Although Clover item group might have been created, no variant items were successfully created or mapped.');
            // Depending on desired atomicity, this could be a full failure.
            // For now, we proceed if itemGroupId exists, but log heavily.
        }
        
        this.logger.log(`Clover product created: Platform Product ID (ItemGroupID): ${platformProductId}, Variants mapped: ${successfullyMappedVariants}/${canonicalVariants.length}`);

        // Note: Inventory levels would typically be updated in a separate step after product structure creation.
        // The `canonicalInventoryLevels` parameter is available if a subsequent call to `updateInventoryLevels` is needed here.

        return { platformProductId, platformVariantIds };
    }

    async updateProduct(
        connection: PlatformConnection,
        existingMapping: PlatformProductMapping, // The mapping for one of the variants, used to get PlatformProductId (Item Group ID)
        canonicalProduct: CanonicalProduct,
        canonicalVariants: CanonicalProductVariant[],
        // canonicalInventoryLevels are not directly used in this simplified update for product structure.
        // A separate call to updateInventoryLevels would handle inventory quantities.
        canonicalInventoryLevels: CanonicalInventoryLevel[] 
    ): Promise<{ platformProductId: string; updatedVariantIds: string[]; createdVariantIds: string[]; deletedVariantIds: string[]; errors: string[] }> {
        this.logger.log(`Starting Clover updateProduct for Platform Product (Group) ID: ${existingMapping.PlatformProductId} on connection ${connection.Id}`);
        const apiClient = this.getApiClient(connection);
        const merchantId = connection.PlatformSpecificData?.merchantId;
        const results = {
            platformProductId: existingMapping.PlatformProductId!,
            updatedVariantIds: [] as string[],
            createdVariantIds: [] as string[], // Not handled in this simplified version
            deletedVariantIds: [] as string[], // Not handled in this simplified version
            errors: [] as string[],
        };

        if (!merchantId) {
            const errorMsg = `Merchant ID not found for connection ${connection.Id}. Cannot update.`;
            this.logger.error(errorMsg);
            results.errors.push(errorMsg);
            return results; // Early exit
        }
        if (!results.platformProductId) {
            const errorMsg = `PlatformProductId (Item Group ID) missing in existingMapping. Cannot update. Mapping ID: ${existingMapping.Id}`;
            this.logger.error(errorMsg);
            results.errors.push(errorMsg);
            return results; // Early exit
        }

        // 1. Update Item Group (Product Level)
        try {
            // Assuming canonicalProduct.Title is the source for the item group name
            // A more robust approach would fetch the current item group from Clover and compare names before updating.
            // For simplicity, we'll just attempt an update if canonicalProduct.Title is provided.
            if (canonicalProduct.Title) {
                await apiClient.updateCloverItemGroup(connection, merchantId, results.platformProductId, { name: canonicalProduct.Title });
                this.logger.log(`Successfully updated Clover Item Group ${results.platformProductId} name to "${canonicalProduct.Title}"`);
            }
            // Updating other item group properties would go here if needed.
        } catch (error) {
            const errorMsg = `Failed to update Clover Item Group ${results.platformProductId}: ${error.message}`;
            this.logger.error(errorMsg);
            results.errors.push(errorMsg);
            // Continue to update variants even if group update fails, as they might still be updatable.
        }

        // 2. Update existing Items (Variants)
        for (const cVariant of canonicalVariants) {
            if (!cVariant.Id) {
                this.logger.warn(`Canonical variant for product ${canonicalProduct.Title} is missing an ID. Cannot map for update.`);
                continue;
            }

            // Find the mapping for this specific canonical variant
            const variantMapping = await this.mappingsService.getMappingByVariantIdAndPlatformProductId(
                cVariant.Id, 
                results.platformProductId, 
                connection.Id
            );

            if (variantMapping && variantMapping.PlatformVariantId) {
                const cloverItemIdToUpdate = variantMapping.PlatformVariantId;
                try {
                    const itemUpdatePayload: Partial<CloverItemInput> = {
                        name: cVariant.Title,
                        price: Math.round(cVariant.Price * 100), // Price to cents
                        sku: cVariant.Sku || undefined, // Ensure null is not sent if SKU is truly absent, but prefer empty string if it means "clear SKU"
                        code: cVariant.Barcode || undefined, // Barcode as 'code'
                        cost: cVariant.Cost ? Math.round(cVariant.Cost * 100) : undefined, // Cost to cents
                        hidden: cVariant.IsArchived ?? canonicalProduct.IsArchived ?? false,
                        // Note: Updating itemGroup link or options is not handled in this simplified version.
                    };

                    await apiClient.updateCloverItem(connection, merchantId, cloverItemIdToUpdate, itemUpdatePayload);
                    this.logger.log(`Successfully updated Clover Item ID ${cloverItemIdToUpdate} (Canonical Variant: ${cVariant.Id})`);
                    results.updatedVariantIds.push(cloverItemIdToUpdate);
                } catch (error) {
                    const errorMsg = `Failed to update Clover Item ID ${cloverItemIdToUpdate} (Canonical: ${cVariant.Id}): ${error.message}`;
                    this.logger.error(errorMsg);
                    results.errors.push(errorMsg);
                }
            } else {
                // This variant is in canonical data but not mapped to an existing Clover item for this product group.
                // In a full implementation, this would trigger creation of a new Clover item and association.
                // For this simplified version, we log and skip.
                this.logger.warn(`Canonical variant ID ${cVariant.Id} has no existing Clover item mapping for product group ${results.platformProductId}. Creation of new variants during update is not handled in this simplified version.`);
                results.errors.push(`Skipped: Canonical variant ID ${cVariant.Id} - no existing Clover item mapping found for update.`);
            }
        }
        
        this.logger.log(`Clover updateProduct finished for Item Group ${results.platformProductId}. Updated items: ${results.updatedVariantIds.length}. Errors: ${results.errors.length}`);
        return results;
    }

    async deleteProduct(
        connection: PlatformConnection,
        existingMapping: PlatformProductMapping, // Now typed correctly
    ): Promise<void> {
        this.logger.log(`Starting Clover deleteProduct for mapping ID: ${existingMapping.Id}, Platform Product (Group) ID: ${existingMapping.PlatformProductId} on connection ${connection.Id}`);
        const apiClient = this.getApiClient(connection);
        const merchantId = connection.PlatformSpecificData?.merchantId;

        if (!merchantId) {
            const errorMsg = `Merchant ID not found in PlatformSpecificData for connection ${connection.Id}. Cannot delete Clover product.`;
            this.logger.error(errorMsg);
            throw new InternalServerErrorException(errorMsg);
        }

        if (!existingMapping.PlatformProductId) {
            const errorMsg = `PlatformProductId (Clover Item Group ID) missing in existingMapping. Cannot delete Clover product. Mapping ID: ${existingMapping.Id}`;
            this.logger.error(errorMsg);
            throw new InternalServerErrorException(errorMsg);
        }

        const itemGroupIdToDelete = existingMapping.PlatformProductId;

        // 1. Find all variant mappings associated with this Item Group ID to get all Clover Item IDs
        const allVariantMappings = await this.mappingsService.getMappingsByPlatformProductId(connection.Id, itemGroupIdToDelete);

        if (allVariantMappings.length === 0) {
            this.logger.warn(`No variant mappings found for Item Group ID ${itemGroupIdToDelete}. Will attempt to delete the item group directly.`);
        } else {
            this.logger.log(`Found ${allVariantMappings.length} Clover items (variants) to delete for Item Group ID: ${itemGroupIdToDelete}`);
            for (const variantMapping of allVariantMappings) {
                if (variantMapping.PlatformVariantId) {
                    try {
                        await apiClient.deleteCloverItem(connection, merchantId, variantMapping.PlatformVariantId);
                        this.logger.log(`Successfully deleted Clover item (variant) ID: ${variantMapping.PlatformVariantId}`);
                    } catch (error) {
                        // Log error but continue trying to delete other items and the group
                        this.logger.error(`Failed to delete Clover item (variant) ID ${variantMapping.PlatformVariantId} for group ${itemGroupIdToDelete}: ${error.message}`);
                    }
                } else {
                    this.logger.warn(`Skipping deletion for mapping ID ${variantMapping.Id} as PlatformVariantId is missing.`);
                }
            }
        }

        // 2. Delete the Item Group
        try {
            await apiClient.deleteCloverItemGroup(connection, merchantId, itemGroupIdToDelete);
            this.logger.log(`Successfully deleted Clover Item Group ID: ${itemGroupIdToDelete}`);
        } catch (error) {
            this.logger.error(`Failed to delete Clover Item Group ID ${itemGroupIdToDelete}: ${error.message}`);
            // If group deletion fails, re-throw as this is the primary target of the delete operation.
            throw new InternalServerErrorException(`Failed to delete Clover Item Group ${itemGroupIdToDelete}: ${error.message}`);
        }
        
        // Note: Associated PlatformProductMapping entries in Supabase should be cleaned up by the SyncCoordinatorService or another process
        // after this adapter method signals success.
    }

    async updateInventoryLevels(
        connection: PlatformConnection,
        inventoryUpdates: Array<{ mapping: PlatformProductMapping; level: CanonicalInventoryLevel }>
    ): Promise<{ successCount: number; failureCount: number; errors: string[] }> {
        this.logger.log(`Starting Clover updateInventoryLevels for ${inventoryUpdates.length} items on connection ${connection.Id}`);
        const apiClient = this.getApiClient(connection);
        const merchantId = connection.PlatformSpecificData?.merchantId;
        let successCount = 0;
        let failureCount = 0;
        const errors: string[] = [];

        if (!merchantId) {
            const errorMsg = `Merchant ID not found in PlatformSpecificData for connection ${connection.Id}. Cannot update Clover inventory.`;
            this.logger.error(errorMsg);
            // If merchantId is missing, all updates will fail. Return early.
            return { 
                successCount: 0, 
                failureCount: inventoryUpdates.length, 
                errors: inventoryUpdates.map(iu => `Merchant ID missing for variant ${iu.mapping.ProductVariantId}`) 
            };
        }

        for (const update of inventoryUpdates) {
            const { mapping, level } = update;
            if (!mapping.PlatformVariantId) {
                const errMsg = `PlatformVariantId (Clover Item ID) missing for mapping with ProductVariantId ${mapping.ProductVariantId}. Skipping inventory update.`;
                this.logger.warn(errMsg);
                errors.push(errMsg);
                failureCount++;
                continue;
            }

            const cloverItemId = mapping.PlatformVariantId;
            const newQuantity = level.Quantity; // CanonicalInventoryLevel.Quantity

            try {
                await apiClient.updateCloverItemStock(connection, merchantId, cloverItemId, newQuantity);
                this.logger.log(`Successfully updated inventory for Clover Item ID ${cloverItemId} to quantity ${newQuantity}`);
                successCount++;
            } catch (error) {
                const errMsg = `Failed to update inventory for Clover Item ID ${cloverItemId} (Canonical Variant: ${mapping.ProductVariantId}): ${error.message}`;
                this.logger.error(errMsg);
                errors.push(errMsg);
                failureCount++;
            }
        }

        this.logger.log(`Clover updateInventoryLevels completed. Success: ${successCount}, Failures: ${failureCount}`);
        if (failureCount > 0) {
            this.logger.warn(`Errors during Clover inventory update: ${JSON.stringify(errors)}`);
        }
        return { successCount, failureCount, errors };
    }

    async processWebhook(
        connection: PlatformConnection,
        payload: any,
        headers: Record<string, string> // Added headers argument
    ): Promise<void> {
        const merchantId = connection.PlatformSpecificData?.merchantId;
        this.logger.log(`CloverAdapter: Processing webhook for merchant '${merchantId}' on connection ${connection.Id}`);
        this.logger.debug(`Webhook payload: ${JSON.stringify(payload).substring(0, 500)}...`);
        this.logger.debug(`Webhook headers: ${JSON.stringify(headers)}`);

        // Clover webhook payloads vary greatly by event type (e.g., inventory, orders, items)
        const eventType = payload?.type; // e.g., CREATE, UPDATE, DELETE
        const objectType = payload?.object; // e.g., ITEM, ITEM_GROUP, ITEM_STOCK, ORDER
        const objectId = payload?.data?.object?.id || payload?.data?.id; // ID of the affected object

        this.logger.log(`Clover webhook: EventType='${eventType}', ObjectType='${objectType}', ObjectId='${objectId}'`);

        if (!eventType || !objectType || !objectId) {
            this.logger.warn('Clover webhook missing critical fields (type, object, or object.id). Skipping.');
            return;
        }

        try {
            if (objectType === 'ITEM' || objectType === 'ITEM_GROUP') {
                if (eventType === 'CREATE' || eventType === 'UPDATE') {
                    this.logger.log(`Item/Item_Group ${eventType} event for ID ${objectId}. Triggering single product sync.`);
                    await this.syncSingleProductFromPlatform(connection, objectId, connection.UserId);
                } else if (eventType === 'DELETE') {
                    this.logger.log(`Item/Item_Group DELETE event for ID ${objectId}. Handling deletion.`);
                    // Find mapping(s) for this platform ID (could be item or item_group)
                    const mappings = await this.mappingsService.getMappingsByPlatformProductId(connection.Id, objectId);
                    if (mappings.length === 0) {
                        this.logger.warn(`No mappings found for Clover platform ID ${objectId} during DELETE webhook. Nothing to delete from canonical store.`);
                    } else {
                        for (const mapping of mappings) {
                            if (mapping.ProductVariantId) {
                                const variant = await this.productsService.getVariantById(mapping.ProductVariantId);
                                if (variant && variant.ProductId) {
                                    await this.productsService.deleteProductAndVariants(variant.ProductId, connection.UserId);
                                    this.logger.log(`Deleted canonical product ${variant.ProductId} (and variants) linked to Clover ID ${objectId}`);
                                }
                            }
                            await this.mappingsService.deleteMapping(mapping.Id);
                            this.logger.log(`Deleted platform mapping ${mapping.Id} for Clover ID ${objectId}`);
                        }
                    }
                } else {
                    this.logger.warn(`Unhandled eventType '${eventType}' for Clover objectType '${objectType}'`);
                }
            } else if (objectType === 'ITEM_STOCK') {
                if (eventType === 'UPDATE' || eventType === 'CREATE') { // Stock changes are usually updates
                    const cloverItemId = payload?.data?.object?.item?.id; // Item ID associated with this stock
                    const newQuantity = payload?.data?.object?.quantity ?? payload?.data?.object?.stockCount;
                    
                    if (cloverItemId && newQuantity !== undefined) {
                        this.logger.log(`Item_Stock ${eventType} for Clover Item ID ${cloverItemId}, new quantity: ${newQuantity}.`);
                        const mapping = await this.mappingsService.getMappingByPlatformVariantIdAndConnection(cloverItemId, connection.Id);
                        if (mapping && mapping.ProductVariantId) {
                            // Clover doesn't typically provide location for item_stock in this basic webhook.
                            // Assuming update for the primary/default location or a convention is established.
                            // For a more robust solution, the specific Clover location ID would be needed.
                            // For now, let's update with null PlatformLocationId, which should update the entry with null locationId in InventoryLevels.
                            await this.inventoryService.updateLevel({
                                ProductVariantId: mapping.ProductVariantId,
                                PlatformConnectionId: connection.Id,
                                PlatformLocationId: null, // Or a default Clover location ID if known
                                Quantity: Number(newQuantity),
                                LastPlatformUpdateAt: new Date().toISOString(),
                            });
                            this.logger.log(`Updated canonical inventory for sssync variant ${mapping.ProductVariantId} (Clover Item ${cloverItemId}) to ${newQuantity}`);
                        } else {
                            this.logger.warn(`No mapping found for Clover Item ID ${cloverItemId} from ITEM_STOCK webhook.`);
                        }
                    } else {
                        this.logger.warn('ITEM_STOCK webhook missing item.id or quantity.');
                    }
                } else {
                     this.logger.warn(`Unhandled eventType '${eventType}' for Clover objectType 'ITEM_STOCK'`);
                }
            } else if (objectType === 'ORDER') {
                this.logger.log(`Order event received from Clover: ${eventType} for Order ID ${objectId}`);
                // TODO: Implement order processing.
                this.logger.warn('Order processing from Clover webhook not yet implemented.');
            } else {
                this.logger.warn(`CloverAdapter received unhandled webhook objectType: ${objectType}`);
            }
        } catch (error) {
            this.logger.error(`Error processing Clover webhook for objectId ${objectId} (Type: ${objectType}, Event: ${eventType}): ${error.message}`, error.stack);
        }
    }

    async syncSingleProductFromPlatform(connection: PlatformConnection, platformPossiblyItemGroupId: string, userId: string): Promise<void> {
        this.logger.log(`Starting Clover single product/itemGroup sync for ID: ${platformPossiblyItemGroupId}, user ${userId}, connection ${connection.Id}`);
        const apiClient = this.getApiClient(connection);
        const mapper = this.getMapper();
        const merchantId = connection.PlatformSpecificData?.merchantId;

        if (!merchantId) {
            this.logger.error(`Merchant ID not found for connection ${connection.Id}. Cannot sync single product.`);
            throw new InternalServerErrorException('Clover merchantId is missing.');
        }

        try {
            let itemsToProcess: CloverItem[] = [];
            const expandFields = ['itemStock', 'categories', 'tags', 'modifierGroups', 'itemGroup', 'options', 'variants'];
            
            // Attempt to fetch as ItemGroup first, as this usually contains multiple items (variants)
            try {
                const itemGroupWithItemsResponse = await apiClient.axiosInstance.get<CloverItemGroup & { items: { elements: CloverItem[] } }>(
                    `/v3/merchants/${merchantId}/item_groups/${platformPossiblyItemGroupId}`,
                    { headers: await apiClient.getHeaders(connection), params: { expand: 'items.elements' } } // Expand items within the group
                );
                if (itemGroupWithItemsResponse.data?.items?.elements) {
                    itemsToProcess.push(...itemGroupWithItemsResponse.data.items.elements);
                    // If items are fetched this way, they might be summaries. Fetch full details.
                    const detailedItems: CloverItem[] = [];
                    for (const summaryItem of itemsToProcess) {
                        try {
                            const itemDetailResponse = await apiClient.axiosInstance.get<CloverItem>(
                                `/v3/merchants/${merchantId}/items/${summaryItem.id}`,
                                { headers: await apiClient.getHeaders(connection), params: { expand: expandFields.join(',') } }
                            );
                            if (itemDetailResponse.data) {
                                detailedItems.push(itemDetailResponse.data);
                            }
                        } catch (detailError) {
                            this.logger.warn(`Failed to fetch full details for item ${summaryItem.id} within item group ${platformPossiblyItemGroupId}: ${detailError.message}`);
                        }
                    }
                    itemsToProcess = detailedItems; // Replace summaries with full details
                } else if (itemGroupWithItemsResponse.data) {
                    // It's an item group, but no items were returned directly or the structure was unexpected.
                    // This case might mean it's an empty group, or we need to query items differently.
                    // For now, assume if `items.elements` is not there, it has no variants via this path.
                    this.logger.log(`Fetched item group ${platformPossiblyItemGroupId}, but it has no directly associated items in the response.`);
                }
            } catch (groupError) {
                // If fetching as item group fails (e.g., 404), it might be a single item ID.
                this.logger.warn(`Could not fetch ID ${platformPossiblyItemGroupId} as an ItemGroup (${groupError.message}). Attempting to fetch as a single Item.`);
                try {
                    const singleItemResponse = await apiClient.axiosInstance.get<CloverItem>(
                        `/v3/merchants/${merchantId}/items/${platformPossiblyItemGroupId}`,
                        { headers: await apiClient.getHeaders(connection), params: { expand: expandFields.join(',') } }
                    );
                    if (singleItemResponse.data) {
                        itemsToProcess.push(singleItemResponse.data);
                    }
                } catch (itemError) {
                    this.logger.error(`Failed to fetch ${platformPossiblyItemGroupId} as either ItemGroup or Item: ${itemError.message}`);
                    throw new InternalServerErrorException(`Could not retrieve product data from Clover for ID ${platformPossiblyItemGroupId}.`);
                }
            }

            if (itemsToProcess.length === 0) {
                this.logger.log(`No Clover items found to process for ID ${platformPossiblyItemGroupId}. Sync for this item might be skipped or it's a deletion.`);
                // Consider if we need to handle deletion case here based on an empty result.
                // For now, if nothing found, we just log and exit.
                return;
            }

            // For now, assume single "location" for Clover, which is the merchant itself.
            const cloverLocations: CloverLocation[] = [];
            try {
                const merchantDetails = await apiClient.axiosInstance.get<{id: string, name: string, address?: any}>( `/v3/merchants/${merchantId}`, { headers: await apiClient.getHeaders(connection), params: {expand: 'address'} });
                if (merchantDetails.data) {
                    cloverLocations.push({
                        id: merchantDetails.data.id,
                        name: merchantDetails.data.name,
                        // address mapping...
                    });
                }
            } catch (locError) {
                 this.logger.warn(`Could not fetch merchant details as location for single sync of ${platformPossiblyItemGroupId}: ${locError.message}`);
            }


            const { 
                canonicalProducts, 
                canonicalVariants, 
                canonicalInventoryLevels 
            } = mapper.mapCloverDataToCanonical({ items: itemsToProcess, locations: cloverLocations }, userId, connection.Id);

            // Save logic (similar to full syncFromPlatform, but scoped to these products/variants)
            const allInventoryToSave: CanonicalInventoryLevel[] = [];

            for (const cProduct of canonicalProducts) { // Should usually be one product if syncing a single item/group
                let savedSupabaseProduct: Product | null = null;
                // Try to find existing product by platform ID if it's an update for an existing group/item
                const existingProductMapping = await this.mappingsService.getMappingByPlatformId(connection.Id, cProduct.Id!);
                if (existingProductMapping?.ProductVariantId) {
                     const variant = await this.productsService.getVariantById(existingProductMapping.ProductVariantId);
                     if (variant) savedSupabaseProduct = await this.productsService.getProductById(variant.ProductId);
                }

                if (!savedSupabaseProduct) {
                    savedSupabaseProduct = await this.productsService.saveProduct({ UserId: userId, IsArchived: cProduct.IsArchived });
                } else {
                    // Update existing product if necessary (e.g., IsArchived status)
                    await this.productsService.updateProduct(savedSupabaseProduct.Id, { IsArchived: cProduct.IsArchived });
                }
                
                if (!savedSupabaseProduct) {
                    this.logger.error(`Failed to save/find product for canonical product ID ${cProduct.Id} during single sync. Skipping variants.`);
                    continue;
                }

                const variantsToSavePrepared = canonicalVariants
                    .filter(cv => cv.ProductId === cProduct.Id) // Ensure variants belong to the current canonical product
                    .map(cv => {
                        if (cv.Sku === null || cv.Sku === undefined || cv.Sku.trim() === '') {
                            this.logger.warn(`Webhook: Canonical variant for product ${cProduct.Title} has a null/empty SKU. Original platform ID: ${cv.Id}. Skipping this variant.`);
                            return null;
                        }
                        return {
                            ProductId: savedSupabaseProduct!.Id,
                            UserId: userId,
                            Sku: cv.Sku,
                            Barcode: cv.Barcode,
                            Title: cv.Title,
                            Description: cv.Description,
                            Price: cv.Price,
                            CompareAtPrice: cv.CompareAtPrice,
                            Weight: cv.Weight,
                            WeightUnit: cv.WeightUnit,
                            Options: cv.Options,
                            RequiresShipping: cv.RequiresShipping !== undefined ? cv.RequiresShipping : true,
                            IsTaxable: cv.IsTaxable !== undefined ? cv.IsTaxable : true,
                            TaxCode: cv.TaxCode,
                            ImageId: cv.ImageId,
                            // Ensure ProductId is correct for variants linked to this product
                        };
                    })
                    .filter(Boolean) as Array<Omit<ProductVariant, 'Id' | 'CreatedAt' | 'UpdatedAt'>>;
                
                if (variantsToSavePrepared.length > 0) {
                    const savedSupabaseVariants = await this.productsService.saveVariants(variantsToSavePrepared);
                    
                    const relevantOriginalCanonicalVariants = canonicalVariants.filter(cv => cv.ProductId === cProduct.Id && cv.Sku && cv.Sku.trim() !== '');

                    for (const originalCv of relevantOriginalCanonicalVariants) {
                        const savedSupabaseVariant = savedSupabaseVariants.find(sv => sv.Sku === originalCv.Sku && sv.ProductId === savedSupabaseProduct!.Id);
                        if (!savedSupabaseVariant) {
                            this.logger.warn(`Webhook: Could not find saved Supabase variant for canonical variant SKU ${originalCv.Sku} of product ${cProduct.Title}`);
                            continue;
                        }

                        const platformVariantIdForMapping = originalCv.Id!.replace('clover-var-', '');
                        let existingVariantMapping = await this.mappingsService.getMappingByPlatformIdentifiers(connection.Id, cProduct.Id!, platformVariantIdForMapping);

                        const mappingData: Omit<PlatformProductMapping, 'Id' | 'CreatedAt' | 'UpdatedAt'> = {
                            PlatformConnectionId: connection.Id,
                            ProductVariantId: savedSupabaseVariant.Id,
                            PlatformProductId: cProduct.Id!, // This is the Clover ItemGroup ID or standalone Item ID
                            PlatformVariantId: platformVariantIdForMapping, // This is the Clover Item ID
                            PlatformSku: originalCv.Sku,
                            PlatformSpecificData: originalCv.PlatformSpecificData,
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
                            });
                        }
                    }
                }
            }

            if (allInventoryToSave.length > 0) {
                await this.inventoryService.saveBulkInventoryLevels(allInventoryToSave);
                this.logger.log(`Webhook: Saved ${allInventoryToSave.length} inventory levels for single Clover product sync, connection ${connection.Id}`);
            }

            this.logger.log(`Clover single product/itemGroup sync completed for ID: ${platformPossiblyItemGroupId}, user ${userId}`);

        } catch (error) {
            this.logger.error(`Error during Clover single product/itemGroup sync for ID ${platformPossiblyItemGroupId}: ${error.message}`, error.stack);
            // Do not re-throw, as webhook controller should handle its own error response strategy.
            // Let the webhook controller decide if this is a fatal error for the webhook ack.
        }
    }
}

// Helper in PlatformProductMappingsService might be needed:
// async getMappingByPlatformIdentifiers(platformConnectionId: string, platformProductId: string, platformVariantId: string): Promise<PlatformProductMapping | null>
// This would query based on PlatformConnectionId, PlatformProductId, AND PlatformVariantId.
// The sssync-db.md shows a UNIQUE constraint on ("PlatformConnectionId", "PlatformProductId", "PlatformVariantId")
// which is perfect for this lookup. 

// Helper in PlatformProductMappingsService might be needed:
// async getMappingByPlatformVariantIdAndConnection(platformVariantId: string, connectionId: string): Promise<PlatformProductMapping | null>
// This would query based on PlatformVariantId and PlatformConnectionId
// The sssync-db.md shows a UNIQUE constraint on ("PlatformConnectionId", "PlatformProductId", "PlatformVariantId")
// which is perfect for this lookup. 