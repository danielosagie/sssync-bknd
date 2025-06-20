-- Migration: Add Platform Boolean Columns to ProductVariants
-- This allows fast filtering without complex joins

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

-- Function to update platform boolean flags
CREATE OR REPLACE FUNCTION update_platform_flags()
RETURNS void AS $$
BEGIN
    -- Update OnShopify flag
    UPDATE "ProductVariants" 
    SET "OnShopify" = true 
    WHERE "Id" IN (
        SELECT DISTINCT ppm."ProductVariantId"
        FROM "PlatformProductMappings" ppm
        JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
        WHERE pc."PlatformType" = 'Shopify' 
        AND pc."IsEnabled" = true 
        AND ppm."IsEnabled" = true
    );
    
    -- Update OnSquare flag
    UPDATE "ProductVariants" 
    SET "OnSquare" = true 
    WHERE "Id" IN (
        SELECT DISTINCT ppm."ProductVariantId"
        FROM "PlatformProductMappings" ppm
        JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
        WHERE pc."PlatformType" = 'Square' 
        AND pc."IsEnabled" = true 
        AND ppm."IsEnabled" = true
    );
    
    -- Update OnClover flag
    UPDATE "ProductVariants" 
    SET "OnClover" = true 
    WHERE "Id" IN (
        SELECT DISTINCT ppm."ProductVariantId"
        FROM "PlatformProductMappings" ppm
        JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
        WHERE pc."PlatformType" = 'Clover' 
        AND pc."IsEnabled" = true 
        AND ppm."IsEnabled" = true
    );
    
    -- Update OnAmazon flag
    UPDATE "ProductVariants" 
    SET "OnAmazon" = true 
    WHERE "Id" IN (
        SELECT DISTINCT ppm."ProductVariantId"
        FROM "PlatformProductMappings" ppm
        JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
        WHERE pc."PlatformType" = 'Amazon' 
        AND pc."IsEnabled" = true 
        AND ppm."IsEnabled" = true
    );
    
    -- Update OnEbay flag
    UPDATE "ProductVariants" 
    SET "OnEbay" = true 
    WHERE "Id" IN (
        SELECT DISTINCT ppm."ProductVariantId"
        FROM "PlatformProductMappings" ppm
        JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
        WHERE pc."PlatformType" = 'Ebay' 
        AND pc."IsEnabled" = true 
        AND ppm."IsEnabled" = true
    );
    
    -- Update OnFacebook flag
    UPDATE "ProductVariants" 
    SET "OnFacebook" = true 
    WHERE "Id" IN (
        SELECT DISTINCT ppm."ProductVariantId"
        FROM "PlatformProductMappings" ppm
        JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
        WHERE pc."PlatformType" = 'Facebook' 
        AND pc."IsEnabled" = true 
        AND ppm."IsEnabled" = true
    );
    
    RAISE NOTICE 'Platform flags updated successfully';
END;
$$ LANGUAGE plpgsql;

-- Execute the function to populate existing data
SELECT update_platform_flags();

-- Create trigger function to automatically update flags when mappings change
CREATE OR REPLACE FUNCTION trigger_update_platform_flags()
RETURNS trigger AS $$
DECLARE
    platform_type text;
