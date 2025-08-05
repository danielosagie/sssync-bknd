-- Allow ProductId to be null for scan embeddings
-- This lets us store scan embeddings without creating fake Product records

ALTER TABLE "ProductEmbeddings" 
ALTER COLUMN "ProductId" DROP NOT NULL;

-- Update the foreign key to allow nulls
ALTER TABLE "ProductEmbeddings" 
DROP CONSTRAINT IF EXISTS "ProductEmbeddings_ProductId_fkey",
ADD CONSTRAINT "ProductEmbeddings_ProductId_fkey" 
  FOREIGN KEY ("ProductId") REFERENCES "Products"("Id") ON DELETE CASCADE;

-- Also make ProductVariantId nullable for scans
ALTER TABLE "ProductEmbeddings" 
ALTER COLUMN "ProductVariantId" DROP NOT NULL;

ALTER TABLE "ProductEmbeddings" 
DROP CONSTRAINT IF EXISTS "ProductEmbeddings_ProductVariantId_fkey",
ADD CONSTRAINT "ProductEmbeddings_ProductVariantId_fkey" 
  FOREIGN KEY ("ProductVariantId") REFERENCES "ProductVariants"("Id") ON DELETE CASCADE;
