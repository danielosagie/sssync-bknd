import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, BaseSyncLogic } from '../base-adapter.interface';

@Injectable()
export class WhatnotAdapter implements BaseAdapter {
    private readonly logger = new Logger(WhatnotAdapter.name);

    getApiClient(connection: any): any {
        this.logger.warn('WhatnotAdapter.getApiClient not implemented');
        return {
            async fetchAllRelevantData() {
                throw new Error('Whatnot API client/bot not implemented yet');
            }
        };
    }

    getMapper(): any {
        this.logger.warn('WhatnotAdapter.getMapper not implemented');
        return {
            mapWhatnotDataToCanonical() { throw new Error('Whatnot mapper not implemented'); }
        };
    }

    getSyncLogic(): BaseSyncLogic {
        return { shouldDelist: (q: number) => q <= 0 };
    }

    async syncFromPlatform(): Promise<void> {
        this.logger.warn('WhatnotAdapter.syncFromPlatform not implemented');
    }

    async createProduct(): Promise<{ platformProductId: string; platformVariantIds: Record<string, string> }> {
        this.logger.warn('WhatnotAdapter.createProduct not implemented');
        return { platformProductId: '', platformVariantIds: {} };
    }

    async updateProduct(): Promise<any> {
        this.logger.warn('WhatnotAdapter.updateProduct not implemented');
        return {};
    }

    async deleteProduct(): Promise<void> {
        this.logger.warn('WhatnotAdapter.deleteProduct not implemented');
    }

    async updateInventoryLevels(): Promise<{ successCount: number; failureCount: number; errors: string[] }> {
        this.logger.warn('WhatnotAdapter.updateInventoryLevels not implemented');
        return { successCount: 0, failureCount: 0, errors: [] };
    }

    async processWebhook(): Promise<void> {
        this.logger.warn('WhatnotAdapter.processWebhook not implemented');
    }

    async syncSingleProductFromPlatform(): Promise<void> {
        this.logger.warn('WhatnotAdapter.syncSingleProductFromPlatform not implemented');
    }
}


