-- v4: Added User Profile details and separated public/private info.

-- Core Entities: Users and Subscriptions
CREATE TABLE "SubscriptionTiers" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "Name" text UNIQUE NOT NULL,
    "PriceMonthly" decimal NOT NULL,
    "ProductLimit" integer,
    "SyncOperationLimit" integer,
    "MarketplaceFeePercent" decimal NOT NULL,
    "OrderFeePercent" decimal NOT NULL,
    "AllowsInterSellerMarketplace" boolean NOT NULL DEFAULT false
    "AiScans" integer,
);

CREATE TABLE "Users" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Align with Supabase Auth User ID
    "Email" text UNIQUE NOT NULL,
    "SubscriptionTierId" uuid REFERENCES "SubscriptionTiers"("Id"),
    -- Private Settings Information (Not typically public)
    "PhoneNumber" text, -- Store securely if sensitive
    "Occupation" text,
    "Region" text, -- e.g., 'US-East', 'EU-West'
    "Currency" text, -- e.g., 'USD', 'EUR' (3-letter ISO code)
    -- PasswordHash text, -- **RECOMMENDED: Let Supabase Auth handle passwords.** Only include if NOT using Supabase Auth password features.
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_email ON "Users"("Email");

-- New table for public-facing seller profiles
CREATE TABLE "UserProfiles" (
    "UserId" uuid PRIMARY KEY REFERENCES "Users"("Id") ON DELETE CASCADE, -- One-to-one with Users
    "DisplayName" text NOT NULL, -- Public seller name
    "ProfilePictureUrl" text,
    "Bio" text,
    "PublicRegion" text, -- Optional: Publicly displayed region (might differ from settings region)
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);
-- Index on DisplayName if needed for searching sellers
CREATE INDEX idx_userprofiles_displayname ON "UserProfiles"("DisplayName");


-- Platform Connections (Depends on Users)
CREATE TABLE "PlatformConnections" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "UserId" uuid NOT NULL REFERENCES "Users"("Id") ON DELETE CASCADE,
    "PlatformType" text NOT NULL,
    "DisplayName" text NOT NULL,
    "Credentials" jsonb NOT NULL, -- Store encrypted OAuth credentials
    "Status" text NOT NULL,
    "IsEnabled" boolean NOT NULL DEFAULT true,
    "LastSyncAttemptAt" timestamptz,
    "LastSyncSuccessAt" timestamptz,
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_platformconnections_userid ON "PlatformConnections"("UserId");
CREATE INDEX idx_platformconnections_platformtype ON "PlatformConnections"("PlatformType");

-- Product Structure (Depends on Users)
CREATE TABLE "Products" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "UserId" uuid NOT NULL REFERENCES "Users"("Id") ON DELETE CASCADE,
    "IsArchived" boolean NOT NULL DEFAULT false,
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_userid ON "Products"("UserId");

CREATE TABLE "ProductVariants" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "ProductId" uuid NOT NULL REFERENCES "Products"("Id") ON DELETE CASCADE,
    "UserId" uuid NOT NULL REFERENCES "Users"("Id") ON DELETE CASCADE,
    "Sku" text NOT NULL,
    "Barcode" text,
    "Title" text NOT NULL,
    "Description" text,
    "Price" decimal NOT NULL,
    "CompareAtPrice" decimal,
    "Weight" decimal,
    "WeightUnit" text,
    "Options" jsonb,
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("UserId", "Sku")
);
CREATE INDEX idx_productvariants_productid ON "ProductVariants"("ProductId");
CREATE INDEX idx_productvariants_userid ON "ProductVariants"("UserId");
CREATE INDEX idx_productvariants_sku ON "ProductVariants"("Sku");
CREATE INDEX idx_productvariants_barcode ON "ProductVariants"("Barcode");
CREATE INDEX idx_productvariants_userid_barcode ON "ProductVariants"("UserId", "Barcode");

-- Mappings and Levels (Depend on Products/Variants and Connections)
CREATE TABLE "PlatformProductMappings" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "PlatformConnectionId" uuid NOT NULL REFERENCES "PlatformConnections"("Id") ON DELETE CASCADE,
    "ProductVariantId" uuid NOT NULL REFERENCES "ProductVariants"("Id") ON DELETE CASCADE,
    "PlatformProductId" text NOT NULL,
    "PlatformVariantId" text,
    "PlatformSku" text,
    "PlatformSpecificData" jsonb,
    "LastSyncedAt" timestamptz,
    "SyncStatus" text NOT NULL DEFAULT 'Pending',
    "SyncErrorMessage" text,
    "IsEnabled" boolean NOT NULL DEFAULT true,
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("PlatformConnectionId", "ProductVariantId"),
    UNIQUE ("PlatformConnectionId", "PlatformProductId", "PlatformVariantId")
);
CREATE INDEX idx_platformproductmappings_platformconnectionid ON "PlatformProductMappings"("PlatformConnectionId");
CREATE INDEX idx_platformproductmappings_productvariantid ON "PlatformProductMappings"("ProductVariantId");
CREATE INDEX idx_platformproductmappings_platformproductid ON "PlatformProductMappings"("PlatformProductId");
CREATE INDEX idx_platformproductmappings_platformvariantid ON "PlatformProductMappings"("PlatformVariantId");

