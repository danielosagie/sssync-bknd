import { Module, Global, forwardRef } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';

// Import individual platform adapter modules
import { ShopifyAdapterModule } from './shopify/shopify-adapter.module';
import { SquareAdapterModule } from './square/square-adapter.module';
import { CloverAdapterModule } from './clover/clover-adapter.module';

// Import the registry
import { PlatformAdapterRegistry } from './adapter.registry';

@Global()
@Module({
    imports: [
        CommonModule,
        PlatformConnectionsModule,
        ShopifyAdapterModule,
        SquareAdapterModule,
        CloverAdapterModule,
    ],
    providers: [
        PlatformAdapterRegistry,
    ],
    exports: [
        PlatformAdapterRegistry,
    ],
})
export class PlatformAdaptersModule {} 