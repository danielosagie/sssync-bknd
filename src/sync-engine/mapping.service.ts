import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service'; // Adjust path
import { PlatformConnection } from '../platform-connections/platform-connections.service'; // Adjust path
import { SupabaseClient } from '@supabase/supabase-js';

// Interfaces (define more comprehensively based on needs)
interface PlatformProductData {
    id: string;
    sku?: string | null;
    barcode?: string | null;
    title?: string | null;
    // ... other raw fields ...
}

interface CanonicalVariantData {
    Id: string; // sssync ProductVariant Id
    Sku?: string | null;
    Barcode?: string | null;
    Title?: string | null;
}

export interface MappingSuggestion {
    platformProduct: PlatformProductData;
    suggestedCanonicalVariant?: CanonicalVariantData | null; // Matched sssync variant
    matchType: 'SKU' | 'BARCODE' | 'NONE';
    confidence: number; // 0 to 1
}

interface ConfirmedMapping {
    platformProductId: string;
    sssyncVariantId?: string | null; // Null if creating new
    action: 'link' | 'create' | 'ignore';
    // Include platformVariantId if needed
}

@Injectable()
export class MappingService {
    private readonly logger = new Logger(MappingService.name);

    constructor(private supabaseService: SupabaseService) {
        // Remove: this.supabase = this.supabaseService.getClient();
    }

    // Optional: Add helper if preferred, or call directly
    private getSupabaseClient(): SupabaseClient {
        return this.supabaseService.getClient();
    }

    /**
     * Generates mapping suggestions by comparing platform data against existing canonical data.
     */
    async generateSuggestions(platformData: { products: PlatformProductData[], variants: PlatformProductData[] /* Adjust based on adapter output */ }, userId: string, platformType: string): Promise<MappingSuggestion[]> {
        const supabase = this.getSupabaseClient(); // Get client here
        this.logger.log(`Generating mapping suggestions for ${platformType}, user ${userId}`);

        // 1. Get all existing canonical variants for the user (SKU, Barcode, ID, Title)
        const { data: canonicalVariants, error: variantError } = await supabase
            .from('ProductVariants')
            .select('Id, Sku, Barcode, Title')
            .eq('UserId', userId);

        if (variantError) {
            this.logger.error(`Failed to fetch canonical variants for user ${userId}: ${variantError.message}`);
            // Decide: throw error or return empty suggestions? Returning empty might be safer for flow.
            return [];
        }

        const suggestions: MappingSuggestion[] = [];
        const canonicalVariantsMap = new Map<string, CanonicalVariantData>();
        const canonicalBarcodesMap = new Map<string, CanonicalVariantData>();
        canonicalVariants?.forEach(v => {
            if (v.Sku) canonicalVariantsMap.set(v.Sku.trim().toLowerCase(), v as CanonicalVariantData);
            if (v.Barcode) canonicalBarcodesMap.set(v.Barcode.trim().toLowerCase(), v as CanonicalVariantData);
        });

        // Use platform variants if available, otherwise products
        const itemsToMap = platformData.variants?.length > 0 ? platformData.variants : platformData.products;

        // 2. Iterate through fetched platform items
        for (const item of itemsToMap) {
            let match: CanonicalVariantData | null = null;
            let matchType: MappingSuggestion['matchType'] = 'NONE';
            let confidence = 0;

            // 3. Attempt matching (prioritize Barcode, then SKU)
            const itemSku = item.sku?.trim().toLowerCase();
            const itemBarcode = item.barcode?.trim().toLowerCase();

            if (itemBarcode && canonicalBarcodesMap.has(itemBarcode)) {
                match = canonicalBarcodesMap.get(itemBarcode)!;
                matchType = 'BARCODE';
                confidence = 0.95; // High confidence
            } else if (itemSku && canonicalVariantsMap.has(itemSku)) {
                match = canonicalVariantsMap.get(itemSku)!;
                matchType = 'SKU';
                confidence = 0.90; // Slightly lower confidence than barcode
                 // Avoid suggesting the same match twice if barcode also matched
                 if (match === canonicalBarcodesMap.get(itemBarcode!)) {
                    // Barcode match already found, skip SKU suggestion unless different item
                    continue;
                 }
            }

            // TODO: Add conflict detection (e.g., multiple platform items mapping to same canonical item?)

            suggestions.push({
                platformProduct: item,
                suggestedCanonicalVariant: match ?? null,
                matchType: matchType,
                confidence: confidence,
            });
        }

        // TODO: Store these suggestions temporarily (e.g., Redis cache, or a dedicated DB table?)
        // keyed by connectionId or a scanJobId so the controller can retrieve them later.
        this.logger.log(`Generated ${suggestions.length} mapping suggestions for ${platformType}, user ${userId}`);
        return suggestions;
    }

