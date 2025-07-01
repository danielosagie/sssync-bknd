-- AI Usage Tracking System
-- Based on how OpenAI, Anthropic, and other AI companies track usage

-- Main usage tracking table
CREATE TABLE "AiUsage" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "UserId" uuid NOT NULL REFERENCES "Users"("Id") ON DELETE CASCADE,
    "ServiceType" text NOT NULL, -- 'embedding', 'generation', 'firecrawl', 'serpapi'
    "ModelName" text NOT NULL, -- 'qwen3-0.6b', 'groq-llama', 'firecrawl-scrape'
    "Operation" text NOT NULL, -- 'embed_product', 'generate_details', 'scrape_url', 'visual_search'
    "InputTokens" integer DEFAULT 0, -- For text-based services
    "OutputTokens" integer DEFAULT 0, -- For generation services  
    "TotalTokens" integer DEFAULT 0, -- Total tokens used
    "RequestCount" integer DEFAULT 1, -- Number of API calls
    "CostUsd" decimal(10,6) NOT NULL DEFAULT 0, -- Cost in USD
    "Metadata" jsonb, -- Additional context like product_id, platform, etc.
    "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

-- Indexes for efficient querying
CREATE INDEX idx_aiusage_userid ON "AiUsage"("UserId");
CREATE INDEX idx_aiusage_servicetype ON "AiUsage"("ServiceType");
CREATE INDEX idx_aiusage_createdat ON "AiUsage"("CreatedAt");
CREATE INDEX idx_aiusage_userid_createdat ON "AiUsage"("UserId", "CreatedAt");

-- Monthly usage aggregation for billing
CREATE TABLE "MonthlyAiUsage" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "UserId" uuid NOT NULL REFERENCES "Users"("Id") ON DELETE CASCADE,
    "Year" integer NOT NULL,
    "Month" integer NOT NULL, -- 1-12
    "ServiceType" text NOT NULL,
    "TotalTokens" bigint NOT NULL DEFAULT 0,
    "TotalRequests" integer NOT NULL DEFAULT 0,
    "TotalCostUsd" decimal(10,2) NOT NULL DEFAULT 0,
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("UserId", "Year", "Month", "ServiceType")
);

CREATE INDEX idx_monthlyaiusage_userid ON "MonthlyAiUsage"("UserId");
CREATE INDEX idx_monthlyaiusage_year_month ON "MonthlyAiUsage"("Year", "Month");

-- AI service pricing configuration
CREATE TABLE "AiServicePricing" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "ServiceType" text NOT NULL,
    "ModelName" text NOT NULL,
    "Operation" text NOT NULL,
    "PricingType" text NOT NULL, -- 'per_token', 'per_request', 'per_mb', 'per_minute'
    "InputPriceUsd" decimal(10,8) DEFAULT 0, -- Price per unit for input
    "OutputPriceUsd" decimal(10,8) DEFAULT 0, -- Price per unit for output
    "BasePriceUsd" decimal(10,6) DEFAULT 0, -- Base price per request
    "IsActive" boolean NOT NULL DEFAULT true,
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("ServiceType", "ModelName", "Operation")
);

-- Insert default pricing (based on current market rates)
INSERT INTO "AiServicePricing" ("ServiceType", "ModelName", "Operation", "PricingType", "InputPriceUsd", "OutputPriceUsd", "BasePriceUsd") VALUES 
-- Embedding pricing (similar to OpenAI)
('embedding', 'qwen3-0.6b', 'embed_product', 'per_token', 0.0000001, 0, 0),
('embedding', 'qwen3-0.6b', 'embed_search', 'per_token', 0.0000001, 0, 0),

-- LLM Generation pricing (similar to Groq)
('generation', 'groq-llama', 'generate_details', 'per_token', 0.0000002, 0.0000002, 0),
('generation', 'groq-llama', 'analyze_image', 'per_token', 0.0000002, 0.0000002, 0),

-- Firecrawl pricing (similar to their actual pricing)
('firecrawl', 'firecrawl-scrape', 'scrape_url', 'per_request', 0, 0, 0.003),
('firecrawl', 'firecrawl-search', 'search_web', 'per_request', 0, 0, 0.005),
('firecrawl', 'firecrawl-extract', 'extract_data', 'per_request', 0, 0, 0.004),

-- SerpAPI pricing
('serpapi', 'serpapi-lens', 'visual_search', 'per_request', 0, 0, 0.025);

