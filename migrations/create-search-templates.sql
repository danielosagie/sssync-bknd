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

-- Insert default templates
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
    '00000000-0000-0000-0000-000000000000' -- System user ID for default templates
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
    '00000000-0000-0000-0000-000000000000'
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
    '00000000-0000-0000-0000-000000000000'
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
    '00000000-0000-0000-0000-000000000000'
);

-- Grant permissions
GRANT ALL ON "SearchTemplates" TO authenticated;
GRANT USAGE ON SEQUENCE "SearchTemplates_Id_seq" TO authenticated; 