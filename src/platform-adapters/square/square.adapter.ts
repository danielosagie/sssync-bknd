import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { SquareApiClientService, SquareCatalogItem, SquareCatalogItemVariation, SquareInventoryCount, SquareCatalogObject, SquareBatchUpsertRequest, SquareBatchChangeInventoryRequest } from './square-api-client.service';
import { SquareMapper } from './square.mapper';
import { PlatformConnection } from '../../platform-connections/platform-connections.service';
import { BaseAdapter, BaseSyncLogic } from '../base-adapter.interface';
import { ProductsService } from '../../canonical-data/products.service';
import { InventoryService, CanonicalInventoryLevel } from '../../canonical-data/inventory.service';
import { PlatformProductMappingsService, PlatformProductMapping } from '../../platform-product-mappings/platform-product-mappings.service';
import { Product, ProductVariant as SupabaseProductVariant } from '../../common/types/supabase.types';
import { randomUUID } from 'crypto';
import { CanonicalProduct, CanonicalProductVariant } from '../shopify/shopify.mapper';
import { SquareInventoryChange } from './square-api-client.service';

@Injectable()
export class SquareAdapter implements BaseAdapter {
    private readonly logger = new Logger(SquareAdapter.name);

    constructor(
        private readonly squareApiClient: SquareApiClientService,
        private readonly squareMapper: SquareMapper,
        private readonly productsService: ProductsService,
        private readonly inventoryService: InventoryService,
        private readonly mappingsService: PlatformProductMappingsService,
    ) {}

    getApiClient(connection: PlatformConnection): SquareApiClientService {
        // Initialize client if it has a stateful initialization per connection
        // this.squareApiClient.initialize(connection); // Assuming initialize is idempotent or handles state
        return this.squareApiClient;
    }

    getMapper(): SquareMapper {
        return this.squareMapper;
    }

    getSyncLogic(): BaseSyncLogic {
        return {
            shouldDelist: (canonicalQuantity: number) => canonicalQuantity <= 0,
        };
    }

    async syncFromPlatform(connection: PlatformConnection, userId: string): Promise<void> {
        this.logger.log(`Starting Square sync for connection ${connection.Id}, user ${userId}`);
        const apiClient = this.getApiClient(connection);
        await apiClient.initialize(connection); // Ensure client is initialized for this connection

        try {
            const squareData = await apiClient.fetchAllRelevantData(connection);
            if (!squareData || squareData.items.length === 0) {
                this.logger.log('No items fetched from Square.');
                return;
            }

            const { 
                canonicalProducts, 
                canonicalVariants, 
                canonicalInventoryLevels 
            } = this.squareMapper.mapSquareDataToCanonical(squareData, userId, connection.Id);

            const allInventoryToSave: CanonicalInventoryLevel[] = [];

            for (const cProduct of canonicalProducts) {
                let savedSupabaseProduct: Product | null = null;
                // cProduct.Id is like `sq-prod-${item.id}`
                const platformProductId = cProduct.Id!.replace('sq-prod-', '');

                const existingProductMapping = await this.mappingsService.getMappingByPlatformId(connection.Id, platformProductId);
                
                if (existingProductMapping && existingProductMapping.ProductVariantId) {
                    const associatedVariant = await this.productsService.getVariantById(existingProductMapping.ProductVariantId);
                    if (associatedVariant) {
                       savedSupabaseProduct = await this.productsService.getProductById(associatedVariant.ProductId);
                    }
                }

                if (!savedSupabaseProduct) {
                    const productToSave: Omit<Product, 'Id' | 'CreatedAt' | 'UpdatedAt'> = {
                        UserId: cProduct.UserId,
                        IsArchived: cProduct.IsArchived,
                        // Title and Description are not on the Products table directly, they live with Variants or CanonicalProduct
                    };
                    savedSupabaseProduct = await this.productsService.saveProduct(productToSave);
                }

                if (!savedSupabaseProduct) {
                    this.logger.error(`Failed to save or find Supabase product for Square product ID ${platformProductId}. Skipping variants.`);
                    continue;
                }

                const variantsToSavePrepared = canonicalVariants
                    .filter(cv => cv.ProductId === cProduct.Id) // cProduct.Id is the temporary sq-prod-...
                    .map(cv => {
                        if (cv.Sku === null || cv.Sku === undefined || cv.Sku.trim() === '') {
                            this.logger.warn(`Canonical variant for product ${cProduct.Title} has a null or empty SKU. Original Square Variant ID: ${cv.Id?.replace('sq-var-', '')}. Skipping this variant.`);
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
                            Options: cv.Options, // Assuming this is JSONB compatible
                            RequiresShipping: cv.RequiresShipping !== undefined ? cv.RequiresShipping : true, 
                            IsTaxable: cv.IsTaxable !== undefined ? cv.IsTaxable : true,      
                            TaxCode: cv.TaxCode,
                            ImageId: cv.ImageId, // Assuming this can be null
                        };
                    })
                    .filter(Boolean) as Array<Omit<SupabaseProductVariant, 'Id' | 'CreatedAt' | 'UpdatedAt'>>;

                if (variantsToSavePrepared.length > 0) {
                    const savedSupabaseVariants = await this.productsService.saveVariants(variantsToSavePrepared);
                    const relevantOriginalCanonicalVariants = canonicalVariants.filter(cv => cv.ProductId === cProduct.Id && cv.Sku && cv.Sku.trim() !== '');

                    for (const originalCv of relevantOriginalCanonicalVariants) {
                        const savedSupabaseVariant = savedSupabaseVariants.find(sv => sv.Sku === originalCv.Sku && sv.ProductId === savedSupabaseProduct!.Id);
                        if (!savedSupabaseVariant) {
                            this.logger.warn(`Could not find saved Supabase variant for canonical variant SKU ${originalCv.Sku} of product ${cProduct.Title}`);
                            continue;
                        }

                        const platformVariantId = originalCv.Id!.replace('sq-var-', '');

                        let existingVariantMapping = await this.mappingsService.getMappingByPlatformIdentifiers(connection.Id, platformProductId, platformVariantId);

                        const mappingData: Omit<PlatformProductMapping, 'Id' | 'CreatedAt' | 'UpdatedAt'> = {
                            PlatformConnectionId: connection.Id,
                            ProductVariantId: savedSupabaseVariant.Id,
                            PlatformProductId: platformProductId, 
                            PlatformVariantId: platformVariantId,
                            PlatformSku: originalCv.Sku,
                            PlatformSpecificData: originalCv.PlatformSpecificData,
                            LastSyncedAt: new Date().toISOString(),
                            SyncStatus: 'Success',
                            IsEnabled: !cProduct.IsArchived, // Product-level archive status applied here
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
                                LastPlatformUpdateAt: cInvLevel.LastPlatformUpdateAt || new Date(), // Provide Date or null
                            });
                        }
                    }
                }
            }

