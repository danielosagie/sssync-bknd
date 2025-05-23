import { Module, Global } from '@nestjs/common';
import { ShopifyAdapterModule } from './shopify/shopify-adapter.module';
import { SquareAdapterModule } from './square/square-adapter.module';
import { CloverAdapterModule } from './clover/clover-adapter.module';
import { PlatformAdapterRegistry } from './adapter.registry';

@Global()
@Module({
    imports: [
        ShopifyAdapterModule,
        SquareAdapterModule,
        CloverAdapterModule,
    ],
    providers: [
        PlatformAdapterRegistry,
    ],
    exports: [
        PlatformAdapterRegistry,
        ShopifyAdapterModule,
        SquareAdapterModule,
        CloverAdapterModule,
    ],
})
export class PlatformAdaptersModule {} 