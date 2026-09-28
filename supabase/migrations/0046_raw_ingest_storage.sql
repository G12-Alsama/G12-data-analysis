-- ============================================================================
-- G12++ — Raw-ingest Storage bucket: gets the ingest payload off the Vercel
-- request body entirely, so payload size stops being a class of 413 failure at
-- any cohort size.
-- Migration 0046_raw_ingest_storage.sql
--
-- WHY THIS EXISTS
--   The ingest route (app/api/cycles/[cycleId]/ingest) persists the browser's
--   cleaned response matrix + 3-CSV canonical model (lib/ingest). Commit 63288db
--   already gzip-compressed that payload in the POST body to dodge Vercel's hard,
--   unraisable 4.5 MB request-body ceiling — but that only pushed the ceiling
--   further out: a large-enough cohort's payload still exceeds it even gzipped
--   (observed on a ~1,431-result / ~50k-row import). Request-body size is a
--   platform ceiling with no per-payload override, so no amount of compression
--   makes it size-independent.
--
--   This migration adds a private Storage bucket the client uploads the SAME
--   payload to directly (still gzipped — lib/transport/gzip.ts); the route is
--   then POSTed only a small `{ filePath }` reference, well under any body limit
--   regardless of cohort size. See lib/transport/raw-ingest-storage.ts.
--
-- WHAT THIS DOES
--   1. `app.path_cycle_id(name)` — reads a Storage object path's first segment as
--      a UUID, or NULL if it isn't one shaped like a UUID. NEVER raises (a bad
--      cast inside an RLS policy would abort the whole statement) — a NULL cycle
--      id makes `app.has_role(NULL, ...)` fail closed to "workspace admin only"
--      (its existing behaviour — see 0025), never open.
--   2. `raw-ingest` bucket — private, gzip-only, 200 MB cap (a guard against
--      abuse, not a target — the actual compressed payload is far smaller).
--   3. RLS on `storage.objects`, scoped to `{cycle_id}/...` paths: only a
--      lead_admin of that exact cycle (or a workspace-wide admin) may INSERT or
--      SELECT an object under that prefix — the same `app.has_role` primitive
--      every other cycle-scoped write in this schema already uses.
--
--      INSERT + SELECT only. No UPDATE (each upload uses a fresh UUID filename,
--      so nothing is ever overwritten) and no client DELETE (the ingest route
--      deletes the object itself, via the admin/service-role client which
--      bypasses Storage RLS, immediately after reading it — the payload carries
--      participant PII and should not linger in Storage regardless of outcome).
--
-- SCOPE / SAFETY
--   New bucket + new function + new policies only — no existing table, function,
--   or RLS policy is touched. Forward-only; reversible via
--   0046_raw_ingest_storage.rollback.sql.
--   Run AFTER 0001–0045 in the Supabase SQL editor (EU).
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. app.path_cycle_id — first path segment as UUID, or NULL. Never raises.
-- ----------------------------------------------------------------------------
create or replace function app.path_cycle_id(name text)
returns uuid language sql stable set search_path = public, app as $$
  select case
    when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then (storage.foldername(name))[1]::uuid
    else null
  end;
$$;

-- ----------------------------------------------------------------------------
-- 2. Bucket. Private; gzip only — the client always uploads a gzip blob
--    (lib/transport/gzip.ts). 200 MB is a generous abuse guard, not a target:
--    the real compressed payload for any realistic cohort is a small fraction
--    of that.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'raw-ingest', 'raw-ingest', false, 209715200,
  array['application/gzip', 'application/x-gzip']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ----------------------------------------------------------------------------
-- 3. RLS on storage.objects, this bucket only.
-- ----------------------------------------------------------------------------
drop policy if exists raw_ingest_insert on storage.objects;
create policy raw_ingest_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'raw-ingest'
    and app.has_role(app.path_cycle_id(name), array['lead_admin']::member_role[])
  );

drop policy if exists raw_ingest_select on storage.objects;
create policy raw_ingest_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'raw-ingest'
    and app.has_role(app.path_cycle_id(name), array['lead_admin']::member_role[])
  );

commit;

-- ----------------------------------------------------------------------------
-- VERIFY (run after the migration):
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets
--    where id = 'raw-ingest';                          -- expect one row, public=false
--
--   select policyname, cmd from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and policyname like 'raw_ingest_%';              -- expect insert + select
--
--   select app.path_cycle_id('not-a-uuid/foo.json.gz'); -- expect null (no error)
-- ----------------------------------------------------------------------------
