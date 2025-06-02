import { Injectable, Logger } from '@nestjs/common';
import { 
    ShopifyProductNode, 
    ShopifyVariantNode, 
    ShopifyInventoryLevelNode, 
    ShopifyLocationNode,
    ShopifyProductSetInput,
    ShopifyVariantInput,
    ShopifyInventoryItem,
    ShopifyInventoryQuantity,
    ShopifyProductOption,
    ShopifyProductFile
} from './shopify-api-client.service';
import { CanonicalInventoryLevel } from '../../canonical-data/inventory.service'; // Adjust path if needed

// --- Canonical Data Structure Interfaces (based on sssync-db.md) ---
// These might eventually live in a central canonical-data module and be imported
export interface CanonicalProduct {
    Id?: string; // Will be set by DB or ProductsService
    UserId: string;
    IsArchived: boolean;
    Title: string;
    Description?: string;
    ImageUrls?: string[]; // Added for product-level images
    PlatformSpecificData?: Record<string, any>;
    // CreatedAt, UpdatedAt are DB managed
    // Any other product-level fields from your DB schema?
}

// Refining the existing CanonicalProductVariant
export interface CanonicalProductVariant {
    Id?: string; // Will be set by DB or ProductsService
    ProductId: string; // Link to CanonicalProduct.Id (set after product is created)
    UserId: string;
    Sku: string | null;
    Barcode?: string | null;
    Title: string;
    Description?: string | null;
    Price: number;
    CompareAtPrice?: number | null;
    Cost?: number | null;
    Weight?: number | null;
    WeightUnit?: string | null;
    Options?: Record<string, string> | null; // e.g. { "Color": "Blue", "Size": "Large" }
    PlatformSpecificData?: Record<string, any>;
    IsArchived?: boolean; // Added - typically product level, but useful for variant-level sync decisions
    RequiresShipping?: boolean;
    IsTaxable?: boolean;
    TaxCode?: string | null;
    ImageId?: string | null; // Could be an ID for a primary image linked in ProductImages
    // CreatedAt, UpdatedAt are DB managed
}

// No longer defined here, will be imported
// export interface CanonicalInventoryLevel {
//     Id?: string; 
//     ProductVariantId: string; 
//     PlatformConnectionId: string; 
//     PlatformLocationId: string; 
//     Quantity: number;
// }

// Existing ShopifyVariantData for mapShopifyVariantToCanonical - may need review/removal if subsumed by new flow
interface ShopifyVariantData { // This was for a FLATTENED variant structure
    id: string; 
    sku: string | null;
    barcode: string | null;
    title: string; 
    price: string; 
    compareAtPrice: string | null;
    weight: number | null;
    weightUnit: string;
    inventoryQuantity: number;
    inventoryItem: { id: string };
    image: { id: string; url: string; altText: string } | null;
    selectedOptions: { name: string; value: string }[];
    productId: string; 
    productTitle?: string;
    productDescriptionHtml?: string;
    productVendor?: string;
    productTags?: string[];
}

// For product updates, Shopify's ProductInput is very similar to ProductSetInput.
// We can reuse ShopifyProductSetInput and ShopifyVariantInput for updates,
// with the understanding that ShopifyVariantInput can optionally include an 'id' field for existing variants.
// Let's alias them for clarity within the update mapping function if needed, or just use them directly.
// type ShopifyProductUpdateInput = ShopifyProductSetInput; // Product GID is passed separately to productUpdate mutation
interface ShopifyVariantWithOptionalIdInput extends ShopifyVariantInput {
    id?: string; // Shopify Variant GID for updates
}

@Injectable()
export class ShopifyMapper {
    private readonly logger = new Logger(ShopifyMapper.name);

