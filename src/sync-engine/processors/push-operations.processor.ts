import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { SyncCoordinatorService } from '../sync-coordinator.service';
import { PUSH_OPERATIONS_QUEUE } from '../sync-engine.constants';
import { PushOperationJobData } from '../sync-engine.types';
import { ActivityLogService } from '../../common/activity-log.service';

@Processor(PUSH_OPERATIONS_QUEUE)
export class PushOperationsProcessor extends WorkerHost {
  private readonly logger = new Logger(PushOperationsProcessor.name);

  constructor(
    private readonly syncCoordinatorService: SyncCoordinatorService,
    private readonly activityLogService: ActivityLogService,
  ) {
    super();
  }

  async process(job: Job<PushOperationJobData, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name} for user ${job.data.userId}, entity ${job.data.entityId}, change ${job.data.changeType}`);
    const { userId, entityId, changeType } = job.data;

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
          throw new Error(`Unknown change type: ${changeType}`);
      }
      this.logger.log(`Successfully processed job ${job.id} for ${changeType} on entity ${entityId}`);
      // await this.activityLogService.logEvent({
      //   userId,
      //   eventType: `PUSH_OPERATION_${changeType}_SUCCESS`,
      //   status: 'Success',
      //   message: `Successfully pushed ${changeType} for entity ${entityId}`,
      //   entityType: changeType.includes('PRODUCT') ? 'Product' : 'ProductVariant',
      //   entityId,
      // });
      return { status: 'success', message: `Job ${job.id} processed.` };
    } catch (error) {
      this.logger.error(`Job ${job.id} failed for ${changeType} on entity ${entityId}: ${error.message}`, error.stack);
      // await this.activityLogService.logEvent({
      //   userId,
      //   eventType: `PUSH_OPERATION_${changeType}_FAILED`,
      //   status: 'Error',
      //   message: `Failed to push ${changeType} for entity ${entityId}: ${error.message}`,
      //   entityType: changeType.includes('PRODUCT') ? 'Product' : 'ProductVariant',
      //   entityId,
      //   details: { error: error.message, stack: error.stack },
      // });
      throw error; // Re-throw to let BullMQ handle retry logic
    }
  }
} 