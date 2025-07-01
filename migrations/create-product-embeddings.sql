-- Enhanced Product Recognition System with Multi-Modal Embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Core product embeddings table with multi-modal support
CREATE TABLE IF NOT EXISTS "ProductEmbeddings" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "ProductId" UUID REFERENCES "Products"("Id") ON DELETE CASCADE,
    "VariantId" UUID REFERENCES "ProductVariants"("Id") ON DELETE CASCADE,
    
    -- Multi-modal embeddings
    "ImageEmbedding" vector(1664), -- SigLIP-large-patch16-384 dimension
    "TextEmbedding" vector(1024), -- Qwen3-Embedding-0.6B dimension
    "CombinedEmbedding" vector(2688), -- Concatenated or weighted combination
    
    -- Source data
    "ImageUrl" TEXT,
    "ImageHash" TEXT, -- For deduplication
    "ProductText" TEXT NOT NULL, -- Title + description for text embedding
    "SourceType" TEXT NOT NULL, -- 'user_upload', 'web_scrape', 'manual_entry'
    "SourceUrl" TEXT,
    
    -- Template and metadata
    "BusinessTemplate" TEXT, -- 'comic-book', 'electronics', 'fashion', etc.
    "ScrapedData" JSONB,
    "SearchKeywords" TEXT[],
    "ModelVersions" JSONB DEFAULT '{"siglip": "google/siglip-large-patch16-384", "qwen3": "Qwen/Qwen3-Embedding-0.6B"}',
    
    "CreatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "UpdatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Product recognition matches and user feedback for training
CREATE TABLE IF NOT EXISTS "ProductMatches" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "UserId" UUID REFERENCES "Users"("Id") ON DELETE CASCADE,
    "SourceImageUrl" TEXT NOT NULL,
    "SourceImageHash" TEXT NOT NULL,
    "ImageEmbedding" vector(1664),
    "TextQuery" TEXT, -- Extracted or user-provided query
    "TextEmbedding" vector(1024),
    
    -- Search results and scoring
    "CandidateProducts" JSONB NOT NULL, -- Array of candidate products found
    "VectorScores" REAL[], -- Initial vector similarity scores
    "RerankerScores" REAL[], -- Qwen3-Reranker scores
    "ConfidenceTier" TEXT NOT NULL CHECK ("ConfidenceTier" IN ('high', 'medium', 'low')),
    "TopScore" REAL NOT NULL,
    
    -- User feedback (critical for training flywheel)
    "UserSelection" INTEGER, -- Index of selected candidate (null if rejected all)
    "UserRejected" BOOLEAN DEFAULT FALSE, -- True if user clicked "None of These"
    "UserFeedback" TEXT, -- Optional user comment
    "FeedbackType" TEXT CHECK ("FeedbackType" IN ('positive', 'negative', 'hard_negative')),
    
    -- System behavior
    "SystemAction" TEXT NOT NULL, -- 'show_single_match', 'show_multiple_candidates', 'fallback_to_external'
    "FallbackUsed" BOOLEAN DEFAULT FALSE,
    "ProcessingTimeMs" INTEGER,
    
    "CreatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Training data collection for model improvement
CREATE TABLE IF NOT EXISTS "TrainingExamples" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "MatchId" UUID REFERENCES "ProductMatches"("Id") ON DELETE CASCADE,
    "ExampleType" TEXT NOT NULL CHECK ("ExampleType" IN ('positive', 'hard_negative', 'easy_negative')),
    
    -- Image data
    "ImageUrl" TEXT NOT NULL,
    "ImageEmbedding" vector(1664) NOT NULL,
    
    -- Product data  
    "ProductId" UUID REFERENCES "Products"("Id") ON DELETE SET NULL,
    "ProductTitle" TEXT NOT NULL,
    "ProductDescription" TEXT,
    "ProductEmbedding" vector(1024) NOT NULL,
    
    -- Similarity scores at time of interaction
    "VectorSimilarity" REAL NOT NULL,
    "RerankerScore" REAL,
    "UserLabel" BOOLEAN NOT NULL, -- True = positive match, False = negative
    
    -- Metadata for training
    "BusinessTemplate" TEXT,
    "DifficultyScore" REAL, -- How hard was this example (based on initial scores)
    "UsedInTraining" BOOLEAN DEFAULT FALSE,
    
    "CreatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Evaluation and performance tracking
CREATE TABLE IF NOT EXISTS "ModelEvaluations" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "EvaluationType" TEXT NOT NULL, -- 'daily_batch', 'weekly_full', 'user_feedback'
    "ModelVersions" JSONB NOT NULL,
    
    -- Performance metrics
    "TotalSamples" INTEGER NOT NULL,
    "HighConfidenceAccuracy" REAL, -- Accuracy when confidence > 0.95
    "MediumConfidenceAccuracy" REAL, -- Accuracy when confidence 0.60-0.95
    "OverallAccuracy" REAL,
    "PrecisionAtK" REAL[], -- Precision at K=[1,3,5,10]
    "RecallAtK" REAL[],
    "MeanReciprocalRank" REAL,
    
    -- Tier distribution
    "HighTierPercentage" REAL,
    "MediumTierPercentage" REAL,
    "LowTierPercentage" REAL,
    "FallbackPercentage" REAL,
    
    -- User satisfaction proxy
    "UserAcceptanceRate" REAL, -- How often users accept recommendations
    "AverageSessionTime" REAL, -- Time to complete listing
    
    "EvaluatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Business template performance tracking