    /**
     * Main method to map all fetched Shopify data to canonical structures.
     */
    mapShopifyDataToCanonical(
        shopifyData: { products: ShopifyProductNode[], locations: ShopifyLocationNode[] },
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

        for (const shopifyProduct of shopifyData.products) {
            // Placeholder for actual product ID after it's saved
            // In a real scenario, you might save product, get ID, then save variants with that ID.
            // Or, the ProductsService handles creating product and variants together if IDs are managed by DB.
            const tempCanonicalProductId = `temp-product-${shopifyProduct.id}`;

            canonicalProducts.push(
                this._mapSingleProduct(shopifyProduct, userId, tempCanonicalProductId)
            );

            for (const variantEdge of shopifyProduct.variants.edges) {
                const shopifyVariant = variantEdge.node;
                canonicalVariants.push(
                    this._mapSingleVariant(shopifyVariant, shopifyProduct, userId, tempCanonicalProductId)
                );

                if (shopifyVariant.inventoryItem?.inventoryLevels?.edges) {
                    for (const invLevelEdge of shopifyVariant.inventoryItem.inventoryLevels.edges) {
                        const shopifyInvLevel = invLevelEdge.node;
                        // Placeholder for actual variant ID after it's saved
                        const tempCanonicalVariantId = `temp-variant-${shopifyVariant.id}`;
                        canonicalInventoryLevels.push(
                            this._mapSingleInventoryLevel(
                                shopifyInvLevel,
                                tempCanonicalVariantId, // This needs to be the ID of the canonical variant we just mapped
                                platformConnectionId
                            )
                        );
                    }
                }
            }
        }
        this.logger.log(`Mapped ${canonicalProducts.length} products, ${canonicalVariants.length} variants, ${canonicalInventoryLevels.length} inventory levels.`);
        return { canonicalProducts, canonicalVariants, canonicalInventoryLevels };
    }

    private _mapSingleProduct(productNode: ShopifyProductNode, userId: string, tempProductId: string): CanonicalProduct {
        const imageUrls: string[] = [];
        if (productNode.media?.edges) {
            for (const edge of productNode.media.edges) {
                if (edge.node?.preview?.image?.url) {
                    imageUrls.push(edge.node.preview.image.url);
                }
            }
        }

        return {
            Id: tempProductId, // This is temporary; actual ID comes from DB.
            UserId: userId,
            IsArchived: productNode.status.toUpperCase() === 'ARCHIVED',
            Title: productNode.title,
            Description: productNode.descriptionHtml || undefined,
            ImageUrls: imageUrls.length > 0 ? imageUrls : undefined,
            // TODO: Map other product-level fields if your CanonicalProduct has them
            // e.g., Title (if product title distinct from variant titles in canonical), Tags, Vendor, ProductType
        };
    }

    private _mapSingleVariant(variantNode: ShopifyVariantNode, productNode: ShopifyProductNode, userId: string, canonicalProductId: string): CanonicalProductVariant {
        const optionsMap = variantNode.selectedOptions?.reduce((acc, opt) => {
            acc[opt.name] = opt.value;
            return acc;
        }, {});

        // Variant-specific image is not directly available on ShopifyVariantNode from the typical fetch query.
        // Images are on productNode.media. If a variant needs a specific image, it's usually an association.
        // Cost is also not directly on ShopifyVariantNode.inventoryItem (ShopifyInventoryItemNode) but on input types.

        return {
            // Id: Will be set by DB or ProductsService
            ProductId: canonicalProductId, // Link to the canonical product
            UserId: userId,
            Sku: variantNode.sku || null,
            Barcode: variantNode.barcode || null,
            Title: productNode.title, // Variant title is derived from product title + options in Shopify UI
                                     // For canonical data, productNode.title is the distinct field.
            Description: productNode.descriptionHtml || null, // Fallback to product description
            Price: parseFloat(variantNode.price),
            CompareAtPrice: variantNode.compareAtPrice ? parseFloat(variantNode.compareAtPrice) : null,
            Cost: null, // Not available on ShopifyVariantNode.inventoryItem (ShopifyInventoryItemNode)
            Weight: variantNode.inventoryItem?.measurement?.weight?.value ?? null,
            WeightUnit: variantNode.inventoryItem?.measurement?.weight?.unit?.toLowerCase() ?? null,
            Options: optionsMap || null,
            RequiresShipping: undefined, // Not directly available on ShopifyVariantNode or its inventoryItem
            IsTaxable: variantNode.taxable === null ? undefined : variantNode.taxable,
            TaxCode: variantNode.taxCode || null,
            ImageId: null, // No direct variant-specific image ID on ShopifyVariantNode
            // ImageUrls: [], // No direct variant-specific image URLs on ShopifyVariantNode
        };
    }

