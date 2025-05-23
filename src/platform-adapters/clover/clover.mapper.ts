import { Injectable, Logger } from '@nestjs/common';
import { ProductVariant } from '../../common/types/supabase.types'; // Adjust path as needed
import { CanonicalProduct, CanonicalProductVariant } from '../../platform-adapters/shopify/shopify.mapper'; // Using existing canonical types for now
import { CanonicalInventoryLevel } from '../../canonical-data/inventory.service'; // <<< Import directly
import { 
    CloverItem, 
    CloverLocation, 
    // CloverVariant, // We will derive variants from CloverItem with options/itemGroup
    CloverItemStock 
} from './clover-api-client.service';

// Import the input types from the API client to use in the bundle
import {
    CloverItemGroupInput,
    CloverAttributeInput, // This was conceptual, let's use a more refined structure
    CloverOptionInput,
    CloverItemInput
} from './clover-api-client.service';

// Define interfaces for Clover's specific data structures if known, e.g.:
// interface CloverItemDto { id: string; name: string; price: number; priceType: string; stockCount?: number; ... }
// interface CloverOrderDto { ... }

// Interface for an attribute payload within the bundle
export interface CloverAttributePayload {
    originalOptionName: string; // e.g., "Color" or "Size" from CanonicalProductVariant.Options
    attribute: { name: string }; // Payload for CloverAttributeInput (excluding itemGroup)
    options: CloverOptionInput[]; // Payloads for options under this attribute (e.g., [{name: "Red"}, {name: "Blue"}])
}

// Interface for a variant item payload within the bundle
export interface CloverVariantItemPayload {
    canonicalVariantId: string; // To link back to the original canonical variant
    itemInput: CloverItemInput;   // Payload for CloverItemInput (excluding itemGroup)
    selectedOptions?: Array<{ attributeName: string; optionName: string }>; // For associating with created Clover options
}

// This is the bundle that the new mapper method will produce
export interface CloverProductCreationBundle {
    itemGroupPayload: CloverItemGroupInput;
    attributesPayload: CloverAttributePayload[];
    variantItemPayloads: CloverVariantItemPayload[];
}

@Injectable()
export class CloverMapper {
    private readonly logger = new Logger(CloverMapper.name);

