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

-- Partial unique indexes to allow multiple connections of the same platform type per user,
-- as long as the platform-specific identifier (shop, merchantId) is different.
CREATE UNIQUE INDEX "platformconnections_shopify_unique_idx" ON "PlatformConnections" ("UserId", ("PlatformSpecificData"->>'shop')) WHERE "PlatformType" = 'shopify';
CREATE UNIQUE INDEX "platformconnections_square_unique_idx" ON "PlatformConnections" ("UserId", ("PlatformSpecificData"->>'merchantId')) WHERE "PlatformType" = 'square';
CREATE UNIQUE INDEX "platformconnections_clover_unique_idx" ON "PlatformConnections" ("UserId", ("PlatformSpecificData"->>'merchantId')) WHERE "PlatformType" = 'clover';

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
    "Cost" decimal,
    "Weight" decimal,
    "WeightUnit" text,
    "Options" jsonb,
    "RequiresShipping" boolean,
    "IsTaxable" boolean,
    "TaxCode" text,
    "ImageId" uuid REFERENCES "ProductImages"("Id") ON DELETE SET NULL,
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now(),
    "status" text,
    UNIQUE ("UserId", "Sku")
);
CREATE INDEX idx_productvariants_productid ON "ProductVariants"("ProductId");
CREATE INDEX idx_productvariants_userid ON "ProductVariants"("UserId");
CREATE INDEX idx_productvariants_sku ON "ProductVariants"("Sku");
CREATE INDEX idx_productvariants_barcode ON "ProductVariants"("Barcode");
CREATE INDEX idx_productvariants_userid_barcode ON "ProductVariants"("UserId", "Barcode");


-- Create the ProductImages table
CREATE TABLE "ProductImages" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique identifier for the image
    "ProductVariantId" uuid NOT NULL REFERENCES "ProductVariants"("Id") ON DELETE CASCADE, -- Link to ProductVariants
    "ImageUrl" text NOT NULL, -- URL of the product image
    "AltText" text, -- Optional alternative text for the image
    "Position" integer NOT NULL DEFAULT 0, -- Position for ordering images
    "PlatformMappingId" uuid REFERENCES "PlatformProductMappings"("Id") ON DELETE SET NULL, -- Optional link to platform mappings
    "CreatedAt" timestamptz NOT NULL DEFAULT now() -- Timestamp for when the record was created
);

-- Create indexes for ProductImages
CREATE INDEX idx_productimages_productvariantid ON "ProductImages"("ProductVariantId");
CREATE INDEX idx_productimages_platformmappingid ON "ProductImages"("PlatformMappingId");


-- Create the ProductEmbeddings table
CREATE TABLE "ProductEmbeddings" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique identifier for the embedding
    "ProductVariantId" uuid REFERENCES "ProductVariants"("Id") ON DELETE CASCADE, -- Link to ProductVariants
    "AiGeneratedContentId" uuid REFERENCES "AiGeneratedContent"("Id") ON DELETE SET NULL, -- Optional link to AI-generated content
    "SourceType" text NOT NULL, -- Source type of the embedding (e.g., 'canonical_title', 'canonical_description')
    "ContentText" text NOT NULL, -- The text that was embedded
    embedding vector(384) NOT NULL, -- Embedding vector for the product
    "ModelName" text NOT NULL, -- Name of the model used for embedding (e.g., 'all-MiniLM-L6-v2')
    "CreatedAt" timestamptz NOT NULL DEFAULT now() -- Timestamp for when the record was created
);

-- Create indexes for ProductEmbeddings
CREATE INDEX idx_productembeddings_variant_id ON "ProductEmbeddings"("ProductVariantId");
CREATE INDEX idx_productembeddings_embedding ON "ProductEmbeddings" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100); -- Example HNSW or IVFFlat index

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
    UNIQUE ("PlatformConnectionId", "PlatformProductId", "PlatformVariantId"),
    "status" text,
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


ALTER TABLE "ProductVariants" 
ADD COLUMN "OnShopify" boolean NOT NULL DEFAULT false,
ADD COLUMN "OnSquare" boolean NOT NULL DEFAULT false,
ADD COLUMN "OnClover" boolean NOT NULL DEFAULT false,
ADD COLUMN "OnAmazon" boolean NOT NULL DEFAULT false,
ADD COLUMN "OnEbay" boolean NOT NULL DEFAULT false,
ADD COLUMN "OnFacebook" boolean NOT NULL DEFAULT false;