    private _mapSingleInventoryLevel(
        invLevelNode: ShopifyInventoryLevelNode, 
        canonicalVariantId: string, 
        platformConnectionId: string
    ): CanonicalInventoryLevel {
        return {
            // Id: Will be set by DB or InventoryService
            ProductVariantId: canonicalVariantId, // Link to the canonical variant
            PlatformConnectionId: platformConnectionId,
            PlatformLocationId: invLevelNode.location.id, // This is the Shopify Location GID
            Quantity: invLevelNode.available ?? 0, // Use the 'available' field, defaulting to 0 if null/undefined
        };
    }


    // This old method might need to be reviewed or removed if the new flow supersedes it.
    // It was designed for a flattened ShopifyVariantData input.
    mapShopifyVariantToCanonical(shopifyVariant: ShopifyVariantData, shopifyProduct?: any): Partial<CanonicalProductVariant> {
        if (!shopifyVariant) {
            this.logger.warn('Attempted to map null/undefined Shopify variant.');
            return {};
        }
        // ... (rest of the existing method, which might be deprecated by the new structure)
        // For now, I will keep the body as is but it should be reviewed.
        try {
            const optionsMap = shopifyVariant.selectedOptions?.reduce((acc, opt) => {
                acc[opt.name] = opt.value;
                return acc;
            }, {});

            const canonicalTitle = shopifyVariant.title;

            return {
                Sku: shopifyVariant.sku || null,
                Barcode: shopifyVariant.barcode || null,
                Title: canonicalTitle,
                Description: shopifyProduct?.descriptionHtml || null,
                Price: parseFloat(shopifyVariant.price),
                CompareAtPrice: shopifyVariant.compareAtPrice ? parseFloat(shopifyVariant.compareAtPrice) : null,
                Weight: shopifyVariant.weight,
                WeightUnit: shopifyVariant.weightUnit?.toLowerCase(),
                Options: optionsMap || null,
            };
        } catch (error) {
             this.logger.error(`Error mapping Shopify variant ${shopifyVariant.id}: ${error.message}`, error.stack);
             return { Title: shopifyVariant.title || 'Mapping Error' }; 
        }
    }

