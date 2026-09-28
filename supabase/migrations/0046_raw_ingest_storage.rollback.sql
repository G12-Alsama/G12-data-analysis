-- ============================================================================
-- Rollback for 0046_raw_ingest_storage.sql
--
-- Drops the raw-ingest Storage bucket, its RLS policies, and app.path_cycle_id.
-- NOTE: deleting the bucket also deletes any objects still inside it (Supabase's
-- storage.objects -> storage.buckets FK cascades). The ingest route deletes each
-- object immediately after reading it (success or failure), so the bucket should
-- normally be empty — but check `select count(*) from storage.objects where
-- bucket_id = 'raw-ingest'` first if you suspect a stuck upload before rolling
-- this back, since anything still there is lost with the bucket.
--
-- Run this only if reverting the client/route changes in the same PR too — the
-- live ingest path depends on this bucket + these policies once deployed.
-- ============================================================================

begin;

drop policy if exists raw_ingest_select on storage.objects;
drop policy if exists raw_ingest_insert on storage.objects;

delete from storage.buckets where id = 'raw-ingest';

drop function if exists app.path_cycle_id(text);

commit;