BEGIN
    -- Get platform type for the connection
    SELECT pc."PlatformType" INTO platform_type
    FROM "PlatformConnections" pc
    WHERE pc."Id" = COALESCE(NEW."PlatformConnectionId", OLD."PlatformConnectionId");
    
    -- Update the appropriate platform flag
    IF platform_type = 'Shopify' THEN
        UPDATE "ProductVariants" 
        SET "OnShopify" = EXISTS (
            SELECT 1 FROM "PlatformProductMappings" ppm2
            JOIN "PlatformConnections" pc2 ON ppm2."PlatformConnectionId" = pc2."Id"
            WHERE ppm2."ProductVariantId" = COALESCE(NEW."ProductVariantId", OLD."ProductVariantId")
            AND pc2."PlatformType" = 'Shopify' 
            AND pc2."IsEnabled" = true 
            AND ppm2."IsEnabled" = true
        )
        WHERE "Id" = COALESCE(NEW."ProductVariantId", OLD."ProductVariantId");
    ELSIF platform_type = 'Square' THEN
        UPDATE "ProductVariants" 
        SET "OnSquare" = EXISTS (
            SELECT 1 FROM "PlatformProductMappings" ppm2
            JOIN "PlatformConnections" pc2 ON ppm2."PlatformConnectionId" = pc2."Id"
            WHERE ppm2."ProductVariantId" = COALESCE(NEW."ProductVariantId", OLD."ProductVariantId")
            AND pc2."PlatformType" = 'Square' 
            AND pc2."IsEnabled" = true 
            AND ppm2."IsEnabled" = true
        )
        WHERE "Id" = COALESCE(NEW."ProductVariantId", OLD."ProductVariantId");
    ELSIF platform_type = 'Clover' THEN
        UPDATE "ProductVariants" 
        SET "OnClover" = EXISTS (
            SELECT 1 FROM "PlatformProductMappings" ppm2
            JOIN "PlatformConnections" pc2 ON ppm2."PlatformConnectionId" = pc2."Id"
            WHERE ppm2."ProductVariantId" = COALESCE(NEW."ProductVariantId", OLD."ProductVariantId")
            AND pc2."PlatformType" = 'Clover' 
            AND pc2."IsEnabled" = true 
            AND ppm2."IsEnabled" = true
        )
        WHERE "Id" = COALESCE(NEW."ProductVariantId", OLD."ProductVariantId");
    ELSIF platform_type = 'Amazon' THEN
        UPDATE "ProductVariants" 
        SET "OnAmazon" = EXISTS (
            SELECT 1 FROM "PlatformProductMappings" ppm2
            JOIN "PlatformConnections" pc2 ON ppm2."PlatformConnectionId" = pc2."Id"
            WHERE ppm2."ProductVariantId" = COALESCE(NEW."ProductVariantId", OLD."ProductVariantId")
            AND pc2."PlatformType" = 'Amazon' 
            AND pc2."IsEnabled" = true 
            AND ppm2."IsEnabled" = true
        )
        WHERE "Id" = COALESCE(NEW."ProductVariantId", OLD."ProductVariantId");
    ELSIF platform_type = 'Ebay' THEN
        UPDATE "ProductVariants" 
        SET "OnEbay" = EXISTS (
            SELECT 1 FROM "PlatformProductMappings" ppm2
            JOIN "PlatformConnections" pc2 ON ppm2."PlatformConnectionId" = pc2."Id"
            WHERE ppm2."ProductVariantId" = COALESCE(NEW."ProductVariantId", OLD."ProductVariantId")
            AND pc2."PlatformType" = 'Ebay' 
            AND pc2."IsEnabled" = true 
            AND ppm2."IsEnabled" = true
        )
        WHERE "Id" = COALESCE(NEW."ProductVariantId", OLD."ProductVariantId");
    ELSIF platform_type = 'Facebook' THEN
        UPDATE "ProductVariants" 
        SET "OnFacebook" = EXISTS (
            SELECT 1 FROM "PlatformProductMappings" ppm2
            JOIN "PlatformConnections" pc2 ON ppm2."PlatformConnectionId" = pc2."Id"
            WHERE ppm2."ProductVariantId" = COALESCE(NEW."ProductVariantId", OLD."ProductVariantId")
            AND pc2."PlatformType" = 'Facebook' 
            AND pc2."IsEnabled" = true 
            AND ppm2."IsEnabled" = true
        )
        WHERE "Id" = COALESCE(NEW."ProductVariantId", OLD."ProductVariantId");
    END IF;
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Create triggers to keep platform flags updated
CREATE TRIGGER platform_mappings_update_flags_trigger
    AFTER INSERT OR UPDATE OR DELETE ON "PlatformProductMappings"
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_platform_flags();

-- Also trigger when platform connections change status
CREATE OR REPLACE FUNCTION trigger_update_platform_flags_on_connection_change()
RETURNS trigger AS $$
BEGIN
    -- Update all platform flags for all variants connected to this platform
    IF OLD."PlatformType" = 'Shopify' OR NEW."PlatformType" = 'Shopify' THEN
        UPDATE "ProductVariants" 
        SET "OnShopify" = EXISTS (
            SELECT 1 FROM "PlatformProductMappings" ppm
            JOIN "PlatformConnections" pc ON ppm."PlatformConnectionId" = pc."Id"
            WHERE ppm."ProductVariantId" = "ProductVariants"."Id"
            AND pc."PlatformType" = 'Shopify' 
            AND pc."IsEnabled" = true 
            AND ppm."IsEnabled" = true
        );
    END IF;
    
    -- Similar updates for other platforms can be added here
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER platform_connections_update_flags_trigger
    AFTER UPDATE ON "PlatformConnections"
    FOR EACH ROW
    WHEN (OLD."IsEnabled" IS DISTINCT FROM NEW."IsEnabled")
    EXECUTE FUNCTION trigger_update_platform_flags_on_connection_change(); 