import { Module, forwardRef } from '@nestjs/common';
import { ShopifyApiClient } from './shopify-api-client.service';
import { ShopifyMapper } from './shopify.mapper';
import { ShopifyAdapter } from './shopify.adapter';
import { ConfigModule } from '@nestjs/config'; // Needed by API client
import { PlatformConnectionsModule } from '../../platform-connections/platform-connections.module';
import { CanonicalDataModule } from '../../canonical-data/canonical-data.module';
import { PlatformProductMappingsModule } from '../../platform-product-mappings/platform-product-mappings.module';

@Module({
  imports: [
    ConfigModule, // Import if needed
    forwardRef(() => PlatformConnectionsModule), // <<< ADD forwardRef HERE
    CanonicalDataModule,
    PlatformProductMappingsModule,
  ],
  providers: [ShopifyApiClient, ShopifyMapper, ShopifyAdapter],
  exports: [ShopifyAdapter, ShopifyApiClient], // Export the main adapter facade AND ShopifyApiClient
})
export class ShopifyAdapterModule {} 