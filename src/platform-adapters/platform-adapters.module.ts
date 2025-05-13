import { Module } from '@nestjs/common';
import { ShopifyApiClient } from './shopify/shopify-api-client.service';
import { CommonModule } from '../common/common.module';
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';

@Module({
    imports: [CommonModule, PlatformConnectionsModule],
    providers: [ShopifyApiClient],
    exports: [ShopifyApiClient],
})
export class PlatformAdaptersModule {} 