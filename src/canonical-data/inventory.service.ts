import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service'; // Adjust path
import { InventoryLevel } from './entities/inventory-level.entity';
import { SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class InventoryService {
    private readonly logger = new Logger(InventoryService.name);

    constructor(private supabaseService: SupabaseService) {}

    private getSupabaseClient(): SupabaseClient {
        return this.supabaseService.getClient();
    }

    /**
     * Updates or inserts an inventory level record.
     * Uses the unique constraint on (ProductVariantId, PlatformConnectionId, PlatformLocationId).
     */
    async updateLevel(levelData: Omit<InventoryLevel, 'Id' | 'UpdatedAt'>): Promise<InventoryLevel> {
        const supabase = this.getSupabaseClient();
        const { ProductVariantId, PlatformConnectionId, PlatformLocationId, Quantity } = levelData;
        const locationLog = PlatformLocationId || '[default]';
        this.logger.log(`Upserting inventory level for variant ${ProductVariantId}, connection ${PlatformConnectionId}, location ${locationLog} to ${Quantity}`);

        const upsertData = {
            ProductVariantId,
            PlatformConnectionId,
            PlatformLocationId: PlatformLocationId || null, // Ensure null is stored correctly
            Quantity,
            UpdatedAt: new Date().toISOString(),
        };

        const { data, error } = await supabase
            .from('InventoryLevels')
            .upsert(upsertData, {
                onConflict: 'ProductVariantId, PlatformConnectionId, PlatformLocationId', // Specify conflict columns based on UNIQUE constraint
                // ignoreDuplicates: false // Default is false, ensures update happens
            })
            .select()
            .single(); // Expecting one row back after upsert

        if (error || !data) {
            this.logger.error(`Failed to upsert inventory level for V:${ProductVariantId}, C:${PlatformConnectionId}, L:${locationLog}: ${error?.message}`, error);
            throw new InternalServerErrorException(`Could not update inventory level: ${error?.message}`);
        }

        this.logger.log(`Successfully upserted inventory level ID: ${data.Id}`);
        return data as InventoryLevel;
    }

    // Add other methods as needed (getLevel, getLevelsForVariant, etc.)
} 