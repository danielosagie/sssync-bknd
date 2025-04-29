import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, InternalServerErrorException } from '@nestjs/common';
import { INITIAL_SCAN_QUEUE } from '../sync-engine.module';
import { PlatformConnectionsService } from '../../platform-connections/platform-connections.service';
import { MappingService } from '../mapping.service';
import { PlatformAdapterRegistry } from '../../platform-adapters/adapter.registry';
import { InitialScanResult, JobData } from '../initial-sync.service';

@Processor(INITIAL_SCAN_QUEUE)
export class InitialScanProcessor extends WorkerHost {
    private readonly logger = new Logger(InitialScanProcessor.name);

    constructor(
        private readonly connectionService: PlatformConnectionsService,
        private readonly mappingService: MappingService,
        private readonly adapterRegistry: PlatformAdapterRegistry,
    ) {
        super();
    }

    async process(job: Job<JobData, any, string>): Promise<any> {
        const { connectionId, userId, platformType } = job.data;
        this.logger.log(`Processing initial scan job ${job.id} for connection ${connectionId} (${platformType})...`);
        let scanSummary: InitialScanResult | null = null; // Define scanSummary variable

        try {
            const connection = await this.connectionService.getConnectionById(connectionId, userId);
            if (!connection || connection.Status !== 'scanning') {
                 this.logger.warn(`Job ${job.id}: Connection ${connectionId} not found or not in 'scanning' state. Skipping.`);
                 return { status: 'skipped', reason: 'Connection not found or invalid state' };
            }

            const adapter = this.adapterRegistry.getAdapter(platformType);
            const apiClient = adapter.getApiClient(connection); // Adapter should handle auth using connection creds

            // 1. Fetch Data
            this.logger.log(`Job ${job.id}: Fetching data from ${platformType}...`);
            // Adapter should return data in a structured way, e.g., { products: [], variants: [], inventory: [], locations: [] }
            const platformData = await apiClient.fetchAllRelevantData(); // Implement pagination etc. inside
            if (!platformData) {
                throw new InternalServerErrorException('Failed to fetch data from platform API.');
            }

            // 2. Analyze Data & Store Summary
            this.logger.log(`Job ${job.id}: Analyzing data...`);
            scanSummary = this.analyzePlatformData(platformData); // Use the variable
            // Store summary (e.g., in PlatformSpecificData)
            await this.connectionService.saveScanSummary(connectionId, userId, scanSummary);
            this.logger.log(`Job ${job.id}: Scan summary saved: ${JSON.stringify(scanSummary)}`);

             // 3. Generate & Store Mapping Suggestions
             this.logger.log(`Job ${job.id}: Generating mapping suggestions...`);
             // This might also need platformData passed in
             const suggestions = await this.mappingService.generateSuggestions(platformData, userId, platformType);
             // TODO: Store suggestions (e.g., Redis cache keyed by connectionId, TTL ~1 day?)
             // Example: await this.cacheManager.set(`mapping:suggestions:${connectionId}`, suggestions, { ttl: 86400 });

            // 4. Update Connection Status
            await this.connectionService.updateConnectionStatus(connectionId, userId, 'needs_review');
            this.logger.log(`Job ${job.id}: Scan complete. Connection ${connectionId} status updated to 'needs_review'.`);

             return { status: 'completed', summary: scanSummary, suggestionCount: suggestions.length };

        } catch (error) {
            this.logger.error(`Job ${job.id}: Failed during initial scan for connection ${connectionId}: ${error.message}`, error.stack);
             await this.connectionService.updateConnectionStatus(connectionId, userId, 'error').catch(e => this.logger.error(`Failed to update status to error: ${e.message}`));
            throw error; // Re-throw
        }
    }

     // Basic analysis, enhance as needed
     private analyzePlatformData(platformData: any): InitialScanResult {
         const productCount = platformData?.products?.length || 0;
         const variantCount = platformData?.variants?.length || 0; // Adjust if variants are nested in products
         const locationCount = platformData?.locations?.length || 0; // Fetch locations if needed
         return { countProducts: productCount, countVariants: variantCount, countLocations: locationCount };
     }
} 