-- Add indexes for fast filtering
CREATE INDEX idx_productvariants_onshopify ON "ProductVariants"("OnShopify") WHERE "OnShopify" = true;
CREATE INDEX idx_productvariants_onsquare ON "ProductVariants"("OnSquare") WHERE "OnSquare" = true;
CREATE INDEX idx_productvariants_onclover ON "ProductVariants"("OnClover") WHERE "OnClover" = true;
CREATE INDEX idx_productvariants_onamazon ON "ProductVariants"("OnAmazon") WHERE "OnAmazon" = true;
CREATE INDEX idx_productvariants_onebay ON "ProductVariants"("OnEbay") WHERE "OnEbay" = true;
CREATE INDEX idx_productvariants_onfacebook ON "ProductVariants"("OnFacebook") WHERE "OnFacebook" = true;

-- Composite index for multiple platform filtering
CREATE INDEX idx_productvariants_platforms ON "ProductVariants"("OnShopify", "OnSquare", "OnClover", "OnAmazon", "OnEbay", "OnFacebook");

-- Update existing records based on current mappings
UPDATE "ProductVariants" 
SET "OnShopify" = true 
WHERE "Id" IN (
    SELECT DISTINCT ppm."ProductVariantId" 
    FROM "PlatformProductMappings" ppm
    JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
    WHERE LOWER(pc."PlatformType") = 'shopify' AND ppm."IsEnabled" = true
);

UPDATE "ProductVariants" 
SET "OnSquare" = true 
WHERE "Id" IN (
    SELECT DISTINCT ppm."ProductVariantId" 
    FROM "PlatformProductMappings" ppm
    JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
    WHERE LOWER(pc."PlatformType") = 'square' AND ppm."IsEnabled" = true
);

UPDATE "ProductVariants" 
SET "OnClover" = true 
WHERE "Id" IN (
    SELECT DISTINCT ppm."ProductVariantId" 
    FROM "PlatformProductMappings" ppm
    JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
    WHERE LOWER(pc."PlatformType") = 'clover' AND ppm."IsEnabled" = true
);

UPDATE "ProductVariants" 
SET "OnAmazon" = true 
WHERE "Id" IN (
    SELECT DISTINCT ppm."ProductVariantId" 
    FROM "PlatformProductMappings" ppm
    JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
    WHERE LOWER(pc."PlatformType") = 'amazon' AND ppm."IsEnabled" = true
);

UPDATE "ProductVariants" 
SET "OnEbay" = true 
WHERE "Id" IN (
    SELECT DISTINCT ppm."ProductVariantId" 
    FROM "PlatformProductMappings" ppm
    JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
    WHERE LOWER(pc."PlatformType") = 'ebay' AND ppm."IsEnabled" = true
);

UPDATE "ProductVariants" 
SET "OnFacebook" = true 
WHERE "Id" IN (
    SELECT DISTINCT ppm."ProductVariantId" 
    FROM "PlatformProductMappings" ppm
    JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
    WHERE LOWER(pc."PlatformType") = 'facebook' AND ppm."IsEnabled" = true
);


-- Create SearchTemplates table for user-customizable business templates
CREATE TABLE IF NOT EXISTS "SearchTemplates" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "UserId" UUID REFERENCES "Users"("Id") ON DELETE CASCADE,
    "Name" TEXT NOT NULL,
    "Category" TEXT NOT NULL,
    "Description" TEXT,
    "SearchPrompt" TEXT NOT NULL,
    "SuggestedSites" TEXT[],
    "ExtractionSchema" JSONB,
    "SearchKeywords" TEXT[],
    "IsDefault" BOOLEAN DEFAULT false,
    "IsPublic" BOOLEAN DEFAULT false,
    "UsageCount" INTEGER DEFAULT 0,
    "CreatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "UpdatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS "idx_search_templates_user_id" ON "SearchTemplates"("UserId");
CREATE INDEX IF NOT EXISTS "idx_search_templates_category" ON "SearchTemplates"("Category");
CREATE INDEX IF NOT EXISTS "idx_search_templates_is_default" ON "SearchTemplates"("IsDefault") WHERE "IsDefault" = true;
CREATE INDEX IF NOT EXISTS "idx_search_templates_is_public" ON "SearchTemplates"("IsPublic") WHERE "IsPublic" = true;
CREATE INDEX IF NOT EXISTS "idx_search_templates_keywords" ON "SearchTemplates" USING gin("SearchKeywords");

-- Create trigger for UpdatedAt
CREATE OR REPLACE FUNCTION update_search_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW."UpdatedAt" = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_search_templates_updated_at
    BEFORE UPDATE ON "SearchTemplates"
    FOR EACH ROW
    EXECUTE FUNCTION update_search_templates_updated_at();

-- Enable RLS
ALTER TABLE "SearchTemplates" ENABLE ROW LEVEL SECURITY;

-- Policy: Users can access their own templates and public templates
CREATE POLICY "Users can access their own and public search templates"
ON "SearchTemplates"
FOR ALL
USING (
    "UserId" = auth.uid() OR "IsPublic" = true
);


