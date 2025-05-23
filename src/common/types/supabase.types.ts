export interface Product {
    Id: string;
    UserId: string;
    IsArchived: boolean;
    CreatedAt: string;
    UpdatedAt: string;
}

export interface ProductVariant {
    Id: string;
    ProductId: string;
    UserId: string;
    Sku: string;
    Barcode: string | null;
    Title: string;
    Description: string | null;
    Price: number;
    CompareAtPrice: number | null;
    Weight: number | null;
    WeightUnit: string | null;
    Options: Record<string, string> | null;
    RequiresShipping: boolean;
    IsTaxable: boolean;
    TaxCode: string | null;
    ImageId: string | null;
    CreatedAt: string;
    UpdatedAt: string;
}

export interface ProductImage {
    Id: string;
    ProductVariantId: string;
    ImageUrl: string;
    AltText: string | null;
    Position: number;
    CreatedAt: string;
}

export interface InventoryLevel {
    Id: string;
    ProductVariantId: string;
    PlatformConnectionId: string;
    PlatformLocationId: string | null;
    Quantity: number;
    LastPlatformUpdateAt: string | null;
    CreatedAt: string;
    UpdatedAt: string;
}

export interface PlatformConnection {
    Id: string;
    UserId: string;
    PlatformType: string;
    DisplayName: string;
    Credentials: any; // This will be encrypted JSON
    Status: string;
    IsEnabled: boolean;
    LastSyncAttemptAt: string | null;
    LastSyncSuccessAt: string | null;
    CreatedAt: string;
    UpdatedAt: string;
}

export interface User {
    Id: string;
    Email: string;
    SubscriptionTierId: string | null;
    PhoneNumber: string | null;
    Occupation: string | null;
    Region: string | null;
    Currency: string | null;
    CreatedAt: string;
    UpdatedAt: string;
}

export interface UserProfile {
    UserId: string;
    DisplayName: string;
    ProfilePictureUrl: string | null;
    Bio: string | null;
    PublicRegion: string | null;
    CreatedAt: string;
    UpdatedAt: string;
} 