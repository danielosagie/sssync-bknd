import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';
import { CommonModule } from '../common/common.module';
import { CanonicalDataModule } from '../canonical-data/canonical-data.module';
import { MappingService } from './mapping.service';
import { InitialSyncService } from './initial-sync.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { InitialScanProcessor } from './processors/initial-scan.processor';
import { InitialSyncProcessor } from './processors/initial-sync.processor';
import { WebhookController } from './webhook.controller';
import { SyncController } from './sync.controller';
import { ShopifyAdapterModule } from '../platform-adapters/shopify/shopify-adapter.module';
import { SquareAdapterModule } from '../platform-adapters/square/square-adapter.module';
import { PlatformAdapterRegistry } from '../platform-adapters/adapter.registry';

// Queue names as constants
export const INITIAL_SCAN_QUEUE = 'initial-scan'; // This queue name might become unused if InitialScanProcessor isn't a BullMQ processor anymore
export const INITIAL_SYNC_QUEUE = 'initial-sync';

@Module({
  imports: [
    ConfigModule,
    PlatformConnectionsModule,
    CommonModule,
    CanonicalDataModule,
    ShopifyAdapterModule,
    SquareAdapterModule,
    BullModule.forRootAsync({
        imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
            const redisUrl = configService.get<string>('REDIS_URL');
            if (!redisUrl) {
          throw new Error('REDIS_URL is not defined in environment variables');
            }
            return {
                connection: { 
            url: redisUrl,
            // For BullMQ, you might want to pass more specific ioredis options here
            // especially if using TLS/SSL with Upstash, e.g., tls: { rejectUnauthorized: false } if needed
            // However, ioredis usually handles rediss:// URLs correctly.
          },
          defaultJobOptions: {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 1000,
            },
            removeOnComplete: true,
            removeOnFail: false, // Keep failed jobs for inspection
          },
          // Global limiter - this was for the previous BullMQ setup. 
          // If QueueManagerService handles high-throughput switching to a specific BullMQ queue,
          // this global limiter might conflict or be redundant. Consider its role carefully.
          // For now, let's keep it as it might affect INITIAL_SYNC_QUEUE if it's still used directly.
          /* limiter: {
            max: 1, 
            duration: 300000, 
            groupKey: 'connection', 
          }, */
            };
        },
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      // We are trying to move away from INITIAL_SCAN_QUEUE being managed here directly
      // If InitialScanProcessor is no longer a @Processor, this registration might not be needed for it.
      // { name: INITIAL_SCAN_QUEUE }, 
      { 
        name: INITIAL_SYNC_QUEUE, // INITIAL_SYNC_QUEUE is still used directly by InitialSyncService
        defaultJobOptions: { // Can override global defaultJobOptions here if needed
          removeOnComplete: true,
          removeOnFail: 1000, // Keep up to 1000 failed jobs for this specific queue
        }
      }
    ),
  ],
  controllers: [WebhookController, SyncController],
  providers: [
    MappingService,
    InitialSyncService,
    SyncCoordinatorService,
    InitialScanProcessor, // Provide InitialScanProcessor so it can be injected elsewhere
    InitialSyncProcessor,
    PlatformAdapterRegistry,
  ],
  // Export InitialScanProcessor so other modules (like QueueModule) can import SyncEngineModule and use InitialScanProcessor
  exports: [InitialSyncService, SyncCoordinatorService, PlatformAdapterRegistry, InitialScanProcessor],
})
export class SyncEngineModule {} 