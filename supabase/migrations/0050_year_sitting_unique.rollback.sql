-- ============================================================================
-- Rollback for 0050_year_sitting_unique.sql
--   Drops unique (year_id, sitting), makes year_id / sitting nullable again and
--   restores execute on the legacy create_cycle(name, region) RPC. It does NOT undo
--   the backfill (periods corrected from 'may' to 'february' stay corrected — they
--   were wrong). Run in the Supabase SQL editor (EU).
-- ============================================================================

begin;

set local lock_timeout = '30s';

alter table public.exam_cycles drop constraint if exists exam_cycles_year_sitting_key;
alter table public.exam_cycles alter column year_id drop not null;
alter table public.exam_cycles alter column sitting drop not null;

-- Back to the 0001 default (PUBLIC execute), as before 0050 revoked it.
grant execute on function public.create_cycle(text, text) to public, authenticated;

commit;
