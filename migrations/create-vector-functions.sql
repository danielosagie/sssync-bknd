-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Update ProductEmbeddings table to use vector type
-- Assuming the table exists, we'll add vector column if not present
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'ProductEmbeddings' 
                   AND column_name = 'embedding_vector') THEN
        ALTER TABLE "ProductEmbeddings" 
        ADD COLUMN embedding_vector vector(2560);
    END IF;
END $$;

-- Create index for vector similarity search
CREATE INDEX IF NOT EXISTS product_embeddings_vector_idx 
ON "ProductEmbeddings" 
USING ivfflat (embedding_vector vector_cosine_ops) 
WITH (lists = 100);

-- Function to match products by vector similarity
CREATE OR REPLACE FUNCTION match_products(
  query_embedding vector(2560),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  product_id text,
  variant_id text,
  title text,
  description text,
  price numeric,
  image_url text,
  similarity float,
  brand text,
  category text,
  tags text[],
  platform_type text,
  user_id text
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    pe.product_id::text,
    pe.variant_id::text,
    p."Title"::text,
    p."Description"::text,
    pv."Price",
    pv."ImageUrl"::text,
    (1 - (pe.embedding_vector <=> query_embedding))::float as similarity,
    pv."Brand"::text,
    pv."Category"::text,
    pv."Tags"::text[],
    'internal'::text as platform_type,
    p."UserId"::text
  FROM "ProductEmbeddings" pe
  JOIN "Products" p ON pe.product_id = p."Id"
  JOIN "ProductVariants" pv ON pe.variant_id = pv."Id"
  WHERE 1 - (pe.embedding_vector <=> query_embedding) > match_threshold
  ORDER BY pe.embedding_vector <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Function to get embedding statistics
CREATE OR REPLACE FUNCTION get_embedding_stats()
RETURNS TABLE (
  total_embeddings bigint,
  unique_products bigint,
  last_updated timestamp
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*)::bigint as total_embeddings,
    COUNT(DISTINCT product_id)::bigint as unique_products,
    MAX(updated_at)::timestamp as last_updated
  FROM "ProductEmbeddings"
  WHERE embedding_vector IS NOT NULL;
END;
$$;

-- Function to update embedding vector from JSON array
CREATE OR REPLACE FUNCTION update_embedding_vector()
RETURNS TRIGGER AS $$
BEGIN
  -- Convert embedding JSON array to vector if embedding column is updated
  IF NEW.embedding IS NOT NULL AND NEW.embedding != OLD.embedding THEN
    NEW.embedding_vector := NEW.embedding::vector(2560);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update vector column
DROP TRIGGER IF EXISTS update_embedding_vector_trigger ON "ProductEmbeddings";
CREATE TRIGGER update_embedding_vector_trigger
  BEFORE UPDATE ON "ProductEmbeddings"
  FOR EACH ROW
  EXECUTE FUNCTION update_embedding_vector();

-- Function to batch insert embeddings efficiently
CREATE OR REPLACE FUNCTION batch_insert_embeddings(
  embedding_data jsonb
)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count int := 0;
  item jsonb;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(embedding_data)
  LOOP
    INSERT INTO "ProductEmbeddings" (
      product_id,
      variant_id,
      embedding,
      embedding_vector,
      metadata,
      updated_at
    ) VALUES (
      (item->>'product_id')::uuid,
      (item->>'variant_id')::uuid,
      (item->'embedding')::jsonb,
      (item->'embedding')::vector(2560),
      COALESCE(item->'metadata', '{}'::jsonb),
      NOW()
    )
    ON CONFLICT (product_id, variant_id) 
    DO UPDATE SET
      embedding = EXCLUDED.embedding,
      embedding_vector = EXCLUDED.embedding_vector,
      metadata = EXCLUDED.metadata,
      updated_at = EXCLUDED.updated_at;
    
    inserted_count := inserted_count + 1;
  END LOOP;
  
  RETURN inserted_count;
END;
$$;

-- Create RLS policies for ProductEmbeddings
ALTER TABLE "ProductEmbeddings" ENABLE ROW LEVEL SECURITY;

-- Policy for users to access their own embeddings
CREATE POLICY "Users can access their own product embeddings" ON "ProductEmbeddings"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM "Products" p 
      WHERE p."Id" = "ProductEmbeddings".product_id 
      AND p."UserId" = auth.uid()
    )
  );

-- Policy for service role to access all embeddings
CREATE POLICY "Service role can access all embeddings" ON "ProductEmbeddings"
  FOR ALL USING (auth.role() = 'service_role');

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON "ProductEmbeddings" TO authenticated;
GRANT EXECUTE ON FUNCTION match_products TO authenticated;
GRANT EXECUTE ON FUNCTION get_embedding_stats TO authenticated;
GRANT EXECUTE ON FUNCTION batch_insert_embeddings TO service_role; 