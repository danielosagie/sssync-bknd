import { Injectable, Logger } from '@nestjs/common';
import { 
    ShopifyProductNode, 
    ShopifyVariantNode, 
    ShopifyInventoryLevelNode, 
    ShopifyLocationNode 
} from './shopify-api-client.service'; // Assuming these are exported
import { CanonicalInventoryLevel } from '../../canonical-data/inventory.service'; // Adjust path if needed

// --- Canonical Data Structure Interfaces (based on sssync-db.md) ---
// These might eventually live in a central canonical-data module and be imported
export interface CanonicalProduct {
    Id?: string; // Will be set by DB or ProductsService
    UserId: string;
    IsArchived: boolean;
    ImageUrls?: string[]; // Added for product-level images
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
    Weight?: number | null;
    WeightUnit?: string | null;
    Options?: Record<string, string> | null; // e.g. { "Color": "Blue", "Size": "Large" }
    // Add fields for images if they are directly on the variant in canonical model
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

        return {
            // Id: Will be set by DB or ProductsService
            ProductId: canonicalProductId, // Link to the canonical product
            UserId: userId,
            Sku: variantNode.sku || null,
            Barcode: variantNode.barcode || null,
            Title: productNode.title,
            Description: productNode.descriptionHtml || null,
            Price: parseFloat(variantNode.price),
            CompareAtPrice: variantNode.compareAtPrice ? parseFloat(variantNode.compareAtPrice) : null,
            Weight: variantNode.inventoryItem?.measurement?.weight?.value ?? null,
            WeightUnit: variantNode.inventoryItem?.measurement?.weight?.unit?.toLowerCase() ?? null,
            Options: optionsMap || null,
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
            Quantity: 0, // TEMP: Set to 0 as 'available' was removed from ShopifyInventoryLevelNode
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

    mapCanonicalVariantToShopify(variantData: CanonicalProductVariant): any {
        this.logger.warn('mapCanonicalVariantToShopify not implemented');
        return {};
    }

     mapShopifyInventory(inventoryData: any): any {
         this.logger.warn('mapShopifyInventory not implemented');
         return {};
     }
}
