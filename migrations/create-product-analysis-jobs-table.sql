-- Create product_analysis_jobs table for async job tracking
CREATE TABLE IF NOT EXISTS public.product_analysis_jobs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    job_id TEXT UNIQUE NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
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
CREATE INDEX IF NOT EXISTS idx_product_analysis_jobs_job_id ON public.product_analysis_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_product_analysis_jobs_user_id ON public.product_analysis_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_product_analysis_jobs_status ON public.product_analysis_jobs(status);
CREATE INDEX IF NOT EXISTS idx_product_analysis_jobs_created_at ON public.product_analysis_jobs(created_at DESC);

-- Enable RLS (Row Level Security)
ALTER TABLE public.product_analysis_jobs ENABLE ROW LEVEL SECURITY;

-- Create RLS policy so users can only see their own jobs
CREATE POLICY "Users can view their own analysis jobs" ON public.product_analysis_jobs
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own analysis jobs" ON public.product_analysis_jobs
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own analysis jobs" ON public.product_analysis_jobs
    FOR UPDATE USING (auth.uid() = user_id);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_product_analysis_jobs_updated_at 
    BEFORE UPDATE ON public.product_analysis_jobs 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column(); 