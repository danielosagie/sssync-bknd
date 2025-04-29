import { Injectable, NotFoundException } from '@nestjs/common';
import { ShopifyAdapter } from './shopify/shopify.adapter'; // Path seems correct if registry is in platform-adapters/
import { SquareAdapter } from './square/square.adapter';   // <<< NEW: Import Square adapter
import { BaseAdapter } from './base-adapter.interface';   // <<< NEW: Import base interface
// Import other adapters like SquareAdapter etc.

@Injectable()
export class PlatformAdapterRegistry {
    constructor(
        private readonly shopifyAdapter: ShopifyAdapter,
        private readonly squareAdapter: SquareAdapter,    // <<< NEW: Inject Square adapter
        // Inject other adapters: private readonly squareAdapter: SquareAdapter,
    ) {}

    getAdapter(platformType: string): BaseAdapter { // <<< Use BaseAdapter type
        switch (platformType.toLowerCase()) {
            case 'shopify':
                return this.shopifyAdapter;
            case 'square':                             // <<< NEW: Add Square case
                return this.squareAdapter;
            // case 'square':
            //     return this.squareAdapter;
            default:
                throw new NotFoundException(`Adapter not found for platform type: ${platformType}`);
        }
    }
}
