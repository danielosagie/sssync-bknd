-- Fix search_products_multimodal function to use correct column names
CREATE OR REPLACE FUNCTION search_products_multimodal(
    p_image_embedding vector(384),
    p_text_embedding vector(384),
    p_business_template TEXT DEFAULT NULL,
    p_image_weight REAL DEFAULT 0.6,
    p_text_weight REAL DEFAULT 0.4,
    p_limit INTEGER DEFAULT 20,
    p_threshold REAL DEFAULT 0.5
) RETURNS TABLE (
    product_id UUID,
    variant_id UUID,
    title TEXT,
    description TEXT,
    image_url TEXT,
    business_template TEXT,
    image_similarity REAL,
    text_similarity REAL,
    combined_score REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        pe."ProductId",
        pe."ProductVariantId",  -- Fixed: was "VariantId"
        pv."Title",
        pv."Description",
        pe."ImageUrl",
        pe."BusinessTemplate",
        (pe."ImageEmbedding" <=> p_image_embedding)::REAL as image_sim,
        (pe."TextEmbedding" <=> p_text_embedding)::REAL as text_sim,
        (p_image_weight * (pe."ImageEmbedding" <=> p_image_embedding) + 
         p_text_weight * (pe."TextEmbedding" <=> p_text_embedding))::REAL as combined
    FROM "ProductEmbeddings" pe
    JOIN "ProductVariants" pv ON pe."ProductVariantId" = pv."Id"  -- Fixed: was pe."VariantId"
    WHERE 
        (p_business_template IS NULL OR pe."BusinessTemplate" = p_business_template)
        AND (p_image_weight * (pe."ImageEmbedding" <=> p_image_embedding) + 
             p_text_weight * (pe."TextEmbedding" <=> p_text_embedding)) < p_threshold
    ORDER BY combined ASC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;