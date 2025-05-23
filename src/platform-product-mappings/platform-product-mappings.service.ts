import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { SupabaseClient } from '@supabase/supabase-js';

export interface PlatformProductMapping {
    Id: string;
    PlatformConnectionId: string;
    ProductVariantId: string;
    PlatformProductId: string;
    PlatformVariantId?: string | null;
    PlatformSku?: string | null;
    PlatformSpecificData?: Record<string, any>;
    LastSyncedAt?: string | null;
    SyncStatus?: string;
    SyncErrorMessage?: string | null;
    IsEnabled?: boolean;
    CreatedAt: string;
    UpdatedAt: string;
}

@Injectable()
export class PlatformProductMappingsService {
    private readonly logger = new Logger(PlatformProductMappingsService.name);

    constructor(private readonly supabaseService: SupabaseService) {}

    private getSupabaseClient(): SupabaseClient {
        return this.supabaseService.getServiceClient();
    }

    async createMapping(mapping: Omit<PlatformProductMapping, 'Id' | 'CreatedAt' | 'UpdatedAt'>): Promise<PlatformProductMapping> {
        const supabase = this.getSupabaseClient();
        this.logger.log(`Creating platform product mapping for variant ${mapping.ProductVariantId}`);

        const { data, error } = await supabase
            .from('PlatformProductMappings')
            .insert(mapping)
            .select()
            .single();

        if (error || !data) {
            this.logger.error(`Failed to create platform product mapping: ${error?.message}`, error);
            throw new InternalServerErrorException(`Could not create platform product mapping: ${error?.message}`);
        }

        return data as PlatformProductMapping;
    }

    async getMappingByPlatformId(platformConnectionId: string, platformProductId: string): Promise<PlatformProductMapping | null> {
        const supabase = this.getSupabaseClient();
        const { data, error } = await supabase
            .from('PlatformProductMappings')
            .select()
            .eq('PlatformConnectionId', platformConnectionId)
            .eq('PlatformProductId', platformProductId)
            .maybeSingle();

        if (error) {
            this.logger.error(`Error fetching platform product mapping: ${error.message}`);
            throw new InternalServerErrorException('Failed to retrieve platform product mapping');
        }

        return data as PlatformProductMapping | null;
    }

    async getMappingByPlatformIdentifiers(platformConnectionId: string, platformProductId: string, platformVariantId: string): Promise<PlatformProductMapping | null> {
        const supabase = this.getSupabaseClient();
        const { data, error } = await supabase
            .from('PlatformProductMappings')
            .select('*')
            .eq('PlatformConnectionId', platformConnectionId)
            .eq('PlatformProductId', platformProductId)
            .eq('PlatformVariantId', platformVariantId)
            .maybeSingle();

        if (error) {
            this.logger.error(`Error fetching mapping by platform identifiers (CxnId: ${platformConnectionId}, ProdId: ${platformProductId}, VarId: ${platformVariantId}): ${error.message}`);
            throw new InternalServerErrorException('Failed to retrieve platform product mapping by platform identifiers');
        }

        return data as PlatformProductMapping | null;
    }

    async getMappingsByVariantId(productVariantId: string): Promise<PlatformProductMapping[]> {
        const supabase = this.getSupabaseClient();
        const { data, error } = await supabase
            .from('PlatformProductMappings')
            .select()
            .eq('ProductVariantId', productVariantId);

        if (error) {
            this.logger.error(`Error fetching platform product mappings: ${error.message}`);
            throw new InternalServerErrorException('Failed to retrieve platform product mappings');
        }

        return (data || []) as PlatformProductMapping[];
    }