    mapCloverDataToCanonical(
        cloverData: {
            items: CloverItem[];
            locations: CloverLocation[]; // Currently, this is the merchant's main address/info
            // itemStocks are expected to be expanded on items via item.itemStock
        },
        userId: string,
        platformConnectionId: string
    ): {
        canonicalProducts: CanonicalProduct[];
        canonicalVariants: CanonicalProductVariant[];
        canonicalInventoryLevels: CanonicalInventoryLevel[];
    } {
        const canonicalProducts: CanonicalProduct[] = [];
        const canonicalVariants: CanonicalProductVariant[] = [];
        const canonicalInventoryLevels: CanonicalInventoryLevel[] = [];

        if (!cloverData.locations || cloverData.locations.length === 0) {
            this.logger.warn('No Clover locations provided (merchant details). Inventory might not be linked to a specific location ID.');
            // Decide on a fallback location ID if necessary, or ensure all inventory is merchant-wide
        }
        // For now, assume a single primary location derived from merchant details.
        // If Clover supports multiple stock-keeping locations, this logic will need to be more robust.
        const primaryCloverLocationId = cloverData.locations[0]?.id || 'default-clover-location'; 

        for (const cloverItem of cloverData.items) {
            if (cloverItem.hidden) {
                this.logger.debug(`Skipping hidden Clover item: ${cloverItem.name} (ID: ${cloverItem.id})`);
                continue;
            }

            // --- Product and Variant Determination --- 
            // In Clover, an "item" can be a standalone product or a specific variant.
            // If an item is part of an itemGroup and/or has options, it's treated more like a variant.
            // If it has its own nested 'variants' via expansion, it's a parent product.

            let isParentProduct = true; // Assume parent unless it's clearly a variant of something else
            let parentProductIdForVariant: string | undefined = undefined;

            // Heuristic: If an item has an itemGroup, it often implies it's a variant within that group structure.
            // The actual "parent product" might be an abstract concept represented by the itemGroup itself,
            // or one of the items in the group is designated as the main one.
            // For simplicity, we'll create a canonical product for each itemGroup encountered,
            // and then items belonging to that group become its variants.
            // If an item has NO itemGroup, it's a standalone product with itself as the only variant.

            let canonicalProductId: string;
            let canonicalProductTitle = cloverItem.name;
            let productPlatformSpecificData: Record<string, any> = {};

            const itemCategories = cloverItem.categories?.elements?.map(c => c.name) || [];
            const itemTags = cloverItem.tags?.elements?.map(t => t.name) || [];

            if (itemCategories.length > 0) {
                productPlatformSpecificData.cloverCategories = itemCategories;
            }
            if (itemTags.length > 0) {
                productPlatformSpecificData.cloverTags = itemTags;
            }
            // Add other item-level platform specific data if needed
            // productPlatformSpecificData.cloverIsRevenue = cloverItem.isRevenue;
            // productPlatformSpecificData.cloverModifiedTime = cloverItem.modifiedTime;

            if (cloverItem.itemGroup && cloverItem.itemGroup.id) {
                // This item is part of an item group. The item group represents the parent product.
                canonicalProductId = `clover-prod-${cloverItem.itemGroup.id}`;
                canonicalProductTitle = cloverItem.itemGroup.name || cloverItem.name; // Prefer item group name for product title
                isParentProduct = false; // This specific item is a variant
                parentProductIdForVariant = canonicalProductId;

                // Check if we've already created a CanonicalProduct for this itemGroup
                if (!canonicalProducts.find(p => p.Id === canonicalProductId)) {
                    canonicalProducts.push({
                        Id: canonicalProductId,
                        UserId: userId,
                        IsArchived: false, // Determine from Clover item status if available, else default
                        Title: canonicalProductTitle, // Use item group name as product title
                        ImageUrls: cloverItem.imageUrl ? [cloverItem.imageUrl] : undefined,
                        PlatformSpecificData: productPlatformSpecificData, // Store categories/tags from one of the items in the group
                    });
                }
            } else {
                // This item is a standalone product or a parent with its own list of variants (less common in Clover typical structure)
                canonicalProductId = `clover-prod-${cloverItem.id}`;
                canonicalProductTitle = cloverItem.name;
                parentProductIdForVariant = canonicalProductId; // It is its own parent for variant creation

                canonicalProducts.push({
                    Id: canonicalProductId,
                    UserId: userId,
                    IsArchived: cloverItem.hidden, 
                    Title: canonicalProductTitle,
                    Description: cloverItem.alternateName || undefined, // Or other field
                    ImageUrls: cloverItem.imageUrl ? [cloverItem.imageUrl] : undefined,
                    PlatformSpecificData: productPlatformSpecificData,
                });
            }
            
            // --- Map Item to Canonical Variant --- 
            // Every Clover item that isn't purely an abstract group will become a CanonicalProductVariant.
            const canonicalVariantId = `clover-var-${cloverItem.id}`;
            const priceInDollars = cloverItem.price / 100.0; // Clover prices are in cents
            const costInDollars = cloverItem.cost ? cloverItem.cost / 100.0 : undefined;

            const variantOptions: Record<string, string> = {};
            if (cloverItem.options && cloverItem.options.elements) {
                cloverItem.options.elements.forEach(opt => {
                    if (opt.attribute && opt.attribute.name) {
                        variantOptions[opt.attribute.name] = opt.name;
                    }
                });
            }

            const variantPlatformSpecificData: Record<string, any> = {};
            if (itemCategories.length > 0) {
                 variantPlatformSpecificData.cloverCategories = itemCategories;
            }
            if (itemTags.length > 0) {
                 variantPlatformSpecificData.cloverTags = itemTags;
            }
            variantPlatformSpecificData.cloverPriceType = cloverItem.priceType;
            variantPlatformSpecificData.cloverItemCode = cloverItem.code; // Often barcode/internal code
            // Add more variant-specific Clover fields if needed

            canonicalVariants.push({
                Id: canonicalVariantId,
                ProductId: parentProductIdForVariant!, 
                UserId: userId,
                Sku: cloverItem.sku || cloverItem.code || null,
                Barcode: cloverItem.code || null, 
                Title: cloverItem.name, 
                Description: cloverItem.alternateName || undefined, 
                Price: priceInDollars,
                CompareAtPrice: undefined, 
                Cost: costInDollars,
                Weight: undefined, 
                WeightUnit: undefined,
                Options: Object.keys(variantOptions).length > 0 ? variantOptions : null,
                PlatformSpecificData: variantPlatformSpecificData,
                IsArchived: cloverItem.hidden, // Map from Clover's hidden status
                RequiresShipping: true, // Default for physical products, Clover API might not specify
                IsTaxable: true,        // Default, Clover tax settings are complex & per-item/order
                TaxCode: undefined,     // Clover uses taxRates, not simple tax codes typically
                ImageId: undefined,     // Clover items might have imageUrl, but ProductImages table is separate
            });

            // --- Map Inventory Level --- 
            if (cloverItem.itemStock) {
                const quantity = typeof cloverItem.itemStock.quantity === 'number' 
                                ? cloverItem.itemStock.quantity 
                                : (typeof cloverItem.itemStock.stockCount === 'number' ? cloverItem.itemStock.stockCount : 0);

                canonicalInventoryLevels.push({
                    ProductVariantId: canonicalVariantId,
                    PlatformConnectionId: platformConnectionId,
                    PlatformLocationId: primaryCloverLocationId, // Use the main merchant ID or a derived location ID
                    Quantity: Math.round(quantity), // Ensure integer, Clover can have decimal stock for some units
                    // LastPlatformUpdateAt: new Date(cloverItem.modifiedTime) // Assuming modifiedTime refers to stock update
                });
            }
        }

        this.logger.log(`Mapped ${canonicalProducts.length} products, ${canonicalVariants.length} variants, ${canonicalInventoryLevels.length} inventory levels from Clover.`);
        return { canonicalProducts, canonicalVariants, canonicalInventoryLevels };
    }

