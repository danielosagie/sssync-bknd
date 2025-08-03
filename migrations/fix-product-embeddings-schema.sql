-- Update ProductEmbeddings table to match code expectations
ALTER TABLE "ProductEmbeddings" 
DROP COLUMN IF EXISTS embedding,
ADD COLUMN IF NOT EXISTS "ProductId" uuid REFERENCES "Products"("Id") ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS "ImageEmbedding" vector(384),
ADD COLUMN IF NOT EXISTS "TextEmbedding" vector(384), 
ADD COLUMN IF NOT EXISTS "CombinedEmbedding" vector(384),
ADD COLUMN IF NOT EXISTS "ImageUrl" text,
ADD COLUMN IF NOT EXISTS "ImageHash" text,
ADD COLUMN IF NOT EXISTS "ProductText" text,
ADD COLUMN IF NOT EXISTS "BusinessTemplate" text,
ADD COLUMN IF NOT EXISTS "SearchKeywords" text[];

-- Add indexes for the new embedding columns
CREATE INDEX IF NOT EXISTS idx_productembeddings_image_embedding ON "ProductEmbeddings" USING ivfflat ("ImageEmbedding" vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_productembeddings_text_embedding ON "ProductEmbeddings" USING ivfflat ("TextEmbedding" vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_productembeddings_combined_embedding ON "ProductEmbeddings" USING ivfflat ("CombinedEmbedding" vector_cosine_ops) WITH (lists = 100);
