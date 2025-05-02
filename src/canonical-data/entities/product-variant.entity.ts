// src/canonical-data/entities/product-variant.entity.ts

// Note: This mirrors the structure defined in ShopifyMapper
// Consider consolidating if imports become complex, but separate files per entity is standard.
export interface ProductVariant {
    Id: string; // uuid PRIMARY KEY DEFAULT gen_random_uuid()
    ProductId: string; // uuid NOT NULL REFERENCES Products(Id)
    UserId: string; // uuid NOT NULL REFERENCES Users(Id)
    Sku: string; // text NOT NULL (Ensure consistency if mapper allows null)
    Barcode?: string | null; // text
    Title: string; // text NOT NULL
    Description?: string | null; // text
    Price: number; // decimal NOT NULL
    CompareAtPrice?: number | null; // decimal
    Weight?: number | null; // decimal
    WeightUnit?: string | null; // text
    Options?: Record<string, string> | null; // jsonb
    CreatedAt: Date | string; // timestamptz NOT NULL DEFAULT now()
    UpdatedAt: Date | string; // timestamptz NOT NULL DEFAULT now()
} 