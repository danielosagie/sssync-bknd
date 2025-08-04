-- Fix ProductEmbeddings dimensions to match actual AI server output
-- Your AI server returns: Image=768, Text=1024 dimensions

-- First, drop existing indexes
DROP INDEX IF EXISTS idx_productembeddings_image_embedding;
DROP INDEX IF EXISTS idx_productembeddings_text_embedding;
DROP INDEX IF EXISTS idx_productembeddings_combined_embedding;

-- Update column types to match actual AI server output
ALTER TABLE "ProductEmbeddings" 
ALTER COLUMN "ImageEmbedding" TYPE vector(768),
ALTER COLUMN "TextEmbedding" TYPE vector(1024),
ALTER COLUMN "CombinedEmbedding" TYPE vector(768);

-- Recreate indexes with correct dimensions
CREATE INDEX IF NOT EXISTS idx_productembeddings_image_embedding 
ON "ProductEmbeddings" USING ivfflat ("ImageEmbedding" vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_productembeddings_text_embedding 
ON "ProductEmbeddings" USING ivfflat ("TextEmbedding" vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_productembeddings_combined_embedding 
ON "ProductEmbeddings" USING ivfflat ("CombinedEmbedding" vector_cosine_ops) WITH (lists = 100);