INSERT INTO "SearchTemplates" ("Name", "Category", "Description", "SearchPrompt", "SuggestedSites", "ExtractionSchema", "SearchKeywords", "IsDefault", "IsPublic", "UserId") VALUES
(
    'Comic Books',
    'Collectibles',
    'Template for comic book product listings',
    'Extract comic book details: title, issue number, variant cover, condition/grade, publisher, publication year, key characters, creators, story arcs, and market value',
    ARRAY['metropoliscomics.com', 'mycomicshop.com', 'comicconnect.com', 'heritage-auctions.com', 'covrprice.com'],
    '{
        "title": "Comic book title and series name",
        "issue_number": "Issue number and variant details",
        "condition": "Condition grade (CGC, CBCS, raw)",
        "publisher": "Publisher name (Marvel, DC, etc.)",
        "year": "Publication year",
        "characters": "Key characters featured",
        "creators": "Writer, artist, cover artist",
        "key_issues": "First appearances, deaths, major events"
    }'::jsonb,
    ARRAY['comic', 'issue', 'variant', 'cgc', 'cbcs', 'marvel', 'dc'],
    true,
    true,
    NULL -- No specific user, applicable for all users
),
(
    'Electronics',
    'Technology',
    'Template for electronic devices and gadgets',
    'Extract electronics details: product name, brand, model number, specifications, compatibility, condition, warranty status, accessories included, and current market price',
    ARRAY['bestbuy.com', 'newegg.com', 'amazon.com', 'bhphotovideo.com', 'adorama.com'],
    '{
        "product_name": "Device name and model",
        "brand": "Manufacturer brand",
        "model_number": "Specific model number",
        "specifications": "Technical specifications",
        "compatibility": "Compatible systems/devices",
        "condition": "Working condition and cosmetic state",
        "accessories": "Included accessories and cables"
    }'::jsonb,
    ARRAY['electronics', 'tech', 'device', 'model', 'specifications', 'warranty'],
    true,
    true,
    NULL -- No specific user, applicable for all users
),
(
    'Trading Cards',
    'Collectibles',
    'Template for trading cards and sports cards',
    'Extract trading card details: player/character name, card number, set name, year, condition/grade, rookie status, parallel/insert type, and current market value',
    ARRAY['cardmarket.com', 'tcgplayer.com', 'comc.com', 'psacard.com', 'beckett.com'],
    '{
        "player_name": "Player or character name",
        "card_number": "Card number within set",
        "set_name": "Set or series name",
        "year": "Year of release",
        "condition": "Grade or condition (PSA, BGS, raw)",
        "card_type": "Base, rookie, insert, parallel, autograph",
        "sport": "Sport or game type"
    }'::jsonb,
    ARRAY['card', 'rookie', 'psa', 'bgs', 'autograph', 'parallel', 'insert'],
    true,
    true,
    NULL -- No specific user, applicable for all users
),
(
    'General Products',
    'General',
    'Default template for any product type',
    'Extract comprehensive product details: title, brand, model, price, description, specifications, dimensions, weight, materials, features, and condition',
    ARRAY['amazon.com', 'ebay.com', 'walmart.com', 'target.com', 'google.com'],
    '{
        "title": "Product name and model",
        "brand": "Manufacturer or brand name",
        "price": "Current market price",
        "description": "Detailed product description",
        "specifications": "Technical specifications",
        "condition": "Product condition (new, used, refurbished)",
        "features": "Key features and benefits",
        "dimensions": "Size and weight information"
    }'::jsonb,
    ARRAY['product', 'brand', 'model', 'specifications', 'features'],
    true,
    true,
    NULL -- No specific user, applicable for all users
);

-- Grant permissions
GRANT ALL ON "SearchTemplates" TO authenticated;

-- Create match_jobs table for async match job tracking
CREATE TABLE IF NOT EXISTS public.match_jobs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    job_id TEXT UNIQUE NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
    current_stage TEXT,
    progress JSONB DEFAULT '{}',
    results JSONB DEFAULT '[]',
    summary JSONB DEFAULT '{}',
    error TEXT,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    estimated_completion_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_match_jobs_job_id ON public.match_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_match_jobs_user_id ON public.match_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_match_jobs_status ON public.match_jobs(status);
CREATE INDEX IF NOT EXISTS idx_match_jobs_created_at ON public.match_jobs(created_at DESC);

-- Enable RLS (Row Level Security)
ALTER TABLE public.match_jobs ENABLE ROW LEVEL SECURITY;

-- Create RLS policy so users can only see their own jobs
CREATE POLICY "Users can view their own match jobs" ON public.match_jobs
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own match jobs" ON public.match_jobs
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own match jobs" ON public.match_jobs
    FOR UPDATE USING (auth.uid() = user_id);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_match_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_match_jobs_updated_at
    BEFORE UPDATE ON public.match_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_match_jobs_updated_at(); 