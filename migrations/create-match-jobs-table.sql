-- Create match_jobs table for async match job tracking
CREATE TABLE IF NOT EXISTS public.match_jobs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    job_id TEXT UNIQUE NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
    current_stage TEXT,
    progress JSONB DEFAULT '{}',
    results JSONB DEFAULT '[]',
    summary JSONB DEFAULT '{}',
    error TEXT,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    estimated_completion_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_match_jobs_job_id ON public.match_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_match_jobs_user_id ON public.match_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_match_jobs_status ON public.match_jobs(status);
CREATE INDEX IF NOT EXISTS idx_match_jobs_created_at ON public.match_jobs(created_at DESC);

-- Enable RLS (Row Level Security)
ALTER TABLE public.match_jobs ENABLE ROW LEVEL SECURITY;

-- Create RLS policy so users can only see their own jobs
CREATE POLICY "Users can view their own match jobs" ON public.match_jobs
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own match jobs" ON public.match_jobs
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own match jobs" ON public.match_jobs
    FOR UPDATE USING (auth.uid() = user_id);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_match_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_match_jobs_updated_at
    BEFORE UPDATE ON public.match_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_match_jobs_updated_at(); 