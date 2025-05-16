// import { Processor, WorkerHost } from '@nestjs/bullmq'; // Comment out Processor
import { WorkerHost } from '@nestjs/bullmq'; // Keep WorkerHost if methods are overridden
import { Job } from 'bullmq';
import { Logger, InternalServerErrorException } from '@nestjs/common';
import { INITIAL_SCAN_QUEUE } from '../sync-engine.constants';
import { PlatformConnectionsService, PlatformConnection } from '../../platform-connections/platform-connections.service';
import { MappingService, MappingSuggestion, PlatformProductData } from '../mapping.service';
import { PlatformAdapterRegistry } from '../../platform-adapters/adapter.registry';
import { InitialScanResult, JobData } from '../initial-sync.service';
import { ProductsService } from '../../canonical-data/products.service';
import { InventoryService, CanonicalInventoryLevel } from '../../canonical-data/inventory.service';
import { ShopifyProductNode, ShopifyVariantNode } from '../../platform-adapters/shopify/shopify-api-client.service';
import { CanonicalProduct, CanonicalProductVariant } from '../../platform-adapters/shopify/shopify.mapper';
import { ProductVariant } from '../../common/types/supabase.types';

// @Processor(INITIAL_SCAN_QUEUE) // <<< Temporarily comment out to stop direct BullMQ polling
export class InitialScanProcessor extends WorkerHost {
    private readonly logger = new Logger(InitialScanProcessor.name);
    private lastActiveJobTimestamp: number = 0;
    private readonly IDLE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
    private isIdle: boolean = false;

    constructor(
        private readonly connectionService: PlatformConnectionsService,
        private readonly mappingService: MappingService,
        private readonly adapterRegistry: PlatformAdapterRegistry,
        private readonly productsService: ProductsService,
        private readonly inventoryService: InventoryService,
    ) {
        super();
        // Log when processor starts
        this.logger.log('InitialScanProcessor initialized');
    }

