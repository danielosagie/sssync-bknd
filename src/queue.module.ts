import { Module, Global, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UltraLowQueueService } from './ultra-low-queue.service';
import { BullMQQueueService } from './bullmq-queue.service';
import { QueueManagerService } from './queue-manager.service';
import { SyncEngineModule } from './sync-engine/sync-engine.module';
import { InitialScanProcessor } from './sync-engine/processors/initial-scan.processor';

@Global() // Make QueueManagerService globally available if needed, or import QueueModule where needed
@Module({
  imports: [
    ConfigModule,
    // Import SyncEngineModule to make its exported providers, like InitialScanProcessor, available.
    // Use forwardRef if SyncEngineModule might also import QueueModule to break circular dependency cycle.
    forwardRef(() => SyncEngineModule), 
  ],
  providers: [
    // InitialScanProcessor is now available via the imported SyncEngineModule, so it can be injected.
    UltraLowQueueService,
    BullMQQueueService,
    QueueManagerService,
  ],
  exports: [QueueManagerService], // Export QueueManagerService so other modules can use it
})
export class QueueModule {} 