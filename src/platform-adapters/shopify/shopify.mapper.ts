import { Injectable, Logger } from '@nestjs/common';

// Define the canonical structure based on ProductVariants table
// Use Partial<> as not all fields might be mapped during initial scan/fetch
// Ensure type compatibility (e.g., decimal -> number, text -> string)
export interface CanonicalProductVariant {
    Id?: string; // Internal ID, usually not set by mapper
    ProductId?: string; // Internal ID, usually not set directly by mapper
    UserId?: string; // Internal ID, usually not set by mapper
    Sku: string | null; // Allow null if Shopify allows missing SKU
    Barcode: string | null;
    Title: string;
    Description?: string | null; // Product-level description
    Price: number; // Convert from string
    CompareAtPrice?: number | null; // Convert from string
    Weight?: number | null;
    WeightUnit?: string | null;
    Options?: Record<string, string> | null; // Map selectedOptions
    // Add other relevant fields like Images if needed
    // CreatedAt, UpdatedAt are DB managed
}

// Define the structure received from ShopifyApiClient (flattened variant)
interface ShopifyVariantData {
    id: string; // Shopify Variant GID (e.g., gid://shopify/ProductVariant/123)
    sku: string | null;
    barcode: string | null;
    title: string; // Variant title
    price: string; // Comes as string
    compareAtPrice: string | null;
    weight: number | null;
    weightUnit: string;
    inventoryQuantity: number;
    inventoryItem: { id: string };
    image: { id: string; url: string; altText: string } | null;
    selectedOptions: { name: string; value: string }[];
    productId: string; // Shopify Product GID (e.g., gid://shopify/Product/456)
    // Include fields from the parent Product node if needed for mapping
    productTitle?: string;
    productDescriptionHtml?: string;
    productVendor?: string;
    productTags?: string[];
}

@Injectable()
export class ShopifyMapper {
    private readonly logger = new Logger(ShopifyMapper.name);

    // Renamed to reflect mapping a variant (potentially with product context)
    mapShopifyVariantToCanonical(shopifyVariant: ShopifyVariantData, shopifyProduct?: any /* Pass product node if needed */): Partial<CanonicalProductVariant> {
        if (!shopifyVariant) {
            this.logger.warn('Attempted to map null/undefined Shopify variant.');
            return {};
        }

        try {
            const optionsMap = shopifyVariant.selectedOptions?.reduce((acc, opt) => {
                acc[opt.name] = opt.value;
                return acc;
            }, {});

            // Combine variant title with product title if needed (depends on desired canonical title)
            // Example: const canonicalTitle = shopifyProduct?.title ? `${shopifyProduct.title} - ${shopifyVariant.title}` : shopifyVariant.title;
            const canonicalTitle = shopifyVariant.title; // Or just use variant title if product title is separate

            return {
                Sku: shopifyVariant.sku || null,
                Barcode: shopifyVariant.barcode || null,
                Title: canonicalTitle,
                // Use product description if available (strip HTML?) - Requires passing product node
                Description: shopifyProduct?.descriptionHtml || null,
                Price: parseFloat(shopifyVariant.price), // Convert price string to number
                CompareAtPrice: shopifyVariant.compareAtPrice ? parseFloat(shopifyVariant.compareAtPrice) : null,
                Weight: shopifyVariant.weight,
                WeightUnit: shopifyVariant.weightUnit?.toLowerCase(),
                Options: optionsMap || null,
                 // --- Platform Specific Data (Not part of canonical model directly, but useful for Mapping table) ---
                 // We return the core canonical fields. The processor using this mapper
                 // will need access to the original shopifyVariant.id, shopifyVariant.productId etc.
                 // to populate the PlatformProductMappings table.
            };
        } catch (error) {
             this.logger.error(`Error mapping Shopify variant ${shopifyVariant.id}: ${error.message}`, error.stack);
             // Return partial data or throw?
             return { Title: shopifyVariant.title || 'Mapping Error' }; // Basic fallback
        }
    }

    mapCanonicalVariantToShopify(variantData: CanonicalProductVariant): any /* Shopify ProductInput or VariantInput */ {
        this.logger.warn('mapCanonicalVariantToShopify not implemented');
        // TODO: Implement mapping logic from Canonical -> Shopify (for creating/updating)
        // This will likely involve constructing a complex GraphQL mutation variable object.
        return {
            // Example structure (needs refinement based on mutation)
            // productVariant: {
            //     sku: variantData.Sku,
            //     barcode: variantData.Barcode,
            //     price: variantData.Price?.toString(),
            //     compareAtPrice: variantData.CompareAtPrice?.toString(),
            //     weight: variantData.Weight,
            //     weightUnit: variantData.WeightUnit?.toUpperCase(),
            //     options: Object.values(variantData.Options || {}),
            //     // Needs inventoryItem ID for inventory updates
            // }
        };
    }

     mapShopifyInventory(inventoryData: any): any {
         this.logger.warn('mapShopifyInventory not implemented');
         // TODO: Implement mapping for inventory levels (often involves Location IDs)
         return {};
     }
}
