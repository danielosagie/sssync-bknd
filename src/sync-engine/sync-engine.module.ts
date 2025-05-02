import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq'; // <<< UNCOMMENT
import { ConfigModule, ConfigService } from '@nestjs/config'; // Needed for queue config
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';
import { CommonModule } from '../common/common.module'; // <<< IMPORT CommonModule
import { CanonicalDataModule } from '../canonical-data/canonical-data.module'; // <<< IMPORT Canonical Data
// Import Canonical Data Services/Modules if they exist
// import { ProductsModule } from '../products/products.module';
// import { InventoryModule } from '../inventory/inventory.module';
import { MappingService } from './mapping.service';
import { InitialSyncService } from './initial-sync.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { InitialScanProcessor } from './processors/initial-scan.processor'; // <<< UNCOMMENT
import { InitialSyncProcessor } from './processors/initial-sync.processor'; // <<< UNCOMMENT
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
    CanonicalDataModule, // <<< ADD CanonicalDataModule HERE
    // Import modules providing Canonical Data services (ProductsService, InventoryService etc)
    ShopifyAdapterModule, // Example: Import specific adapter modules
    SquareAdapterModule,  // <<< NEW: Import Square
    // PlatformAdapterRegistry, // <<< REMOVED from imports
    BullModule, // <<< UNCOMMENT

    // <<< UNCOMMENT BullMQ Config >>>
    // /*
    BullModule.forRootAsync({
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => {
            const redisUrl = configService.get<string>('REDIS_URL');
            if (!redisUrl) {
                 console.error('[BullMQ Config] *** REDIS_URL is not defined! BullMQ will likely fail. ***');
                 // Optionally throw an error to prevent startup?
                 // throw new Error('REDIS_URL is not defined for BullMQ');
                 // Or return a config that will fail clearly
                 return { connection: {} }; // This will likely cause connection errors
            }
            console.log(`[BullMQ Config] Using REDIS_URL: ${redisUrl ? '**** (set)' : 'undefined'}`);
            // Basic config using REDIS_URL (handles Upstash rediss:// with TLS)
            return {
                connection: { connectionString: redisUrl, tls: redisUrl.startsWith('rediss://') ? {} : undefined },
                // connection: redisUrl // Simpler if connectionString/tls isn't needed explicitly
                    // ? { connectionString: redisUrl, ...(redisUrl.startsWith('rediss://') ? { tls: {} } : {}) }
                    // : { host: configService.get<string>('QUEUE_HOST', 'localhost'), port: configService.get<number>('QUEUE_PORT', 6379) }, // Fallback removed, rely on REDIS_URL
            };
        },
    }),
    BullModule.registerQueue(
        { name: INITIAL_SCAN_QUEUE },
        { name: INITIAL_SYNC_QUEUE },
        // { name: WEBHOOK_QUEUE }, // Keep commented unless webhook processor is used
    ),
    // */
    // <<< END UNCOMMENT BullMQ Config >>>
  ],
  controllers: [WebhookController, SyncController],
  providers: [
    MappingService,
    InitialSyncService, // Note: This service will fail if not commented out/modified due to missing @InjectQueue
    SyncCoordinatorService,
    // Processors for the queues
    InitialScanProcessor, // <<< UNCOMMENT
    InitialSyncProcessor, // <<< UNCOMMENT
    PlatformAdapterRegistry, // <<< ENSURE it's in providers
    // Add WebhookProcessor etc.
  ],
  exports: [
      // Export services if needed by other modules (less common for engine)
      PlatformAdapterRegistry // <<< ENSURE it's in exports
  ]
})
export class SyncEngineModule {} 