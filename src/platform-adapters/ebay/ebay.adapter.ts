import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, BaseSyncLogic } from '../base-adapter.interface';
import { EbayApiClient } from './ebay-api-client.service';
import { EbayMapper } from './ebay.mapper';
import { PlatformConnection } from '../../platform-connections/platform-connections.service';

@Injectable()
export class EbayAdapter implements BaseAdapter {
    private readonly logger = new Logger(EbayAdapter.name);

    constructor(private readonly api: EbayApiClient, private readonly mapper: EbayMapper) {}

    getApiClient(connection: PlatformConnection): EbayApiClient {
        return this.api;
    }

    getMapper(): EbayMapper {
        return this.mapper;
    }

    getSyncLogic(): BaseSyncLogic {
        return { shouldDelist: (q: number) => q <= 0 };
    }

    async syncFromPlatform(connection: PlatformConnection, userId: string): Promise<void> {
        const data = await this.api.fetchAllRelevantData(connection);
        const mapped = this.mapper.mapEbayDataToCanonical(data, userId, connection.Id);
        this.logger.log(`Fetched ${mapped.canonicalProducts.length} products from eBay (read-only)`);
    }

    async createProduct(): Promise<{ platformProductId: string; platformVariantIds: Record<string, string> }> {
        this.logger.warn('EbayAdapter.createProduct not implemented');
        return { platformProductId: '', platformVariantIds: {} };
    }

    async updateProduct(): Promise<any> {
        this.logger.warn('EbayAdapter.updateProduct not implemented');
        return {};
    }

    async deleteProduct(): Promise<void> {
        this.logger.warn('EbayAdapter.deleteProduct not implemented');
    }

    async updateInventoryLevels(): Promise<{ successCount: number; failureCount: number; errors: string[] }> {
        this.logger.warn('EbayAdapter.updateInventoryLevels not implemented');
        return { successCount: 0, failureCount: 0, errors: [] };
    }

    async processWebhook(): Promise<void> {
        this.logger.warn('EbayAdapter.processWebhook not implemented');
    }

    async syncSingleProductFromPlatform(): Promise<void> {
        this.logger.warn('EbayAdapter.syncSingleProductFromPlatform not implemented');
    }
}


