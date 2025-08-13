import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PlatformConnectionsService,
  PlatformConnection,
} from '../platform-connections/platform-connections.service';
import { MappingService, MappingSuggestion } from './mapping.service';
import {
  INITIAL_SCAN_QUEUE,
  INITIAL_SYNC_QUEUE,
  RECONCILIATION_QUEUE,
} from './sync-engine.constants';
import { PlatformAdapterRegistry } from '../platform-adapters/adapter.registry';
import * as QueueManager from '../queue-manager';
import { ActivityLogService } from '../common/activity-log.service';
import { QueueManagerService } from '../queue-manager.service';
import { ProductAnalysisJobData } from '../products/types/product-analysis-job.types';
import { MatchJobData } from '../products/types/match-job.types';

// Define interfaces for return types
export interface InitialScanResult {
  countProducts: number;
  countVariants: number;
  countLocations: number;
  analysisId?: string;
}
export interface SyncPreview {
  actions: Array<{ type: string; description: string }> /* ... */;
}

// Base sync job data
export interface SyncJobData {
  type?: string;
  connectionId: string;
  userId: string;
  platformType: string;
}

// Interface for Reconciliation Job Data
export interface ReconciliationJobData {
  connectionId: string;
  userId: string;
  platformType: string;
  // Potentially add options like 'full' or 'delta' in the future
}

// Union type for all job data types
export type JobData = SyncJobData | ProductAnalysisJobData | MatchJobData;

console.log(
  '[InitialSyncService] Imported INITIAL_SCAN_QUEUE:',
  INITIAL_SCAN_QUEUE,
);

@Injectable()
export class InitialSyncService {
  private readonly logger = new Logger(InitialSyncService.name);

