import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq'; // Import BullModule
import { ConfigModule, ConfigService } from '@nestjs/config'; // Needed for queue config
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';
import { CommonModule } from '../common/common.module'; // <<< IMPORT CommonModule
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
import { INITIAL_SCAN_QUEUE, INITIAL_SYNC_QUEUE, WEBHOOK_QUEUE } from './sync-engine.constants'; // <<< IMPORT from new file

@Module({
  imports: [
    ConfigModule, // Ensure ConfigModule is available
    PlatformConnectionsModule, // Needs connection service
    CommonModule, // <<< ADD CommonModule HERE
    // Import modules providing Canonical Data services (ProductsService, InventoryService etc)
    ShopifyAdapterModule, // Example: Import specific adapter modules
    SquareAdapterModule,  // <<< NEW: Import Square
    // PlatformAdapterRegistry, // <<< REMOVED from imports
    BullModule, // <<< Explicitly import BullModule

    // Configure BullMQ Queues
    BullModule.forRootAsync({
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => {
            const redisUrl = configService.get<string>('REDIS_URL');
            // --- Add Logging Here ---
            console.log(`[BullMQ Config] Using REDIS_URL: ${redisUrl}`);
            // --- End Logging ---
            return {
                connection: redisUrl
                    ? { // Use connectionString if REDIS_URL is provided
                          connectionString: redisUrl,
                          // Explicitly add TLS options needed for rediss://
                          ...(redisUrl.startsWith('rediss://') ? { tls: {} } : {}),
                      }
                    : { // Fallback to host/port (Likely hitting this?)
                          host: configService.get<string>('QUEUE_HOST', 'localhost'),
                          port: configService.get<number>('QUEUE_PORT', 6379),
                      },
            };
        },
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
    PlatformAdapterRegistry, // <<< ENSURE it's in providers
    // Add WebhookProcessor etc.
  ],
  exports: [
      // Export services if needed by other modules (less common for engine)
      PlatformAdapterRegistry // <<< ENSURE it's in exports
  ]
})
export class SyncEngineModule {} 