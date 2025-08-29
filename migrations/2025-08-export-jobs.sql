-- Export jobs table for tracking long-running export operations
create table if not exists public."ExportJobs" (
    "Id" uuid primary key default gen_random_uuid(),
    "UserId" uuid not null references "Users"("Id") on delete cascade,
    "ExportType" text not null check ("ExportType" in ('csv', 'shopify', 'square', 'clover', 'ebay', 'facebook', 'whatnot')),
    "Format" text not null check ("Format" in ('csv', 'platform-specific')),
    "Status" text not null default 'queued' check ("Status" in ('queued', 'processing', 'completed', 'failed')),
    "Progress" integer not null default 0 check ("Progress" >= 0 and "Progress" <= 100),
    "Description" text not null default 'Export job queued',
    "Filters" jsonb not null default '{}',
    "Options" jsonb not null default '{}',
    "ResultFileUrl" text,
    "ErrorMessage" text,
    "CreatedAt" timestamptz not null default now(),
    "UpdatedAt" timestamptz not null default now()
);

create index if not exists idx_exportjobs_user on public."ExportJobs"("UserId");
create index if not exists idx_exportjobs_status on public."ExportJobs"("Status");
create index if not exists idx_exportjobs_created on public."ExportJobs"("CreatedAt");

-- RLS policies
alter table public."ExportJobs" enable row level security;

create policy "Users can access their own export jobs" on public."ExportJobs"
    for all using (auth.uid() = "UserId");

grant all on public."ExportJobs" to authenticated;
