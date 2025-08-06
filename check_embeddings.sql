-- Check what's in ProductEmbeddings table
SELECT 
    pe."SourceType",
    COUNT(*) as count,
    pe."BusinessTemplate",
    CASE 
        WHEN pv."Id" IS NOT NULL THEN 'HAS_PRODUCT'
        ELSE 'SCAN_ONLY'
    END as product_status
FROM "ProductEmbeddings" pe
LEFT JOIN "ProductVariants" pv ON pe."ProductVariantId" = pv."Id"
WHERE pe."CombinedEmbedding" IS NOT NULL
GROUP BY pe."SourceType", pe."BusinessTemplate", 
         CASE WHEN pv."Id" IS NOT NULL THEN 'HAS_PRODUCT' ELSE 'SCAN_ONLY' END
ORDER BY count DESC;

-- Also check for actual products with embeddings
SELECT 
    pv."Title",
    pv."Sku",
    pe."SourceType",
    pe."BusinessTemplate",
    pe."CreatedAt"
FROM "ProductEmbeddings" pe
INNER JOIN "ProductVariants" pv ON pe."ProductVariantId" = pv."Id"
WHERE pe."CombinedEmbedding" IS NOT NULL
ORDER BY pe."CreatedAt" DESC
LIMIT 10;
