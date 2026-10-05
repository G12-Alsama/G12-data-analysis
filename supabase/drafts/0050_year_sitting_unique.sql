-- ============================================================================
-- 0050 (DRAFT — NOT APPLIED) — one sitting per (year, period)
--
-- Makes the data model enforce what the app now assumes: within an exam year there
-- is at most ONE February sitting and ONE May sitting, and every sitting HAS a year
-- and a period. Prerequisite for using several sittings at once (Overall, analytics
-- and the multi-sitting provider all slot a sitting by (year, period)).
--
-- DO NOT RUN BLIND. Order of operations:
--   1. Run supabase/drafts/0050_year_sitting_preflight.sql (read-only) and resolve
--      what it reports (duplicates by hand; name/period mismatches via its
--      suggested_fix lines).
--   2. Optional but recommended — so the backfill's audit rows name YOU, set your id
--      first (the SQL editor has no signed-in user):
--         select set_config('request.jwt.claim.sub', '<your auth.users id>', false);
--      Without it the backfill still runs and RAISEs a NOTICE per change, but writes
--      no audit_log rows (audit_log.actor_id is NOT NULL).
--   3. Run this file once. It is one transaction: it either completes or changes
--      nothing.
--
-- WHAT IT DOES
--   1. BACKFILL (conservative). Fixes only the unambiguous case the old create form
--      produced: a sitting STORED as 'may' whose name contains a whole month word
--      January–April (or jan/feb/mar/apr), does not also say "may", sits in a year
--      with NO existing February, and is the only such candidate in that year. Each
--      change is announced (NOTICE) and, when a user id was set, audited. Anything
--      else is left for a human.
--   2. PRE-FLIGHT GUARD. Raises (changing nothing) if any cycle still has no year or
--      no period, or if any (year, period) still has more than one sitting — naming
--      the offending ids.
--   3. ENFORCE. year_id and sitting become NOT NULL; unique (year_id, sitting).
--   4. RETIRE the legacy create_cycle(name, region) RPC (0001). It inserts a cycle
--      with NO year and NO period — it would now fail on NOT NULL, and before this
--      it let any signed-in user create a sitting outside the one-per-period rule.
--      The app only ever calls create_cycle_with_assessments. (Decision for review:
--      drop this step if anything external still calls create_cycle.)
--
-- Reversible: 0050_year_sitting_unique.rollback.sql (does not undo the backfill).
-- Touches no fact table and no scoring path.
-- ============================================================================

begin;

set local lock_timeout = '30s';

-- ----------------------------------------------------------------------------
-- 1. Conservative backfill: 'may' → 'february' for unambiguous Jan–Apr-named rows.
-- ----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    with cand as (
      select c.id, c.year_id, c.name
        from exam_cycles c
       where c.year_id is not null
         and c.sitting = 'may'
         and c.name ~* '\m(january|february|march|april|jan|feb|mar|apr)\M'
         and c.name !~* '\mmay\M'
         and not exists (select 1 from exam_cycles o
                          where o.year_id = c.year_id and o.sitting = 'february')
    ), single as (
      select year_id from cand group by year_id having count(*) = 1
    )
    select cand.id, cand.name
      from cand join single using (year_id)
  loop
    update exam_cycles set sitting = 'february' where id = r.id;
    raise notice 'backfill: sitting "%" (%) stored as may -> february', r.name, r.id;
    if auth.uid() is not null then
      perform app.audit(r.id, 'sitting_period_corrected', 'exam_cycle', r.id::text,
                        jsonb_build_object('sitting', 'may'),
                        jsonb_build_object('sitting', 'february', 'migration', '0050'));
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Pre-flight guard: stop, changing nothing, if the data would violate step 3.
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_dupes   text;
begin
  select string_agg(id::text, ', ' order by created_at)
    into v_missing
    from exam_cycles
   where year_id is null or sitting is null;
  if v_missing is not null then
    raise exception
      '0050: cycles with no year or no period must be fixed first (preflight query 3): %', v_missing;
  end if;

  select string_agg(format('%s / %s: %s', y.name, d.sitting, d.ids), '; ' order by y.name, d.sitting)
    into v_dupes
    from (select year_id, sitting, string_agg(id::text, ', ' order by created_at) as ids
            from exam_cycles
           group by year_id, sitting
          having count(*) > 1) d
    join exam_years y on y.id = d.year_id;
  if v_dupes is not null then
    raise exception
      '0050: several sittings share a (year, period) — resolve by hand first (preflight query 1): %', v_dupes;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Enforce.
-- ----------------------------------------------------------------------------
alter table public.exam_cycles alter column year_id set not null;
alter table public.exam_cycles alter column sitting set not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.exam_cycles'::regclass
       and conname = 'exam_cycles_year_sitting_key'
  ) then
    alter table public.exam_cycles
      add constraint exam_cycles_year_sitting_key unique (year_id, sitting);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Retire the legacy year-less create RPC.
-- ----------------------------------------------------------------------------
revoke execute on function public.create_cycle(text, text) from public, anon, authenticated;

commit;

-- ----------------------------------------------------------------------------
-- VERIFY (read-only, after applying).
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.exam_cycles'::regclass and contype = 'u';
--   -- expect exam_cycles_year_sitting_key  UNIQUE (year_id, sitting)
--   select column_name, is_nullable from information_schema.columns
--    where table_name = 'exam_cycles' and column_name in ('year_id', 'sitting');
--   -- expect NO for both.
-- ----------------------------------------------------------------------------
