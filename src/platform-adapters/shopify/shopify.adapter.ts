import { Injectable } from '@nestjs/common';
import { ShopifyApiClient } from './shopify-api-client.service';
import { ShopifyMapper } from './shopify.mapper';
import { PlatformConnection } from '../../platform-connections/platform-connections.service'; // Check this path relative to shopify.adapter.ts
import { BaseAdapter } from '../base-adapter.interface'; // <<< NEW: Implement base interface

// Facade for Shopify interactions
@Injectable()
export class ShopifyAdapter implements BaseAdapter { // <<< Implement interface
    constructor(
        private readonly apiClientInstance: ShopifyApiClient, // Rename for clarity
        private readonly mapperInstance: ShopifyMapper,       // Rename for clarity
    ) {}

    // Return the configured client instance
    getApiClient(connection: PlatformConnection): ShopifyApiClient {
        return this.apiClientInstance;
    }

    // Return the mapper instance
    getMapper(): ShopifyMapper {
        return this.mapperInstance;
    }

    // Return specific sync logic handler
    getSyncLogic() {
        return {
            shouldDelist: (canonicalQuantity: number) => false,
        };
    }
} 