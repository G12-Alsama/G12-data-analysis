-- ============================================================================
-- TEMPLATE (a draft, NOT part of the migration chain) — add a sitting period.
--
-- To add a period (say August) you make exactly two changes:
--   1. one entry in PERIOD_DEFS in lib/data/periods.ts
--        { key: 'august', label: 'August', shortLabel: 'Aug', month: 8, order: 3,
--          covers: [...], expectedByDefault: false }
--      (re-split `covers` so every calendar month still belongs to exactly one period;
--       the registry refuses to load otherwise, and tests/periods.registry.test.ts
--       fails if the registry and this enum disagree);
--   2. a migration, copied from this file to supabase/migrations/00NN_add_period_august.sql,
--      with <key> replaced.
--
-- Years that already exist keep expecting only the periods in their
-- exam_years.expected_periods (default {february,may}); a new period does NOT make an
-- old year "not ready". Set `expectedByDefault: true` only if every existing year
-- should start expecting it. Opt a year in with public.set_year_expected_periods().
--
-- ── ALTER TYPE … ADD VALUE: the transaction caveat ───────────────────────────
-- * On PostgreSQL 12+ (all Supabase projects today) ADD VALUE may run inside a
--   transaction block, BUT the new value cannot be USED (inserted, compared, cast
--   in a default or a function body that executes) until that transaction has
--   committed. So this migration must contain ONLY the ADD VALUE — do not insert a
--   row with the new period, add a CHECK mentioning it, or create an index
--   predicate on it in the same file. Do that in a later migration.
-- * On PostgreSQL < 12 it cannot run inside a transaction at all: drop the
--   begin/commit below and run the statement on its own.
-- * Enum values can never be removed. There is no rollback for this migration; the
--   only way back is to recreate the type, which needs every column using it
--   rewritten. Treat it as one-way, and add the value only when you are sure.
-- * IF NOT EXISTS makes it safe to re-run.
-- ============================================================================

begin;
set local lock_timeout = '30s';

-- Replace 'august' with the new registry key; keep AFTER the period that precedes it
-- in the registry (enum order is cosmetic — the app orders by the registry).
alter type public.sitting_period add value if not exists 'august' after 'may';

commit;

-- VERIFY (separate statement, after the commit):
--   select enum_range(null::public.sitting_period);
-- ROLLBACK: none (see above).
