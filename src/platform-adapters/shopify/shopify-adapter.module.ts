import { Module } from '@nestjs/common';
import { ShopifyApiClient } from './shopify-api-client.service';
import { ShopifyMapper } from './shopify.mapper';
import { ShopifyAdapter } from './shopify.adapter';
import { ConfigModule } from '@nestjs/config'; // Needed by API client
import { PlatformConnectionsModule } from '../../platform-connections/platform-connections.module';

@Module({
  imports: [
    ConfigModule, // Import if needed
    PlatformConnectionsModule // <<< ADD IT HERE
  ],
  providers: [ShopifyApiClient, ShopifyMapper, ShopifyAdapter],
  exports: [ShopifyAdapter], // Export the main adapter facade
})
export class ShopifyAdapterModule {} 