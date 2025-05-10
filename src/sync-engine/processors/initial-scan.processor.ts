import { Processor, WorkerHost } from '@nestjs/bullmq';
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
import { ProductVariant } from '../../canonical-data/entities/product-variant.entity';

@Processor(INITIAL_SCAN_QUEUE)
export class InitialScanProcessor extends WorkerHost {
    private readonly logger = new Logger(InitialScanProcessor.name);

    constructor(
        private readonly connectionService: PlatformConnectionsService,
        private readonly mappingService: MappingService,
        private readonly adapterRegistry: PlatformAdapterRegistry,
        private readonly productsService: ProductsService,
        private readonly inventoryService: InventoryService,
    ) {
        super();
    }

    async process(job: Job<JobData, any, string>): Promise<any> {
        const { connectionId, userId, platformType } = job.data;
        this.logger.log(`Processing initial scan job ${job.id} for connection ${connectionId} (${platformType})...`);

        try {
            const connection = await this.connectionService.getConnectionById(connectionId, userId);
            if (!connection || connection.Status !== 'scanning') {
                 this.logger.warn(`Job ${job.id}: Connection ${connectionId} not found or not in 'scanning' state. Skipping.`);
                 return { status: 'skipped', reason: 'Connection not found or invalid state' };
            }

            const adapter = this.adapterRegistry.getAdapter(platformType);
            const apiClient = adapter.getApiClient(connection);
            const mapper = adapter.getMapper();

            // 1. Fetch Data
            this.logger.log(`Job ${job.id}: Fetching data from ${platformType}...`);
            const platformData: { products: ShopifyProductNode[], locations: any[] } = await apiClient.fetchAllRelevantData(connection);
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
                const { Id: tempId, ...productToSave } = tempProduct; // Separate tempId
                const savedProduct = await this.productsService.saveProduct(productToSave as Omit<CanonicalProduct, 'Id'>);
                if (tempId) savedProductsMap.set(tempId, savedProduct.Id!); // Store mapping from tempId to actual Id
                finalCanonicalProducts.push(savedProduct);
            }
            this.logger.log(`Job ${job.id}: Saved ${finalCanonicalProducts.length} products.`);

            // 4. Update ProductId in Canonical Variants and Save them
            this.logger.log(`Job ${job.id}: Updating ProductIds and saving ${mappedVariants.length} canonical variants...`);
            const variantsToSave: Array<Omit<CanonicalProductVariant, 'Id'>> = [];
            const savedVariantsMap = new Map<string, string>(); // Map tempVariantId from mapper to actual DB Id
            
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
            const updatedPlatformSpecificData = { ...currentPlatformSpecificData, mappingSuggestions: suggestions, scanSummary }; // Also include scanSummary here
            await this.connectionService.updateConnectionData(connectionId, userId, { PlatformSpecificData: updatedPlatformSpecificData });
            this.logger.log(`Job ${job.id}: Mapping suggestions and scan summary stored for connection ${connectionId}`);

            // Update Connection Status
            await this.connectionService.updateConnectionStatus(connectionId, userId, 'needs_review');
            this.logger.log(`Job ${job.id}: Scan complete. Connection ${connectionId} status updated to 'needs_review'.`);

             return { status: 'completed', summary: scanSummary, suggestionCount: suggestions.length };

        } catch (error) {
            this.logger.error(`Job ${job.id}: Failed during initial scan for connection ${connectionId}: ${error.message}`, error.stack);
             await this.connectionService.updateConnectionStatus(connectionId, userId, 'error').catch(e => this.logger.error(`Failed to update status to error: ${e.message}`));
            throw error; 
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