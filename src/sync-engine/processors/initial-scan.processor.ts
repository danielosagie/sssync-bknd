import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, InternalServerErrorException } from '@nestjs/common';
import { INITIAL_SCAN_QUEUE } from '../sync-engine.constants';
import { PlatformConnectionsService } from '../../platform-connections/platform-connections.service';
import { MappingService } from '../mapping.service';
import { PlatformAdapterRegistry } from '../../platform-adapters/adapter.registry';
import { InitialScanResult, JobData } from '../initial-sync.service';
import { ProductsService } from '../../canonical-data/products.service';

// @Processor(INITIAL_SCAN_QUEUE)
export class InitialScanProcessor extends WorkerHost {
    private readonly logger = new Logger(InitialScanProcessor.name);

    constructor(
        private readonly connectionService: PlatformConnectionsService,
        private readonly mappingService: MappingService,
        private readonly adapterRegistry: PlatformAdapterRegistry,
        private readonly productsService: ProductsService,
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

            // 1. Fetch Data using the actual API client
            this.logger.log(`Job ${job.id}: Fetching data from ${platformType}...`);
            const platformData = await apiClient.fetchAllRelevantData(connection);
            if (!platformData) {
                throw new InternalServerErrorException('Failed to fetch data from platform API.');
            }

            // 2. Analyze Data & Store Summary
            this.logger.log(`Job ${job.id}: Analyzing fetched data...`);
            const scanSummary = this.analyzePlatformData(platformData);
            await this.connectionService.saveScanSummary(connectionId, userId, scanSummary);
            this.logger.log(`Job ${job.id}: Scan summary saved: ${JSON.stringify(scanSummary)}`);

             // 3. Generate & Store Mapping Suggestions using MappingService
             this.logger.log(`Job ${job.id}: Generating mapping suggestions...`);
             const suggestions = await this.mappingService.generateSuggestions(platformData, userId, platformType);
             this.logger.log(`Job ${job.id}: Generated ${suggestions.length} suggestions. Storing not implemented, logging instead: ${JSON.stringify(suggestions.slice(0, 5))}...`);

            // 4. Update Connection Status
            await this.connectionService.updateConnectionStatus(connectionId, userId, 'needs_review');
            this.logger.log(`Job ${job.id}: Scan complete. Connection ${connectionId} status updated to 'needs_review'.`);

             return { status: 'completed', summary: scanSummary, suggestionCount: suggestions.length };

        } catch (error) {
            this.logger.error(`Job ${job.id}: Failed during initial scan for connection ${connectionId}: ${error.message}`, error.stack);
             await this.connectionService.updateConnectionStatus(connectionId, userId, 'error').catch(e => this.logger.error(`Failed to update status to error: ${e.message}`));
            throw error; // Re-throw for BullMQ job retries
        }
    }

     // Analyze based on the structure returned by fetchAllRelevantData
     private analyzePlatformData(platformData: { products: any[], variants: any[], locations: any[] }): InitialScanResult {
         const productCount = platformData?.products?.length || 0;
         const variantCount = platformData?.variants?.length || 0;
         const locationCount = platformData?.locations?.length || 0;
         return { countProducts: productCount, countVariants: variantCount, countLocations: locationCount };
     }
} 