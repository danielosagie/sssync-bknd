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

console.log('[InitialSyncService] Imported INITIAL_SCAN_QUEUE:', INITIAL_SCAN_QUEUE); // Log constant

@Injectable()
export class InitialSyncService {
    private readonly logger = new Logger(InitialSyncService.name);

    constructor(
        @InjectQueue(INITIAL_SCAN_QUEUE) private initialScanQueue: Queue,
        @InjectQueue(INITIAL_SYNC_QUEUE) private initialSyncQueue: Queue,
        private readonly connectionService: PlatformConnectionsService,
        private readonly mappingService: MappingService,
        // private readonly adapterRegistry: PlatformAdapterRegistry, // Inject registry or specific adapters
        // Inject Canonical Data services (ProductsService, InventoryService etc.)
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

        // Update status immediately
        await this.connectionService.updateConnectionStatus(connectionId, userId, 'scanning');

        const jobData: JobData = {
            connectionId,
            userId,
            platformType: connection.PlatformType!, // Assert non-null if PlatformType is mandatory
        };
        const job = await this.initialScanQueue.add('scan-platform-data', jobData);
        this.logger.log(`Job ${job.id} added to queue ${INITIAL_SCAN_QUEUE}`);
        return job.id!;
    }

    async getScanSummary(connectionId: string, userId: string): Promise<InitialScanResult> {
        // TODO: Implement logic to fetch scan results (maybe stored temporarily with connection or in cache?)
         this.logger.log(`Fetching scan summary for ${connectionId}`);
         // Placeholder
         await this.getConnectionAndVerify(connectionId, userId); // Verify access
         return { countProducts: 0, countVariants: 0, countLocations: 0 };
    }

     async getMappingSuggestions(connectionId: string, userId: string): Promise<MappingSuggestion[]> {
         // TODO: Implement logic to fetch mapping suggestions
          this.logger.log(`Fetching mapping suggestions for ${connectionId}`);
          await this.getConnectionAndVerify(connectionId, userId); // Verify access
          return []; // Placeholder
     }

     async saveConfirmedMappings(connectionId: string, userId: string, confirmationData: any /* ConfirmMappingsDto */): Promise<void> {
         // TODO: Implement logic to save confirmed mappings and sync rules
          this.logger.log(`Saving confirmed mappings for ${connectionId}`);
          const connection = await this.getConnectionAndVerify(connectionId, userId);
          await this.mappingService.saveConfirmedMappings(connection, confirmationData);
          await this.connectionService.saveSyncRules(connectionId, userId, confirmationData.syncRules || {});
          // Maybe update status?
     }

     async generateSyncPreview(connectionId: string, userId: string): Promise<SyncPreview> {
         // TODO: Simulate the initial sync based on confirmed mappings/rules
          this.logger.log(`Generating sync preview for ${connectionId}`);
          await this.getConnectionAndVerify(connectionId, userId); // Verify access
          return { actions: [] }; // Placeholder
     }


    async queueInitialSyncJob(connectionId: string, userId: string): Promise<string> {
        const connection = await this.getConnectionAndVerify(connectionId, userId);
        this.logger.log(`Queueing initial sync execution job for connection ${connectionId} (${connection.PlatformType})`);

         // Update status immediately or let the job do it? Let job do it on start.

        const jobData: JobData = {
            connectionId,
            userId,
            platformType: connection.PlatformType!, // Assert non-null if PlatformType is mandatory
        };
        const job = await this.initialSyncQueue.add('execute-initial-sync', jobData);
        this.logger.log(`Job ${job.id} added to queue ${INITIAL_SYNC_QUEUE}`);
        return job.id!;
    }
} 