    async updateMapping(
        id: string,
        updates: Partial<Omit<PlatformProductMapping, 'Id' | 'CreatedAt' | 'UpdatedAt'>>
    ): Promise<PlatformProductMapping> {
        const supabase = this.getSupabaseClient();
        this.logger.log(`Updating platform product mapping ${id}`);

        const { data, error } = await supabase
            .from('PlatformProductMappings')
            .update({ ...updates, UpdatedAt: new Date().toISOString() })
            .eq('Id', id)
            .select()
            .single();

        if (error || !data) {
            this.logger.error(`Failed to update platform product mapping: ${error?.message}`, error);
            throw new InternalServerErrorException(`Could not update platform product mapping: ${error?.message}`);
        }

        return data as PlatformProductMapping;
    }

    async deleteMapping(id: string): Promise<void> {
        const supabase = this.getSupabaseClient();
        this.logger.log(`Deleting platform product mapping ${id}`);

        const { error } = await supabase
            .from('PlatformProductMappings')
            .delete()
            .eq('Id', id);

        if (error) {
            this.logger.error(`Failed to delete platform product mapping: ${error.message}`);
            throw new InternalServerErrorException('Failed to delete platform product mapping');
        }
    }

    async getMappingsByConnectionId(platformConnectionId: string, onlyActive: boolean = false): Promise<PlatformProductMapping[]> {
        const supabase = this.getSupabaseClient();
        this.logger.debug(`Fetching all mappings for connection ${platformConnectionId}, onlyActive: ${onlyActive}`);
        let query = supabase
            .from('PlatformProductMappings')
            .select('*')
            .eq('PlatformConnectionId', platformConnectionId);
        
        if (onlyActive) {
            query = query.eq('IsEnabled', true);
        }

        const { data, error } = await query;

        if (error) {
            this.logger.error(`Error fetching mappings for connection ${platformConnectionId}: ${error.message}`);
            throw new InternalServerErrorException(`Could not fetch mappings: ${error.message}`);
        }
        return (data || []) as PlatformProductMapping[];
    }

    async getMappingsByVariantIdAndConnection(variantId: string, connectionId: string): Promise<PlatformProductMapping | null> {
        const supabase = this.getSupabaseClient();
        this.logger.debug(`Fetching mapping for variant ${variantId} and connection ${connectionId}`);
        const { data, error } = await supabase
            .from('PlatformProductMappings')
            .select('*')
            .eq('ProductVariantId', variantId)
            .eq('PlatformConnectionId', connectionId)
            .maybeSingle();

        if (error) {
            this.logger.error(`Error fetching mapping for variant ${variantId} on connection ${connectionId}: ${error.message}`);
            throw new InternalServerErrorException(`Could not fetch mapping: ${error.message}`);
        }
        return data as PlatformProductMapping | null;
    }

    async getMappingsByProductIdAndConnection(productId: string, connectionId: string): Promise<PlatformProductMapping[]> {
        const supabase = this.getSupabaseClient();
        this.logger.debug(`Fetching mappings for product ${productId} and connection ${connectionId}`);
        
        const { data: variantsData, error: variantsError } = await supabase
            .from('ProductVariants')
            .select('Id')
            .eq('ProductId', productId);

        if (variantsError) {
            this.logger.error(`Error fetching variants for product ${productId}: ${variantsError.message}`);
            throw new InternalServerErrorException(`Could not fetch variants for product: ${variantsError.message}`);
        }
        if (!variantsData || variantsData.length === 0) {
            return [];
        }

        const variantIds = variantsData.map(v => v.Id);

        const { data: mappingsData, error: mappingsError } = await supabase
            .from('PlatformProductMappings')
            .select('*')
            .in('ProductVariantId', variantIds)
            .eq('PlatformConnectionId', connectionId);

        if (mappingsError) {
            this.logger.error(`Error fetching mappings for product ${productId} (via variants) on connection ${connectionId}: ${mappingsError.message}`);
            throw new InternalServerErrorException(`Could not fetch mappings for product: ${mappingsError.message}`);
        }

        return (mappingsData || []) as PlatformProductMapping[];
    }

