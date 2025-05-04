import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PlatformConnectionsService, PlatformConnection } from '../platform-connections/platform-connections.service';
import { MappingService, MappingSuggestion } from './mapping.service';
import { INITIAL_SCAN_QUEUE, INITIAL_SYNC_QUEUE } from './sync-engine.constants';
import { PlatformAdapterRegistry } from '../platform-adapters/adapter.registry';

// Define interfaces for return types
export interface InitialScanResult { countProducts: number; countVariants: number; countLocations: number; analysisId?: string; }
export interface SyncPreview { actions: Array<{type: string; description: string}>; /* ... */ }
export interface JobData { connectionId: string; userId: string; platformType: string; } // Type for job data

console.log('[InitialSyncService] Imported INITIAL_SCAN_QUEUE:', INITIAL_SCAN_QUEUE);

@Injectable()
export class InitialSyncService {
    private readonly logger = new Logger(InitialSyncService.name);

    constructor(
        @InjectQueue(INITIAL_SCAN_QUEUE) private initialScanQueue: Queue,
        @InjectQueue(INITIAL_SYNC_QUEUE) private initialSyncQueue: Queue,
        private readonly connectionService: PlatformConnectionsService,
        private readonly mappingService: MappingService,
    ) {}

    private async getConnectionAndVerify(connectionId: string, userId: string): Promise<PlatformConnection> {
         const connection = await this.connectionService.getConnectionById(connectionId, userId);
         if (!connection) {
             throw new NotFoundException(`Platform connection ${connectionId} not found for user.`);
         }
         return connection;
    }

    async queueInitialScanJob(connectionId: string, userId: string): Promise<string> {
        const connection = await this.getConnectionAndVerify(connectionId, userId);
        this.logger.log(`Queueing initial scan job for connection ${connectionId} (${connection.PlatformType})`);
        await this.connectionService.updateConnectionStatus(connectionId, userId, 'scanning');
        const jobData: JobData = { connectionId, userId, platformType: connection.PlatformType! };

        const job = await this.initialScanQueue.add('scan-platform-data', jobData);
        this.logger.log(`Job ${job.id} added to queue ${INITIAL_SCAN_QUEUE}`);
        return job.id!;
    }

    async getScanSummary(connectionId: string, userId: string): Promise<InitialScanResult> {
         this.logger.log(`Fetching scan summary for ${connectionId}`);
         await this.getConnectionAndVerify(connectionId, userId);
         const summary = await this.connectionService.getScanSummaryFromData(connectionId, userId);
         if (!summary) {
             this.logger.warn(`Scan summary not yet available for connection ${connectionId}. Returning defaults.`);
             return { countProducts: 0, countVariants: 0, countLocations: 0 };
         }
         this.logger.debug(`Returning scan summary for ${connectionId}: ${JSON.stringify(summary)}`);
         return summary;
    }

     async getMappingSuggestions(connectionId: string, userId: string): Promise<MappingSuggestion[]> {
          this.logger.log(`Fetching mapping suggestions for ${connectionId}`);
          const connection = await this.getConnectionAndVerify(connectionId, userId);
          // Retrieve suggestions stored by InitialScanProcessor in PlatformSpecificData
          const suggestions = connection.PlatformSpecificData?.['mappingSuggestions'];
          
          if (!suggestions || !Array.isArray(suggestions)) {
            this.logger.warn(`No mapping suggestions found or invalid format in PlatformSpecificData for connection ${connectionId}`);
            return [];
          }
          
          this.logger.debug(`Returning ${suggestions?.length || 0} suggestions for ${connectionId} from PlatformSpecificData`);
          // TODO: Add validation here if needed (e.g., using class-transformer)
          return suggestions as MappingSuggestion[]; // Cast as suggestions are stored
     }

     async saveConfirmedMappings(connectionId: string, userId: string, confirmationData: any ): Promise<void> {
          this.logger.log(`Saving confirmed mappings for ${connectionId}`);
          const connection = await this.getConnectionAndVerify(connectionId, userId);
          await this.mappingService.saveConfirmedMappings(connection, confirmationData);
     }

     async generateSyncPreview(connectionId: string, userId: string): Promise<SyncPreview> {
          this.logger.log(`Generating sync preview for ${connectionId}`);
          await this.getConnectionAndVerify(connectionId, userId);
          return { actions: [] };
     }


    async queueInitialSyncJob(connectionId: string, userId: string): Promise<string> {
        const connection = await this.getConnectionAndVerify(connectionId, userId);
        this.logger.log(`Queueing initial sync execution job for connection ${connectionId} (${connection.PlatformType})`);
        const jobData: JobData = { connectionId, userId, platformType: connection.PlatformType! };

        const job = await this.initialSyncQueue.add('execute-initial-sync', jobData);
        this.logger.log(`Job ${job.id} added to queue ${INITIAL_SYNC_QUEUE}`);
        return job.id!;
    }
} 