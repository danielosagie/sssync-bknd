-- Match candidates table for storing CSV import matching results
create table if not exists public."MatchCandidates" (
    "Id" uuid primary key default gen_random_uuid(),
    "RawImportItemId" uuid not null references "RawImportItems"("Id") on delete cascade,
    "UserId" uuid not null references "Users"("Id") on delete cascade,
    "CanonicalVariantId" uuid references "ProductVariants"("Id") on delete cascade,
    "MatchType" text not null check ("MatchType" in ('SKU', 'BARCODE', 'TITLE', 'NONE')),
    "Confidence" numeric not null check ("Confidence" >= 0 and "Confidence" <= 1),
    "MatchData" jsonb,
    "Status" text not null default 'NEEDS_REVIEW' check ("Status" in ('AUTO_MATCHED', 'NEEDS_REVIEW', 'NO_MATCH', 'USER_CONFIRMED', 'USER_REJECTED')),
    "UserAction" text check ("UserAction" in ('ACCEPT', 'REJECT', 'CREATE_NEW', 'IGNORE')),
    "UserActionAt" timestamptz,
    "CreatedAt" timestamptz not null default now(),
    "UpdatedAt" timestamptz not null default now()
);

create index if not exists idx_matchcandidates_rawitem on public."MatchCandidates"("RawImportItemId");
create index if not exists idx_matchcandidates_user on public."MatchCandidates"("UserId");
create index if not exists idx_matchcandidates_status on public."MatchCandidates"("Status");
create index if not exists idx_matchcandidates_canonical on public."MatchCandidates"("CanonicalVariantId");

-- RLS policies
alter table public."MatchCandidates" enable row level security;

create policy "Users can access their own match candidates" on public."MatchCandidates"
    for all using (auth.uid() = "UserId");

grant all on public."MatchCandidates" to authenticated;










