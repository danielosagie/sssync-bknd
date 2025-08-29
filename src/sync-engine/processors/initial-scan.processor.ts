import { Processor, WorkerHost } from '@nestjs/bullmq'; // Keep WorkerHost if methods are overridden
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
import { ActivityLogService } from '../../common/activity-log.service';

@Processor(INITIAL_SCAN_QUEUE) // <<< Temporarily comment out to stop direct BullMQ polling
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
        private readonly activityLogService: ActivityLogService,
    ) {
        super();
        // Log when processor starts
        this.logger.log('InitialScanProcessor initialized');
    }

    async process(job: Job<JobData, any, string>): Promise<any> {
        const { connectionId, userId, platformType } = job.data as any;
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
            await job.updateProgress({ progress: 10, description: `Fetching products from ${platformType}...` });

            const platformData = await apiClient.fetchAllRelevantData({ Id: connectionId, UserId: userId, PlatformType: platformType });
            
            // Log analysis results
            const analysis = this.analyzePlatformData(platformData);
            this.logger.log(`[ACTIVE JOB] Analysis complete for connection ${connectionId}: ${JSON.stringify(analysis)}`);

            // Map and save the data
            const mapper = adapter.getMapper();
            // Platform-specific canonical mapping
            let mappedProducts: CanonicalProduct[] = [];
            let mappedVariants: CanonicalProductVariant[] = [];
            let mappedInventoryLevels: CanonicalInventoryLevel[] = [];
            if (platformType === 'shopify') {
                const res = mapper.mapShopifyDataToCanonical(platformData, userId, connectionId);
                mappedProducts = res.canonicalProducts;
                mappedVariants = res.canonicalVariants;
                mappedInventoryLevels = res.canonicalInventoryLevels;
            } else if (platformType === 'square') {
                const res = mapper.mapSquareDataToCanonical(platformData, userId, connectionId);
                mappedProducts = res.canonicalProducts;
                mappedVariants = res.canonicalVariants;
                mappedInventoryLevels = res.canonicalInventoryLevels;
            } else if (platformType === 'clover') {
                const res = mapper.mapCloverDataToCanonical(platformData, userId, connectionId);
                mappedProducts = res.canonicalProducts;
                mappedVariants = res.canonicalVariants;
                mappedInventoryLevels = res.canonicalInventoryLevels;
            } else {
                throw new InternalServerErrorException(`Mapping not implemented for platform: ${platformType}`);
            }

            await job.updateProgress({ progress: 30, description: 'Saving product data...' });
            
            // --- New Batch-Optimized Database Save Logic ---
            this.logger.log(`Job ${job.id}: Beginning optimized database save for ${mappedProducts.length} products.`);
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'Connection',
                EntityId: connectionId,
                EventType: 'SCAN_DATABASE_SAVE_START',
                Status: 'Info',
                Message: `Starting database save for ${mappedProducts.length} products.`
            });

            // 3. Batch-save Canonical Products
            this.logger.log(`Job ${job.id}: Batch saving ${mappedProducts.length} canonical products...`);
            const productInputs = mappedProducts.map(({ Id, ...rest }) => rest); // Prepare for bulk insert
            const savedProducts = await this.productsService.saveProducts(productInputs);

            // Create a map from the temporary ID (used during mapping) to the final database Product object
            const tempIdToSavedProductMap = new Map<string, CanonicalProduct>();
            savedProducts.forEach((savedProduct, index) => {
                const tempId = mappedProducts[index].Id;
                if (tempId) {
                    tempIdToSavedProductMap.set(tempId, { 
                        ...savedProduct, 
                        Title: mappedProducts[index].Title,
                        ImageUrls: mappedProducts[index].ImageUrls 
                    });
                }
            });
            this.logger.log(`Job ${job.id}: Saved ${savedProducts.length} products.`);
            await job.updateProgress({ progress: 50, description: 'Saving product variants...' });


            // 4. Prepare Canonical Variants with correct ProductIds
            this.logger.log(`Job ${job.id}: Preparing ${mappedVariants.length} variants for saving...`);
            const variantsToSave: Array<Omit<CanonicalProductVariant, 'Id'>> = [];
            const tempVariantIdToImagesMap = new Map<string, string[]>();

            for (const tempVariant of mappedVariants) {
                const { Id: tempVariantId, ProductId: tempProductId, ...variantData } = tempVariant;
                const parentProduct = tempIdToSavedProductMap.get(tempProductId!);
                
                if (!parentProduct || !parentProduct.Id) {
                    this.logger.warn(`Job ${job.id}: Could not find a saved parent product for temp ProductId: ${tempProductId}. Skipping variant SKU: ${variantData.Sku}.`);
                    continue;
                }

                variantsToSave.push({ ...variantData, ProductId: parentProduct.Id, UserId: userId });
                
                // Store image URLs associated with this variant's parent for later batch processing
                if (tempVariantId && parentProduct.ImageUrls && parentProduct.ImageUrls.length > 0) {
                    tempVariantIdToImagesMap.set(tempVariantId, parentProduct.ImageUrls);
                }
            }
            await job.updateProgress({ progress: 60, description: 'Preparing variants for database...' });

            // 5. Batch-save Canonical Variants
            this.logger.log(`Job ${job.id}: Batch saving ${variantsToSave.length} canonical variants...`);
            const savedVariants = await this.productsService.saveVariants(
                variantsToSave as Array<Omit<ProductVariant, 'Id' | 'CreatedAt' | 'UpdatedAt'>>
            );
            this.logger.log(`Job ${job.id}: Saved ${savedVariants.length} variants.`);
            await job.updateProgress({ progress: 75, description: 'Saving variant details...' });

            // Create a map from the temporary variant ID to the final saved variant ID
            const tempIdToSavedVariantIdMap = new Map<string, string>();
            savedVariants.forEach((savedVariant, index) => {
                 const tempId = mappedVariants.find(mv => mv.Sku === savedVariant.Sku && mv.ProductId === tempIdToSavedProductMap.get(savedVariant.ProductId)?.Id)?.Id;
                 if (tempId && savedVariant.Id) {
                    tempIdToSavedVariantIdMap.set(tempId, savedVariant.Id);
                 }
            });

            // 6. Batch-save Product Images
            this.logger.log(`Job ${job.id}: Preparing images for ${tempVariantIdToImagesMap.size} variants...`);
            const imagesToSave: Array<{ ProductVariantId: string; ImageUrl: string; Position: number }> = [];
            tempVariantIdToImagesMap.forEach((imageUrls, tempVariantId) => {
                const finalVariantId = tempIdToSavedVariantIdMap.get(tempVariantId);
                if (finalVariantId) {
                    imageUrls.forEach((url, index) => {
                        imagesToSave.push({ ProductVariantId: finalVariantId, ImageUrl: url, Position: index });
                    });
                }
            });

            if (imagesToSave.length > 0) {
                this.logger.log(`Job ${job.id}: Batch saving ${imagesToSave.length} product images...`);
                await this.productsService.saveBulkVariantImages(imagesToSave);
                this.logger.log(`Job ${job.id}: Saved product images.`);
            }
            await job.updateProgress({ progress: 85, description: 'Saving inventory levels...' });

            // 7. Prepare and Batch-save Inventory Levels
            this.logger.log(`Job ${job.id}: Updating ProductVariantIds and preparing ${mappedInventoryLevels.length} inventory levels...`);
            const inventoryLevelsToSave: CanonicalInventoryLevel[] = mappedInventoryLevels.map(tempLevel => {
                const finalVariantId = tempIdToSavedVariantIdMap.get(tempLevel.ProductVariantId!);
                if (!finalVariantId) return null;
                return {
                    ...tempLevel,
                    ProductVariantId: finalVariantId,
                    PlatformConnectionId: connectionId,
                } as CanonicalInventoryLevel;
            }).filter((level): level is CanonicalInventoryLevel => level !== null);

            if (inventoryLevelsToSave.length > 0) {
                await this.inventoryService.saveBulkInventoryLevels(inventoryLevelsToSave);
                this.logger.log(`Job ${job.id}: Saved ${inventoryLevelsToSave.length} inventory levels.`);
            }
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'Connection',
                EntityId: connectionId,
                EventType: 'SCAN_DATABASE_SAVE_FINISH',
                Status: 'Info',
                Message: `Database save complete. Saved ${savedProducts.length} products and ${savedVariants.length} variants.`
            });
            await job.updateProgress({ progress: 90, description: 'Generating suggestions...' });


            // --- Generate and Store Suggestions ---
            this.logger.log(`Job ${job.id}: Analyzing fetched data for summary...`);
            const scanSummary = this.analyzePlatformData(platformData);
            await this.connectionService.saveScanSummary(connectionId, userId, scanSummary);
            this.logger.log(`Job ${job.id}: Scan summary saved: ${JSON.stringify(scanSummary)}`);

             this.logger.log(`Job ${job.id}: Generating mapping suggestions...`);
            // Build platform-agnostic variant list for suggestions
            let variantsForSuggestions: PlatformProductData[] = [];
            if (platformType === 'shopify') {
                variantsForSuggestions = (platformData.products || []).flatMap((p: any) => {
                    const firstImageUrl = p.media?.edges?.[0]?.node?.preview?.image?.url;
                    return p.variants.edges.map((vEdge: any) => {
                        const variantNode = vEdge.node;
                        return {
                            id: variantNode.id,
                            sku: variantNode.sku,
                            barcode: variantNode.barcode,
                            title: p.title,
                            price: variantNode.price,
                            imageUrl: firstImageUrl || null,
                        } as PlatformProductData;
                    });
                });
            } else if (platformType === 'square') {
                variantsForSuggestions = (platformData.items || []).flatMap((item: any) => {
                    return (item.item_data?.variations || []).map((variation: any) => ({
                        id: variation.id,
                        sku: variation.item_variation_data?.sku,
                        barcode: null,
                        title: item.item_data?.name,
                        price: (variation.item_variation_data?.price_money?.amount ?? 0) / 100,
                        imageUrl: null,
                    } as PlatformProductData));
                });
            } else if (platformType === 'clover') {
                variantsForSuggestions = (platformData.items || []).map((it: any) => ({
                    id: it.id,
                    sku: it.sku || it.code,
                    barcode: it.code,
                    title: it.name,
                    price: (it.price ?? 0) / 100,
                    imageUrl: it.imageUrl || null,
                } as PlatformProductData));
            }

            // If we couldn't extract platform variants, fall back to canonical ones so UI always has something to show for review
            if (!variantsForSuggestions || variantsForSuggestions.length === 0) {
                variantsForSuggestions = mappedVariants.map(v => ({
                    id: v.Id || '',
                    sku: v.Sku || undefined,
                    barcode: v.Barcode || undefined,
                    title: v.Title || undefined,
                    price: v.Price || undefined,
                    imageUrl: (mappedProducts.find(p => p.Id === v.ProductId)?.ImageUrls?.[0]) || null,
                }));
            }
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
            await job.updateProgress({ progress: 100, description: 'Scan complete!' });

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
        this.logger.log(`[JOB COMPLETED] Job ${job.id} completed for connection ${(job.data as any).connectionId || 'no-connection'}`);
        await this.checkIdleState();
    }

    async handleFailed(job: Job<JobData, any, string>, error: Error): Promise<void> {
        this.logger.error(`[JOB FAILED] Job ${job.id} failed for connection ${(job.data as any).connectionId || 'no-connection'}: ${error.message}`);
        await this.checkIdleState();
    }

    async handleStalled(job: Job<JobData, any, string>): Promise<void> {
        this.logger.warn(`[JOB STALLED] Job ${job.id} stalled for connection ${(job.data as any).connectionId || 'no-connection'}`);
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