CREATE TABLE IF NOT EXISTS "TemplatePerformance" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "TemplateName" TEXT NOT NULL,
    "Period" DATE NOT NULL, -- Daily aggregation
    
    -- Usage stats
    "TotalQueries" INTEGER DEFAULT 0,
    "HighConfidenceCount" INTEGER DEFAULT 0,
    "MediumConfidenceCount" INTEGER DEFAULT 0,
    "LowConfidenceCount" INTEGER DEFAULT 0,
    
    -- Performance metrics
    "AverageAccuracy" REAL,
    "AverageProcessingTime" INTEGER,
    "UserSatisfactionScore" REAL,
    
    "CreatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE("TemplateName", "Period")
);

-- Create optimized indexes
CREATE INDEX IF NOT EXISTS "idx_product_embeddings_product_id" ON "ProductEmbeddings"("ProductId");
CREATE INDEX IF NOT EXISTS "idx_product_embeddings_variant_id" ON "ProductEmbeddings"("VariantId");
CREATE INDEX IF NOT EXISTS "idx_product_embeddings_template" ON "ProductEmbeddings"("BusinessTemplate");
CREATE INDEX IF NOT EXISTS "idx_product_embeddings_image_hash" ON "ProductEmbeddings"("ImageHash");

-- Vector similarity search indexes (multi-modal)
CREATE INDEX IF NOT EXISTS "idx_product_embeddings_image_vector" 
ON "ProductEmbeddings" USING ivfflat ("ImageEmbedding" vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS "idx_product_embeddings_text_vector" 
ON "ProductEmbeddings" USING ivfflat ("TextEmbedding" vector_cosine_ops) WITH (lists = 100);

/*
-- This index is intentionally commented out.
-- The "CombinedEmbedding" column (2688 dimensions) exceeds the pgvector index limit of 2000.
-- We use a hybrid search approach in the `search_products_multimodal` function,
-- which queries the two indexed columns (`ImageEmbedding` and `TextEmbedding`) separately
-- and combines their scores at query time. This avoids the need to index the combined vector.
CREATE INDEX IF NOT EXISTS "idx_product_embeddings_combined_vector" 
ON "ProductEmbeddings" USING ivfflat ("CombinedEmbedding" vector_cosine_ops) WITH (lists = 100);
*/

-- Indexes for training data queries
CREATE INDEX IF NOT EXISTS "idx_product_matches_user_id" ON "ProductMatches"("UserId");
CREATE INDEX IF NOT EXISTS "idx_product_matches_confidence" ON "ProductMatches"("ConfidenceTier");
CREATE INDEX IF NOT EXISTS "idx_product_matches_feedback" ON "ProductMatches"("FeedbackType");
CREATE INDEX IF NOT EXISTS "idx_product_matches_created_at" ON "ProductMatches"("CreatedAt");
CREATE INDEX IF NOT EXISTS "idx_training_examples_match_id" ON "TrainingExamples"("MatchId");
CREATE INDEX IF NOT EXISTS "idx_training_examples_type" ON "TrainingExamples"("ExampleType");
CREATE INDEX IF NOT EXISTS "idx_training_examples_used" ON "TrainingExamples"("UsedInTraining");

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_product_embeddings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW."UpdatedAt" = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_product_embeddings_updated_at
    BEFORE UPDATE ON "ProductEmbeddings"
    FOR EACH ROW
    EXECUTE FUNCTION update_product_embeddings_updated_at();

-- Helper function: Log a product match interaction
CREATE OR REPLACE FUNCTION log_product_match(
    p_user_id UUID,
    p_image_url TEXT,
    p_image_hash TEXT,
    p_image_embedding vector(1664),
    p_text_query TEXT,
    p_text_embedding vector(1024),
    p_candidates JSONB,
    p_vector_scores REAL[],
    p_reranker_scores REAL[],
    p_confidence_tier TEXT,
    p_top_score REAL,
    p_system_action TEXT,
    p_processing_time_ms INTEGER
) RETURNS UUID AS $$
DECLARE
    match_id UUID;
BEGIN
    INSERT INTO "ProductMatches" (
        "UserId", "SourceImageUrl", "SourceImageHash", "ImageEmbedding",
        "TextQuery", "TextEmbedding", "CandidateProducts", "VectorScores",
        "RerankerScores", "ConfidenceTier", "TopScore", "SystemAction",
        "ProcessingTimeMs"
    ) VALUES (
        p_user_id, p_image_url, p_image_hash, p_image_embedding,
        p_text_query, p_text_embedding, p_candidates, p_vector_scores,
        p_reranker_scores, p_confidence_tier, p_top_score, p_system_action,
        p_processing_time_ms
    ) RETURNING "Id" INTO match_id;
    
    RETURN match_id;
END;
$$ LANGUAGE plpgsql;

-- Helper function: Record user feedback and generate training examples
CREATE OR REPLACE FUNCTION record_user_feedback(
    p_match_id UUID,
    p_user_selection INTEGER,
    p_user_rejected BOOLEAN,
    p_user_feedback TEXT
) RETURNS VOID AS $$
DECLARE
    match_record RECORD;
    candidate JSONB;
    i INTEGER;
    example_type TEXT;
BEGIN
    -- Get the match record
    SELECT * INTO match_record FROM "ProductMatches" WHERE "Id" = p_match_id;
    
    -- Update the match with user feedback
    UPDATE "ProductMatches" SET
        "UserSelection" = p_user_selection,
        "UserRejected" = p_user_rejected,
        "UserFeedback" = p_user_feedback,
        "FeedbackType" = CASE 
            WHEN p_user_rejected THEN 'negative'
            WHEN p_user_selection IS NOT NULL THEN 'positive'
            ELSE 'hard_negative'
        END
    WHERE "Id" = p_match_id;
    
    -- Generate training examples
    FOR i IN 0..jsonb_array_length(match_record."CandidateProducts")-1 LOOP
        candidate := match_record."CandidateProducts" -> i;
        
        -- Determine example type
        IF p_user_selection = i THEN
            example_type := 'positive';
        ELSIF match_record."RerankerScores"[i+1] > 0.8 THEN
            example_type := 'hard_negative';  -- High score but user rejected
        ELSE
            example_type := 'easy_negative';
        END IF;
        
        -- Insert training example
        INSERT INTO "TrainingExamples" (
            "MatchId", "ExampleType", "ImageUrl", "ImageEmbedding",
            "ProductId", "ProductTitle", "ProductDescription", "ProductEmbedding",
            "VectorSimilarity", "RerankerScore", "UserLabel",
            "BusinessTemplate", "DifficultyScore"
        ) VALUES (
            p_match_id,
            example_type,
            match_record."SourceImageUrl",
            match_record."ImageEmbedding",
            (candidate->>'productId')::UUID, -- Correctly extract ProductId from the candidate JSON
            candidate->>'title',
            candidate->>'description',
            match_record."TextEmbedding", -- Simplified: use query embedding
            match_record."VectorScores"[i+1],
            match_record."RerankerScores"[i+1],
            (p_user_selection = i),
            candidate->>'business_template',
            1.0 - match_record."RerankerScores"[i+1] -- Higher difficulty for lower scores
        );
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Helper function: Multi-modal product search
CREATE OR REPLACE FUNCTION search_products_multimodal(
    p_image_embedding vector(1664),
    p_text_embedding vector(1024),
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
        pe."VariantId",
        pv."Title",
        pv."Description",
        pe."ImageUrl",
        pe."BusinessTemplate",
        (pe."ImageEmbedding" <=> p_image_embedding)::REAL as image_sim,
        (pe."TextEmbedding" <=> p_text_embedding)::REAL as text_sim,
        (p_image_weight * (pe."ImageEmbedding" <=> p_image_embedding) + 
         p_text_weight * (pe."TextEmbedding" <=> p_text_embedding))::REAL as combined
    FROM "ProductEmbeddings" pe
    JOIN "ProductVariants" pv ON pe."VariantId" = pv."Id"
    WHERE 
        (p_business_template IS NULL OR pe."BusinessTemplate" = p_business_template)
        AND (p_image_weight * (pe."ImageEmbedding" <=> p_image_embedding) + 
             p_text_weight * (pe."TextEmbedding" <=> p_text_embedding)) < p_threshold
    ORDER BY combined ASC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Row Level Security
ALTER TABLE "ProductEmbeddings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductMatches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrainingExamples" ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can access their own product embeddings"
ON "ProductEmbeddings" FOR ALL USING (
    "ProductId" IN (SELECT "Id" FROM "Products" WHERE "UserId" = auth.uid())
);

CREATE POLICY "Users can access their own product matches"
ON "ProductMatches" FOR ALL USING ("UserId" = auth.uid());

CREATE POLICY "Users can access training examples from their matches"
ON "TrainingExamples" FOR ALL USING (
    "MatchId" IN (SELECT "Id" FROM "ProductMatches" WHERE "UserId" = auth.uid())
);

-- Grant permissions
GRANT ALL ON "ProductEmbeddings" TO authenticated;
GRANT ALL ON "ProductMatches" TO authenticated;
GRANT ALL ON "TrainingExamples" TO authenticated;
GRANT ALL ON "ModelEvaluations" TO authenticated;
GRANT ALL ON "TemplatePerformance" TO authenticated; 