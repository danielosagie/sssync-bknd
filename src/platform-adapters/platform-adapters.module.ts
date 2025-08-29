import { Module, Global } from '@nestjs/common';
import { ShopifyAdapterModule } from './shopify/shopify-adapter.module';
import { SquareAdapterModule } from './square/square-adapter.module';
import { CloverAdapterModule } from './clover/clover-adapter.module';
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';
import { PlatformAdapterRegistry } from './adapter.registry';
import { EbayAdapter } from './ebay/ebay.adapter';
import { EbayApiClient } from './ebay/ebay-api-client.service';
import { EbayMapper } from './ebay/ebay.mapper';
import { FacebookAdapter } from './facebook/facebook.adapter';
import { WhatnotAdapter } from './whatnot/whatnot.adapter';

@Global()
@Module({
    imports: [
        ShopifyAdapterModule,
        SquareAdapterModule,
        CloverAdapterModule,
        PlatformConnectionsModule,
    ],
    providers: [
        PlatformAdapterRegistry,
        EbayApiClient,
        EbayMapper,
        EbayAdapter,
        FacebookAdapter,
        WhatnotAdapter,
    ],
    exports: [
        PlatformAdapterRegistry,
        ShopifyAdapterModule,
        SquareAdapterModule,
        CloverAdapterModule,
        EbayApiClient,
        EbayMapper,
        EbayAdapter,
        FacebookAdapter,
        WhatnotAdapter,
    ],
})
export class PlatformAdaptersModule {} 