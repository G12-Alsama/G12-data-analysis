-- ============================================================================
-- Rollback for 0051_year_expected_periods.sql
--   Drops set_year_expected_periods and the exam_years.expected_periods column (with
--   its check). Any per-year configuration is lost; every year then behaves as the
--   app's built-in default (February + May), which is what every year had at 0051.
--   Run in the Supabase SQL editor (EU).
-- ============================================================================

begin;

set local lock_timeout = '30s';

drop function if exists public.set_year_expected_periods(uuid, public.sitting_period[]);
alter table public.exam_years drop constraint if exists exam_years_expected_periods_nonempty;
alter table public.exam_years drop column if exists expected_periods;

commit;
