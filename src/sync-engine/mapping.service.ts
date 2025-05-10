import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service'; // Adjust path
import { PlatformConnection, PlatformConnectionsService } from '../platform-connections/platform-connections.service'; // Adjust path
import { SupabaseClient } from '@supabase/supabase-js';
import { ProductVariant } from '../canonical-data/entities/product-variant.entity'; // <<< Import Canonical type
import { ProductsService } from '../canonical-data/products.service'; // <<< Import ProductsService

// Interfaces (define more comprehensively based on needs)
export interface PlatformProductData {
    id: string; // Platform GID/ID
    sku?: string | null;
    barcode?: string | null;
    title?: string | null;
    // Add other raw fields needed for displaying suggestions
    price?: string | number | null;
    imageUrl?: string | null;
}

// Re-using canonical type definition
// interface CanonicalVariantData {
//     Id: string; // sssync ProductVariant Id
//     Sku?: string | null;
//     Barcode?: string | null;
//     Title?: string | null;
// }

export interface MappingSuggestion {
    platformProduct: PlatformProductData;
    suggestedCanonicalVariant?: Partial<ProductVariant> | null; // Use Partial<ProductVariant>
    matchType: 'SKU' | 'BARCODE' | 'NONE';
    confidence: number; // 0 to 1
}

export interface ConfirmedMatch {
    platformProductId: string;
    platformVariantId?: string | null; // Store if available/relevant (e.g., Shopify)
    platformProductSku?: string | null; // Store for reference
    platformProductTitle?: string | null; // Store for reference
    sssyncVariantId?: string | null; // Null if creating new
    action: 'link' | 'create' | 'ignore';
}

// Structure stored in PlatformSpecificData
interface StoredConfirmationData {
    confirmedMatches: ConfirmedMatch[];
    confirmedAt: string; // ISO timestamp
}

@Injectable()
export class MappingService {
    private readonly logger = new Logger(MappingService.name);

    constructor(
        private supabaseService: SupabaseService,
        // Inject services needed for suggestions and saving
        private productsService: ProductsService,
        private connectionsService: PlatformConnectionsService
    ) {}

    // Optional: Add helper if preferred, or call directly
    private getSupabaseClient(): SupabaseClient {
        return this.supabaseService.getClient();
    }

    /**
     * Generates mapping suggestions by comparing platform data against existing canonical data.
     */
    async generateSuggestions(platformData: { products: any[], variants: PlatformProductData[] /* Adapt based on adapter output */ }, userId: string, platformType: string): Promise<MappingSuggestion[]> {
        const supabase = this.getSupabaseClient();
        this.logger.log(`Generating mapping suggestions for ${platformType}, user ${userId}`);

        // 1. Get all existing canonical variants for the user
        const canonicalVariants = await this.productsService.findVariantsByUserId(userId);

        const suggestions: MappingSuggestion[] = [];
        const canonicalVariantsMap = new Map<string, Partial<ProductVariant>>();
        const canonicalBarcodesMap = new Map<string, Partial<ProductVariant>>();
        canonicalVariants?.forEach(v => {
            if (v.Sku) canonicalVariantsMap.set(v.Sku.trim().toLowerCase(), v);
            if (v.Barcode) canonicalBarcodesMap.set(v.Barcode.trim().toLowerCase(), v);
        });

        const itemsToMap: PlatformProductData[] = platformData.variants?.length > 0 ? platformData.variants : platformData.products;

        if (!itemsToMap || itemsToMap.length === 0) {
             this.logger.warn(`No platform items provided to generate suggestions for ${platformType}, user ${userId}.`);
             return [];
        }

        for (const item of itemsToMap) {
            let match: Partial<ProductVariant> | null = null;
            let matchType: MappingSuggestion['matchType'] = 'NONE';
            let confidence = 0;

            if (!item || !item.id) continue;

            const itemSku = item.sku?.trim().toLowerCase();
            const itemBarcode = item.barcode?.trim().toLowerCase();

            // Try barcode match first
            if (itemBarcode && canonicalBarcodesMap.has(itemBarcode)) {
                match = canonicalBarcodesMap.get(itemBarcode)!;
                matchType = 'BARCODE';
                confidence = 0.95;
            }

            // Try SKU match ONLY if barcode didn't match OR if SKU match is a DIFFERENT variant
            if (itemSku && canonicalVariantsMap.has(itemSku)) {
                const skuMatch = canonicalVariantsMap.get(itemSku)!;
                // If no barcode match OR if the SKU match is different from the barcode match
                if (matchType !== 'BARCODE' || (match && skuMatch.Id !== match.Id)) {
                     match = skuMatch;
                     matchType = 'SKU';
                     confidence = 0.90;
                }
            }

            suggestions.push({
                platformProduct: item,
                suggestedCanonicalVariant: match ?? null,
                matchType: matchType,
                confidence: confidence,
            });
        }

        this.logger.log(`Generated ${suggestions.length} mapping suggestions for ${platformType}, user ${userId}`);
        return suggestions;
    }

