import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { SyncCoordinatorService } from '../sync-coordinator.service';
import { PUSH_OPERATIONS_QUEUE } from '../sync-engine.constants';
import { PushOperationJobData } from '../sync-engine.types';
import { ActivityLogService } from '../../common/activity-log.service';

// Slow down push operations: 1 job every 1 minute
@Processor(PUSH_OPERATIONS_QUEUE, {
  concurrency: 1,
  limiter: {
    max: 1,
    duration: 1000 * 60 * 1, // 1 minute
  },
})
export class PushOperationsProcessor extends WorkerHost {
  private readonly logger = new Logger(PushOperationsProcessor.name);

  constructor(
    private readonly syncCoordinatorService: SyncCoordinatorService,
    private readonly activityLogService: ActivityLogService, // Keep ActivityLogService for potential future use or detailed internal logging
  ) {
    super();
  }

  async process(job: Job<PushOperationJobData, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} (type: ${job.name}) for user ${job.data.userId}, entity ${job.data.entityId}, change ${job.data.changeType}`);
    const { userId, entityId, changeType } = job.data;

    // Note: Activity logging for job start/success/failure is now primarily handled
    // within the _execute...Push methods in SyncCoordinatorService for more context.

    try {
      switch (changeType) {
        case 'PRODUCT_CREATED':
          await this.syncCoordinatorService._executeProductCreationPush(entityId, userId);
          break;
        case 'PRODUCT_UPDATED':
          await this.syncCoordinatorService._executeProductUpdatePush(entityId, userId);
          break;
        case 'PRODUCT_DELETED':
          await this.syncCoordinatorService._executeProductDeletionPush(entityId, userId);
          break;
        case 'INVENTORY_UPDATED':
          await this.syncCoordinatorService._executeInventoryUpdatePush(entityId, userId);
          break;
        default:
          this.logger.warn(`Unknown change type: ${changeType} for job ${job.id}`);
          // Log to activity log as well for visibility on unknown job types attempted
          await this.activityLogService.logActivity({
            UserId: userId,
            EntityType: null, // No specific entity type for an unknown operation
            EntityId: entityId,
            EventType: 'PUSH_OPERATION_UNKNOWN_TYPE',
            Status: 'Error',
            Message: `Job ${job.id} attempted with unknown change type: ${changeType}`,
            Details: { jobName: job.name, receivedChangeType: changeType }
          });
          throw new Error(`Unknown change type: ${changeType}`);
      }
      this.logger.log(`Successfully processed job ${job.id} for ${changeType} on entity ${entityId}. More detailed activity logs within execution methods.`);
      return { status: 'success', message: `Job ${job.id} processed.` };
    } catch (error) {
      // Error logging (including to ActivityLogService) is now expected to be handled 
      // comprehensively within the _execute...Push methods called above.
      // This catch block is a fallback or for errors happening directly in the switch/processor logic itself before/after _execute calls.
      this.logger.error(`Job ${job.id} failed for ${changeType} on entity ${entityId}: ${error.message}`, error.stack);
      // Re-throw for BullMQ to handle retry based on defaultJobOptions
      // The individual _execute methods in SyncCoordinatorService are responsible for detailed failure logging to ActivityLogService.
      throw error; 
    }
  }
} 