    // Example private helper (adapt based on Clover's item structure)
    // private _mapSingleCloverItem(cloverItem: any, userId: string, platformConnectionId: string): { product?: CanonicalProduct, variant?: CanonicalProductVariant } {
    //     // Placeholder: This needs to be heavily adapted based on how Clover structures items and if they have separate products/variants
    //     const tempProductId = `temp-clover-product-${cloverItem.id}`;
    //     const product: CanonicalProduct = {
    //         Id: tempProductId, // Temporary
    //         UserId: userId,
    //         IsArchived: cloverItem.hidden || false, 
    //     };

    //     const variant: CanonicalProductVariant = {
    //         ProductId: tempProductId, // Temporary
    //         UserId: userId,
    //         Sku: cloverItem.code, // Assuming 'code' is SKU
    //         Title: cloverItem.name,
    //         Price: cloverItem.price / 100, // Clover prices are often in cents
    //         // ... map other fields ...
    //     };
    //     return { product, variant };
    // }

    // private _mapCloverInventory(cloverItem: any, canonicalVariantId: string | undefined, platformConnectionId: string): CanonicalInventoryLevel | null {
    //     if (!canonicalVariantId || cloverItem.stockCount === undefined || cloverItem.stockCount === null) return null;
        
    //     // Clover might have a general stockCount or per-location inventory via a separate API call
    //     // This is a very basic placeholder.
    //     return {
    //         ProductVariantId: canonicalVariantId,
    //         PlatformConnectionId: platformConnectionId,
    //         PlatformLocationId: 'clover-default-location', // Clover locations need to be fetched and mapped
    //         Quantity: cloverItem.stockCount,
    //     };
    // }

