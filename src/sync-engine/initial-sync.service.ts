import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PlatformConnectionsService, PlatformConnection } from '../platform-connections/platform-connections.service';
import { MappingService, MappingSuggestion } from './mapping.service';
import { INITIAL_SCAN_QUEUE, INITIAL_SYNC_QUEUE, RECONCILIATION_QUEUE } from './sync-engine.constants';
import { PlatformAdapterRegistry } from '../platform-adapters/adapter.registry';
import * as QueueManager from '../queue-manager';
import { ActivityLogService } from '../common/activity-log.service';
import { QueueManagerService } from '../queue-manager.service';

// Define interfaces for return types
export interface InitialScanResult { countProducts: number; countVariants: number; countLocations: number; analysisId?: string; }
export interface SyncPreview { actions: Array<{type: string; description: string}>; /* ... */ }
export interface JobData { type?: string; connectionId: string; userId: string; platformType: string; }

// Interface for Reconciliation Job Data
export interface ReconciliationJobData {
    connectionId: string;
    userId: string;
    platformType: string;
    // Potentially add options like 'full' or 'delta' in the future
}

console.log('[InitialSyncService] Imported INITIAL_SCAN_QUEUE:', INITIAL_SCAN_QUEUE);

@Injectable()
export class InitialSyncService {
    private readonly logger = new Logger(InitialSyncService.name);

    constructor(
        @InjectQueue(INITIAL_SYNC_QUEUE) private initialSyncQueue: Queue<JobData>,
        @InjectQueue(RECONCILIATION_QUEUE) private reconciliationQueue: Queue<ReconciliationJobData>,
        private readonly queueManagerService: QueueManagerService,
        private readonly connectionService: PlatformConnectionsService,
        private readonly mappingService: MappingService,
        private readonly activityLogService: ActivityLogService,
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
        const jobData: JobData = { type: 'initial-scan', connectionId, userId, platformType: connection.PlatformType };

        await this.activityLogService.logActivity(
            userId,
            'PlatformConnection',
            connectionId,
            'QUEUE_INITIAL_SCAN_JOB',
            'Info',
            `Attempting to queue initial scan job for ${connection.PlatformType} connection: ${connection.DisplayName}.`,
            connectionId, 
            connection.PlatformType
        );

        try {
            await this.queueManagerService.enqueueJob(jobData);
            const message = `Initial scan job for connection ${connectionId} successfully handed to QueueManager.`;
            this.logger.log(message);
            
            await this.activityLogService.logActivity(
                userId,
                'PlatformConnection',
                connectionId,
                'QUEUE_INITIAL_SCAN_JOB_SUCCESS',
                'Success',
                `Successfully queued initial scan job (via QueueManager) for ${connection.PlatformType} connection: ${connection.DisplayName}.`,
                connectionId,
                connection.PlatformType,
            );
            return "queued_via_manager";
        } catch (error) {
            this.logger.error(`Failed to queue initial scan job for connection ${connectionId} via QueueManager: ${error.message}`, error.stack);
            throw error;
        }
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
          const suggestions = connection.PlatformSpecificData?.['mappingSuggestions'];
          
          if (!suggestions || !Array.isArray(suggestions)) {
            this.logger.warn(`No mapping suggestions found or invalid format in PlatformSpecificData for connection ${connectionId}`);
            return [];
          }
          
          this.logger.debug(`Returning ${suggestions?.length || 0} suggestions for ${connectionId} from PlatformSpecificData`);
          return suggestions as MappingSuggestion[];
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

        await this.connectionService.updateConnectionStatus(connectionId, userId, 'syncing');
        this.logger.log(`Updated connection ${connectionId} status to 'syncing' before queueing job.`);

        const existingJobs = await this.initialSyncQueue.getJobs(['active', 'waiting', 'delayed']);
        const existingJob = existingJobs.find(job => job.data.connectionId === connectionId);
        
        if (existingJob) {
            this.logger.warn(`Found existing sync job ${existingJob.id} for connection ${connectionId}. Skipping new job creation.`);
            return existingJob.id!;
        }

        const jobData: JobData = { type: 'initial-sync', connectionId, userId, platformType: connection.PlatformType! };

        const job = await this.initialSyncQueue.add('execute-initial-sync', jobData, {
            jobId: `sync-${connectionId}-${Date.now()}`,
        });
        this.logger.log(`Job ${job.id} added to queue ${INITIAL_SYNC_QUEUE}`);
        return job.id!;
    }

    async queueReconciliationJob(connectionId: string, userId: string, platformType: string): Promise<string> {
        this.logger.log(`Queueing reconciliation job for connection ${connectionId} (User: ${userId}, Platform: ${platformType})`);
        const job = await this.reconciliationQueue.add(
            'reconcile-connection', // Job name
            { connectionId, userId, platformType },
            {
                jobId: `reconcile-${connectionId}-${Date.now()}`,
                // attempts: 2, // Default from queue config, or override here
                // backoff: { type: 'exponential', delay: 60000 }
            }
        );
        this.logger.log(`Reconciliation job ${job.id} queued for connection ${connectionId}.`);
        await this.activityLogService.logActivity(userId, 'Connection', connectionId, 'RECONCILIATION_QUEUED', 'Info', 
            `Periodic reconciliation job queued for ${platformType} connection.`, connectionId, platformType);
        return job.id as string;
    }
} 