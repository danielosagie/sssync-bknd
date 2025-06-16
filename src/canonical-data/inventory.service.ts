import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { InventoryLevel } from '../common/types/supabase.types';
import { SupabaseClient } from '@supabase/supabase-js';

// Interface for Canonical Inventory Level data based on sssync-db.md
export interface CanonicalInventoryLevel {
    Id?: string; // Optional: Will be set by DB
    ProductVariantId: string; // FK to ProductVariants.Id
    PlatformConnectionId: string; // FK to PlatformConnections.Id
    PlatformLocationId: string | null; // The platform-specific location ID (e.g., Shopify Location GID)
    Quantity: number;
    LastPlatformUpdateAt?: Date | null;
    // UpdatedAt is managed by the DB
}

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
    async updateLevel(levelData: Omit<InventoryLevel, 'Id' | 'UpdatedAt' | 'CreatedAt'>): Promise<InventoryLevel> {
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

    async saveBulkInventoryLevels(inventoryLevels: CanonicalInventoryLevel[]): Promise<void> {
        if (!inventoryLevels || inventoryLevels.length === 0) {
            this.logger.log('No inventory levels to save.');
            return;
        }

        const supabase = this.getSupabaseClient();
        this.logger.log(`Saving ${inventoryLevels.length} inventory levels...`);

        // Transform the data to match Supabase schema
        const inventoryLevelsToInsert = inventoryLevels.map(level => ({
            ProductVariantId: level.ProductVariantId,
            PlatformConnectionId: level.PlatformConnectionId,
            PlatformLocationId: level.PlatformLocationId,
            Quantity: level.Quantity,
            LastPlatformUpdateAt: level.LastPlatformUpdateAt?.toISOString() || null,
        }));

        const { error } = await supabase
            .from('InventoryLevels')
            .upsert(inventoryLevelsToInsert, {
                onConflict: 'ProductVariantId, PlatformConnectionId, PlatformLocationId',
                ignoreDuplicates: false,
            });

        if (error) {
            this.logger.error(`Failed to save inventory levels: ${error.message}`, error);
            throw new InternalServerErrorException(`Could not save inventory levels: ${error.message}`);
        }

        this.logger.log(`Successfully saved ${inventoryLevels.length} inventory levels.`);
    }

    async getInventoryLevelsForVariant(variantId: string): Promise<InventoryLevel[]> {
        const supabase = this.getSupabaseClient();
        this.logger.debug(`Fetching inventory levels for variant ${variantId}`);

        const { data, error } = await supabase
            .from('InventoryLevels')
            .select('*')
            .eq('ProductVariantId', variantId);

        if (error) {
            this.logger.error(`Error fetching inventory levels for variant ${variantId}: ${error.message}`);
            throw new InternalServerErrorException(`Could not fetch inventory levels: ${error.message}`);
        }

        return (data || []) as InventoryLevel[];
    }

    async updateInventoryLevel(
        variantId: string,
        platformConnectionId: string,
        platformLocationId: string | null,
        quantity: number
    ): Promise<InventoryLevel> {
        const supabase = this.getSupabaseClient();
        this.logger.log(`Updating inventory level for variant ${variantId}, location ${platformLocationId}`);

        const { data, error } = await supabase
            .from('InventoryLevels')
            .upsert({
                ProductVariantId: variantId,
                PlatformConnectionId: platformConnectionId,
                PlatformLocationId: platformLocationId,
                Quantity: quantity,
                LastPlatformUpdateAt: new Date().toISOString(),
            }, {
                onConflict: 'ProductVariantId, PlatformConnectionId, PlatformLocationId',
            })
            .select()
            .single();

        if (error || !data) {
            this.logger.error(`Failed to update inventory level: ${error?.message}`, error);
            throw new InternalServerErrorException(`Could not update inventory level: ${error?.message}`);
        }

        return data as InventoryLevel;
    }

    async getInventoryLevelsByProductId(productId: string): Promise<InventoryLevel[]> {
        const supabase = this.getSupabaseClient();
        this.logger.debug(`Fetching inventory levels for product ${productId}`);

        const { data, error } = await supabase
            .from('InventoryLevels')
            .select(`
                *,
                ProductVariants!inner(ProductId)
            `)
            .eq('ProductVariants.ProductId', productId);

        if (error) {
            this.logger.error(`Error fetching inventory levels for product ${productId}: ${error.message}`);
            throw new InternalServerErrorException(`Could not fetch inventory levels: ${error.message}`);
        }

        return (data || []) as InventoryLevel[];
    }

    // Add other methods as needed (getLevel, getLevelsForVariant, etc.)
} 