            if (allInventoryToSave.length > 0) {
                await this.inventoryService.saveBulkInventoryLevels(allInventoryToSave);
                this.logger.log(`Saved ${allInventoryToSave.length} Square inventory levels for connection ${connection.Id}`);
            }

            this.logger.log(`Square sync completed for connection ${connection.Id}`);
        } catch (error) {
            this.logger.error(`Error during Square sync for connection ${connection.Id}: ${error.message}`, error.stack);
            // Optionally, update connection status to 'error'
            // await this.connectionService.updateConnectionStatus(connection.Id, userId, 'error');
            throw new InternalServerErrorException(`Square sync failed: ${error.message}`);
        }
    }

    async createProduct(
        connection: PlatformConnection,
        canonicalProduct: CanonicalProduct, 
        canonicalVariants: CanonicalProductVariant[], 
        canonicalInventoryLevels: CanonicalInventoryLevel[] // Not directly used for creation structure, but available
    ): Promise<{ platformProductId: string; platformVariantIds: Record<string, string> }> {
        this.logger.log(`Starting Square createProduct for canonical product: ${canonicalProduct.Title} on connection ${connection.Id}`);
        const apiClient = this.getApiClient(connection);
        const mapper = this.getMapper();
        const idempotencyKey = randomUUID(); // crypto.randomUUID() if in Node.js 15.6.0+

        if (!canonicalVariants || canonicalVariants.length === 0) {
            this.logger.error('Cannot create Square product: No canonical variants provided.');
            throw new InternalServerErrorException('No variants provided for Square product creation.');
        }

        // Fetch active location IDs for this connection to set availability
        let activeLocationIds: string[] = [];
        try {
            const squareLocations = await apiClient.fetchAllRelevantData(connection); // Fetches all, including locations
            activeLocationIds = squareLocations.locations
                .filter(loc => loc.status === 'ACTIVE' && loc.id)
                .map(loc => loc.id!);
            if (activeLocationIds.length === 0) {
                this.logger.warn(`No active Square locations found for connection ${connection.Id}. Product will be created but might not be available anywhere.`);
                // Square might require at least one location or present_at_all_locations to be true.
                // If targetLocationIds is empty, mapper sets present_at_all_locations to true.
            }
        } catch (error) {
            this.logger.error(`Failed to fetch Square locations for connection ${connection.Id}: ${error.message}. Proceeding without specific location IDs.`);
            // Proceeding means present_at_all_locations will be true by default from mapper logic
        }

        const catalogObjectsToCreate = mapper.mapCanonicalToSquareCatalogObjects(
            canonicalProduct,
            canonicalVariants,
            activeLocationIds
        );

        if (catalogObjectsToCreate.length === 0) {
            this.logger.error('Mapper returned no catalog objects to create for Square.');
            throw new InternalServerErrorException('Failed to map canonical product to Square catalog objects.');
        }

        const requestBody: SquareBatchUpsertRequest = {
            idempotency_key: idempotencyKey,
            batches: [{ objects: catalogObjectsToCreate }],
        };

        try {
            const response = await apiClient.batchUpsertCatalogObjects(connection, requestBody);

            if (response.errors && response.errors.length > 0) {
                this.logger.error(`Error creating Square product (batch upsert). Idempotency Key: ${idempotencyKey}. Errors: ${JSON.stringify(response.errors)}`);
                // Try to find details about which object failed if possible
                const errorMessages = response.errors.map((err: any) => 
                    `Error Detail: ${err.detail}, Category: ${err.category}, Code: ${err.code}${err.field ? ', Field: ' + err.field : ''}${err.object_id ? ', Temp ID: ' + err.object_id : ''}`
                ).join('; ');
                throw new InternalServerErrorException(`Square product creation failed: ${errorMessages}`);
            }

            if (!response.id_mappings || response.id_mappings.length === 0) {
                this.logger.error(`Square batch upsert for ${idempotencyKey} succeeded but returned no ID mappings.`);
                throw new InternalServerErrorException('Square product creation succeeded but no ID mappings were returned.');
            }

            let platformProductId = '';
            const platformVariantIds: Record<string, string> = {}; // Map: CanonicalVariant.Id -> Square ItemVariation ID

            // Find the temporary ID used for the main product (ITEM object)
            const productTempId = catalogObjectsToCreate.find(obj => obj.type === 'ITEM')?.id;
            if (!productTempId) {
                this.logger.error('Could not find temporary ID for the main product in the mapped objects.');
                throw new InternalServerErrorException('Internal error: Main product temporary ID not found after mapping.');
            }

            const productMapping = response.id_mappings.find(m => m.client_object_id === productTempId);
            if (productMapping && productMapping.object_id) {
                platformProductId = productMapping.object_id;
            } else {
                this.logger.error(`Could not find permanent Square ID for product (temp ID: ${productTempId}) in batch response.`);
                throw new InternalServerErrorException('Failed to get permanent ID for created Square product.');
            }

            canonicalVariants.forEach((cVariant, index) => {
                const expectedVariantTempId = mapper.tempId('variant', cVariant.Id || index); // Use the same logic as mapper
                const variationMapping = response.id_mappings?.find(m => m.client_object_id === expectedVariantTempId);
                if (variationMapping && variationMapping.object_id && cVariant.Id) {
                    platformVariantIds[cVariant.Id] = variationMapping.object_id;
                } else {
                    this.logger.warn(`Could not find permanent Square ID for variant (temp ID: ${expectedVariantTempId}, canonical ID: ${cVariant.Id || 'N/A'}) or canonical variant ID missing.`);
                }
            });

            if (Object.keys(platformVariantIds).length !== canonicalVariants.length) {
                this.logger.warn(`Not all canonical variants were successfully mapped to Square variant IDs. Mapped: ${Object.keys(platformVariantIds).length}/${canonicalVariants.length}`);
            }

            this.logger.log(`Square product created successfully. Platform Product ID: ${platformProductId}, Variant IDs mapped: ${Object.keys(platformVariantIds).length}`);
            return { platformProductId, platformVariantIds };

        } catch (error) {
            this.logger.error(`Exception during Square createProduct for ${canonicalProduct.Title}: ${error.message}`, error.stack);
            if (error instanceof InternalServerErrorException) throw error;
            throw new InternalServerErrorException(`Failed to create product on Square: ${error.message}`);
        }
    }

    async updateProduct(
        connection: PlatformConnection,
        existingMapping: PlatformProductMapping, // Mapping for one of the product's variants
        canonicalProduct: CanonicalProduct,
        canonicalVariants: CanonicalProductVariant[],
        canonicalInventoryLevels: CanonicalInventoryLevel[] // Not used in this simplified update
    ): Promise<{ platformProductId: string; updatedVariantIds: string[]; createdVariantIds: string[]; deletedVariantIds: string[]; errors: string[] }> {
        this.logger.log(`Starting Square updateProduct for platform product ID (Item): ${existingMapping.PlatformProductId} on connection ${connection.Id}`);
        const apiClient = this.getApiClient(connection);
        const idempotencyKey = randomUUID();

        const results = {
            platformProductId: existingMapping.PlatformProductId!,
            updatedVariantIds: [] as string[],
            createdVariantIds: [] as string[], // Not handled in this simplified version
            deletedVariantIds: [] as string[], // Not handled in this simplified version
            errors: [] as string[],
        };

        if (!results.platformProductId) {
            const msg = 'PlatformProductId (Square Item ID) is missing in existingMapping.';
            this.logger.error(msg);
            results.errors.push(msg);
            return results;
        }

        const objectsToUpdate: SquareCatalogObject[] = [];

        // 1. Prepare update for the parent CatalogItem (Product)
        try {
            // Fetch the item to get its current version - this is crucial for updates.
            const currentSquareItem = await apiClient.fetchCatalogObject(connection, results.platformProductId);
            
            if (!currentSquareItem || typeof currentSquareItem.version !== 'number') { 
                throw new Error(`Could not fetch version for Square item ${results.platformProductId}`); 
            }
            const itemVersion = currentSquareItem.version;

            const productUpdateObject: SquareCatalogObject = {
                type: 'ITEM',
                id: results.platformProductId, // Permanent Square ID
                version: itemVersion, // This is critical for updates
                item_data: {
                    name: canonicalProduct.Title,
                    description: canonicalProduct.Description || undefined,
                    // Other fields like ecom_visibility, is_taxable etc. could be updated here if changed.
                },
            };
            objectsToUpdate.push(productUpdateObject);
        } catch (error) {
            const msg = `Error preparing update for Square ITEM ${results.platformProductId}: ${error.message}`;
            this.logger.error(msg);
            results.errors.push(msg);
        }

        // 2. Prepare updates for existing CatalogItemVariations
        for (const cVariant of canonicalVariants) {
            if (!cVariant.Id) {
                this.logger.warn(`Canonical variant for product ${canonicalProduct.Title} is missing an ID. Cannot map for update.`);
                continue;
            }

            // Find the mapping for this specific canonical variant to get its Square ID
            const variantMapping = await this.mappingsService.getMappingByVariantIdAndPlatformProductId(
                cVariant.Id,
                results.platformProductId,
                connection.Id
            );

            if (variantMapping && variantMapping.PlatformVariantId) {
                const squareVariantId = variantMapping.PlatformVariantId;
                try {
                    // Fetch current version of the SquareCatalogItemVariation.
                    const currentSquareVariation = await apiClient.fetchCatalogObject(connection, squareVariantId); 
                    if (!currentSquareVariation || typeof currentSquareVariation.version !== 'number') { 
                        throw new Error(`Could not fetch version for Square variation ${squareVariantId}`); 
                    }
                    const variantVersion = currentSquareVariation.version;

                    const priceMoney = cVariant.Price != null ? { amount: Math.round(cVariant.Price * 100), currency: 'USD' } : undefined;
                    
                    const variationUpdateObject: SquareCatalogObject = {
                        type: 'ITEM_VARIATION',
                        id: squareVariantId, // Permanent Square Variation ID
                        version: variantVersion, // Critical for updates
                        item_variation_data: {
                            name: cVariant.Title,
                            sku: cVariant.Sku || undefined,
                            price_money: priceMoney,
                            // Other updatable fields: pricing_type, track_inventory, etc.
                        },
                    };
                    objectsToUpdate.push(variationUpdateObject);
                    // We'll add to updatedVariantIds after successful API call if possible, or assume success if no error for now.
                } catch (error) {
                    const msg = `Error preparing update for Square ITEM_VARIATION ${squareVariantId} (Canonical: ${cVariant.Id}): ${error.message}`;
                    this.logger.error(msg);
                    results.errors.push(msg);
                }
            } else {
                this.logger.warn(`No mapping found for canonical variant ID ${cVariant.Id} to update on Square for item ${results.platformProductId}.`);
                // Not creating new variants in this simplified update path.
            }
        }

        if (objectsToUpdate.length === 0 && results.errors.length === 0) {
            this.logger.log('No changes detected or objects prepared for Square product update.');
            return results; // No actual updates to send
        }
        if (objectsToUpdate.length === 0 && results.errors.length > 0) {
            this.logger.warn('No objects to update for Square due to preparation errors.');
            return results; 
        }

        const requestBody: SquareBatchUpsertRequest = {
            idempotency_key: idempotencyKey,
            batches: [{ objects: objectsToUpdate }],
        };

        try {
            const response = await apiClient.batchUpsertCatalogObjects(connection, requestBody);

            if (response.errors && response.errors.length > 0) {
                const errorMessages = response.errors.map((err: any) => 
                    `Detail: ${err.detail}, Category: ${err.category}, Code: ${err.code}${err.field ? ', Field: ' + err.field : ''}${err.object_id ? ', Object ID: ' + err.object_id : ''}`
                ).join('; ');
                this.logger.error(`Error updating Square product (batch upsert). Idempotency Key: ${idempotencyKey}. Errors: ${errorMessages}`);
                results.errors.push(`Square product update failed: ${errorMessages}`);
                // TODO: Potentially parse response.objects to see which ones succeeded/failed if it's a partial success.
            } else {
                this.logger.log(`Square product update batch upsert successful for idempotency key: ${idempotencyKey}.`);
                // Assume all objects in the batch were updated if no errors reported at batch level.
                // A more robust solution would check response.objects for their new versions.
                objectsToUpdate.forEach(obj => {
                    if (obj.type === 'ITEM_VARIATION' && obj.id) {
                        results.updatedVariantIds.push(obj.id);
                    }
                });
            }
        } catch (error) {
            this.logger.error(`Exception during Square updateProduct for item ${results.platformProductId}: ${error.message}`, error.stack);
            results.errors.push(`Failed to update product on Square: ${error.message}`);
        }
        
        if (results.errors.length > 0) {
             this.logger.warn(`Square updateProduct for Item ${results.platformProductId} finished with ${results.errors.length} errors.`);
        } else {
            this.logger.log(`Square updateProduct for Item ${results.platformProductId} finished. Updated variants: ${results.updatedVariantIds.length}`);
        }
        return results;
    }

    async deleteProduct(
        connection: PlatformConnection,
        existingMapping: PlatformProductMapping, // Mapping for the product (or one of its variants)
    ): Promise<void> {
        this.logger.log(`Starting Square deleteProduct for platform product ID (Item): ${existingMapping.PlatformProductId} on connection ${connection.Id}`);
        const apiClient = this.getApiClient(connection);

        if (!existingMapping.PlatformProductId) {
            const errorMsg = `PlatformProductId (Square Item ID) is missing in existingMapping. Cannot delete. Mapping ID: ${existingMapping.Id}`;
            this.logger.error(errorMsg);
            throw new InternalServerErrorException(errorMsg);
        }

        const itemObjectIdToDelete = existingMapping.PlatformProductId;
        const objectIdsToDelete: string[] = [itemObjectIdToDelete];

        // Optional: Collect related object IDs (like ITEM_OPTION, IMAGE) if they were created as separate entities
        // and their IDs stored, for example, in PlatformSpecificData of the product mapping.
        // For this version, we rely on Square deleting associated variations and potentially options when the item is deleted.
        // If images or options are top-level objects shared elsewhere, they wouldn't be auto-deleted.

        // Example of how one might gather other related IDs if stored:
        // const platformSpecificData = existingMapping.PlatformSpecificData;
        // if (platformSpecificData?.image_object_ids && Array.isArray(platformSpecificData.image_object_ids)) {
        //     objectIdsToDelete.push(...platformSpecificData.image_object_ids);
        // }
        // if (platformSpecificData?.item_option_object_ids && Array.isArray(platformSpecificData.item_option_object_ids)) {
        //     objectIdsToDelete.push(...platformSpecificData.item_option_object_ids);
        // }
        // It's also good practice to delete item variations explicitly if they are managed as separate entities in some contexts,
        // but batch-delete on the item should cascade.

        this.logger.log(`Preparing to delete Square catalog object(s): ${objectIdsToDelete.join(', ')}`);

        try {
            const response = await apiClient.batchDeleteCatalogObjects(connection, objectIdsToDelete);

            if (response.errors && response.errors.length > 0) {
                // Check if errors are due to some objects already being deleted (e.g., 404s reported as errors in the batch)
                // A more sophisticated error handling would inspect each error.
                const errorMessages = response.errors.map((err: any) => 
                    `Detail: ${err.detail}, Category: ${err.category}, Code: ${err.code}${err.object_id ? ', Object ID: ' + err.object_id : ''}`
                ).join('; ');
                
                // If all errors are 'CATALOG_OBJECT_NOT_FOUND', consider it a success for deletion purposes.
                const allNotFoundError = response.errors.every((err:any) => err.code === 'CATALOG_OBJECT_NOT_FOUND');
                if (allNotFoundError) {
                    this.logger.warn(`Square deleteProduct: All specified objects (${objectIdsToDelete.join(', ')}) were not found. Assuming already deleted. Errors: ${errorMessages}`);
                    return; // Success, already deleted.
                }

                this.logger.error(`Error deleting Square product (batch delete). IDs: ${objectIdsToDelete.join(', ')}. Errors: ${errorMessages}`);
                throw new InternalServerErrorException(`Square product deletion failed: ${errorMessages}`);
            }

            if (!response.deleted_object_ids || response.deleted_object_ids.length === 0) {
                // This case could happen if the objects were already deleted and Square reports no errors and no deleted_object_ids.
                // Or if the request had object_ids that didn't exist to begin with.
                this.logger.warn(`Square batch delete for IDs [${objectIdsToDelete.join(', ')}] reported no errors but also no deleted_object_ids. Assuming objects were already gone or invalid.`);
                // No throw here, as the desired state (objects gone) might be true.
            } else {
                 this.logger.log(`Square product and potentially related objects deleted successfully. Deleted IDs: ${response.deleted_object_ids.join(', ')}`);
            }

        } catch (error) {
            this.logger.error(`Exception during Square deleteProduct for item ${itemObjectIdToDelete}: ${error.message}`, error.stack);
            if (error instanceof InternalServerErrorException) throw error;
            throw new InternalServerErrorException(`Failed to delete product on Square: ${error.message}`);
        }
    }

    async updateInventoryLevels(
        connection: PlatformConnection,
        inventoryUpdates: Array<{ mapping: PlatformProductMapping; level: CanonicalInventoryLevel }>
    ): Promise<{ successCount: number; failureCount: number; errors: string[] }> {
        this.logger.log(`Starting Square updateInventoryLevels for ${inventoryUpdates.length} items on connection ${connection.Id}`);
        const apiClient = this.getApiClient(connection);
        const idempotencyKey = randomUUID();
        
        let successCount = 0;
        let failureCount = 0;
        const errors: string[] = [];
        const changes: SquareInventoryChange[] = [];

        if (inventoryUpdates.length === 0) {
            this.logger.log('No inventory updates to process for Square.');
            return { successCount: 0, failureCount: 0, errors: [] };
        }

        for (const update of inventoryUpdates) {
            const { mapping, level } = update;

            if (!mapping.PlatformVariantId) {
                const errMsg = `PlatformVariantId (Square ItemVariation ID) missing for mapping with ProductVariantId ${mapping.ProductVariantId}. Skipping inventory update.`;
                this.logger.warn(errMsg);
                errors.push(errMsg);
                failureCount++; // Count as failure as we can't process it
                continue;
            }
            if (!level.PlatformLocationId) {
                const errMsg = `PlatformLocationId (Square Location ID) missing for inventory level of ProductVariantId ${mapping.ProductVariantId}. Skipping inventory update.`;
                this.logger.warn(errMsg);
                errors.push(errMsg);
                failureCount++;
                continue;
            }

            changes.push({
                type: 'PHYSICAL_COUNT',
                physical_count: {
                    catalog_object_id: mapping.PlatformVariantId,
                    state: 'IN_STOCK',
                    location_id: level.PlatformLocationId,
                    quantity: Math.round(level.Quantity).toString(), // Ensure integer string
                    occurred_at: new Date().toISOString(),
                },
            });
        }

        if (changes.length === 0) {
            this.logger.log('No valid inventory changes prepared for Square batch update.');
            // Return current failure count which might be > 0 due to skipped items
            return { successCount, failureCount, errors }; 
        }

        const requestBody: SquareBatchChangeInventoryRequest = {
            idempotency_key: idempotencyKey,
            changes: changes,
            ignore_unchanged_counts: true, // Good to set to avoid errors if inventory is already correct
        };

        try {
            const response = await apiClient.batchChangeInventory(connection, requestBody);

            if (response.errors && response.errors.length > 0) {
                const errorMessages = response.errors.map((err: any) => 
                    `Detail: ${err.detail}, Category: ${err.category}, Code: ${err.code}` +
                    `${err.catalog_object_id ? ', VarID: ' + err.catalog_object_id : ''}` +
                    `${err.location_id ? ', LocID: ' + err.location_id : ''}`
                ).join('; ');
                this.logger.error(`Error updating Square inventory (batch change). Idempotency Key: ${idempotencyKey}. Errors: ${errorMessages}`);
                // Assume all changes in this batch failed if a batch-level error occurs
                failureCount += changes.length; 
                errors.push(`Square inventory update batch failed: ${errorMessages}`);
            } else {
                // If no batch-level errors, assume all changes in *this* batch were successful.
                // Square's batchChangeInventory returns updated counts, not per-change success/failure directly in response.errors usually.
                // The absence of errors is the primary success indicator for the batch.
                successCount += changes.length;
                this.logger.log(`Square inventory update batch successful for idempotency key: ${idempotencyKey}. ${changes.length} changes processed.`);
            }
        } catch (error) {
            this.logger.error(`Exception during Square batchChangeInventory for key ${idempotencyKey}: ${error.message}`, error.stack);
            failureCount += changes.length; // Assume all changes in this batch failed due to exception
            errors.push(`Failed to update inventory on Square: ${error.message}`);
        }
        
        this.logger.log(`Square updateInventoryLevels completed. Total Success: ${successCount}, Total Failures (incl. skipped): ${failureCount}`);
        if (errors.length > 0) {
            this.logger.warn(`Errors during Square inventory update: ${JSON.stringify(errors)}`);
        }
        return { successCount, failureCount, errors };
    }

    async processWebhook(
        connection: PlatformConnection,
        payload: any,
        headers: Record<string, string>
    ): Promise<void> {
        const merchantId = connection.PlatformSpecificData?.merchantId;
        this.logger.log(`SquareAdapter: Processing webhook for merchant '${merchantId}' on connection ${connection.Id}`);
        this.logger.debug(`Webhook payload: ${JSON.stringify(payload).substring(0, 500)}...`);
        this.logger.debug(`Webhook headers: ${JSON.stringify(headers)}`);

        // Square webhooks have a `type` field indicating the event, e.g., "inventory.count.updated", "catalog.version.updated"
        // The actual data is usually under an `data.object` or similar structure.
        const eventType = payload?.type;
        this.logger.log(`Square webhook event type: ${eventType}`);

        if (eventType === 'inventory.count.updated') {
            const inventoryData = payload.data?.object?.inventory_count;
            if (inventoryData && inventoryData.catalog_object_id && inventoryData.quantity !== undefined && inventoryData.location_id) {
                const platformVariantId = inventoryData.catalog_object_id; // This is Square ItemVariation ID
                const newQuantity = Number(inventoryData.quantity);
                const platformLocationId = inventoryData.location_id;

                this.logger.log(`Processing inventory.count.updated for Square variation ${platformVariantId} at location ${platformLocationId}, new quantity: ${newQuantity}`);

                // 1. Find PlatformProductMapping by PlatformVariantId
                // We might need to also consider platformLocationId if our canonical inventory is location-aware per platform
                const mapping = await this.mappingsService.getMappingByPlatformVariantIdAndConnection(platformVariantId, connection.Id);
                if (mapping && mapping.ProductVariantId) {
                    // 2. Update canonical inventory
                    await this.inventoryService.updateLevel({
                        ProductVariantId: mapping.ProductVariantId,
                        PlatformConnectionId: connection.Id,
                        PlatformLocationId: platformLocationId, // Square provides this
                        Quantity: newQuantity,
                        LastPlatformUpdateAt: new Date().toISOString(), // Changed to toISOString()
                        // LastPlatformUpdateAt could be inventoryData.calculated_at if needed
                    });
                    this.logger.log(`Updated canonical inventory for sssync variant ${mapping.ProductVariantId} (Square Variation ${platformVariantId} at Loc ${platformLocationId}) from webhook.`);
                } else {
                    this.logger.warn(`No mapping found for Square ItemVariation ID ${platformVariantId} from inventory.count.updated webhook. Cannot update inventory.`);
                }
            }
        } else if (eventType === 'catalog.version.updated') {
            this.logger.log(`Received catalog.version.updated webhook from Square. Merchant: ${payload.merchant_id}. Affected object IDs: ${JSON.stringify(payload.data?.object_ids)}`);
            // This indicates a change to catalog items, variations, options, etc.
            // A targeted re-sync of the affected catalog objects is the safest approach.
            const affectedObjectIds: string[] = payload.data?.object_ids || [];
            const catalogObjectType: string | undefined = payload.data?.object?.type; // e.g. ITEM, ITEM_VARIATION

            // We are primarily interested in ITEM level changes triggering a full product resync.
            // If only variations change, the parent ITEM webhook might also fire, or we might get specific variation events.
            // For simplicity, if an ITEM is in affectedObjectIds, we resync it.
            for (const objectId of affectedObjectIds) {
                // Heuristic: If the webhook doesn't explicitly state object types, we might infer or try to fetch.
                // For now, let's assume we primarily care about top-level ITEMs being re-synced from this webhook.
                // A more robust solution might check the type of each objectId if the webhook payload provides it.
                // If payload.data.object.type is ITEM, then payload.data.object.id is the item ID
                // If the webhook is less specific and just gives IDs, we might need to fetch each to check its type.
                
                // Let's assume for catalog.version.updated, object_ids are mostly ITEM ids or we want to resync the parent if a variation changes.
                // This needs refinement based on exact Square webhook behavior for various catalog changes.
                this.logger.log(`Processing catalog.version.updated for object ID: ${objectId}. Attempting to sync as product.`);
                try {
                    await this.syncSingleProductFromPlatform(connection, objectId, connection.UserId); 
                    this.logger.log(`Successfully triggered single product sync for Square product/object ID ${objectId} from webhook.`);
                } catch (error) {
                    this.logger.error(`Failed to sync Square product/object ID ${objectId} from catalog.version.updated webhook: ${error.message}`, error.stack);
                }
            }

        } else if (eventType && eventType.startsWith('order.')) {
            this.logger.log(`Received Square order webhook: ${eventType}, Order ID: ${payload.data?.object?.order?.id}`);
            // TODO: Implement order processing
            this.logger.warn('Order processing from Square webhook not yet implemented.');
        }
        // Add more event type handlers

        // return Promise.resolve();
    }

    async syncSingleProductFromPlatform(connection: PlatformConnection, platformProductId: string, userId: string): Promise<void> {
        this.logger.log(`Starting Square single product sync for platform product ID: ${platformProductId}, user ${userId}`);
        const apiClient = this.getApiClient(connection);
        const mapper = this.getMapper();

        try {
            // 1. Fetch the specific catalog object (ITEM) and its related objects (ITEM_VARIATIONs)
            const fetchedSquareObject = await apiClient.fetchCatalogObject(connection, platformProductId, true);

            if (!fetchedSquareObject || !('item_data' in fetchedSquareObject) || !fetchedSquareObject.item_data) {
                this.logger.warn(`Square catalog object ${platformProductId} not found or is not an ITEM. Skipping sync.`);
                return;
            }
            const squareItem = fetchedSquareObject as SquareCatalogItem; // Type assertion after check

            // Square's fetchCatalogObject with include_related_objects=true should return variations within the item_data for an ITEM.
            // If not, we might need to explicitly fetch variations if only the item is returned.
            // For now, assume variations are included as per typical Square API behavior with that flag.

            // We also need locations and inventory counts for this item/its variations.
            // Fetching all locations for context, could be optimized if we know target locations.
            const locations = await apiClient._fetchSquareLocations(connection); 
            
            const variationIds = squareItem.item_data?.variations?.map(v => v.id) || [];
            let inventoryCounts: SquareInventoryCount[] = [];
            if (variationIds.length > 0) {
                 // Fetch inventory for only the variations of this specific item
                inventoryCounts = await apiClient._fetchSquareInventory(connection, variationIds, locations.map(l=>l.id));
            }

            const { 
                canonicalProducts, 
                canonicalVariants, 
                canonicalInventoryLevels 
            } = mapper.mapSquareDataToCanonical(
                { items: [squareItem], inventoryCounts, locations }, 
                userId, 
                connection.Id
            );

            // Logic below is similar to syncFromPlatform but scoped to this single product
            const allInventoryToSave: CanonicalInventoryLevel[] = [];

            for (const cProduct of canonicalProducts) { // Should be only one product
                if (cProduct.Id !== platformProductId) {
                    this.logger.warn(`Mapped canonical product ID ${cProduct.Id} does not match requested platform ID ${platformProductId}. Skipping.`);
                    continue;
                }

                let savedSupabaseProduct: Product | null = null;
                // Try to find existing sssync Product via a mapping of one of its variants
                const existingMappings = await this.mappingsService.getMappingsByPlatformProductId(connection.Id, platformProductId);
                if (existingMappings.length > 0 && existingMappings[0].ProductVariantId) {
                    const associatedVariant = await this.productsService.getVariantById(existingMappings[0].ProductVariantId);
                    if (associatedVariant) {
                       savedSupabaseProduct = await this.productsService.getProductById(associatedVariant.ProductId);
                    }
                }

                if (!savedSupabaseProduct) {
                    this.logger.log(`No existing sssync product found for Square product ${platformProductId}. Creating new.`);
                    const productToSave: Omit<Product, 'Id' | 'CreatedAt' | 'UpdatedAt'> = {
                        UserId: userId, // cProduct.UserId should be set by mapper
                        IsArchived: cProduct.IsArchived,
                    };
                    savedSupabaseProduct = await this.productsService.saveProduct(productToSave);
                } else {
                    this.logger.log(`Found existing sssync product ${savedSupabaseProduct.Id} for Square product ${platformProductId}. Updating.`);
                    // TODO: Update existing product fields if necessary (e.g., IsArchived)
                    // For now, we focus on variants and inventory. Product-level updates handled by full sync or specific calls.
                }

                if (!savedSupabaseProduct) {
                    this.logger.error(`Failed to save or find sssync product for Square product ${platformProductId}. Skipping variants.`);
                    continue;
                }

                const variantsToSavePrepared = canonicalVariants
                    .filter(cv => cv.ProductId === cProduct.Id) // Ensure only variants for this product
                    .map(cv => {
                        if (!cv.Sku || cv.Sku.trim() === '') {
                            this.logger.warn(`Canonical variant for product ${cProduct.Title} has a null or empty SKU. Original platform ID: ${cv.Id}. Skipping.`);
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
                            ImageId: cv.ImageId, // If image handling is part of this
                        };
                    })
                    .filter(Boolean) as Array<Omit<SupabaseProductVariant, 'Id' | 'CreatedAt' | 'UpdatedAt'>>;

                if (variantsToSavePrepared.length > 0) {
                    const savedSupabaseVariants = await this.productsService.saveVariants(variantsToSavePrepared);
                    
                    // Re-fetch canonicalVariants that were successfully prepared & SKUs to ensure we only process those
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

                        // originalCv.Id should be the Square ItemVariation ID from the mapper
                        const platformVariantIdForMapping = originalCv.Id!;

                        let existingVariantMapping = await this.mappingsService.getMappingByPlatformIdentifiers(connection.Id, platformProductId, platformVariantIdForMapping);
                        
                        const mappingData: Omit<PlatformProductMapping, 'Id' | 'CreatedAt' | 'UpdatedAt'> = {
                            PlatformConnectionId: connection.Id,
                            ProductVariantId: savedSupabaseVariant.Id,
                            PlatformProductId: platformProductId, // Parent Item ID
                            PlatformVariantId: platformVariantIdForMapping, // Variation ID
                            PlatformSku: originalCv.Sku,
                            PlatformSpecificData: originalCv.PlatformSpecificData,
                            LastSyncedAt: new Date().toISOString(),
                            SyncStatus: 'Success',
                            IsEnabled: !cProduct.IsArchived, // or !originalCv.IsArchived if variants can be archived independently
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
                                LastPlatformUpdateAt: cInvLevel.LastPlatformUpdateAt || new Date(), // Provide Date or null
                            });
                        }
                    }
                }
            }

            if (allInventoryToSave.length > 0) {
                await this.inventoryService.saveBulkInventoryLevels(allInventoryToSave);
                this.logger.log(`Saved/Updated ${allInventoryToSave.length} inventory levels for Square product ${platformProductId}`);
            }

            this.logger.log(`Square single product sync completed for platform product ID: ${platformProductId}`);

        } catch (error) {
            this.logger.error(`Error during Square single product sync for ${platformProductId}: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Square single product sync failed for ${platformProductId}: ${error.message}`);
        }
    }
}