  constructor(
    @InjectQueue(RECONCILIATION_QUEUE)
    private reconciliationQueue: Queue<ReconciliationJobData>,
    private readonly queueManagerService: QueueManagerService,
    private readonly connectionService: PlatformConnectionsService,
    private readonly mappingService: MappingService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private async getConnectionAndVerify(
    connectionId: string,
    userId: string,
  ): Promise<PlatformConnection> {
    const connection = await this.connectionService.getConnectionById(
      connectionId,
      userId,
    );
    if (!connection) {
      throw new NotFoundException(
        `Platform connection ${connectionId} not found for user.`,
      );
    }
    return connection;
  }

  async queueInitialScanJob(
    connectionId: string,
    userId: string,
  ): Promise<string> {
    const connection = await this.getConnectionAndVerify(connectionId, userId);

    const jobData: JobData = {
      type: 'initial-scan',
      connectionId,
      userId,
      platformType: connection.PlatformType,
    };

    await this.activityLogService.logActivity({
      UserId: userId,
      EntityType: 'PlatformConnection',
      EntityId: connectionId,
      EventType: 'INITIAL_SCAN_JOB_QUEUED',
      Status: 'Info',
      Message: `Attempting to queue initial scan job for ${connection.PlatformType} connection: ${connection.DisplayName}.`,
      PlatformConnectionId: connectionId,
      Details: { platform: connection.PlatformType }
    });

    try {
      // Enqueue the job and get the actual job ID from the queue manager
      const jobId = await this.queueManagerService.enqueueJob(jobData);

      // Store the job ID in the connection's PlatformSpecificData for tracking
      await this.connectionService.updateConnectionData(connectionId, userId, {
        PlatformSpecificData: {
          ...connection.PlatformSpecificData,
          currentJobId: jobId,
          jobStartedAt: new Date().toISOString(),
          jobType: 'initial-scan',
        },
      });

      const message = `Initial scan job ${jobId} for connection ${connectionId} successfully handed to QueueManager.`;
      this.logger.log(message);

      await this.activityLogService.logActivity({
        UserId: userId,
        EntityType: 'PlatformConnection',
        EntityId: connectionId,
        EventType: 'INITIAL_SCAN_JOB_SUCCESS',
        Status: 'Success',
        Message: `Successfully queued initial scan job ${jobId} (via QueueManager) for ${connection.PlatformType} connection: ${connection.DisplayName}.`,
        PlatformConnectionId: connectionId,
        Details: { platform: connection.PlatformType }
      });
      return jobId;
    } catch (error) {
      this.logger.error(
        `Failed to queue initial scan job for connection ${connectionId} via QueueManager: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async getScanSummary(
    connectionId: string,
    userId: string,
  ): Promise<InitialScanResult> {
    this.logger.log(`Fetching scan summary for ${connectionId}`);
    await this.getConnectionAndVerify(connectionId, userId);
    const summary = await this.connectionService.getScanSummaryFromData(
      connectionId,
      userId,
    );
    if (!summary) {
      this.logger.warn(
        `Scan summary not yet available for connection ${connectionId}. Returning defaults.`,
      );
      return { countProducts: 0, countVariants: 0, countLocations: 0 };
    }
    this.logger.debug(
      `Returning scan summary for ${connectionId}: ${JSON.stringify(summary)}`,
    );
    return summary;
  }

  async getMappingSuggestions(
    connectionId: string,
    userId: string,
  ): Promise<MappingSuggestion[]> {
    this.logger.log(`Fetching mapping suggestions for ${connectionId}`);
    const connection = await this.getConnectionAndVerify(connectionId, userId);
    const suggestions = connection.PlatformSpecificData?.['mappingSuggestions'];

    if (!suggestions || !Array.isArray(suggestions)) {
      this.logger.warn(
        `No mapping suggestions found or invalid format in PlatformSpecificData for connection ${connectionId}`,
      );
      return [];
    }

    this.logger.debug(
      `Returning ${suggestions?.length || 0} suggestions for ${connectionId} from PlatformSpecificData`,
    );
    return suggestions as MappingSuggestion[];
  }

  async saveConfirmedMappings(
    connectionId: string,
    userId: string,
    confirmationData: any,
  ): Promise<void> {
    this.logger.log(`Saving confirmed mappings for ${connectionId}`);
    const connection = await this.getConnectionAndVerify(connectionId, userId);
    await this.mappingService.saveConfirmedMappings(
      connection,
      confirmationData,
    );
  }

  async generateSyncPreview(
    connectionId: string,
    userId: string,
  ): Promise<SyncPreview> {
    this.logger.log(`Generating sync preview for ${connectionId}`);
    await this.getConnectionAndVerify(connectionId, userId);
    return { actions: [] };
  }

  async queueInitialSyncJob(
    connectionId: string,
    userId: string,
  ): Promise<string> {
    const connection = await this.getConnectionAndVerify(connectionId, userId);
    this.logger.log(
      `Queueing initial sync execution job for connection ${connectionId} (${connection.PlatformType}) via QueueManager`,
    );

    await this.connectionService.updateConnectionStatus(
      connectionId,
      userId,
      'syncing',
    );
    this.logger.log(
      `Updated connection ${connectionId} status to 'syncing' before queueing job.`,
    );

    const jobData: JobData = {
      type: 'initial-sync',
      connectionId,
      userId,
      platformType: connection.PlatformType,
    };

    await this.activityLogService.logActivity({
      UserId: userId,
      EntityType: 'PlatformConnection',
      EntityId: connectionId,
      EventType: 'INITIAL_SYNC_STARTED',
      Status: 'Info',
      Message: `Starting initial sync for ${connection.PlatformType} connection: ${connection.DisplayName}`,
      PlatformConnectionId: connectionId,
      Details: { platform: connection.PlatformType }
    });

    try {
      // Enqueue the job and get the actual job ID from the queue manager
      const jobId = await this.queueManagerService.enqueueJob(jobData);
      const message = `Initial sync job ${jobId} for connection ${connectionId} successfully handed to QueueManager.`;
      this.logger.log(message);

      await this.activityLogService.logActivity({
        UserId: userId,
        EntityType: 'PlatformConnection',
        EntityId: connectionId,
        EventType: 'INITIAL_SYNC_QUEUED',
        Status: 'Info',
        Message: `Initial sync queued for ${connection.PlatformType} connection: ${connection.DisplayName}`,
        PlatformConnectionId: connectionId,
        Details: { platform: connection.PlatformType }
      });
      return jobId;
    } catch (error) {
      this.logger.error(
        `Failed to queue initial sync job for connection ${connectionId} via QueueManager: ${error.message}`,
        error.stack,
      );
      await this.activityLogService.logActivity({
        UserId: userId,
        EntityType: 'Connection',
        EntityId: connectionId,
        EventType: 'INITIAL_SYNC_JOB_FAILED',
        Status: 'Error',
        Message: `Failed to queue initial sync job for ${connectionId}: ${error.message}`,
        Details: { error: error.message }
      });
      throw new InternalServerErrorException(
        `Failed to queue initial sync job for ${connectionId}`,
      );
    }
  }

  async getJobProgress(jobId: string): Promise<{
    isActive: boolean;
    isCompleted: boolean;
    isFailed: boolean;
    progress: number;
    description: string | null;
    total?: number;
    processed?: number;
  }> {
    this.logger.debug(`Getting progress for job ID: ${jobId}`);

    // First try to find the job in the queue system
    const job = await this.queueManagerService.getJobById(jobId);

    if (job) {
      // Job found in queue system - return its actual progress
      const [isActive, isCompleted, isFailed] = await Promise.all([
        job.isActive(),
        job.isCompleted(),
        job.isFailed(),
      ]);

      let progressValue = 0;
      let description = 'Processing...';
      let total: number | undefined = undefined;
      let processed: number | undefined = undefined;

      if (typeof job.progress === 'object' && job.progress !== null) {
        const progressData = job.progress as any;
        progressValue = progressData.progress || 0;
        description = progressData.description || 'Processing...';
        total = progressData.total;
        processed = progressData.processed;
      } else if (typeof job.progress === 'number') {
        progressValue = job.progress;
      }

      return {
        isActive,
        isCompleted,
        isFailed,
        progress: progressValue / 100, // Assuming progress is 0-100
        description,
        total,
        processed,
      };
    }

    // Job not found in queue system - check if it's tracked in connection data
    // Extract connection ID from job ID (format: {type}-{connectionId}-{timestamp})
    const jobIdParts = jobId.split('-');
    if (jobIdParts.length >= 3) {
      const jobType = jobIdParts[0];
      const connectionId = jobIdParts.slice(1, -1).join('-'); // Everything except the timestamp

      this.logger.debug(
        `Extracted connectionId: ${connectionId} from jobId: ${jobId}`,
      );

      try {
        // Try to find the connection by ID without knowing the user ID
        // This is a special case for job tracking where we don't have the user context
        const connection = await this.findConnectionById(connectionId);

        if (!connection) {
          this.logger.warn(`Connection ${connectionId} not found`);
          throw new NotFoundException(
            `Job with ID ${jobId} not found and connection lookup failed.`,
          );
        }

        if (connection.PlatformSpecificData?.currentJobId === jobId) {
          const jobData = connection.PlatformSpecificData;
          const jobStartedAt = new Date(jobData.jobStartedAt || Date.now());
          const now = new Date();
          const elapsedMinutes =
            (now.getTime() - jobStartedAt.getTime()) / (1000 * 60);

          // Check connection status to determine job state
          const status = connection.Status;

          if (status === 'needs_review') {
            // Job completed successfully
            return {
              isActive: false,
              isCompleted: true,
              isFailed: false,
              progress: 1.0,
              description: `${connection.PlatformType} scan completed successfully`,
              total: undefined,
              processed: undefined,
            };
          } else if (status === 'error') {
            // Job failed
            return {
              isActive: false,
              isCompleted: false,
              isFailed: true,
              progress: 0,
              description: `${connection.PlatformType} scan failed`,
              total: undefined,
              processed: undefined,
            };
          } else if (status === 'scanning' || status === 'syncing') {
            // Job is still active - simulate progress based on elapsed time
            const estimatedDurationMinutes = jobType === 'initial-scan' ? 3 : 5;
            const simulatedProgress = Math.min(
              0.95,
              elapsedMinutes / estimatedDurationMinutes,
            );

            return {
              isActive: true,
              isCompleted: false,
              isFailed: false,
              progress: simulatedProgress,
              description: `${jobType === 'initial-scan' ? 'Scanning' : 'Syncing'} ${connection.PlatformType} products...`,
              total: undefined,
              processed: undefined,
            };
          }
        }

        // If we reach here, the job might be completed but not tracked properly
        this.logger.warn(
          `Job ${jobId} found in connection ${connectionId} but status is unclear. Status: ${connection?.Status}`,
        );
      } catch (error) {
        this.logger.warn(
          `Could not find connection data for job ${jobId}: ${error.message}`,
        );
      }
    }

    // Job not found anywhere
    throw new NotFoundException(
      `Job with ID ${jobId} not found in any queue or connection data.`,
    );
  }

  // Helper method to find a connection by ID without requiring user ID
  // This is only used for job progress tracking where we don't have user context
  private async findConnectionById(
    connectionId: string,
  ): Promise<PlatformConnection | null> {
    try {
      // Get all connections with this ID - should be only one
      const connections =
        await this.connectionService.getConnectionsByPlatformAndAttribute(
          '*', // Any platform type
          'id', // Looking for connection ID
          connectionId,
        );

      return connections && connections.length > 0 ? connections[0] : null;
    } catch (error) {
      this.logger.error(
        `Error finding connection by ID ${connectionId}: ${error.message}`,
      );
      return null;
    }
  }

  async queueReconciliationJob(
    connectionId: string,
    userId: string,
    platformType: string,
  ): Promise<string> {
    this.logger.log(
      `Queueing reconciliation job for connection ${connectionId}`,
    );
    const job = await this.reconciliationQueue.add(
      'reconcile-connection', // Job name
      { connectionId, userId, platformType },
      {
        jobId: `reconcile-${connectionId}-${Date.now()}`,
        // attempts: 2, // Default from queue config, or override here
        // backoff: { type: 'exponential', delay: 60000 }
      },
    );
    this.logger.log(
      `Reconciliation job ${job.id} queued for connection ${connectionId}.`,
    );

    // Store job tracking info on the connection for client progress polling
    try {
      const connection = await this.getConnectionAndVerify(connectionId, userId);
      await this.connectionService.updateConnectionData(connectionId, userId, {
        PlatformSpecificData: {
          ...(connection.PlatformSpecificData || {}),
          currentJobId: job.id,
          jobStartedAt: new Date().toISOString(),
          jobType: 'reconcile',
        },
        Status: 'reconciling',
      });
    } catch (e: any) {
      this.logger.warn(`Failed to persist reconcile job metadata for ${connectionId}: ${e?.message}`);
    }
    await this.activityLogService.logActivity({
      UserId: userId,
      EntityType: 'Connection',
      EntityId: connectionId,
      EventType: 'RECONCILIATION_QUEUED',
      Status: 'Info',
      Message: `Periodic reconciliation job queued for ${platformType} connection.`,
      PlatformConnectionId: connectionId,
      Details: { platform: platformType }
    });
    return job.id as string;
  }
}
