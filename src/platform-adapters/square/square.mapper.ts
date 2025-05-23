import { Injectable, Logger } from '@nestjs/common';
import {
    CanonicalProduct,
    CanonicalProductVariant,
} from '../shopify/shopify.mapper'; // Using common canonical types for now
import { CanonicalInventoryLevel } from '../../canonical-data/inventory.service';
import {
    SquareCatalogItem,
    SquareCatalogItemVariation,
    SquareInventoryCount,
    SquareLocation,
    SquareMoney
} from './square-api-client.service'; // Import Square specific types
import { SquareCatalogObject } from './square-api-client.service'; // Import Square specific types

@Injectable()
export class SquareMapper {
    private readonly logger = new Logger(SquareMapper.name);

    // Helper to generate temporary Square IDs
    public tempId(type: string, id: string | number): string {
        return `#${type}-${id.toString().replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    }

    mapSquareItemToCanonical(squareItem: any, squareVariation: any): Partial<CanonicalProductVariant> {
        // TODO: Implement mapping logic (Square often links price/sku to variations)
        return {
            Title: squareItem?.itemData?.name + (squareVariation ? ` - ${squareVariation.itemVariationData?.name}` : ''),
            Sku: squareVariation?.itemVariationData?.sku,
            Price: this.parseSquareMoney(squareVariation?.itemVariationData?.priceMoney),
            // ... map other fields ...
        };
    }

    mapCanonicalVariantToSquare(variantData: any): any /* Square CatalogObject (Item/Variation) */ {
        // TODO: Implement mapping logic (more complex as might need Item and Variation objects)
        return {
            // ... structure for Square API ...
        };
    }

     mapSquareInventory(inventoryData: any): any {
        // TODO: Implement mapping (locations are important in Square)
         return {};
     }

    private parseSquareMoney(money?: SquareMoney): number | undefined {
        if (!money || typeof money.amount !== 'number') {
            return undefined;
        }
        // Square money amounts are in the smallest currency unit (e.g., cents)
        return money.amount / 100.0;
    }

    mapSquareDataToCanonical(
        squareData: {
            items: SquareCatalogItem[];
            inventoryCounts: SquareInventoryCount[];
            locations: SquareLocation[];
        },
        userId: string,
        platformConnectionId: string,
    ): {
        canonicalProducts: CanonicalProduct[];
        canonicalVariants: CanonicalProductVariant[];
        canonicalInventoryLevels: CanonicalInventoryLevel[];
    } {
        const canonicalProducts: CanonicalProduct[] = [];
        const canonicalVariants: CanonicalProductVariant[] = [];
        const canonicalInventoryLevels: CanonicalInventoryLevel[] = [];

        const { items, inventoryCounts, locations } = squareData;

        for (const item of items) {
            if (!item.item_data || item.is_deleted) {
                this.logger.debug(`Skipping deleted or item without item_data: ${item.id}`);
                continue;
            }

            const productPlatformSpecificData: Record<string, any> = {
                squareProductType: item.item_data.product_type,
                squareVisibility: item.item_data.visibility,
                squareEcomVisibility: item.item_data.ecom_visibility,
                squareCategoryId: item.item_data.category_id,
                squareTaxIds: item.item_data.tax_ids,
            };
            
            // Create a canonical product for each Square item
            const cProduct: CanonicalProduct = {
                Id: `sq-prod-${item.id}`,
                UserId: userId,
                Title: item.item_data.name,
                Description: item.item_data.description, // Square description can be HTML
                IsArchived: item.item_data.ecom_visibility === 'HIDDEN' || item.item_data.visibility === 'PRIVATE' || item.is_deleted,
                PlatformSpecificData: productPlatformSpecificData,
                // ImageUrls will be tricky, Square item_data.image_ids needs separate fetch via /v2/catalog/object/{image_id}
                // For now, leave ImageUrls undefined or handle if direct URLs are available elsewhere (not typical for Square Catalog API)
            };
            canonicalProducts.push(cProduct);

            if (!item.item_data.variations || item.item_data.variations.length === 0) {
                this.logger.warn(`Square item ${item.id} (${item.item_data.name}) has no variations. Skipping variant creation.`);
                continue;
            }

            for (const variation of item.item_data.variations) {
                if (!variation.item_variation_data || variation.is_deleted) {
                    this.logger.debug(`Skipping deleted variation or variation without item_variation_data: ${variation.id} for item ${item.id}`);
                    continue;
                }

                const ivd = variation.item_variation_data;
                const price = this.parseSquareMoney(ivd.price_money);

                // TODO: Handle location_overrides for price if necessary. For now, using base price.

                const variantPlatformSpecificData: Record<string, any> = {
                    squarePricingType: ivd.pricing_type,
                    squareOrdinal: ivd.ordinal,
                    squareServiceDurationMs: ivd.service_duration,
                    squareItemOptionValues: ivd.item_option_values,
                };

                const cVariant: CanonicalProductVariant = {
                    Id: `sq-var-${variation.id}`,
                    ProductId: cProduct.Id!,
                    UserId: userId,
                    Sku: ivd.sku || null,
                    Title: ivd.name, // Variation name
                    Price: price !== undefined ? price : 0, // Default to 0 if price is missing
                    // CompareAtPrice: undefined, // Square doesn't have a direct compare_at_price on variation, might be custom attribute or handled differently
                    Cost: undefined, // Square doesn't expose cost directly on variation object, might be through other means if at all
                    Barcode: null, // Square uses SKU, UPC might be a custom attribute if used
                    PlatformSpecificData: variantPlatformSpecificData,
                    IsArchived: variation.is_deleted, 
                    RequiresShipping: item.item_data.product_type === 'REGULAR', // Assumption
                    IsTaxable: item.item_data.is_taxable !== undefined ? item.item_data.is_taxable : true, // Default to true if not specified
                    // Options: map from ivd.item_option_values if needed by fetching option definitions
                };
                canonicalVariants.push(cVariant);

                // Map inventory counts for this variation
                const relevantCounts = inventoryCounts.filter(
                    cnt => cnt.catalog_object_id === variation.id
                );

                for (const count of relevantCounts) {
                    // Square quantity is a string, parse it.
                    const quantity = parseFloat(count.quantity);
                    if (isNaN(quantity)) {
                        this.logger.warn(`Could not parse quantity string "${count.quantity}" for variation ${variation.id} at location ${count.location_id}`);
                        continue;
                    }

                    // Only consider 'IN_STOCK' as available quantity. Other states imply non-sellable.
                    // Square's "calculated_at" can be used as LastPlatformUpdateAt for inventory
                    if (count.state === 'IN_STOCK') {
                         canonicalInventoryLevels.push({
                            ProductVariantId: cVariant.Id!,
                            PlatformConnectionId: platformConnectionId,
                            PlatformLocationId: count.location_id, 
                            Quantity: Math.round(quantity), // Ensure integer if your system expects that
                            LastPlatformUpdateAt: count.calculated_at ? new Date(count.calculated_at) : undefined,
                        });
                    }
                }
            }
        }

        this.logger.log(`Mapped ${canonicalProducts.length} products, ${canonicalVariants.length} variants, and ${canonicalInventoryLevels.length} inventory levels from Square.`);
        return { canonicalProducts, canonicalVariants, canonicalInventoryLevels };
    }

    mapCanonicalToSquare(product: CanonicalProduct, variants: CanonicalProductVariant[]): any {
        // This method might be deprecated or adapted if batch upsert is the primary way.
        // For now, let's focus on the batch upsert helper.
        this.logger.warn('mapCanonicalToSquare is likely deprecated in favor of mapCanonicalToSquareCatalogObjects for batch operations.');
        return {};
    }

    mapCanonicalToSquareCatalogObjects(
        canonicalProduct: CanonicalProduct,
        canonicalVariants: CanonicalProductVariant[],
        targetLocationIds: string[],
    ): SquareCatalogObject[] {
        const objects: SquareCatalogObject[] = [];
        const productTempId = this.tempId('product', canonicalProduct.Id || Date.now());

        // --- 1. Create Item Option and Item Option Value Objects ---
        const createdOptionDetails: Array<{
            optionTempId: string;
            optionName: string;
            valueTempIds: Map<string, string>; // Map<OptionValueName, TempID>
        }> = [];

        const allVariantOptionTypes = new Map<string, Set<string>>(); // Map<OptionName, Set<OptionValueName>>
        canonicalVariants.forEach(v => {
            if (v.Options) {
                for (const [optName, optValue] of Object.entries(v.Options)) {
                    if (!allVariantOptionTypes.has(optName)) {
                        allVariantOptionTypes.set(optName, new Set());
                    }
                    allVariantOptionTypes.get(optName)!.add(optValue);
                }
            }
        });

        allVariantOptionTypes.forEach((valueNames, optionName) => {
            const optionTempId = this.tempId('option', optionName);
            const currentOptionValueTempIds = new Map<string, string>();

            const optionValuesForSquare: any[] = []; // To be used in ITEM_OPTION item_option_data.values

            Array.from(valueNames).forEach((valueName, index) => {
                const valueTempId = this.tempId('optval', `${optionName}-${valueName}`);
                // ITEM_OPTION_VAL objects are created separately if they need to be globally unique
                // or can be defined inline within the ITEM_OPTION if that's how Square prefers for item-specific options.
                // For batch upsert, it's common to create them as distinct objects if they are referenced by multiple variations.
                // However, item_option_data.values expects an array of CatalogItemOptionValue, not SquareCatalogObject.
                // Let's define them and add them to the main objects array.
                const optionValueObject: SquareCatalogObject = {
                    type: 'ITEM_OPTION_VAL',
                    id: valueTempId,
                    item_option_value_data: {
                        name: valueName,
                        ordinal: index + 1,
                    }
                };
                objects.push(optionValueObject);
                currentOptionValueTempIds.set(valueName, valueTempId);
                // For direct inclusion in ITEM_OPTION, we'd structure it differently.
                // Given the batch structure, we create them as separate objects.
            });

            const itemOptionObject: SquareCatalogObject = {
                type: 'ITEM_OPTION',
                id: optionTempId,
                item_option_data: {
                    name: optionName,
                    // values: optionValuesForSquare, // This was causing issues. Link via item_data.item_options later.
                    // The ITEM_OPTION object itself defines the option (e.g., "Color").
                    // Its values (e.g., "Red", "Blue") are separate ITEM_OPTION_VAL objects.
                }
            };
            objects.push(itemOptionObject);
            createdOptionDetails.push({ optionTempId, optionName, valueTempIds: currentOptionValueTempIds });
        });


        // --- 2. Create Image Objects (if any) ---
        const imageTempIds: string[] = [];
        if (canonicalProduct.ImageUrls && canonicalProduct.ImageUrls.length > 0) {
            canonicalProduct.ImageUrls.forEach((url, index) => {
                const imageTempId = this.tempId('image', `${canonicalProduct.Id || 'prodimg'}-${index}`);
                objects.push({
                    type: 'IMAGE',
                    id: imageTempId,
                    image_data: {
                        url: url,
                        // Square might require a name for the image object, or it can be inferred.
                        // name: `${canonicalProduct.Title} Image ${index + 1}`,
                        caption: canonicalProduct.Title || 'Product image',
                    }
                });
                imageTempIds.push(imageTempId);
            });
        }

        // --- 3. Create CatalogItemVariation Objects (these will be nested in the ITEM object later) ---
        const variationDataForProductItem: Partial<SquareCatalogItemVariation['item_variation_data']>[] = [];
        const variationObjectsForMainList: SquareCatalogObject[] = []; // For independent variations if needed, not typical for create

        canonicalVariants.forEach((variant, index) => {
            const variantTempId = this.tempId('variant', variant.Id || index);
            const priceMoney = variant.Price != null ? { amount: Math.round(variant.Price * 100), currency: 'USD' } : undefined; // Assuming USD

            const currentVariantOptionValueSelections: { item_option_id: string; item_option_value_id: string }[] = [];
            if (variant.Options) {
                for (const [vOptName, vOptValue] of Object.entries(variant.Options)) {
                    const foundOptionDetail = createdOptionDetails.find(cod => cod.optionName === vOptName);
                    if (foundOptionDetail) {
                        const valueTempId = foundOptionDetail.valueTempIds.get(vOptValue);
                        if (valueTempId) {
                            currentVariantOptionValueSelections.push({
                                item_option_id: foundOptionDetail.optionTempId,
                                item_option_value_id: valueTempId,
                            });
                        }
                    }
                }
            }
            
            // This is the data for a variation *within* an item's definition
            const singleVariationData: Partial<SquareCatalogItemVariation['item_variation_data']> & { id: string } = {
                id: variantTempId, // Client ID for this variation
                item_id: productTempId,
                name: variant.Title || canonicalProduct.Title,
                sku: variant.Sku || undefined,
                pricing_type: 'FIXED_PRICING',
                price_money: priceMoney,
                track_inventory: true,
                // inventory_alert_type: 'NONE', // Default
                item_option_values: currentVariantOptionValueSelections.length > 0 ? currentVariantOptionValueSelections : undefined,
                // location_overrides would be used for setting initial stock per location,
                // but this is often done in a separate inventory adjustment call.
                // For creation, we define the structure.
            };
            
            // Construct the full ITEM_VARIATION object to be added to the main `objects` list for Square.
            // Square expects ITEM_VARIATION objects to be top-level in the batch if they are not just defined inline.
            // For creating a new item with variations, the variations are part of the ITEM object's item_data.
            // So, we will prepare the data and add it to productItemData.variations.
            
            // We need to add each variation to the item_data.variations array of the parent ITEM.
            // The structure for item_data.variations is an array of CatalogItemVariation objects (not SquareCatalogObject).
            // So we build the variation_data part here.

            variationDataForProductItem.push(singleVariationData as any); // Cast to any for now, Square's SDK types are complex for nesting
        });


        // --- 4. Create CatalogItem (Product) Object ---
        const productItemData: Partial<SquareCatalogItem['item_data']> = {
            name: canonicalProduct.Title,
            description: canonicalProduct.Description || undefined,
            product_type: 'REGULAR',
            variations: variationDataForProductItem as any[], // Contains the definitions of variations
            // Link top-level ITEM_OPTION objects created earlier
            item_options: createdOptionDetails.length > 0 ? createdOptionDetails.map(cod => ({ item_option_id: cod.optionTempId })) : undefined,
            image_ids: imageTempIds.length > 0 ? imageTempIds : undefined,
        };

        const productObject: SquareCatalogObject = {
            type: 'ITEM',
            id: productTempId,
            present_at_all_locations: !targetLocationIds || targetLocationIds.length === 0,
            present_at_location_ids: targetLocationIds && targetLocationIds.length > 0 ? targetLocationIds : undefined,
            item_data: productItemData,
        };
        objects.push(productObject); // Add the main product object

        // The ITEM_VARIATION objects are defined *within* the ITEM object's `item_data.variations` array.
        // They are not typically added as separate top-level objects in the batch when creating a new product *with* its variations.
        // If updating variations independently, then they would be separate objects.

        this.logger.log(`Mapped ${objects.length} Square catalog objects for product: ${canonicalProduct.Title} (Temp ID: ${productTempId})`);
        // this.logger.verbose(`Square catalog objects for batch: ${JSON.stringify(objects, null, 2)}`);
        return objects;
    }
}
