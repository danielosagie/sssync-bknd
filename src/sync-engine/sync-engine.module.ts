import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';
import { CommonModule } from '../common/common.module';
import { CanonicalDataModule } from '../canonical-data/canonical-data.module';
import { MappingService } from './mapping.service';
import { InitialSyncService } from './initial-sync.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { WebhookController } from './webhook.controller';
import { SyncController } from './sync.controller';
import { ReconciliationProcessor } from './processors/reconciliation.processor';
import { PushOperationsProcessor } from './processors/push-operations.processor';
import { InitialScanProcessor } from './processors/initial-scan.processor';
import { InitialSyncProcessor } from './processors/initial-sync.processor';
import { ProductsModule } from '../products/products.module';
import { PlatformProductMappingsModule } from '../platform-product-mappings/platform-product-mappings.module';
import { QueueModule } from '../queue.module';
import { PlatformAdaptersModule } from '../platform-adapters/platform-adapters.module';
import { UltraLowQueueService } from '../ultra-low-queue.service';
import { BullMQQueueService } from '../bullmq-queue.service';
import { QueueManagerService } from '../queue-manager.service';
import { 
    RECONCILIATION_QUEUE,
    PUSH_OPERATIONS_QUEUE,
    INITIAL_SCAN_QUEUE,
    INITIAL_SYNC_QUEUE,
} from './sync-engine.constants';

@Module({
  imports: [
    ConfigModule,
    PlatformConnectionsModule,
    CommonModule,
    CanonicalDataModule,
    PlatformProductMappingsModule,
    QueueModule,
    ProductsModule,
    PlatformAdaptersModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        connection: {
          host: new URL(configService.get<string>('REDIS_URL')!).hostname,
          port: Number(new URL(configService.get<string>('REDIS_URL')!).port),
          password: new URL(configService.get<string>('REDIS_URL')!).password,
          username: new URL(configService.get<string>('REDIS_URL')!).username,
          ...(new URL(configService.get<string>('REDIS_URL')!).protocol === 'rediss:' ? { tls: {} } : {}),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 60000 * 5,
          },
          removeOnComplete: {
            count: 1000,
            age: 24 * 60 * 60,
          },
          removeOnFail: {
            count: 5000,
            age: 7 * 24 * 60 * 60,
          },
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      { name: RECONCILIATION_QUEUE },
      { name: PUSH_OPERATIONS_QUEUE },
      { name: INITIAL_SCAN_QUEUE },
      { name: INITIAL_SYNC_QUEUE }
    ),
  ],
  controllers: [SyncController, WebhookController],
  providers: [
    MappingService,
    InitialSyncService,
    SyncCoordinatorService,
    ReconciliationProcessor,
    PushOperationsProcessor,
    InitialScanProcessor,
    InitialSyncProcessor,
    UltraLowQueueService,
    BullMQQueueService,
    QueueManagerService,
  ],
  exports: [
    InitialSyncService,
    MappingService,
    BullModule,
    SyncCoordinatorService,
    InitialScanProcessor,
    InitialSyncProcessor,
    UltraLowQueueService,
    BullMQQueueService,
    QueueManagerService,
  ],
})
export class SyncEngineModule {} 