-- Create PostgreSQL function for efficient vector similarity search
-- This uses pgvector's native similarity operations for better performance

CREATE OR REPLACE FUNCTION search_products_by_vector(
    query_embedding vector(768),
    match_threshold float DEFAULT 0.0,
    match_count int DEFAULT 15,
    p_business_template text DEFAULT NULL
)
RETURNS TABLE (
    product_id uuid,
    variant_id uuid,
    title text,
    description text,
    image_url text,
    business_template text,
    price decimal,
    similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        pe."ProductId"::uuid as product_id,
        pe."ProductVariantId"::uuid as variant_id,
        COALESCE(pv."Title", pe."ProductText", 'Scanned Product') as title,
        COALESCE(pv."Description", 'Scanned product (' || pe."SourceType" || ')') as description,
        pe."ImageUrl" as image_url,
        pe."BusinessTemplate" as business_template,
        COALESCE(pv."Price", 0) as price,
        -- Calculate cosine similarity (1 - cosine distance)
        (1 - (pe."CombinedEmbedding" <=> query_embedding)) as similarity
    FROM "ProductEmbeddings" pe
    LEFT JOIN "ProductVariants" pv ON pe."ProductVariantId" = pv."Id"
    WHERE 
        pe."CombinedEmbedding" IS NOT NULL
        AND (p_business_template IS NULL OR pe."BusinessTemplate" = p_business_template)
        AND (1 - (pe."CombinedEmbedding" <=> query_embedding)) >= match_threshold
    ORDER BY pe."CombinedEmbedding" <=> query_embedding ASC
    LIMIT match_count;
END;
$$;

-- Create index for better performance if it doesn't exist
CREATE INDEX IF NOT EXISTS idx_productembeddings_combined_embedding_cosine 
ON "ProductEmbeddings" USING ivfflat ("CombinedEmbedding" vector_cosine_ops) 
WITH (lists = 100);