    async process(job: Job<JobData, any, string>): Promise<any> {
        const { connectionId, userId, platformType } = job.data;
        this.lastActiveJobTimestamp = Date.now();
        this.isIdle = false;
        
        this.logger.log(`[ACTIVE JOB] Processing job ${job.id} for connection ${connectionId} (${platformType})`);

        try {
            // Get the connection object first
            const connection = await this.connectionService.getConnectionById(connectionId, userId);
            if (!connection) {
                throw new Error(`Connection ${connectionId} not found for user ${userId}`);
            }

            // Update connection status to scanning
            await this.connectionService.updateConnectionStatus(connectionId, userId, 'scanning');
            
            // Get the appropriate adapter
            const adapter = this.adapterRegistry.getAdapter(platformType);
            if (!adapter) {
                throw new Error(`No adapter found for platform type: ${platformType}`);
            }

            // Get the API client and fetch data
            const apiClient = adapter.getApiClient({ Id: connectionId, UserId: userId, PlatformType: platformType });
            this.logger.log(`[ACTIVE JOB] Fetching platform data for connection ${connectionId}`);
            
            const platformData = await apiClient.fetchAllRelevantData({ Id: connectionId, UserId: userId, PlatformType: platformType });
            
            // Log analysis results
            const analysis = this.analyzePlatformData(platformData);
            this.logger.log(`[ACTIVE JOB] Analysis complete for connection ${connectionId}: ${JSON.stringify(analysis)}`);

            // Map and save the data
            const mapper = adapter.getMapper();
            const { canonicalProducts, canonicalVariants, canonicalInventoryLevels } = 
                mapper.mapShopifyDataToCanonical(platformData, userId, connectionId);

            // Save to database
            this.logger.log(`[ACTIVE JOB] Saving ${canonicalProducts.length} products, ${canonicalVariants.length} variants for connection ${connectionId}`);

            // 1. Fetch Data
            this.logger.log(`Job ${job.id}: Fetching data from ${platformType}...`);
            if (!platformData || !platformData.products) {
                throw new InternalServerErrorException('Failed to fetch products from platform API.');
            }

            // 2. Map data to canonical structures
            this.logger.log(`Job ${job.id}: Mapping fetched data to canonical structures...`);
            const { 
                canonicalProducts: mappedProducts, 
                canonicalVariants: mappedVariants, 
                canonicalInventoryLevels: mappedInventoryLevels 
            } = mapper.mapShopifyDataToCanonical(platformData, userId, connectionId);
            
            // 3. Save Canonical Products and get their DB IDs
            this.logger.log(`Job ${job.id}: Saving ${mappedProducts.length} canonical products...`);
            const savedProductsMap = new Map<string, string>(); // Map tempId to actual DB Id
            const finalCanonicalProducts: CanonicalProduct[] = [];

            for (const tempProduct of mappedProducts) {
                const { Id: tempId, UserId, IsArchived, ImageUrls } = tempProduct; // Destructure known direct fields
                // Create an object specifically for saving, matching expected columns for the Products table
                const productTableData = { 
                    UserId,
                    IsArchived 
                    // Add any other direct column fields from CanonicalProduct that should be saved to Products table
                };
                const savedProduct = await this.productsService.saveProduct(productTableData);
                if (tempId) savedProductsMap.set(tempId, savedProduct.Id!); // Store mapping from tempId to actual Id
                // We keep the full mappedProduct (including ImageUrls) for later use if needed, 
                // but only save the direct table data.
                // To avoid confusion, ensure finalCanonicalProducts stores the saved DB representation if its structure differs significantly
                // For now, assuming savedProduct is compatible with CanonicalProduct for what we need later (Id).
                finalCanonicalProducts.push({ ...tempProduct, Id: savedProduct.Id! }); // Store original mapped data with new DB Id
            }
            this.logger.log(`Job ${job.id}: Saved ${finalCanonicalProducts.length} products.`);

            // 4. Update ProductId in Canonical Variants and Save them
            this.logger.log(`Job ${job.id}: Updating ProductIds and saving ${mappedVariants.length} canonical variants...`);
            const variantsToSave: Array<Omit<CanonicalProductVariant, 'Id'>> = [];
            const savedVariantsMap = new Map<string, string>(); // Map tempVariantId from mapper to actual DB Id
            const variantToTempProductMap = new Map<string, CanonicalProduct>(); // Map tempVariantId to its original mapped Product (for images)

            for (const tempVariant of mappedVariants) {
                const { Id: tempVariantId, ProductId: tempProductId, ...variantData } = tempVariant;

                if (variantData.Sku === null || variantData.Sku === undefined) {
                    this.logger.warn(`Job ${job.id}: Skipping variant with tempId ${tempVariantId} because its Sku is null.`);
                    continue; 
                }

                const actualProductId = savedProductsMap.get(tempProductId!);
                if (!actualProductId) {
                    this.logger.warn(`Job ${job.id}: Could not find actual DB ProductId for temp ProductId: ${tempProductId} on variant SKU: ${variantData.Sku}. Skipping variant.`);
                    continue;
                }
                variantsToSave.push({ ...variantData, Sku: variantData.Sku, ProductId: actualProductId, UserId: userId });
                // Store the original mapped product for this variant for later image association
                const originalProduct = mappedProducts.find(p => p.Id === tempProductId);
                if (originalProduct && tempVariantId) {
                    variantToTempProductMap.set(tempVariantId, originalProduct);
                }
            }

            const finalCanonicalVariants = await this.productsService.saveVariants(
                variantsToSave as Array<Omit<ProductVariant, 'Id' | 'CreatedAt' | 'UpdatedAt'>>
            );
            mappedVariants.forEach((tempVar, index) => {
                if (tempVar.Id && finalCanonicalVariants[index]) {
                     savedVariantsMap.set(tempVar.Id, finalCanonicalVariants[index].Id!);
                }
            });
            this.logger.log(`Job ${job.id}: Saved ${finalCanonicalVariants.length} variants.`);

            // 4.5 Save Product Images (associating product-level images with each variant)
            this.logger.log(`Job ${job.id}: Saving product images...`);
            for (const tempVariant of mappedVariants) {
                if (!tempVariant.Id) continue; // Should have tempId if processed
                const actualVariantId = savedVariantsMap.get(tempVariant.Id);
                const originalProductForVariant = variantToTempProductMap.get(tempVariant.Id);

                if (actualVariantId && originalProductForVariant?.ImageUrls && originalProductForVariant.ImageUrls.length > 0) {
                    try {
                        await this.productsService.saveVariantImages(actualVariantId, originalProductForVariant.ImageUrls);
                        this.logger.debug(`Job ${job.id}: Associated product images with variant ${actualVariantId}`);
                    } catch (imgError) {
                        this.logger.error(`Job ${job.id}: Failed to save images for variant ${actualVariantId}: ${imgError.message}`, imgError.stack);
                        // Continue processing other variants even if image saving fails for one
                    }
                }
            }
            this.logger.log(`Job ${job.id}: Finished processing product images.`);

            // 5. Update ProductVariantId in Canonical Inventory Levels and Save them
            this.logger.log(`Job ${job.id}: Updating ProductVariantIds and saving ${mappedInventoryLevels.length} inventory levels...`);
            const inventoryLevelsToSave: CanonicalInventoryLevel[] = [];
            for (const tempInventoryLevel of mappedInventoryLevels) {
                const { ProductVariantId: tempVariantId, ...levelData } = tempInventoryLevel;
                const actualVariantId = savedVariantsMap.get(tempVariantId!);
                if (!actualVariantId) {
                    this.logger.warn(`Job ${job.id}: Could not find actual DB VariantId for temp VariantId: ${tempVariantId}. Skipping inventory level.`);
                    continue;
                }
                inventoryLevelsToSave.push({ ...levelData, ProductVariantId: actualVariantId, PlatformConnectionId: connectionId } as CanonicalInventoryLevel);
            }
            await this.inventoryService.saveBulkInventoryLevels(inventoryLevelsToSave);
            this.logger.log(`Job ${job.id}: Saved ${inventoryLevelsToSave.length} inventory levels.`);

            // --- Original Post-Fetch Logic (Summary & Suggestions) ---
            this.logger.log(`Job ${job.id}: Analyzing fetched data for summary...`);
            const scanSummary = this.analyzePlatformData(platformData); // Use original platformData for summary
            await this.connectionService.saveScanSummary(connectionId, userId, scanSummary);
            this.logger.log(`Job ${job.id}: Scan summary saved: ${JSON.stringify(scanSummary)}`);

             this.logger.log(`Job ${job.id}: Generating mapping suggestions...`);
            const variantsForSuggestions: PlatformProductData[] = platformData.products.flatMap(p => {
                const firstImageUrl = p.media?.edges?.[0]?.node?.preview?.image?.url;
                return p.variants.edges.map(vEdge => {
                    const variantNode = vEdge.node;
                    return {
                        id: variantNode.id, 
                        sku: variantNode.sku,
                        barcode: variantNode.barcode,
                        title: p.title,
                        price: variantNode.price, 
                        imageUrl: firstImageUrl || null,
                    };
                })
            });
            const suggestions = await this.mappingService.generateSuggestions(
               { products: [], variants: variantsForSuggestions }, 
               userId, 
               platformType
            );
             this.logger.log(`Job ${job.id}: Generated ${suggestions.length} suggestions. Storing in PlatformSpecificData...`);
            const currentPlatformSpecificData = connection.PlatformSpecificData || {};
            const updatedPlatformSpecificData = { 
                ...currentPlatformSpecificData, 
                mappingSuggestions: suggestions, 
                scanSummary 
            };
            await this.connectionService.updateConnectionData(connectionId, userId, { 
                PlatformSpecificData: updatedPlatformSpecificData 
            });
            this.logger.log(`Job ${job.id}: Mapping suggestions and scan summary stored for connection ${connectionId}`);

            // Update Connection Status
            await this.connectionService.updateConnectionStatus(connectionId, userId, 'needs_review');
            this.logger.log(`Job ${job.id}: Scan complete. Connection ${connectionId} status updated to 'needs_review'.`);

             this.logger.log(`[ACTIVE JOB] Job ${job.id} completed successfully for connection ${connectionId}`);
            return analysis;

        } catch (error) {
            this.logger.error(`[ACTIVE JOB] Job ${job.id} failed for connection ${connectionId}: ${error.message}`, error.stack);
            await this.connectionService.updateConnectionStatus(connectionId, userId, 'error').catch(e => 
                this.logger.error(`Failed to update status to error: ${e.message}`)
            );
            throw error; 
        }
    }

