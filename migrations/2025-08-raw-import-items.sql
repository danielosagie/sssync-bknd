-- Raw import items for CSV/unstructured ingestion
create table if not exists public."RawImportItems" (
    "Id" uuid primary key default gen_random_uuid(),
    "UserId" uuid not null references "Users"("Id") on delete cascade,
    "Source" text not null default 'csv', -- csv | ocr | freeform
    "OriginalFilename" text,
    "IngestJobId" text,
    "RawRow" jsonb not null,
    "NormalizedSku" text,
    "NormalizedBarcode" text,
    "NormalizedTitle" text,
    "NormalizedPrice" numeric,
    "NormalizedQuantity" integer,
    "CreatedAt" timestamptz not null default now()
);

create index if not exists idx_rawimportitems_user on public."RawImportItems"("UserId");
create index if not exists idx_rawimportitems_job on public."RawImportItems"("IngestJobId");

-- Enable trigram ops on normalized fields for quick fuzzy lookup if needed
create extension if not exists pg_trgm;
create index if not exists idx_rawimportitems_title_trgm on public."RawImportItems" using gin ("NormalizedTitle" gin_trgm_ops);
create index if not exists idx_productvariants_title_trgm on public."ProductVariants" using gin ("Title" gin_trgm_ops);

-- Function to find similar variants by title for a user
create or replace function public.find_similar_variants(p_user_id uuid, p_title text, p_limit int default 10)
returns table(
    variant_id uuid,
    product_id uuid,
    sku text,
    title text,
    barcode text,
    price numeric,
    similarity real
)
language sql stable as $$
    select v."Id" as variant_id,
           v."ProductId" as product_id,
           v."Sku" as sku,
           v."Title" as title,
           v."Barcode" as barcode,
           v."Price" as price,
           similarity(v."Title", p_title) as similarity
    from public."ProductVariants" v
    where v."UserId" = p_user_id
    order by v."Title" <-> p_title -- trigram distance
    limit p_limit;
$$;

grant execute on function public.find_similar_variants(uuid, text, int) to authenticated;