    /**
     * Maps the first variant of a Shopify product to CanonicalProductVariant details.
     * Used when SyncRules.productDetailsSoT === 'PLATFORM' for a link action.
     */
    mapShopifyProductToCanonicalDetails(
        productNode: ShopifyProductNode,
        userId: string,
        // sssyncVariantId: string, // Not strictly needed here if we map the first variant as per current processor call pattern
    ): Partial<CanonicalProductVariant> {
        if (!productNode?.variants?.edges || productNode.variants.edges.length === 0) {
            this.logger.warn(`Product ${productNode?.id} has no variants to map for canonical details.`);
            return {};
        }
        const firstVariantNode = productNode.variants.edges[0].node;

        // Reuse the logic of _mapSingleVariant, but it expects a canonicalProductId which we don't have here directly.
        // We are returning Partial<CanonicalProductVariant>, so ProductId isn't strictly needed from this method.
        // Let's adapt the core mapping logic from _mapSingleVariant:

        const optionsMap = firstVariantNode.selectedOptions?.reduce((acc, opt) => {
            acc[opt.name] = opt.value;
            return acc;
        }, {});
        
        // Cost, variant-specific image, and requiresShipping are not directly on firstVariantNode or its inventoryItem

        return {
            // ProductId: undefined, // Not setting this, as it's a Partial update for an existing SSSync variant
            UserId: userId, // Or should this be omitted if not updating UserId?
            Sku: firstVariantNode.sku || null,
            Barcode: firstVariantNode.barcode || null,
            Title: productNode.title, // Using product title as per _mapSingleVariant logic
            Description: productNode.descriptionHtml || null,
            Price: parseFloat(firstVariantNode.price),
            CompareAtPrice: firstVariantNode.compareAtPrice ? parseFloat(firstVariantNode.compareAtPrice) : null,
            Cost: null, 
            Weight: firstVariantNode.inventoryItem?.measurement?.weight?.value ?? null,
            WeightUnit: firstVariantNode.inventoryItem?.measurement?.weight?.unit?.toLowerCase() ?? null,
            Options: optionsMap || null,
            RequiresShipping: undefined,
            IsTaxable: firstVariantNode.taxable === null ? undefined : firstVariantNode.taxable,
            TaxCode: firstVariantNode.taxCode || null,
            ImageId: null,
        };
    }

    mapCanonicalVariantToShopify(variantData: CanonicalProductVariant): any {
        this.logger.warn('mapCanonicalVariantToShopify not implemented');
        return {};
    }

    /**
     * Maps inventory levels for a specific linked Shopify variant to CanonicalInventoryLevel array.
     * @param linkedShopifyVariantNode The specific ShopifyVariantNode whose inventory is to be mapped.
     * @param sssyncVariantId The ID of the SSSync variant to which this inventory belongs.
     * @param platformConnectionId The ID of the platform connection.
     * @returns An array of CanonicalInventoryLevel objects.
     */
     mapShopifyInventoryToCanonical(
        linkedShopifyVariantNode: ShopifyVariantNode,
        sssyncVariantId: string, 
        platformConnectionId: string
    ): CanonicalInventoryLevel[] {
        const canonicalInventoryLevels: CanonicalInventoryLevel[] = [];

        if (!linkedShopifyVariantNode?.inventoryItem?.inventoryLevels?.edges) {
            this.logger.warn(`No inventory levels found for Shopify variant ${linkedShopifyVariantNode?.id} to map.`);
            return [];
        }

        for (const invLevelEdge of linkedShopifyVariantNode.inventoryItem.inventoryLevels.edges) {
            const shopifyInvLevel = invLevelEdge.node;
            canonicalInventoryLevels.push({
                // Id: Will be set by DB or InventoryService
                ProductVariantId: sssyncVariantId, // Link to the SSSync canonical variant
                PlatformConnectionId: platformConnectionId,
                PlatformLocationId: shopifyInvLevel.location.id, // Shopify Location GID
                Quantity: shopifyInvLevel.available ?? 0,
            });
        }
        return canonicalInventoryLevels;
     }

