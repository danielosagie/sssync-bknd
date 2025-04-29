import { Module } from '@nestjs/common';
import { ShopifyApiClient } from './shopify-api-client.service';
import { ShopifyMapper } from './shopify.mapper';
import { ShopifyAdapter } from './shopify.adapter';
import { ConfigModule } from '@nestjs/config'; // Needed by API client

@Module({
  imports: [ConfigModule], // Import if needed
  providers: [ShopifyApiClient, ShopifyMapper, ShopifyAdapter],
  exports: [ShopifyAdapter], // Export the main adapter facade
})
export class ShopifyAdapterModule {} 