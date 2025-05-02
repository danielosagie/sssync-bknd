import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
// import { InjectQueue } from '@nestjs/bullmq'; // <<< RE-COMMENT OUT
// import { Queue } from 'bullmq'; // <<< RE-COMMENT OUT
import { PlatformConnectionsService, PlatformConnection } from '../platform-connections/platform-connections.service';
import { MappingService, MappingSuggestion } from './mapping.service';
// import { INITIAL_SCAN_QUEUE, INITIAL_SYNC_QUEUE } from './sync-engine.constants'; // <<< RE-COMMENT OUT
import { PlatformAdapterRegistry } from '../platform-adapters/adapter.registry';

// Define interfaces for return types
export interface InitialScanResult { countProducts: number; countVariants: number; countLocations: number; analysisId?: string; }
export interface SyncPreview { actions: Array<{type: string; description: string}>; /* ... */ }
export interface JobData { connectionId: string; userId: string; platformType: string; } // Type for job data

// console.log('[InitialSyncService] Imported INITIAL_SCAN_QUEUE:', INITIAL_SCAN_QUEUE);

@Injectable()
export class InitialSyncService {
    private readonly logger = new Logger(InitialSyncService.name);

    constructor(
        // Re-comment queue injections
        // @InjectQueue(INITIAL_SCAN_QUEUE) private initialScanQueue: Queue,
        // @InjectQueue(INITIAL_SYNC_QUEUE) private initialSyncQueue: Queue,
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

        // --- Re-disable queueing ---
        this.logger.warn('BullMQ is disabled. Skipping initialScanQueue.add() - Returning dummy ID.');
        // const job = await this.initialScanQueue.add('scan-platform-data', jobData); // Use a descriptive job name
        // this.logger.log(`Job ${job.id} added to queue ${INITIAL_SCAN_QUEUE}`);
        // return job.id!;
        return 'disabled-job-id'; // Return dummy ID
        // --- End Re-disable ---
    }

    async getScanSummary(connectionId: string, userId: string): Promise<InitialScanResult> {
         this.logger.log(`Fetching scan summary for ${connectionId}`);
         await this.getConnectionAndVerify(connectionId, userId);
         // TODO: Fetch summary from connectionService.getScanSummaryFromData ?
         return { countProducts: 0, countVariants: 0, countLocations: 0 };
    }

     async getMappingSuggestions(connectionId: string, userId: string): Promise<MappingSuggestion[]> {
          this.logger.log(`Fetching mapping suggestions for ${connectionId}`);
          await this.getConnectionAndVerify(connectionId, userId);
          // TODO: Retrieve suggestions stored by InitialScanProcessor (e.g., from Redis cache?)
          return [];
     }

     async saveConfirmedMappings(connectionId: string, userId: string, confirmationData: any ): Promise<void> {
          this.logger.log(`Saving confirmed mappings for ${connectionId}`);
          const connection = await this.getConnectionAndVerify(connectionId, userId);
          await this.mappingService.saveConfirmedMappings(connection, confirmationData);
          // Sync rules were being saved here, but might belong in a different endpoint/flow?
          // If sync rules are part of confirmation, keep it:
          // await this.connectionService.saveSyncRules(connectionId, userId, confirmationData.syncRules || {});
     }

     async generateSyncPreview(connectionId: string, userId: string): Promise<SyncPreview> {
          this.logger.log(`Generating sync preview for ${connectionId}`);
          await this.getConnectionAndVerify(connectionId, userId);
          // TODO: Implement preview logic based on confirmed mappings
          return { actions: [] };
     }


    async queueInitialSyncJob(connectionId: string, userId: string): Promise<string> {
        const connection = await this.getConnectionAndVerify(connectionId, userId);
        this.logger.log(`Queueing initial sync execution job for connection ${connectionId} (${connection.PlatformType})`);
        const jobData: JobData = { connectionId, userId, platformType: connection.PlatformType! };

        // --- Re-disable queueing ---
        this.logger.warn('BullMQ is disabled. Skipping initialSyncQueue.add() - Returning dummy ID.');
        // const job = await this.initialSyncQueue.add('execute-initial-sync', jobData); // Use descriptive job name
        // this.logger.log(`Job ${job.id} added to queue ${INITIAL_SYNC_QUEUE}`);
        // return job.id!;
        return 'disabled-job-id'; // Return dummy ID
        // --- End Re-disable ---
    }
} 