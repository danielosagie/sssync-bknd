export interface InventoryLevel {
    Id: string; // uuid PRIMARY KEY DEFAULT gen_random_uuid()
    ProductVariantId: string; // uuid NOT NULL REFERENCES ProductVariants(Id)
    PlatformConnectionId: string; // uuid NOT NULL REFERENCES PlatformConnections(Id)
    PlatformLocationId?: string | null; // text (NULL implies default/untracked location for platform)
    Quantity: number; // integer NOT NULL DEFAULT 0
    UpdatedAt: Date | string; // timestamptz NOT NULL DEFAULT now()
} 