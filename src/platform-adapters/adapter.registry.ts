import { Injectable } from '@nestjs/common';
import { ShopifyAdapter } from './shopify/shopify.adapter';
import { SquareAdapter } from './square/square.adapter';
import { CloverAdapter } from './clover/clover.adapter';
import { BaseAdapter } from './base-adapter.interface';

@Injectable()
export class PlatformAdapterRegistry {
    constructor(
        private readonly shopifyAdapter: ShopifyAdapter,
        private readonly squareAdapter: SquareAdapter,
        private readonly cloverAdapter: CloverAdapter,
    ) {}

    getAdapter(platformType: string): BaseAdapter {
        switch (platformType.toLowerCase()) {
            case 'shopify':
                return this.shopifyAdapter;
            case 'square':
                return this.squareAdapter;
            case 'clover':
                return this.cloverAdapter;
            default:
                throw new Error(`Unsupported platform type: ${platformType}`);
        }
    }
}