    async getMappingByVariantIdAndPlatformProductId(
        productVariantId: string, 
        platformProductId: string, 
        platformConnectionId: string
    ): Promise<PlatformProductMapping | null> {
        const supabase = this.getSupabaseClient();
        this.logger.debug(`Fetching mapping by sssync VariantId ${productVariantId}, PlatformProductId ${platformProductId}, and ConnectionId ${platformConnectionId}`);

        const { data, error } = await supabase
            .from('PlatformProductMappings')
            .select('*')
            .eq('ProductVariantId', productVariantId)
            .eq('PlatformProductId', platformProductId)
            .eq('PlatformConnectionId', platformConnectionId)
            .maybeSingle(); // Expecting at most one such mapping

        if (error) {
            this.logger.error(`Error fetching mapping by VariantId ${productVariantId}, PlatformProductId ${platformProductId}, ConnectionId ${platformConnectionId}: ${error.message}`);
            throw new InternalServerErrorException(`Could not fetch specific product-variant mapping: ${error.message}`);
        }

        return data as PlatformProductMapping | null;
    }

    async getMappingByPlatformVariantIdAndConnection(
        platformVariantId: string,
        platformConnectionId: string,
    ): Promise<PlatformProductMapping | null> {
        const supabase = this.getSupabaseClient();
        this.logger.debug(`Fetching mapping by PlatformVariantId ${platformVariantId} and ConnectionId ${platformConnectionId}`);

        const { data, error } = await supabase
            .from('PlatformProductMappings')
            .select('*')
            .eq('PlatformVariantId', platformVariantId)
            .eq('PlatformConnectionId', platformConnectionId)
            .maybeSingle(); // Expecting at most one such mapping

        if (error) {
            this.logger.error(`Error fetching mapping for PlatformVariantId ${platformVariantId}, ConnectionId ${platformConnectionId}: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Could not fetch mapping by PlatformVariantId and ConnectionId: ${error.message}`);
        }
        if (!data) {
            this.logger.debug(`No mapping found for PlatformVariantId ${platformVariantId}, ConnectionId ${platformConnectionId}`);
            return null;
        }
        return data as PlatformProductMapping;
    }

    async getMappingsByPlatformProductId(platformConnectionId: string, platformProductId: string): Promise<PlatformProductMapping[]> {
        const supabase = this.getSupabaseClient();
        this.logger.debug(`Fetching mappings for Connection ${platformConnectionId} and Platform Product ID ${platformProductId}`);

        const { data, error } = await supabase
            .from('PlatformProductMappings')
            .select('*')
            .eq('PlatformConnectionId', platformConnectionId)
            .eq('PlatformProductId', platformProductId);

        if (error) {
            this.logger.error(`Error fetching mappings for PlatformProductId ${platformProductId} on Connection ${platformConnectionId}: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Could not fetch mappings by PlatformProductId: ${error.message}`);
        }

        return (data || []) as PlatformProductMapping[];
    }

    async getMappingByPlatformVariantInventoryItemId(platformConnectionId: string, platformInventoryItemId: string): Promise<PlatformProductMapping | null> {
        const supabase = this.getSupabaseClient();
        this.logger.debug(`Fetching mapping by Connection ${platformConnectionId} and Platform Inventory Item ID ${platformInventoryItemId}`);

        const { data, error } = await supabase
            .from('PlatformProductMappings')
            .select('*')
            .eq('PlatformConnectionId', platformConnectionId)
            .eq('PlatformSpecificData->>shopifyInventoryItemId', platformInventoryItemId)
            .maybeSingle();

        if (error) {
            this.logger.error(`Error fetching mapping for PlatformInventoryItemId ${platformInventoryItemId} on Connection ${platformConnectionId}: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Could not fetch mapping by PlatformInventoryItemId: ${error.message}`);
        }
        if (data) {
            this.logger.log(`Found mapping for inv item id ${platformInventoryItemId}: ${data.Id}`);
        } else {
            this.logger.log(`No mapping found for inv item id ${platformInventoryItemId}`);
        }
        return data as PlatformProductMapping | null;
    }
} 