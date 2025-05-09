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
import { InitialScanProcessor } from './processors/initial-scan.processor'; // Keep import for provider list
import { InitialSyncProcessor } from './processors/initial-sync.processor'; // Keep import for provider list
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
    // /* // Temporarily commented out to avoid Redis connection issues // Removed outer comment block
    BullModule.forRootAsync({
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => {
            const redisUrl = configService.get<string>('REDIS_URL');
            if (!redisUrl) {
                 console.error('[BullMQ Config] *** REDIS_URL is not defined! BullMQ will likely fail. ***');
                 return { connection: {} }; 
            }
            console.log(`[BullMQ Config] Using REDIS_URL: ${redisUrl ? '**** (set)' : 'undefined'}`);
            const tlsOptions = redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}; 
            return {
                connection: { 
                    host: new URL(redisUrl).hostname,
                    port: parseInt(new URL(redisUrl).port),
                    password: new URL(redisUrl).password,
                    ...(tlsOptions) 
                },
            };
        },
    }),
    BullModule.registerQueue(
        { name: INITIAL_SCAN_QUEUE },
        { name: INITIAL_SYNC_QUEUE },
        // { name: WEBHOOK_QUEUE }, 
    ),
    // */ // End of temporary comment out // Removed outer comment block
    // <<< END UNCOMMENT BullMQ Config >>>
  ],
  controllers: [WebhookController, SyncController],
  providers: [
    MappingService,
    InitialSyncService, // Needs adjustment for InjectQueue
    SyncCoordinatorService,
    // Processors for the queues
    InitialScanProcessor,
    InitialSyncProcessor,
    PlatformAdapterRegistry, // <<< ENSURE it's in providers
    // Add WebhookProcessor etc.
  ],
  exports: [
      // Export services if needed by other modules (less common for engine)
      PlatformAdapterRegistry, // <<< ENSURE it's in exports
      InitialScanProcessor, // <<< EXPORT InitialScanProcessor
      InitialSyncService, // Might be needed if other modules queue jobs directly, good practice to export if it has public methods used elsewhere
      MappingService, // If other modules need mapping services directly
  ]
})
export class SyncEngineModule {} 