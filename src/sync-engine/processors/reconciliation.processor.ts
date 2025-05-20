import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, InternalServerErrorException } from '@nestjs/common';
import { RECONCILIATION_QUEUE } from '../sync-engine.constants';
import { PlatformConnectionsService, PlatformConnection } from '../../platform-connections/platform-connections.service';
import { PlatformAdapterRegistry } from '../../platform-adapters/adapter.registry';
import { ReconciliationJobData } from '../initial-sync.service'; // Job data interface
import { ProductsService } from '../../canonical-data/products.service';
import { InventoryService } from '../../canonical-data/inventory.service';
import { PlatformProductMappingsService } from '../../platform-product-mappings/platform-product-mappings.service';
import { ActivityLogService } from '../../common/activity-log.service';

@Processor(RECONCILIATION_QUEUE)
export class ReconciliationProcessor extends WorkerHost {
    private readonly logger = new Logger(ReconciliationProcessor.name);

    constructor(
        private readonly connectionService: PlatformConnectionsService,
        private readonly adapterRegistry: PlatformAdapterRegistry,
        private readonly productsService: ProductsService, // For saving new canonical products/variants
        private readonly inventoryService: InventoryService, // For updating inventory levels
        private readonly mappingService: PlatformProductMappingsService, // For checking/creating mappings
        private readonly activityLogService: ActivityLogService,
    ) {
        super();
        this.logger.log('ReconciliationProcessor initialized');
    }