    mapCanonicalVariantToClover(variantData: CanonicalProductVariant): any /* Clover Item/Order Line Item format */ {
        this.logger.warn('mapCanonicalVariantToClover not implemented');
        // TODO: Implement mapping from canonical to Clover format for creating/updating products/orders
        return {};
    }

    // New method to map canonical product data to the Clover creation bundle structure
    mapCanonicalToCloverCreationBundle(
        canonicalProduct: CanonicalProduct,
        canonicalVariants: CanonicalProductVariant[],
        // We don't need canonicalInventoryLevels for Clover product structure creation directly
    ): CloverProductCreationBundle {
        this.logger.log(`Mapping canonical product ${canonicalProduct.Title} (ID: ${canonicalProduct.Id}) to Clover creation bundle.`);

        const itemGroupPayload: CloverItemGroupInput = {
            name: canonicalProduct.Title, // Use canonical product title for item group name
        };

        const attributesPayload: CloverAttributePayload[] = [];
        const variantItemPayloads: CloverVariantItemPayload[] = [];

        // Determine unique attributes and their options from all variants
        const uniqueAttributesWithOptions = new Map<string, Set<string>>();
        canonicalVariants.forEach(variant => {
            if (variant.Options) {
                for (const attrName in variant.Options) {
                    if (!uniqueAttributesWithOptions.has(attrName)) {
                        uniqueAttributesWithOptions.set(attrName, new Set());
                    }
                    uniqueAttributesWithOptions.get(attrName)!.add(variant.Options[attrName]);
                }
            }
        });

        uniqueAttributesWithOptions.forEach((optionValues, attributeName) => {
            attributesPayload.push({
                originalOptionName: attributeName,
                attribute: { name: attributeName },
                options: Array.from(optionValues).map(optVal => ({ name: optVal })),
            });
        });

        for (const variant of canonicalVariants) {
            if (!variant.Id) {
                this.logger.warn(`Canonical variant for product ${canonicalProduct.Title} is missing an ID. Skipping.`);
                continue;
            }
            if (!variant.Sku && !variant.Barcode) {
                this.logger.warn(`Canonical variant ID ${variant.Id} for product ${canonicalProduct.Title} has no SKU or Barcode. Clover requires one. Skipping.`);
                // Potentially generate a temporary one if desired, but for now, skip.
                continue;
            }

            const itemInput: CloverItemInput = {
                name: variant.Title,
                price: Math.round(variant.Price * 100), // Price to cents
                sku: variant.Sku,
                code: variant.Barcode, // Barcode as 'code'
                cost: variant.Cost ? Math.round(variant.Cost * 100) : undefined, // Cost to cents
                hidden: variant.IsArchived ?? canonicalProduct.IsArchived ?? false,
                // itemGroup will be linked by the API client using the created item group ID
            };

            const selectedOptionsForPayload: Array<{ attributeName: string; optionName: string }> = [];
            if (variant.Options) {
                for (const attrName in variant.Options) {
                    selectedOptionsForPayload.push({ attributeName: attrName, optionName: variant.Options[attrName]});
                }
            }

            variantItemPayloads.push({
                canonicalVariantId: variant.Id,
                itemInput: itemInput,
                selectedOptions: selectedOptionsForPayload.length > 0 ? selectedOptionsForPayload : undefined,
            });
        }

        if (variantItemPayloads.length === 0) {
            this.logger.error(`No valid variants could be prepared for Clover product creation for canonical product: ${canonicalProduct.Title} (ID: ${canonicalProduct.Id}). At least one variant item is required.`);
            // This situation should ideally be caught before calling the API client, 
            // but the bundle will be empty of variants, leading to a failure there too.
        }

        this.logger.log(`Successfully mapped to CloverProductCreationBundle for ${canonicalProduct.Title}. Attributes: ${attributesPayload.length}, Variants: ${variantItemPayloads.length}`);
        return { itemGroupPayload, attributesPayload, variantItemPayloads };
    }
} 