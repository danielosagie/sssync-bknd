import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { 
    RECONCILIATION_QUEUE,
    PUSH_OPERATIONS_QUEUE,
    INITIAL_SCAN_QUEUE,
    INITIAL_SYNC_QUEUE,
} from './sync-engine/sync-engine.constants';

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
  exports: [BullModule],
})
export class QueueModule {} 