    /**
     * Saves the mappings confirmed by the user into PlatformConnections.PlatformSpecificData.
     */
    async saveConfirmedMappings(connection: PlatformConnection, confirmationData: { confirmedMatches: ConfirmedMatch[] }): Promise<void> {
        this.logger.log(`Saving ${confirmationData.confirmedMatches.length} confirmed mappings for connection ${connection.Id}`);

        const dataToStore: StoredConfirmationData = {
            confirmedMatches: confirmationData.confirmedMatches,
            confirmedAt: new Date().toISOString(),
        };

        const currentData = connection.PlatformSpecificData || {};
        const newData = { ...currentData, mappingConfirmations: dataToStore };

        try {
            await this.connectionsService.updateConnectionData(connection.Id, connection.UserId, { PlatformSpecificData: newData });
            this.logger.log(`Successfully saved mapping confirmations to PlatformSpecificData for connection ${connection.Id}`);
        } catch (error) {
             this.logger.error(`Failed to update PlatformSpecificData with confirmed mappings for connection ${connection.Id}: ${error.message}`);
             throw new InternalServerErrorException('Failed to save mapping confirmations.');
        }

        // Also save direct links to PlatformProductMappings table for 'link' actions
        const mappingsToUpsert = confirmationData.confirmedMatches
            .filter(match => match.action === 'link' && match.sssyncVariantId)
            .map(match => ({
                PlatformConnectionId: connection.Id,
                ProductVariantId: match.sssyncVariantId,
                PlatformProductId: match.platformProductId,
                PlatformVariantId: match.platformVariantId || null,
                PlatformSku: match.platformProductSku || null,
                PlatformSpecificData: { confirmedByUser: true, action: 'link' },
                SyncStatus: 'Linked', // Or 'Pending' if initial sync needed
                IsEnabled: true,
                UpdatedAt: new Date().toISOString(),
            }));

        if (mappingsToUpsert.length > 0) {
             const supabase = this.getSupabaseClient();
             this.logger.log(`Upserting ${mappingsToUpsert.length} direct links into PlatformProductMappings.`);
             const { error } = await supabase
                 .from('PlatformProductMappings')
                 .upsert(mappingsToUpsert, { onConflict: 'PlatformConnectionId, ProductVariantId' }); // Adjust onConflict based on unique constraints

             if (error) {
                 this.logger.error(`Failed to save direct mappings for connection ${connection.Id}: ${error.message}`);
                 // Don't necessarily throw here if PlatformSpecificData save succeeded, but log error
             }
        }
    }

     /**
      * Finds an existing mapping.
      */
     async findMapping(connectionId: string, platformProductId: string): Promise<any /* PlatformProductMapping */ | null> {
         const supabase = this.getSupabaseClient(); // Get client here
         const { data, error } = await supabase
             .from('PlatformProductMappings')
             .select('*') // Select needed fields
             .eq('PlatformConnectionId', connectionId)
             .eq('PlatformProductId', platformProductId)
             .maybeSingle();

          if (error) {
             this.logger.error(`Error finding mapping for connection ${connectionId}, platformId ${platformProductId}: ${error.message}`);
             return null; // Or throw?
          }
          return data;
     }

     /**
      * Retrieves the confirmed mapping actions from PlatformConnections.PlatformSpecificData.
      */
     async getConfirmedMappings(connectionId: string): Promise<StoredConfirmationData | null> {
         const supabase = this.getSupabaseClient();
         this.logger.log(`Fetching confirmed mappings from PlatformSpecificData for connection ${connectionId}`);

         const { data, error } = await supabase
            .from('PlatformConnections')
            .select('PlatformSpecificData')
            .eq('Id', connectionId)
            .single();

        if (error) {
            this.logger.error(`Failed to fetch PlatformSpecificData for connection ${connectionId}: ${error.message}`);
            // Throw or return null? Returning null might be safer for processor flow.
            return null;
        }

        if (!data || !data.PlatformSpecificData?.mappingConfirmations) {
            this.logger.warn(`No mappingConfirmations found in PlatformSpecificData for connection ${connectionId}`);
            return null;
        }

        // TODO: Add validation here? Use class-transformer?
        return data.PlatformSpecificData.mappingConfirmations as StoredConfirmationData;
     }

     // TODO: Add findVariantByPlatformId etc. as needed by SyncCoordinator
}