    mapCanonicalProductToShopifyInput(
        product: CanonicalProduct,
        variants: CanonicalProductVariant[],
        inventoryLevels: CanonicalInventoryLevel[], // All canonical levels for these variants across all connections
        targetShopifyLocationGids: string[] // Shopify Location GIDs for THIS connection to set inventory for
    ): ShopifyProductSetInput {
        if (!product || !variants || variants.length === 0) {
            this.logger.error('Cannot map to Shopify input: product or variants are missing/empty.');
            // Or throw an error, depending on how SyncCoordinator handles this.
            // For now, returning a partial/empty structure might lead to API errors.
            // It's better to ensure valid inputs before calling this mapper.
            throw new Error('Product and at least one variant are required to map to Shopify input.');
        }

        const shopifyVariants: ShopifyVariantInput[] = variants.map(v => {
            if (!v.Sku) {
                this.logger.error(`Variant with ID ${v.Id} is missing an SKU. Shopify requires SKUs for variants being created via productSet. Skipping this variant.`);
                // Or throw, as Shopify often requires SKU for new variants.
                // throw new Error(`Variant ${v.Id} (Title: ${v.Title}) is missing an SKU, which is required by Shopify.`);
                return null; // This variant will be filtered out later.
            }

            const optionValues: Array<{ optionName: string; name: string }> = [];
            if (v.Options) {
                for (const optName in v.Options) {
                    optionValues.push({ optionName: optName, name: v.Options[optName] });
                }
            } else if (variants.length === 1 && (!v.Options || Object.keys(v.Options).length === 0)) {
                // Handle single variant products that might not have explicit options (Shopify still needs a default title option)
                optionValues.push({ optionName: "Title", name: "Default Title" });
            }


            const inventoryItem: ShopifyInventoryItem = {
                cost: v.Cost?.toString(), // Cost should be string
                tracked: true, // Assuming all synced items should be tracked
                measurement: v.Weight && v.WeightUnit ? {
                    weight: {
                        value: v.Weight,
                        unit: v.WeightUnit.toUpperCase() as 'KILOGRAMS' | 'GRAMS' | 'POUNDS' | 'OUNCES'
                    }
                } : undefined
            };

            const inventoryQuantities: ShopifyInventoryQuantity[] = [];
            for (const shopifyLocationGid of targetShopifyLocationGids) {
                const relevantLevel = inventoryLevels.find(
                    il => il.ProductVariantId === v.Id && il.PlatformLocationId === shopifyLocationGid
                );
                inventoryQuantities.push({
                    locationId: shopifyLocationGid,
                    name: 'available', // Setting 'available' quantity
                    quantity: relevantLevel ? relevantLevel.Quantity : 0
                });
            }
            
            // TODO: Handle variant image (ShopifyVariantInput.file)
            // This would require knowing the primary image URL for the variant.
            // If v.ImageId refers to a CanonicalProductImage, we'd need to fetch its URL.
            // Or, if CanonicalProductVariant had a direct `ImageUrl` field for its primary image.

            return {
                optionValues,
                price: v.Price.toString(), // Price must be a string
                sku: v.Sku,
                inventoryItem,
                inventoryQuantities,
                taxable: v.IsTaxable !== undefined ? v.IsTaxable : true, // Default to true
                barcode: v.Barcode || undefined,
            };
        }).filter(Boolean) as ShopifyVariantInput[]; // Filter out nulls from skipped variants

        if (shopifyVariants.length === 0) {
             this.logger.error('No valid variants could be mapped for Shopify product creation. All variants were missing SKUs or other critical info.');
             throw new Error('Cannot create Shopify product: No valid variants provided or all were missing SKUs.');
        }
        
        const productOptions: ShopifyProductOption[] = [];
        if (variants.length > 0 && variants[0].Options) {
            const firstVariantOptions = variants[0].Options;
            for (const optName in firstVariantOptions) {
                // Collect all unique values for this option across all variants
                const uniqueValues = Array.from(new Set(variants.map(v => v.Options?.[optName]).filter(Boolean))) as string[];
                productOptions.push({
                    name: optName,
                    values: uniqueValues.map(val => ({ name: val }))
                });
            }
        }  else if (variants.length === 1) { // Single variant, no explicit options
             productOptions.push({ name: "Title", values: [{ name: "Default Title"}] });
        }


        // Map product-level images to ShopifyProductFile[]
        const files: ShopifyProductFile[] = product.ImageUrls?.map((url, index) => ({
            originalSource: url,
            alt: product.Title, // Use product title as alt text for now
            filename: `${product.Title.replace(/[^a-zA-Z0-9]/g, '_')}_${index + 1}`, // Basic filename
            contentType: 'IMAGE', // Assuming all are images
        })) || [];


        const input: ShopifyProductSetInput = {
            title: product.Title,
            descriptionHtml: product.Description || undefined,
            // vendor: product.PlatformSpecificData?.vendor, // Example
            // productType: product.PlatformSpecificData?.productType, // Example
            status: product.IsArchived ? 'ARCHIVED' : 'ACTIVE', // Default to ACTIVE if not archived
            // tags: product.PlatformSpecificData?.tags, // Example, ensure it's string[]
            productOptions: productOptions.length > 0 ? productOptions : undefined,
            files: files.length > 0 ? files : undefined,
            variants: shopifyVariants,
        };

        return input;
    }