    /**
     * Saves the mappings confirmed by the user.
     */
    async saveConfirmedMappings(connection: PlatformConnection, confirmationData: { confirmedMatches: ConfirmedMapping[] }): Promise<void> {
        const supabase = this.getSupabaseClient(); // Get client here
        this.logger.log(`Saving ${confirmationData.confirmedMatches.length} confirmed mappings for connection ${connection.Id}`);

        const mappingsToUpsert = confirmationData.confirmedMatches
            .filter(match => match.action === 'link' && match.sssyncVariantId) // Only save links with target ID
            .map(match => ({
                PlatformConnectionId: connection.Id,
                ProductVariantId: match.sssyncVariantId, // Canonical sssync Variant ID
                PlatformProductId: match.platformProductId, // Platform's ID
                // PlatformVariantId: match.platformVariantId, // Add if applicable
                PlatformSpecificData: { confirmedByUser: true }, // Optional metadata
                SyncStatus: 'Pending', // Initial status for linked items
                IsEnabled: true,
                // Use platform's SKU/Variant ID if needed for uniqueness constraint? Check schema.
            }));

        if (mappingsToUpsert.length > 0) {
            const { error } = await supabase
                .from('PlatformProductMappings')
                .upsert(mappingsToUpsert, { onConflict: 'PlatformConnectionId, ProductVariantId' }); // Adjust onConflict based on unique constraints

            if (error) {
                this.logger.error(`Failed to save confirmed mappings for connection ${connection.Id}: ${error.message}`);
                throw new InternalServerErrorException('Failed to save mapping confirmations.');
            }
        }
        // Note: 'create' actions will be handled during the InitialSyncProcessor based on this confirmation data
        // Note: 'ignore' actions are implicitly handled by not creating a mapping.
        this.logger.log(`Successfully saved/updated ${mappingsToUpsert.length} mappings for connection ${connection.Id}`);
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
      * Retrieves the confirmed mappings/actions for a connection.
      * This data might be stored temporarily (Redis) or persistently (DB).
      */
     async getConfirmedMappings(connectionId: string): Promise<{ confirmedMatches: ConfirmedMapping[] } | null> {
         const supabase = this.getSupabaseClient(); // Get client here
         this.logger.log(`Fetching confirmed mappings for connection ${connectionId}`);
         // TODO: Implement retrieval logic.
         // How was the data from saveConfirmedMappings stored?
         // Option A: Store in PlatformConnections.PlatformSpecificData JSONB column.
         // Option B: Store in a dedicated "MappingConfirmations" table.
         // Option C: Store temporarily in Redis Cache.
         // Placeholder - assumes it needs implementation:
         console.warn(`getConfirmedMappings for ${connectionId} not fully implemented.`);
         // Example returning empty if not found:
         return { confirmedMatches: [] }; // Return structure expected by processor
         // return null; // Or return null if absolutely nothing found
     }

     // TODO: Add findVariantByPlatformId etc. as needed by SyncCoordinator
}
