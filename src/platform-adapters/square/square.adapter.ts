import { Injectable } from '@nestjs/common';
import { SquareApiClient } from './square-api-client.service';
import { SquareMapper } from './square.mapper';
import { PlatformConnection } from '../../platform-connections/platform-connections.service'; // Adjust path
import { BaseAdapter } from '../base-adapter.interface'; // Adjust path

@Injectable()
export class SquareAdapter implements BaseAdapter {
    constructor(
        private readonly apiClientInstance: SquareApiClient,
        private readonly mapperInstance: SquareMapper,
    ) {}

    getApiClient(connection: PlatformConnection): SquareApiClient {
        this.apiClientInstance.initialize(connection);
        return this.apiClientInstance;
    }

    getMapper(): SquareMapper {
        return this.mapperInstance;
    }

    getSyncLogic() {
        // TODO: Implement Square specific logic (e.g., inventory handling)
        return {
            shouldDelist: (canonicalQuantity: number) => true, // Example: Maybe Square requires delisting?
        };
    }
}
