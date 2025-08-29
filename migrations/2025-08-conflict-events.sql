-- Migration: Create ConflictEvents table for tracking data conflicts
-- This table stores conflicts detected during sync operations

CREATE TABLE IF NOT EXISTS "ConflictEvents" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "UserId" uuid NOT NULL REFERENCES "Users"("Id") ON DELETE CASCADE,
    "EntityType" text NOT NULL CHECK ("EntityType" IN ('product', 'variant', 'inventory')),
    "EntityId" uuid NOT NULL,
    "ConflictType" text NOT NULL CHECK ("ConflictType" IN ('price_mismatch', 'inventory_mismatch', 'title_mismatch', 'concurrent_update')),
    "SssyncValue" jsonb,
    "PlatformValue" jsonb,
    "PlatformType" text NOT NULL,
    "PlatformConnectionId" uuid NOT NULL REFERENCES "PlatformConnections"("Id") ON DELETE CASCADE,
    "SssyncTimestamp" timestamptz NOT NULL, -- When sssync data was last updated
    "PlatformTimestamp" timestamptz NOT NULL, -- When platform data was last updated
    "Resolution" jsonb, -- { action: string, appliedValue: any, reason: string }
    "ResolvedAt" timestamptz,
    "CreatedAt" timestamptz DEFAULT now(),
    "UpdatedAt" timestamptz DEFAULT now()
);

-- Indexes for efficient querying
CREATE INDEX idx_conflict_events_user_id ON "ConflictEvents"("UserId");
CREATE INDEX idx_conflict_events_entity_id ON "ConflictEvents"("EntityId");
CREATE INDEX idx_conflict_events_platform_connection ON "ConflictEvents"("PlatformConnectionId");
CREATE INDEX idx_conflict_events_created_at ON "ConflictEvents"("CreatedAt");
CREATE INDEX idx_conflict_events_resolved ON "ConflictEvents"("ResolvedAt") WHERE "ResolvedAt" IS NULL;

-- Function to update the UpdatedAt timestamp
CREATE OR REPLACE FUNCTION update_conflict_events_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW."UpdatedAt" = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update UpdatedAt
CREATE TRIGGER conflict_events_updated_at_trigger
    BEFORE UPDATE ON "ConflictEvents"
    FOR EACH ROW
    EXECUTE FUNCTION update_conflict_events_updated_at();
