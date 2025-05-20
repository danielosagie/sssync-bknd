import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { SupabaseClient } from '@supabase/supabase-js';

export interface PlatformProductMapping {
    Id: string;
    PlatformConnectionId: string;
    ProductVariantId: string;
    PlatformProductId: string;
    PlatformVariantId: string;
    PlatformSku: string;
    PlatformSpecificData?: Record<string, any>;
    CreatedAt: string;
    UpdatedAt: string;
}

@Injectable()
export class PlatformProductMappingsService {
    private readonly logger = new Logger(PlatformProductMappingsService.name);

    constructor(private readonly supabaseService: SupabaseService) {}

    private getSupabaseClient(): SupabaseClient {
        return this.supabaseService.getClient();
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
        
        // if (onlyActive) { // Assuming IsEnabled or similar field might be added to mappings later
        //     query = query.eq('IsEnabled', true);
        // }

        const { data, error } = await query;

        if (error) {
            this.logger.error(`Error fetching mappings for connection ${platformConnectionId}: ${error.message}`);
            throw new InternalServerErrorException(`Could not fetch mappings: ${error.message}`);
        }
        return (data || []) as PlatformProductMapping[];
    }
} 