    mapCanonicalProductToShopifyUpdateInput(
        product: CanonicalProduct,
        variants: CanonicalProductVariant[], // All current canonical variants for the product
        inventoryLevels: CanonicalInventoryLevel[],
        targetShopifyLocationGids: string[],
        existingPlatformVariantGids: Map<string, string> // Map<CanonicalVariantID, ShopifyVariantGID>
    ): ShopifyProductSetInput { // Re-using ShopifyProductSetInput structure
        if (!product || !variants) { 
            this.logger.error('Cannot map to Shopify update input: product or variants array is missing.');
            throw new Error('Product and variants array are required to map to Shopify update input.');
        }

        const shopifyVariants: ShopifyVariantWithOptionalIdInput[] = variants.map(v => {
            const shopifyVariantGid = v.Id ? existingPlatformVariantGids.get(v.Id) : undefined;

            if (!v.Sku) {
                if (!shopifyVariantGid) {
                    // This is a NEW variant being added during an update, and it has no SKU.
                    this.logger.error(`New variant (Canonical ID: ${v.Id}, Title: ${v.Title}) is missing an SKU. New variants cannot be added to Shopify without an SKU. Skipping this variant.`);
                    return null; // Filter this variant out later
                } else {
                    // This is an EXISTING variant being updated, and its canonical Sku is null/empty.
                    // We will send an empty string for the SKU. Shopify might reject this or clear the SKU.
                    this.logger.warn(`Existing variant (Canonical ID: ${v.Id}, Shopify GID: ${shopifyVariantGid}, Title: ${v.Title}) has a null/empty SKU in canonical data. Sending empty SKU to Shopify.`);
                }
            }

            const optionValues: Array<{ optionName: string; name: string }> = [];
            if (v.Options) {
                for (const optName in v.Options) {
                    optionValues.push({ optionName: optName, name: v.Options[optName] });
                }
            } else if (variants.length === 1 && (!v.Options || Object.keys(v.Options).length === 0)) {
                optionValues.push({ optionName: "Title", name: "Default Title" });
            }

            const inventoryItem: ShopifyInventoryItem = {
                cost: v.Cost?.toString(),
                tracked: true, 
                measurement: v.Weight && v.WeightUnit ? {
                    weight: {
                        value: v.Weight,
                        unit: v.WeightUnit.toUpperCase() as 'KILOGRAMS' | 'GRAMS' | 'POUNDS' | 'OUNCES'
                    }
                } : undefined
            };

            const inventoryQuantities: ShopifyInventoryQuantity[] = [];
            for (const shopifyLocationGid of targetShopifyLocationGids) {
                const relevantLevel = inventoryLevels.find(
                    il => il.ProductVariantId === v.Id && il.PlatformLocationId === shopifyLocationGid
                );
                inventoryQuantities.push({
                    locationId: shopifyLocationGid,
                    name: 'available',
                    quantity: relevantLevel ? relevantLevel.Quantity : 0
                });
            }
            
            const variantInput: ShopifyVariantWithOptionalIdInput = {
                id: shopifyVariantGid, 
                optionValues,
                price: v.Price.toString(),
                sku: v.Sku || "", // Ensure SKU is a string; if v.Sku is null/undefined, use ""
                inventoryItem,
                inventoryQuantities,
                taxable: v.IsTaxable !== undefined ? v.IsTaxable : true,
                barcode: v.Barcode || undefined,
                // TODO: Handle variant image updates. Shopify's ProductInput variants can take 'imageSrc' or 'imageId'.
            };
             // Clean up undefined id field if not present, as Shopify expects it to be absent for new variants
            if (!variantInput.id) {
                delete variantInput.id;
            }
            return variantInput;

        }).filter(Boolean) as ShopifyVariantWithOptionalIdInput[]; // Filter out nulls (new variants without SKUs)

        if (variants.length > 0 && shopifyVariants.length === 0 && !product.IsArchived) {
            // All variants were filtered out (e.g. new variants missing SKUs), and product is not being archived.
            // This would lead to a product with no variants if we proceed, which might be an issue.
            this.logger.error('All variants were filtered out during mapping for Shopify product update (e.g., new variants missing SKUs). Cannot proceed with update that would leave product with no variants unless archiving.');
            throw new Error('Cannot update Shopify product: No valid variants to update or add, and product is not being archived.');
        }

        const productOptions: ShopifyProductOption[] = [];
         if (variants.length > 0 && variants[0].Options) { // Define options based on the current set of variants
            const allOptionNames = new Set<string>();
            variants.forEach(v => {
                if (v.Options) {
                    Object.keys(v.Options).forEach(name => allOptionNames.add(name));
                }
            });

            allOptionNames.forEach(optName => {
                const uniqueValues = Array.from(new Set(variants.map(v => v.Options?.[optName]).filter(Boolean))) as string[];
                 if (uniqueValues.length > 0) {
                    productOptions.push({
                        name: optName,
                        values: uniqueValues.map(val => ({ name: val }))
                    });
                }
            });
        } else if (variants.length === 1 && (!variants[0].Options || Object.keys(variants[0].Options).length === 0)) {
            productOptions.push({ name: "Title", values: [{ name: "Default Title" }] });
        }


        // TODO: Handle image updates. ProductInput takes an `images` array.
        // This would involve comparing product.ImageUrls with existing Shopify images,
        // creating new ones, updating alt text, or disassociating. This is complex.
        // For now, we'll pass existing images if any, or new ones.
        // A more robust solution involves image IDs for updates.
        const files: ShopifyProductFile[] = product.ImageUrls?.map((url, index) => ({
            originalSource: url, // If these are new URLs. For existing images, we'd pass their Shopify Image GID.
            alt: product.Title, 
            filename: `${product.Title.replace(/[^a-zA-Z0-9]/g, '_')}_update_${index + 1}`,
            contentType: 'IMAGE',
        })) || [];

        // Construct the ShopifyProductSetInput (which serves as ProductInput for updates)
        // The main product GID is passed separately to the productUpdate mutation.
        const updateInput: ShopifyProductSetInput = {
            title: product.Title, // Title is required by ProductInput
            descriptionHtml: product.Description || undefined,
            status: product.IsArchived ? 'ARCHIVED' : 'ACTIVE',
            // Shopify's ProductInput can also take 'handle', 'vendor', 'productType', 'tags'
            // productOptions: productOptions.length > 0 ? productOptions : undefined, // Manage options carefully during update
            // files: files.length > 0 ? files : undefined, // Manage images carefully
            variants: shopifyVariants, // This will contain variants with GIDs (for update) and without (for creation)
        };
        
        // Conditionally add options and files to avoid sending empty arrays if not intended.
        if (productOptions.length > 0) {
            updateInput.productOptions = productOptions;
        }
        // For images, productUpdate uses an `images` field with `ImageInput` which can take `id` for existing, `src` for new.
        // The `files` field used in `productSet` is for StagedUploads, typically for new products.
        // This part needs careful handling for updates. For now, this mapping might not correctly update images.

        return updateInput;
     }
}
