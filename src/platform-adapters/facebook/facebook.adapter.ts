import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, BaseSyncLogic } from '../base-adapter.interface';

@Injectable()
export class FacebookAdapter implements BaseAdapter {
    private readonly logger = new Logger(FacebookAdapter.name);

    getApiClient(connection: any): any {
        this.logger.warn('FacebookAdapter.getApiClient not implemented');
        return {
            async fetchAllRelevantData() {
                throw new Error('Facebook Shops API client not implemented yet');
            }
        };
    }

    getMapper(): any {
        this.logger.warn('FacebookAdapter.getMapper not implemented');
        return {
            mapFacebookDataToCanonical() { throw new Error('Facebook mapper not implemented'); }
        };
    }

    getSyncLogic(): BaseSyncLogic {
        return { shouldDelist: (q: number) => q <= 0 };
    }

    async syncFromPlatform(): Promise<void> {
        this.logger.warn('FacebookAdapter.syncFromPlatform not implemented');
    }

    async createProduct(): Promise<{ platformProductId: string; platformVariantIds: Record<string, string> }> {
        this.logger.warn('FacebookAdapter.createProduct not implemented');
        return { platformProductId: '', platformVariantIds: {} };
    }

    async updateProduct(): Promise<any> {
        this.logger.warn('FacebookAdapter.updateProduct not implemented');
        return {};
    }

    async deleteProduct(): Promise<void> {
        this.logger.warn('FacebookAdapter.deleteProduct not implemented');
    }

    async updateInventoryLevels(): Promise<{ successCount: number; failureCount: number; errors: string[] }> {
        this.logger.warn('FacebookAdapter.updateInventoryLevels not implemented');
        return { successCount: 0, failureCount: 0, errors: [] };
    }

    async processWebhook(): Promise<void> {
        this.logger.warn('FacebookAdapter.processWebhook not implemented');
    }

    async syncSingleProductFromPlatform(): Promise<void> {
        this.logger.warn('FacebookAdapter.syncSingleProductFromPlatform not implemented');
    }
}




