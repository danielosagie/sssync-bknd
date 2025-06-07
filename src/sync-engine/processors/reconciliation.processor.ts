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
// Use a more generic type for platformInventoryLevels initially, or import a specific one if available and consistently returned
// For now, let's stick to the generic Array type defined inline later, removing this specific import if not strictly necessary
// import { ShopifyInventoryLevelNode } from '../../platform-adapters/shopify/shopify-api-client.service'; 

// Slow down reconciliation: 1 job every 2 minutes
@Processor(RECONCILIATION_QUEUE, {
    concurrency: 1,
    limiter: {
        max: 1,
        duration: 1000 * 60 * 2, // 2 minutes
    },
})
export class ReconciliationProcessor extends WorkerHost {
    private readonly logger = new Logger(ReconciliationProcessor.name);

    constructor(
        private readonly connectionService: PlatformConnectionsService,
        private readonly adapterRegistry: PlatformAdapterRegistry,
        private readonly productsService: ProductsService, 
        private readonly inventoryService: InventoryService, 
        private readonly mappingService: PlatformProductMappingsService, 
        private readonly activityLogService: ActivityLogService,
    ) {
        super();
        this.logger.log('ReconciliationProcessor initialized');
    }

    async process(job: Job<ReconciliationJobData, any, string>): Promise<any> {
        const { connectionId, userId, platformType } = job.data;
        this.logger.log(`Starting reconciliation for connection ${connectionId}, user ${userId} - Job ID: ${job.id}`);
        await this.activityLogService.logActivity(
            userId,
            'PlatformConnection',
            connectionId,
            'RECONCILIATION_JOB_STARTED',
            'Info',
            `Reconciliation job ${job.id} started for connection ${connectionId}.`
        );

        let connection: PlatformConnection | null = null; 
        let platformInventoryLevels: Array<{ variantId: string; locationId: string; quantity: number; [key: string]: any }> = [];

        try {
            connection = await this.connectionService.getConnectionById(connectionId, userId);
            if (!connection) {
                throw new Error(`Connection ${connectionId} not found for user ${userId}. Cannot proceed with reconciliation.`);
            }
            if (!connection.IsEnabled) {
                this.logger.log(`[RECONCILIATION JOB ${job.id}] Connection ${connectionId} is disabled. Skipping reconciliation.`);
                await this.activityLogService.logActivity(
                    userId,
                    'PlatformConnection',
                    connectionId,
                    'RECONCILIATION_JOB_SKIPPED',
                    'Warning',
                    `Reconciliation skipped: Connection ${connectionId} not found or disabled.`
                );
                return { status: 'skipped', reason: 'Connection disabled' };
            }

            await this.connectionService.updateConnectionData(connectionId, userId, { LastSyncAttemptAt: new Date().toISOString() });

            const adapter = this.adapterRegistry.getAdapter(platformType);
            const apiClient = adapter.getApiClient(connection); 
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
                
                const newPlatformProductIds = newOnPlatform.map(p => p.id);
                const newFullProductDetails = await apiClient.fetchProductsByIds(connection, newPlatformProductIds);

                for (const platformProduct of newFullProductDetails) { 
                    try {
                        let fetchedPlatformLocations = []; 
                        if (typeof apiClient.getAllLocations === 'function') { 
                            fetchedPlatformLocations = await apiClient.getAllLocations(connection);
                        } else {
                            this.logger.warn(`[RECONCILIATION JOB ${job.id}] apiClient for ${platformType} does not have getAllLocations. Location data might be missing for mapper.`);
                        }

                        const { canonicalProducts, canonicalVariants, canonicalInventoryLevels: newProductInventoryLevels } = // Renamed to avoid clash
                            mapper.mapShopifyDataToCanonical({ products: [platformProduct], locations: fetchedPlatformLocations }, userId, connectionId);

                        if (canonicalProducts.length > 0 && canonicalVariants.length > 0) {
                            const cp = canonicalProducts[0];
                            const savedProduct = await this.productsService.saveProduct({ UserId: cp.UserId, IsArchived: cp.IsArchived });
                            
                            const variantsToSave = canonicalVariants.map(cv => ({ ...cv, ProductId: savedProduct.Id, UserId: userId }));

                            // Generate temporary SKUs for variants that are missing one before saving.
                            for (const variant of variantsToSave) {
                                if (!variant.Sku) {
                                    this.logger.warn(`[RECONCILIATION JOB ${job.id}] Variant for new product ${platformProduct.id} is missing an SKU. Generating a temporary one.`);
                                    variant.Sku = `TEMP-SKU-${platformProduct.id.split('/').pop()}-${variant.Id || Math.random().toString(36).substring(2, 9)}`;
                                }
                            }

                            const savedVariants = await this.productsService.saveVariants(variantsToSave as any[]); 

                            if (savedVariants.length > 0 && savedVariants[0].Id) {
                                await this.mappingService.createMapping({
                                    PlatformConnectionId: connectionId,
                                    ProductVariantId: savedVariants[0].Id, 
                                    PlatformProductId: platformProduct.id,
                                    PlatformVariantId: platformProduct.variants?.edges?.[0]?.node?.id, 
                                    PlatformSku: platformProduct.variants?.edges?.[0]?.node?.sku,
                                });

                                if (cp.ImageUrls && cp.ImageUrls.length > 0) {
                                    await this.productsService.saveVariantImages(savedVariants[0].Id, cp.ImageUrls);
                                }

                                const invToSave = newProductInventoryLevels // Use renamed variable
                                    .filter(inv => inv.ProductVariantId === canonicalVariants[0].Id) 
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
                await this.activityLogService.logActivity(userId, 'ProductVariant', mapping.ProductVariantId, 'RECONCILE_MISSING_PRODUCT', 'Warning', 
                    `Product (Platform ID: ${mapping.PlatformProductId}) previously mapped is no longer found on ${platformType}. Review needed.`, connectionId, platformType);
            }

            // --- Inventory Reconciliation for ALL MAPPED products ---
            this.logger.log(`[RECONCILIATION JOB ${job.id}] Starting inventory reconciliation for mapped products on ${platformType}...`);
            const activeMappings = await this.mappingService.getMappingsByConnectionId(connectionId, true); 
            const platformVariantIdsToFetchInventory = activeMappings.map(m => m.PlatformVariantId).filter(Boolean) as string[];

            if (platformVariantIdsToFetchInventory.length > 0) {
                this.logger.log(`[RECONCILIATION JOB ${job.id}] Fetching inventory for ${platformVariantIdsToFetchInventory.length} mapped platform variants.`);
                platformInventoryLevels = await apiClient.getInventoryLevels(connection, platformVariantIdsToFetchInventory);
                
                for (const pInv of platformInventoryLevels) {
                    const mapping = activeMappings.find(m => m.PlatformVariantId === pInv.variantId); 
                    if (mapping && mapping.ProductVariantId) {
                        try {
                            await this.inventoryService.updateLevel({
                                ProductVariantId: mapping.ProductVariantId,
                                PlatformConnectionId: connectionId,
                                PlatformLocationId: pInv.locationId,
                                Quantity: pInv.quantity,
                                LastPlatformUpdateAt: new Date().toISOString() 
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
            await this.activityLogService.logActivity(
                userId,
                'PlatformConnection',
                connectionId,
                'RECONCILIATION_JOB_SUCCESS',
                'Success',
                `Reconciliation job ${job.id} completed for connection ${connectionId}. New: ${newOnPlatform.length}, Updated: ${platformInventoryLevels.length}, Errors: ${missingOnPlatform.length}.`,
                connectionId,
                platformType,
                { newProducts: newOnPlatform.length, updatedProducts: platformInventoryLevels.length, missingProducts: missingOnPlatform.length }
            );
            return { status: 'completed', newProducts: newOnPlatform.length, missingProducts: missingOnPlatform.length };

        } catch (error) {
            this.logger.error(`[RECONCILIATION JOB ${job.id}] FAILED for connection ${connectionId}: ${error.message}`, error.stack);
            if (connection) {
                await this.connectionService.updateConnectionData(connectionId, userId, { Status: 'error' }).catch(e => this.logger.error(`Failed to set connection status to error: ${e.message}`));
            }
            await this.activityLogService.logActivity(
                userId,
                'PlatformConnection',
                connectionId,
                'RECONCILIATION_JOB_FAILED',
                'Error',
                `Reconciliation job ${job.id} failed for connection ${connectionId}: ${error.message}`,
                connectionId,
                connection ? connection.PlatformType : null, 
                { error: error.message, stack: error.stack?.substring(0, 500) }
            );
            throw error; 
        }
    }
} 