-- Function to track AI usage
CREATE OR REPLACE FUNCTION track_ai_usage(
    p_user_id uuid,
    p_service_type text,
    p_model_name text,
    p_operation text,
    p_input_tokens integer DEFAULT 0,
    p_output_tokens integer DEFAULT 0,
    p_request_count integer DEFAULT 1,
    p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    usage_id uuid;
    total_tokens integer;
    cost_usd decimal(10,6);
    pricing_row "AiServicePricing"%ROWTYPE;
BEGIN
    -- Calculate total tokens
    total_tokens := p_input_tokens + p_output_tokens;
    
    -- Get pricing information
    SELECT * INTO pricing_row 
    FROM "AiServicePricing" 
    WHERE "ServiceType" = p_service_type 
      AND "ModelName" = p_model_name 
      AND "Operation" = p_operation 
      AND "IsActive" = true;
    
    -- Calculate cost based on pricing type
    IF pricing_row.PricingType = 'per_token' THEN
        cost_usd := (p_input_tokens * pricing_row.InputPriceUsd) + 
                   (p_output_tokens * pricing_row.OutputPriceUsd);
    ELSIF pricing_row.PricingType = 'per_request' THEN
        cost_usd := p_request_count * pricing_row.BasePriceUsd;
    ELSE
        cost_usd := pricing_row.BasePriceUsd;
    END IF;
    
    -- Insert usage record
    INSERT INTO "AiUsage" (
        "UserId", "ServiceType", "ModelName", "Operation",
        "InputTokens", "OutputTokens", "TotalTokens", 
        "RequestCount", "CostUsd", "Metadata"
    ) VALUES (
        p_user_id, p_service_type, p_model_name, p_operation,
        p_input_tokens, p_output_tokens, total_tokens,
        p_request_count, cost_usd, p_metadata
    ) RETURNING "Id" INTO usage_id;
    
    -- Update monthly aggregation
    INSERT INTO "MonthlyAiUsage" (
        "UserId", "Year", "Month", "ServiceType",
        "TotalTokens", "TotalRequests", "TotalCostUsd"
    ) VALUES (
        p_user_id, EXTRACT(YEAR FROM NOW()), EXTRACT(MONTH FROM NOW()), p_service_type,
        total_tokens, p_request_count, cost_usd
    )
    ON CONFLICT ("UserId", "Year", "Month", "ServiceType")
    DO UPDATE SET
        "TotalTokens" = "MonthlyAiUsage"."TotalTokens" + total_tokens,
        "TotalRequests" = "MonthlyAiUsage"."TotalRequests" + p_request_count,
        "TotalCostUsd" = "MonthlyAiUsage"."TotalCostUsd" + cost_usd,
        "UpdatedAt" = NOW();
    
    RETURN usage_id;
END;
$$;

-- Function to get user's monthly AI usage
CREATE OR REPLACE FUNCTION get_user_monthly_usage(
    p_user_id uuid,
    p_year integer DEFAULT EXTRACT(YEAR FROM NOW()),
    p_month integer DEFAULT EXTRACT(MONTH FROM NOW())
)
RETURNS TABLE (
    service_type text,
    total_tokens bigint,
    total_requests integer,
    total_cost_usd decimal(10,2)
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        "ServiceType"::text,
        "TotalTokens",
        "TotalRequests",
        "TotalCostUsd"
    FROM "MonthlyAiUsage"
    WHERE "UserId" = p_user_id
      AND "Year" = p_year
      AND "Month" = p_month
    ORDER BY "TotalCostUsd" DESC;
END;
$$;

-- Function to check if user is within limits
CREATE OR REPLACE FUNCTION check_user_ai_limits(
    p_user_id uuid,
    p_service_type text DEFAULT NULL
)
RETURNS TABLE (
    service_type text,
    current_usage bigint,
    limit_amount bigint,
    is_over_limit boolean,
    cost_this_month decimal(10,2)
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        mau."ServiceType"::text,
        mau."TotalTokens",
        COALESCE(st."AiScans", 1000)::bigint as limit_amount, -- Default limit from SubscriptionTiers
        (mau."TotalTokens" > COALESCE(st."AiScans", 1000)) as is_over_limit,
        mau."TotalCostUsd"
    FROM "MonthlyAiUsage" mau
    JOIN "Users" u ON mau."UserId" = u."Id"
    LEFT JOIN "SubscriptionTiers" st ON u."SubscriptionTierId" = st."Id"
    WHERE mau."UserId" = p_user_id
      AND mau."Year" = EXTRACT(YEAR FROM NOW())
      AND mau."Month" = EXTRACT(MONTH FROM NOW())
      AND (p_service_type IS NULL OR mau."ServiceType" = p_service_type)
    ORDER BY mau."TotalCostUsd" DESC;
END;
$$;

-- Grant permissions
GRANT SELECT, INSERT ON "AiUsage" TO authenticated;
GRANT SELECT ON "MonthlyAiUsage" TO authenticated;
GRANT SELECT ON "AiServicePricing" TO authenticated;
GRANT EXECUTE ON FUNCTION track_ai_usage TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_monthly_usage TO authenticated;
GRANT EXECUTE ON FUNCTION check_user_ai_limits TO authenticated; 