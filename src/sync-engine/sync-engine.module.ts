import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq'; // Import BullModule
import { ConfigModule, ConfigService } from '@nestjs/config'; // Needed for queue config
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';
// Import Canonical Data Services/Modules if they exist
// import { ProductsModule } from '../products/products.module';
// import { InventoryModule } from '../inventory/inventory.module';
import { MappingService } from './mapping.service';
import { InitialSyncService } from './initial-sync.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { InitialScanProcessor } from './processors/initial-scan.processor';
import { InitialSyncProcessor } from './processors/initial-sync.processor';
import { WebhookController } from './webhook.controller';
import { SyncController } from './sync.controller';

// Platform Adapters - provided here or dynamically loaded
import { ShopifyAdapterModule } from '../platform-adapters/shopify/shopify-adapter.module'; // Example
import { SquareAdapterModule } from '../platform-adapters/square/square-adapter.module';     // <<< NEW: Import Square adapter module
import { PlatformAdapterRegistry } from '../platform-adapters/adapter.registry'; // <<< NEW: Import Registry

// Queue Names (use constants)
export const INITIAL_SCAN_QUEUE = 'initial-scan';
export const INITIAL_SYNC_QUEUE = 'initial-sync';
export const WEBHOOK_QUEUE = 'webhook-processing';

@Module({
  imports: [
    ConfigModule, // Ensure ConfigModule is available
    PlatformConnectionsModule, // Needs connection service
    // Import modules providing Canonical Data services (ProductsService, InventoryService etc)
    ShopifyAdapterModule, // Example: Import specific adapter modules
    SquareAdapterModule,  // <<< NEW: Import Square
    PlatformAdapterRegistry, // <<< NEW: Import Registry

    // Configure BullMQ Queues
    BullModule.forRootAsync({
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => ({
            connection: {
                host: configService.get<string>('QUEUE_HOST', 'localhost'), // Use separate Redis? Or Upstash?
                port: configService.get<number>('QUEUE_PORT', 6379),
                // password: configService.get<string>('QUEUE_PASSWORD'), // Add if needed
                // Use Upstash URL directly if desired:
                // connectionString: configService.get<string>('REDIS_URL'), // Reuse throttler Redis?
                 ...(configService.get<string>('REDIS_URL') ? { connectionString: configService.get<string>('REDIS_URL') } : {}),
                 // Add TLS options if using Upstash URL
                 ...(configService.get<string>('REDIS_URL')?.startsWith('rediss://') || configService.get<string>('QUEUE_HOST') !== 'localhost' ? { tls: {} } : {}),
            },
        }),
    }),
    BullModule.registerQueue(
        { name: INITIAL_SCAN_QUEUE },
        { name: INITIAL_SYNC_QUEUE },
        { name: WEBHOOK_QUEUE },
    ),
  ],
  controllers: [WebhookController, SyncController],
  providers: [
    MappingService,
    InitialSyncService,
    SyncCoordinatorService,
    // Processors for the queues
    InitialScanProcessor,
    InitialSyncProcessor,
    PlatformAdapterRegistry, // <<< NEW: Provide Registry
    // Add WebhookProcessor etc.
  ],
  exports: [
      // Export services if needed by other modules (less common for engine)
  ]
})
export class SyncEngineModule {} 