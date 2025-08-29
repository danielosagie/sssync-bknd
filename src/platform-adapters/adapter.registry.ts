import { Injectable } from '@nestjs/common';
import { ShopifyAdapter } from './shopify/shopify.adapter';
import { SquareAdapter } from './square/square.adapter';
import { CloverAdapter } from './clover/clover.adapter';
import { BaseAdapter } from './base-adapter.interface';
import { EbayAdapter } from './ebay/ebay.adapter';
import { FacebookAdapter } from './facebook/facebook.adapter';
import { WhatnotAdapter } from './whatnot/whatnot.adapter';

@Injectable()
export class PlatformAdapterRegistry {
    constructor(
        private readonly shopifyAdapter: ShopifyAdapter,
        private readonly squareAdapter: SquareAdapter,
        private readonly cloverAdapter: CloverAdapter,
        private readonly ebayAdapter: EbayAdapter,
        private readonly facebookAdapter: FacebookAdapter,
        private readonly whatnotAdapter: WhatnotAdapter,
    ) {}

    getAdapter(platformType: string): BaseAdapter {
        switch (platformType.toLowerCase()) {
            case 'shopify':
                return this.shopifyAdapter;
            case 'square':
                return this.squareAdapter;
            case 'clover':
                return this.cloverAdapter;
            case 'ebay':
                return this.ebayAdapter;
            case 'facebook':
                return this.facebookAdapter;
            case 'whatnot':
                return this.whatnotAdapter;
            default:
                throw new Error(`Unsupported platform type: ${platformType}`);
        }
    }
}