CREATE TABLE "ProductImages" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "ProductVariantId" uuid NOT NULL REFERENCES "ProductVariants"("Id") ON DELETE CASCADE,
    "ImageUrl" text NOT NULL,
    "AltText" text,
    "Position" integer NOT NULL DEFAULT 0,
    "PlatformMappingId" uuid REFERENCES "PlatformProductMappings"("Id") ON DELETE SET NULL,
    "CreatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_productimages_productvariantid ON "ProductImages"("ProductVariantId");
CREATE INDEX idx_productimages_platformmappingid ON "ProductImages"("PlatformMappingId");

CREATE TABLE "InventoryLevels" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "ProductVariantId" uuid NOT NULL REFERENCES "ProductVariants"("Id") ON DELETE CASCADE,
    "PlatformConnectionId" uuid NOT NULL REFERENCES "PlatformConnections"("Id") ON DELETE CASCADE,
    "PlatformLocationId" text,
    "Quantity" integer NOT NULL DEFAULT 0,
    "UpdatedAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("ProductVariantId", "PlatformConnectionId", "PlatformLocationId")
);
CREATE INDEX idx_inventorylevels_productvariantid ON "InventoryLevels"("ProductVariantId");
CREATE INDEX idx_inventorylevels_platformconnectionid ON "InventoryLevels"("PlatformConnectionId");

-- AI Generated Content (Depends on Products)
CREATE TABLE "AiGeneratedContent" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "ProductId" uuid NOT NULL REFERENCES "Products"("Id") ON DELETE CASCADE,
    "ContentType" text NOT NULL,
    "SourceApi" text NOT NULL,
    "Prompt" text,
    "GeneratedText" text NOT NULL,
    "Metadata" jsonb,
    "IsActive" boolean NOT NULL DEFAULT false,
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_aigeneratedcontent_productid ON "AiGeneratedContent"("ProductId");

-- Orders & Marketplace (Depend on Users, Connections, Variants)
CREATE TABLE "Orders" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "UserId" uuid NOT NULL REFERENCES "Users"("Id") ON DELETE CASCADE,
    "PlatformConnectionId" uuid NOT NULL REFERENCES "PlatformConnections"("Id") ON DELETE CASCADE,
    "PlatformOrderId" text NOT NULL,
    "OrderNumber" text,
    "Status" text NOT NULL,
    "Currency" text NOT NULL,
    "TotalAmount" decimal NOT NULL,
    "CustomerEmail" text,
    "OrderDate" timestamptz NOT NULL,
    "IsMarketplaceOrder" boolean NOT NULL DEFAULT false,
    "MarketplaceSellerUserId" uuid REFERENCES "Users"("Id"),
    "MarketplaceFeeAmount" decimal,
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_userid ON "Orders"("UserId");
CREATE INDEX idx_orders_platformconnectionid ON "Orders"("PlatformConnectionId");
CREATE INDEX idx_orders_platformorderid ON "Orders"("PlatformOrderId");

CREATE TABLE "OrderItems" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrderId" uuid NOT NULL REFERENCES "Orders"("Id") ON DELETE CASCADE,
    "ProductVariantId" uuid REFERENCES "ProductVariants"("Id") ON DELETE SET NULL,
    "PlatformProductId" text,
    "PlatformVariantId" text,
    "Sku" text NOT NULL,
    "Title" text NOT NULL,
    "Quantity" integer NOT NULL,
    "Price" decimal NOT NULL
);
CREATE INDEX idx_orderitems_orderid ON "OrderItems"("OrderId");
CREATE INDEX idx_orderitems_productvariantid ON "OrderItems"("ProductVariantId");

CREATE TABLE "MarketplaceListings" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "ProductVariantId" uuid UNIQUE NOT NULL REFERENCES "ProductVariants"("Id") ON DELETE CASCADE,
    "SellerUserId" uuid NOT NULL REFERENCES "Users"("Id") ON DELETE CASCADE,
    "Price" decimal NOT NULL,
    "AvailableQuantity" integer NOT NULL,
    "IsEnabled" boolean NOT NULL DEFAULT true,
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketplacelistings_selleruserid ON "MarketplaceListings"("SellerUserId");

-- System & Logging (Depends on Users, Connections)
CREATE TABLE "ActivityLogs" (
    "Id" bigserial PRIMARY KEY,
    "Timestamp" timestamptz NOT NULL DEFAULT now(),
    "UserId" uuid REFERENCES "Users"("Id") ON DELETE SET NULL,
    "PlatformConnectionId" uuid REFERENCES "PlatformConnections"("Id") ON DELETE SET NULL,
    "EntityType" text,
    "EntityId" text,
    "EventType" text NOT NULL,
    "Status" text NOT NULL,
    "Message" text NOT NULL,
    "Details" jsonb
);
CREATE INDEX idx_activitylogs_timestamp ON "ActivityLogs"("Timestamp");
CREATE INDEX idx_activitylogs_userid ON "ActivityLogs"("UserId");
CREATE INDEX idx_activitylogs_platformconnectionid ON "ActivityLogs"("PlatformConnectionId");
CREATE INDEX idx_activitylogs_eventtype ON "ActivityLogs"("EventType");

