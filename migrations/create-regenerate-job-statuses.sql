-- Create regenerate_job_statuses table
CREATE TABLE IF NOT EXISTS regenerate_job_statuses (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    job_id VARCHAR(255) NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
    current_stage VARCHAR(100) NOT NULL,
    progress JSONB NOT NULL DEFAULT '{}',
    results JSONB DEFAULT '[]',
    summary JSONB DEFAULT '{}',
    error TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    estimated_completion_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_regenerate_job_statuses_user_id ON regenerate_job_statuses(user_id);
CREATE INDEX IF NOT EXISTS idx_regenerate_job_statuses_status ON regenerate_job_statuses(status);
CREATE INDEX IF NOT EXISTS idx_regenerate_job_statuses_created_at ON regenerate_job_statuses(created_at DESC);

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION update_regenerate_job_statuses_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_regenerate_job_statuses_updated_at
    BEFORE UPDATE ON regenerate_job_statuses
    FOR EACH ROW
    EXECUTE FUNCTION update_regenerate_job_statuses_updated_at();

-- Add RLS (Row Level Security) policies
ALTER TABLE regenerate_job_statuses ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own job statuses
CREATE POLICY "Users can view their own regenerate job statuses" ON regenerate_job_statuses
    FOR SELECT USING (auth.uid() = user_id);

-- Policy: Users can only insert their own job statuses
CREATE POLICY "Users can insert their own regenerate job statuses" ON regenerate_job_statuses
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Policy: Users can only update their own job statuses
CREATE POLICY "Users can update their own regenerate job statuses" ON regenerate_job_statuses
    FOR UPDATE USING (auth.uid() = user_id);

-- Policy: Users can only delete their own job statuses
CREATE POLICY "Users can delete their own regenerate job statuses" ON regenerate_job_statuses
    FOR DELETE USING (auth.uid() = user_id);

