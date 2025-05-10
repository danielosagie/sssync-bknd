import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service'; // Adjust path
import { InventoryLevel } from './entities/inventory-level.entity';
import { SupabaseClient } from '@supabase/supabase-js';

// Interface for Canonical Inventory Level data based on sssync-db.md
export interface CanonicalInventoryLevel {
    Id?: string; // Optional: Will be set by DB
    ProductVariantId: string; // FK to ProductVariants.Id
    PlatformConnectionId: string; // FK to PlatformConnections.Id
    PlatformLocationId: string; // The platform-specific location ID (e.g., Shopify Location GID)
    Quantity: number;
    // UpdatedAt is managed by the DB
}

@Injectable()
export class InventoryService {
    private readonly logger = new Logger(InventoryService.name);
    private supabase: SupabaseClient;

    constructor(private readonly supabaseService: SupabaseService) {
        this.supabase = this.supabaseService.getServiceClient(); // Use service client for direct DB access
    }

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

    async saveBulkInventoryLevels(levels: CanonicalInventoryLevel[]): Promise<void> {
        if (!levels || levels.length === 0) {
            this.logger.log('No inventory levels to save.');
            return;
        }

        this.logger.log(`Saving ${levels.length} inventory levels to the database.`);

        // Map to DB column names if they differ, though they seem to match here.
        // Ensure ProductVariantId, PlatformConnectionId are populated correctly before calling this.
        const recordsToInsert = levels.map(level => ({
            ProductVariantId: level.ProductVariantId,
            PlatformConnectionId: level.PlatformConnectionId,
            PlatformLocationId: level.PlatformLocationId,
            Quantity: level.Quantity,
            // UpdatedAt will be set by default in the DB
        }));

        const { data, error } = await this.supabase
            .from('InventoryLevels')
            .upsert(recordsToInsert, {
                onConflict: 'ProductVariantId, PlatformConnectionId, PlatformLocationId', // Specify conflict target
                ignoreDuplicates: false, // Set to false to update on conflict
            });

        if (error) {
            this.logger.error(`Error saving inventory levels: ${error.message}`, error.stack);
            throw new Error(`Failed to save inventory levels: ${error.message}`);
        }

        this.logger.log(`${recordsToInsert.length} inventory levels saved successfully.`);
        // Data returned by upsert might contain the saved records if needed, but Supabase v2 often returns null on upsert unless .select() is added.
        // For now, we assume success if no error.
    }

    // Add other methods as needed (getLevel, getLevelsForVariant, etc.)
} 