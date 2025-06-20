import { Module, forwardRef } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ShopifyApiClient } from './shopify-api-client.service';
import { ShopifyMapper } from './shopify.mapper';
import { ShopifyAdapter } from './shopify.adapter';
import { ShopifyProductManagerService } from './shopify-product-manager.service';
import { ShopifyProductsController } from './shopify-products.controller';
import { ConfigModule } from '@nestjs/config'; // Needed by API client
import { PlatformConnectionsModule } from '../../platform-connections/platform-connections.module';
import { CanonicalDataModule } from '../../canonical-data/canonical-data.module';
import { PlatformProductMappingsModule } from '../../platform-product-mappings/platform-product-mappings.module';
import { CommonModule } from '../../common/common.module';
import { AiGenerationService } from '../../products/ai-generation/ai-generation.service';
import { SyncEventsService } from '../../sync-engine/sync-events.service';

@Module({
  imports: [
    ConfigModule, // Import if needed
    EventEmitterModule.forRoot(),
    CommonModule,
    forwardRef(() => PlatformConnectionsModule), // <<< ADD forwardRef HERE
    CanonicalDataModule,
    PlatformProductMappingsModule,
  ],
  controllers: [ShopifyProductsController],
  providers: [ShopifyApiClient, ShopifyMapper, ShopifyAdapter, ShopifyProductManagerService, AiGenerationService, SyncEventsService],
  exports: [ShopifyAdapter, ShopifyApiClient, ShopifyProductManagerService], // Export the main adapter facade AND ShopifyApiClient
})
export class ShopifyAdapterModule {} 