    async process(job: Job<ReconciliationJobData, any, string>): Promise<any> {
        const { connectionId, userId, platformType } = job.data;
        this.logger.log(`[RECONCILIATION JOB ${job.id}] Starting for connection ${connectionId} (${platformType})`);

        let connection: PlatformConnection | null = null; // Initialize to null
        try {
            connection = await this.connectionService.getConnectionById(connectionId, userId);
            if (!connection) {
                throw new Error(`Connection ${connectionId} not found for user ${userId}. Cannot proceed with reconciliation.`);
            }
            if (!connection.IsEnabled) {
                this.logger.log(`[RECONCILIATION JOB ${job.id}] Connection ${connectionId} is disabled. Skipping reconciliation.`);
                return { status: 'skipped', reason: 'Connection disabled' };
            }

            await this.connectionService.updateConnectionData(connectionId, userId, { LastSyncAttemptAt: new Date().toISOString() });

            const adapter = this.adapterRegistry.getAdapter(platformType);
            const apiClient = adapter.getApiClient(connection); // Pass the full connection object
            const mapper = adapter.getMapper();

            // --- 1. Fetch Platform Product Identifiers/Overviews ---
            this.logger.log(`[RECONCILIATION JOB ${job.id}] Fetching product overviews from ${platformType}...`);
            const platformProductOverviews = await apiClient.fetchAllProductOverviews(connection);
            this.logger.log(`[RECONCILIATION JOB ${job.id}] Fetched ${platformProductOverviews.length} product overviews from ${platformType}.`);

            // --- 2. Fetch All Canonical Product Mappings for this Connection ---
            const canonicalMappings = await this.mappingService.getMappingsByConnectionId(connectionId);
            const mappedPlatformProductIds = new Set(canonicalMappings.map(m => m.PlatformProductId));

            // --- 3. Compare and Identify Differences ---
            const newOnPlatform = platformProductOverviews.filter(p => !mappedPlatformProductIds.has(p.id));
            const existingCanonicalPlatformIds = new Set(platformProductOverviews.map(p => p.id));
            const missingOnPlatform = canonicalMappings.filter(m => !existingCanonicalPlatformIds.has(m.PlatformProductId));

            this.logger.log(`[RECONCILIATION JOB ${job.id}] New on platform: ${newOnPlatform.length}, Missing on platform: ${missingOnPlatform.length}`);

            // --- 4. Process Differences ---

            // ** Handle New on Platform **
            if (newOnPlatform.length > 0) {
                this.logger.log(`[RECONCILIATION JOB ${job.id}] Processing ${newOnPlatform.length} new products from ${platformType}...`);
                
                // Get the IDs of the new products
                const newPlatformProductIds = newOnPlatform.map(p => p.id);
                // Fetch full details for these new products
                const newFullProductDetails = await apiClient.fetchProductsByIds(connection, newPlatformProductIds);

                for (const platformProduct of newFullProductDetails) { // Iterate over the fully detailed products
                    try {
                        // Map to canonical (using the existing Shopify mapping logic as an example)
                        // This will need to be generalized or use platform-specific mappers from the adapter
                        // Ensure platformData.locations is available or fetched if needed by the mapper.
                        // For now, assuming mapper might not strictly need locations for product/variant mapping itself,
                        // or that locations are fetched separately if critical for this step.
                        // Consider if locations are needed for mapShopifyDataToCanonical for just one product.
                        // If _fetchLocations is cheap, it could be called here, or rely on a prior full sync's locations.
                        // For reconciliation, perhaps we only need active locations for inventory levels later.
                        
                        // Fetch locations if not already available or if mapper requires them
                        // This is a placeholder, actual location data might come from a different source or be cached
                        let platformLocations = []; // Default to empty
                        if (typeof apiClient.getAllLocations === 'function') { // Check if apiClient has getAllLocations
                            platformLocations = await apiClient.getAllLocations(connection);
                        } else {
                            // Attempt to get from a broader fetch if it was done (less ideal for targeted reconciliation)
                            // const fullPlatformData = await apiClient.fetchAllRelevantData(connection); 
                            // platformLocations = fullPlatformData.locations;
                            this.logger.warn(`[RECONCILIATION JOB ${job.id}] apiClient for ${platformType} does not have getAllLocations. Location data might be missing for mapper.`);
                        }

                        const { canonicalProducts, canonicalVariants, canonicalInventoryLevels } = 
                            mapper.mapShopifyDataToCanonical({ products: [platformProduct], locations: platformLocations }, userId, connectionId);

                        if (canonicalProducts.length > 0 && canonicalVariants.length > 0) {
                            const cp = canonicalProducts[0];
                            const savedProduct = await this.productsService.saveProduct({ UserId: cp.UserId, IsArchived: cp.IsArchived });
                            
                            const variantsToSave = canonicalVariants.map(cv => ({ ...cv, ProductId: savedProduct.Id, UserId: userId }));
                            const savedVariants = await this.productsService.saveVariants(variantsToSave as any[]); // Cast for now

                            if (savedVariants.length > 0 && savedVariants[0].Id) {
                                await this.mappingService.createMapping({
                                    PlatformConnectionId: connectionId,
                                    ProductVariantId: savedVariants[0].Id, // Assuming one variant for simplicity here
                                    PlatformProductId: platformProduct.id,
                                    PlatformVariantId: platformProduct.variants?.edges?.[0]?.node?.id, // Example
                                    PlatformSku: platformProduct.variants?.edges?.[0]?.node?.sku,
                                });

                                if (cp.ImageUrls && cp.ImageUrls.length > 0) {
                                    await this.productsService.saveVariantImages(savedVariants[0].Id, cp.ImageUrls);
                                }

                                const invToSave = canonicalInventoryLevels
                                    .filter(inv => inv.ProductVariantId === canonicalVariants[0].Id) // Filter for the correct temp variant ID
                                    .map(inv => ({ ...inv, ProductVariantId: savedVariants[0].Id! }));
                                await this.inventoryService.saveBulkInventoryLevels(invToSave);

                                this.logger.log(`[RECONCILIATION JOB ${job.id}] Added new product from ${platformType}: ${savedProduct.Id} (Platform ID: ${platformProduct.id})`);
                                await this.activityLogService.logActivity(userId, 'Product', savedProduct.Id, 'RECONCILE_NEW_PRODUCT', 'Success', 
                                    `New product '${canonicalVariants[0].Title}' (SKU: ${canonicalVariants[0].Sku}) detected on ${platformType} and added.`, connectionId, platformType);
                            }
                        }
                    } catch (error) {
                        this.logger.error(`[RECONCILIATION JOB ${job.id}] Error processing new platform product ${platformProduct.id}: ${error.message}`, error.stack);
                    }
                }
            }

            // ** Handle Missing on Platform **
            for (const mapping of missingOnPlatform) {
                this.logger.log(`[RECONCILIATION JOB ${job.id}] Product mapping for Platform ID ${mapping.PlatformProductId} (Canonical Variant: ${mapping.ProductVariantId}) is missing on ${platformType}.`);
                // Action: Mark mapping inactive? Delete canonical? For now, log.
                // await this.mappingService.updateMapping(mapping.Id, { IsActive: false }); // Example
                await this.activityLogService.logActivity(userId, 'ProductVariant', mapping.ProductVariantId, 'RECONCILE_MISSING_PRODUCT', 'Warning', 
                    `Product (Platform ID: ${mapping.PlatformProductId}) previously mapped is no longer found on ${platformType}. Review needed.`, connectionId, platformType);
            }

            // ** TODO: Detailed Reconciliation for Existing/Matched Products (Phase 2) **
            // This would involve fetching full details for matched products and comparing fields like price, title, inventory.
            // For now, we'll focus on inventory reconciliation for all mapped products as a key part.

            // --- Inventory Reconciliation for ALL MAPPED products ---
            this.logger.log(`[RECONCILIATION JOB ${job.id}] Starting inventory reconciliation for mapped products on ${platformType}...`);
            const activeMappings = await this.mappingService.getMappingsByConnectionId(connectionId, true); // Get only active mappings
            const platformVariantIdsToFetchInventory = activeMappings.map(m => m.PlatformVariantId).filter(Boolean) as string[];

            if (platformVariantIdsToFetchInventory.length > 0) {
                this.logger.log(`[RECONCILIATION JOB ${job.id}] Fetching inventory for ${platformVariantIdsToFetchInventory.length} mapped platform variants.`);
                const platformInventoryLevels = await apiClient.getInventoryLevels(connection, platformVariantIdsToFetchInventory);
                // This assumes getInventoryLevels returns a structure like: 
                // Array<{ variantId: string, locationId: string, quantity: number }>
                // (Note: ShopifyApiClient.getInventoryLevels calls its internal IDs 'variantId' after converting from inventoryItemId)

                for (const pInv of platformInventoryLevels) {
                    const mapping = activeMappings.find(m => m.PlatformVariantId === pInv.variantId); // Match with pInv.variantId
                    if (mapping && mapping.ProductVariantId) {
                        try {
                            await this.inventoryService.updateLevel({
                                ProductVariantId: mapping.ProductVariantId,
                                PlatformConnectionId: connectionId,
                                PlatformLocationId: pInv.locationId,
                                Quantity: pInv.quantity,
                                LastPlatformUpdateAt: new Date().toISOString() // Mark as updated now from platform
                            });
                        } catch (error) {
                            this.logger.error(`[RECONCILIATION JOB ${job.id}] Failed to update inventory for canonical variant ${mapping.ProductVariantId}, platform location ${pInv.locationId}: ${error.message}`);
                        }
                    }
                }
                this.logger.log(`[RECONCILIATION JOB ${job.id}] Inventory reconciliation complete for ${platformInventoryLevels.length} platform inventory records processed.`);
            } else {
                this.logger.log(`[RECONCILIATION JOB ${job.id}] No active mappings with PlatformVariantId found. Skipping inventory reconciliation phase.`);
            }

            await this.connectionService.updateConnectionData(connectionId, userId, { LastSyncSuccessAt: new Date().toISOString() });
            this.logger.log(`[RECONCILIATION JOB ${job.id}] Completed successfully for connection ${connectionId}`);
            return { status: 'completed', newProducts: newOnPlatform.length, missingProducts: missingOnPlatform.length };

        } catch (error) {
            this.logger.error(`[RECONCILIATION JOB ${job.id}] FAILED for connection ${connectionId}: ${error.message}`, error.stack);
            if (connection) {
                await this.connectionService.updateConnectionData(connectionId, userId, { Status: 'error' }).catch(e => this.logger.error(`Failed to set connection status to error: ${e.message}`));
            }
            throw error; // Re-throw to let BullMQ handle job failure
        }
    }
} 