import { Injectable, Logger } from '@nestjs/common';
import { CloverApiClient } from './clover-api-client.service';
import { CloverMapper } from './clover.mapper';
import { PlatformConnection } from '../../platform-connections/platform-connections.service'; // Adjust path
import { BaseAdapter, BaseSyncLogic } from '../base-adapter.interface'; // Adjust path

@Injectable()
export class CloverAdapter implements BaseAdapter {
    private readonly logger = new Logger(CloverAdapter.name);

    constructor(
        private readonly apiClientInstance: CloverApiClient,
        private readonly mapperInstance: CloverMapper,
    ) {}

    getApiClient(connection: PlatformConnection): CloverApiClient {
        // Initialization of the client with connection-specific details (like token)
        // happens within the apiClientInstance itself, typically via an init() method called here or by its methods.
        // The apiClientInstance.initialize(connection) method should handle setting up the token.
        this.logger.debug(`Returning Clover API client for connection: ${connection.Id}`);
        return this.apiClientInstance;
    }

    getMapper(): CloverMapper {
        this.logger.debug('Returning Clover mapper.');
        return this.mapperInstance;
    }

    getSyncLogic(): BaseSyncLogic {
        this.logger.debug('Returning Clover sync logic.');
        // TODO: Implement Clover-specific sync logic
        // Example: How Clover handles inventory, delisting, etc.
        return {
            shouldDelist: (canonicalQuantity: number) => {
                // Example: Clover might not support setting quantity to 0 for active items,
                // so delist if quantity is 0.
                return canonicalQuantity <= 0;
            },
            // Add other Clover-specific rules as needed
        };
    }
} 