    // Replace the event handling methods with the correct ones from WorkerHost
    async handleCompleted(job: Job<JobData, any, string>): Promise<void> {
        this.logger.log(`[JOB COMPLETED] Job ${job.id} completed for connection ${job.data.connectionId}`);
        await this.checkIdleState();
    }

    async handleFailed(job: Job<JobData, any, string>, error: Error): Promise<void> {
        this.logger.error(`[JOB FAILED] Job ${job.id} failed for connection ${job.data.connectionId}: ${error.message}`);
        await this.checkIdleState();
    }

    async handleStalled(job: Job<JobData, any, string>): Promise<void> {
        this.logger.warn(`[JOB STALLED] Job ${job.id} stalled for connection ${job.data.connectionId}`);
        await this.checkIdleState();
    }

    // Custom method to check and update idle state
    private async checkIdleState(): Promise<void> {
        const now = Date.now();
        const timeSinceLastActive = now - this.lastActiveJobTimestamp;
        
        if (timeSinceLastActive > this.IDLE_THRESHOLD && !this.isIdle) {
            this.isIdle = true;
            this.logger.debug('[IDLE] No active jobs for 5+ minutes, system is idle');
        } else if (timeSinceLastActive <= this.IDLE_THRESHOLD && this.isIdle) {
            this.isIdle = false;
            this.logger.debug('[ACTIVE] System is active again');
        }
    }

    // New public method for testing purposes
    async triggerScanProcessingForConnection(connectionId: string, userId: string, platformType: string): Promise<any> {
        this.logger.log(`Manually triggering scan processing for connection ${connectionId} (${platformType}) by user ${userId}`);
        // We simulate the job object partially, as the full Job object is complex and tied to BullMQ internals.
        // The process method mainly uses job.data and job.id for logging.
        const pseudoJob = {
            id: `manual-scan-${Date.now()}`,
            data: { connectionId, userId, platformType }
        };
        return this.process(pseudoJob as Job<JobData, any, string>); // Cast to Job, acknowledge it's a partial mock
    }

     private analyzePlatformData(platformData: { products: ShopifyProductNode[], locations: any[] }): InitialScanResult {
         const productCount = platformData.products?.length || 0;
         const variantCount = platformData.products?.reduce((acc, product) => {
             return acc + (product.variants?.edges?.length || 0);
         }, 0) || 0;
         const locationCount = platformData.locations?.length || 0;
         return { countProducts: productCount, countVariants: variantCount, countLocations: locationCount };
     }
} 