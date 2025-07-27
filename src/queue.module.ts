import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { 
    RECONCILIATION_QUEUE,
    PUSH_OPERATIONS_QUEUE,
    INITIAL_SCAN_QUEUE,
    INITIAL_SYNC_QUEUE,
} from './sync-engine/sync-engine.constants';
import { BullMQQueueService } from './bullmq-queue.service';
import { QueueManagerService } from './queue-manager.service';
import { UltraLowQueueService } from './ultra-low-queue.service';

@Global()
@Module({
  imports: [
    BullModule.registerQueue(
      { name: RECONCILIATION_QUEUE },
      { name: PUSH_OPERATIONS_QUEUE },
      { name: INITIAL_SCAN_QUEUE },
      { name: INITIAL_SYNC_QUEUE }
    ),
  ],
  providers: [BullMQQueueService, QueueManagerService, UltraLowQueueService],
  exports: [BullModule, BullMQQueueService, QueueManagerService],
})
export class QueueModule {} 