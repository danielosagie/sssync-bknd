-- Migration: Create BackfillJobs table for tracking data backfill operations
-- This table stores jobs for filling missing data after platform connections

CREATE TABLE IF NOT EXISTS "BackfillJobs" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "UserId" uuid NOT NULL REFERENCES "Users"("Id") ON DELETE CASCADE,
    "ConnectionId" uuid NOT NULL REFERENCES "PlatformConnections"("Id") ON DELETE CASCADE,
    "JobType" text NOT NULL CHECK ("JobType" IN ('data_gap_analysis', 'bulk_ai_backfill', 'photo_request', 'description_generation', 'tag_generation', 'barcode_scanning')),
    "Status" text NOT NULL CHECK ("Status" IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')) DEFAULT 'pending',
    "Priority" text NOT NULL CHECK ("Priority" IN ('low', 'medium', 'high', 'urgent')) DEFAULT 'medium',
    "Progress" integer NOT NULL DEFAULT 0 CHECK ("Progress" >= 0 AND "Progress" <= 100),
    "TotalItems" integer NOT NULL DEFAULT 0,
    "ProcessedItems" integer NOT NULL DEFAULT 0,
    "FailedItems" integer NOT NULL DEFAULT 0,
    "Metadata" jsonb NOT NULL DEFAULT '{}',
    "StartedAt" timestamptz,
    "CompletedAt" timestamptz,
    "ErrorMessage" text,
    "CreatedAt" timestamptz DEFAULT now(),
    "UpdatedAt" timestamptz DEFAULT now()
);

-- Create BackfillItems table for tracking individual backfill operations
CREATE TABLE IF NOT EXISTS "BackfillItems" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "BackfillJobId" uuid NOT NULL REFERENCES "BackfillJobs"("Id") ON DELETE CASCADE,
    "ProductVariantId" uuid NOT NULL REFERENCES "ProductVariants"("Id") ON DELETE CASCADE,
    "DataType" text NOT NULL CHECK ("DataType" IN ('photo', 'description', 'tags', 'barcode', 'pricing', 'inventory')),
    "Status" text NOT NULL CHECK ("Status" IN ('pending', 'processing', 'completed', 'failed', 'skipped')) DEFAULT 'pending',
    "OriginalValue" jsonb,
    "GeneratedValue" jsonb,
    "Confidence" decimal(3,2) CHECK ("Confidence" >= 0 AND "Confidence" <= 1),
    "AiModelUsed" text,
    "ProcessingTime" integer, -- milliseconds
    "ErrorMessage" text,
    "CreatedAt" timestamptz DEFAULT now(),
    "UpdatedAt" timestamptz DEFAULT now()
);

-- Indexes for efficient querying
CREATE INDEX idx_backfill_jobs_user_id ON "BackfillJobs"("UserId");
CREATE INDEX idx_backfill_jobs_connection_id ON "BackfillJobs"("ConnectionId");
CREATE INDEX idx_backfill_jobs_status ON "BackfillJobs"("Status");
CREATE INDEX idx_backfill_jobs_priority ON "BackfillJobs"("Priority");
CREATE INDEX idx_backfill_jobs_created_at ON "BackfillJobs"("CreatedAt");
CREATE INDEX idx_backfill_jobs_job_type ON "BackfillJobs"("JobType");

CREATE INDEX idx_backfill_items_job_id ON "BackfillItems"("BackfillJobId");
CREATE INDEX idx_backfill_items_product_variant_id ON "BackfillItems"("ProductVariantId");
CREATE INDEX idx_backfill_items_data_type ON "BackfillItems"("DataType");
CREATE INDEX idx_backfill_items_status ON "BackfillItems"("Status");

-- Function to update the UpdatedAt timestamp for BackfillJobs
CREATE OR REPLACE FUNCTION update_backfill_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW."UpdatedAt" = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to update the UpdatedAt timestamp for BackfillItems
CREATE OR REPLACE FUNCTION update_backfill_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW."UpdatedAt" = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to automatically update UpdatedAt
CREATE TRIGGER backfill_jobs_updated_at_trigger
    BEFORE UPDATE ON "BackfillJobs"
    FOR EACH ROW
    EXECUTE FUNCTION update_backfill_jobs_updated_at();

CREATE TRIGGER backfill_items_updated_at_trigger
    BEFORE UPDATE ON "BackfillItems"
    FOR EACH ROW
    EXECUTE FUNCTION update_backfill_items_updated_at();
