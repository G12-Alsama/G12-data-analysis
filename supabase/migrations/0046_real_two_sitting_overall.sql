-- ============================================================================
-- G12++ — REAL two-sitting Overall (closes open item O9)
-- Migration 0046_real_two_sitting_overall.sql
--
-- WHY THIS EXISTS
--   The Overall view needs two REAL, locked sittings of one year: February and
--   May. Three defects in the data layer stopped that from ever happening on live
--   data, so the app fell back to a February "synthesised from May":
--
--   (a) `exam_cycles.sitting` was never derived. The UI's create path never passes
--       `p_sitting`, so EVERY cycle created through the app was stored as the
--       default 'may', including real February sittings. Ingest tags each
--       sitting row with its result period (`sittings.sitting`, e.g. 'FEB2026',
--       from the QM ResultGroupName), but nothing carried that onto the cycle.
--   (b) The 0043 synthetic analytics seed (centres `seed-ov-*`, "△ Sample") has
--       no durable DB-level marker beyond a slug convention, so the app could
--       not reliably keep it out of real years / the live-cycle pick.
--
-- WHAT THIS DOES (additive + one audited metadata backfill)
--   1. `test_centres.is_synthetic boolean not null default false`, backfilled
--      TRUE for the 0043 seed centres (`slug like 'seed-ov-%'`). The app excludes
--      synthetic centres (and every year/cycle under them) from operational views
--      and from the Overall. No synthetic row is deleted (0043's own rollback
--      remains the way to remove it).
--   2. `app.sitting_period_of(code)` — 'JAN…APR<yyyy>' → february, 'MAY…DEC<yyyy>'
--      → may (the same Jan–Apr rule as 0005 and lib/ingest/qm/canonical.ts).
--   3. `app.derive_cycle_sitting(cycle)` — the DOMINANT period over the cycle's
--      ingested `sittings.sitting` codes (the result date). A tie or no data →
--      NULL (never guesses).
--   4. `app.sync_cycle_sitting(cycle, source)` — sets `exam_cycles.sitting` from
--      (3) when it differs, and appends an audit row. LOCKED cycles are NEVER
--      changed by the trigger path (only by the one-time backfill in 7).
--   5. Statement-level AFTER INSERT trigger on `sittings` → (4) for each cycle
--      touched, so every future ingest_persist designates the sitting from its
--      own result dates. ingest_persist itself is NOT modified.
--   6. `create_cycle_with_assessments` — same signature, same grants; the only
--      change is that a supplied `p_sitting_date` now designates the sitting
--      (Jan–Apr → february) and supplies the year when the name carries none.
--   7. One-time backfill: every NON-synthetic cycle whose stored sitting
--      disagrees with its ingested result dates is corrected. The prior value is
--      saved in `app.sitting_backfill_0046` (for the rollback) and each change is
--      appended to `audit_log`. Locked cycles ARE corrected here: `sitting` is
--      grouping metadata only, so no score, grade, lock or sign-off is touched.
--
-- SCOPE / SAFETY
--   * Touches no score / grade / item / response row, no lock flag, and no
--     scoring path (engine parity 183/183 unchanged).
--   * audit_log stays append-only: this migration only INSERTs audit rows.
--     `actor_id` is NOT NULL, so the actor is the session user when there is
--     one, else the cycle's creator; `after.source` records which.
--   * Reversible: 0046_real_two_sitting_overall.rollback.sql.
--   * Run AFTER 0001–0045 in the Supabase SQL editor (EU), as the project owner.
--
-- DRY RUN (read-only; run BEFORE applying to see what step 7 will change):
--   select c.id, c.name, c.status, c.sitting as stored, d.period as derived, d.n
--     from exam_cycles c
--     cross join lateral (
--       select case when upper(left(s.sitting, 3)) in ('JAN','FEB','MAR','APR')
--                   then 'february' else 'may' end as period,
--              count(*) as n
--         from sittings s
--        where s.cycle_id = c.id
--          and s.sitting ~* '^[a-z]{3}[[:space:]]*(19|20)[0-9]{2}$'
--        group by 1 order by n desc limit 1) d
--    where c.sitting::text is distinct from d.period;
-- ============================================================================

begin;

set local lock_timeout = '30s';

-- ----------------------------------------------------------------------------
-- 1. Durable synthetic-data marker on test centres.
-- ----------------------------------------------------------------------------
alter table public.test_centres
  add column if not exists is_synthetic boolean not null default false;

comment on column public.test_centres.is_synthetic is
  '0046 — TRUE for synthetic/sample centres (the 0043 analytics seed, slug seed-ov-*). Excluded from real years and the Overall.';

update public.test_centres
   set is_synthetic = true
 where slug like 'seed-ov-%'
   and is_synthetic = false;

-- ----------------------------------------------------------------------------
-- 2. Period of one ingested sitting code ('FEB2026' → february).
-- ----------------------------------------------------------------------------
create or replace function app.sitting_period_of(p_code text)
returns sitting_period language sql immutable as $$
  select case
    when p_code is null then null
    when upper(p_code) ~ '^(JAN|FEB|MAR|APR)\s*(19|20)\d{2}$' then 'february'::sitting_period
    when upper(p_code) ~ '^(MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*(19|20)\d{2}$' then 'may'::sitting_period
    else null
  end
$$;

-- ----------------------------------------------------------------------------
-- 3. Dominant period across a cycle's ingested sitting rows. A tie → NULL.
-- ----------------------------------------------------------------------------
create or replace function app.derive_cycle_sitting(p_cycle uuid)
returns sitting_period language sql stable set search_path = public, app as $$
  with tally as (
    select app.sitting_period_of(s.sitting) as period, count(*) as n
      from public.sittings s
     where s.cycle_id = p_cycle
       and app.sitting_period_of(s.sitting) is not null
     group by 1
  ), ranked as (
    select period, n, rank() over (order by n desc) as r from tally
  )
  select case when (select count(*) from ranked where r = 1) = 1
              then (select period from ranked where r = 1)
              else null end
$$;

-- ----------------------------------------------------------------------------
-- 4. Sync one cycle's sitting from its result dates (audited). Never touches a
--    locked cycle. Returns true when it changed the row.
-- ----------------------------------------------------------------------------
create or replace function app.sync_cycle_sitting(p_cycle uuid, p_source text)
returns boolean language plpgsql security definer set search_path = public, app as $$
declare
  c         exam_cycles;
  v_derived sitting_period;
  v_actor   uuid;
begin
  select * into c from exam_cycles where id = p_cycle;
  if not found or c.status = 'locked' then
    return false;
  end if;
  v_derived := app.derive_cycle_sitting(p_cycle);
  if v_derived is null or v_derived is not distinct from c.sitting then
    return false;
  end if;
  update exam_cycles set sitting = v_derived, updated_at = now() where id = p_cycle;
  v_actor := coalesce(auth.uid(), c.created_by);
  insert into audit_log (cycle_id, actor_id, action, entity, entity_id, before, after)
  values (p_cycle, v_actor, 'derive_sitting', 'exam_cycle', p_cycle::text,
          jsonb_build_object('sitting', c.sitting),
          jsonb_build_object('sitting', v_derived, 'source', p_source,
                             'actor', case when auth.uid() is null then 'cycle_creator' else 'session' end));
  return true;
end $$;

revoke all on function app.sync_cycle_sitting(uuid, text) from public;

-- ----------------------------------------------------------------------------
-- 5. Every ingest designates its cycle's sitting from the rows it just wrote.
--    Statement-level (one sync per cycle per INSERT statement, not per row).
-- ----------------------------------------------------------------------------
create or replace function app.trg_sittings_sync_cycle_sitting()
returns trigger language plpgsql security definer set search_path = public, app as $$
declare
  v_cycle uuid;
begin
  for v_cycle in select distinct cycle_id from new_rows loop
    perform app.sync_cycle_sitting(v_cycle, 'ingest');
  end loop;
  return null;
end $$;

drop trigger if exists sittings_sync_cycle_sitting on public.sittings;
create trigger sittings_sync_cycle_sitting
  after insert on public.sittings
  referencing new table as new_rows
  for each statement
  execute function app.trg_sittings_sync_cycle_sitting();

-- ----------------------------------------------------------------------------
-- 6. Create path: a picked sitting date designates the sitting (and the year
--    when the name has none). Same signature/defaults as 0031, so the existing
--    grant stands; body identical to 0031 except the two marked lines.
-- ----------------------------------------------------------------------------
create or replace function public.create_cycle_with_assessments(
  p_name text,
  p_region text default 'eu-west',
  p_assessments jsonb default '[]'::jsonb,
  p_year_id uuid default null,
  p_sitting sitting_period default 'may',
  p_test_centre_id uuid default null,
  p_sitting_date date default null)
returns uuid language plpgsql security definer set search_path = public, app as $$
declare
  c           exam_cycles;
  rec         jsonb;
  v_name      text;
  v_year_id   uuid := p_year_id;
  v_year_name text;
  v_centre    uuid;
  v_sitting   sitting_period;
begin
  -- 0046: the sitting date, when given, designates the sitting (Jan–Apr → february).
  v_sitting := case
    when p_sitting_date is null then p_sitting
    when extract(month from p_sitting_date) between 1 and 4 then 'february'::sitting_period
    else 'may'::sitting_period
  end;

  -- Resolve the year and its centre. The audit payload below records v_centre,
  -- so it must ALWAYS be the year's REAL centre — never a passed-in guess that
  -- could disagree with it. (The audit trail is load-bearing for the Cambridge
  -- check-ins.)
  if v_year_id is null then
    -- New year: resolve the centre (explicit, else placeholder) and
    -- find-or-create the year within it.
    v_centre := coalesce(p_test_centre_id, app.default_test_centre());
    -- 0046: fall back to the sitting date's year before today's.
    v_year_name := coalesce(substring(p_name from '(?:19|20)\d{2}'),
                            to_char(p_sitting_date, 'YYYY'),
                            to_char(now(), 'YYYY'));
    select id into v_year_id from exam_years
      where name = v_year_name and region = p_region and test_centre_id = v_centre;
    if v_year_id is null then
      insert into exam_years (name, region, test_centre_id, created_by)
      values (v_year_name, p_region, v_centre, auth.uid())
      returning id into v_year_id;
    end if;
  else
    -- Explicit year: the centre is whatever that year already belongs to.
    select test_centre_id into v_centre from exam_years where id = v_year_id;
    if not found then
      raise exception 'exam year % not found', v_year_id;
    end if;
    -- Passing a year under one centre together with a DIFFERENT centre is a
    -- caller bug: fail loudly rather than silently attaching to the year's centre.
    if p_test_centre_id is not null and p_test_centre_id <> v_centre then
      raise exception 'test_centre_id % conflicts with year %''s centre %',
        p_test_centre_id, v_year_id, v_centre;
    end if;
  end if;

  insert into exam_cycles (name, region, created_by, year_id, sitting, sitting_date)
  values (p_name, p_region, auth.uid(), v_year_id, v_sitting, p_sitting_date)
  returning * into c;

  insert into memberships (cycle_id, user_id, role)
  values (c.id, auth.uid(), 'lead_admin');

  for rec in select * from jsonb_array_elements(coalesce(p_assessments, '[]'::jsonb)) loop
    v_name := coalesce(trim(rec->>'name'), '');
    if v_name <> '' then
      insert into assessments (cycle_id, name, item_count)
      values (c.id, v_name, coalesce((rec->>'item_count')::int, 0));
    end if;
  end loop;

  perform app.audit(c.id, 'create', 'exam_cycle', c.id::text, null,
                    jsonb_build_object('cycle', to_jsonb(c),
                                       'assessments', coalesce(p_assessments, '[]'::jsonb),
                                       'test_centre_id', v_centre));
  return c.id;
end $$;

-- ----------------------------------------------------------------------------
-- 7. One-time backfill of mis-designated sittings (real centres only), with the
--    prior value kept for the rollback. Includes locked cycles: `sitting` is
--    grouping metadata, so no grade/score/lock is touched.
-- ----------------------------------------------------------------------------
create table if not exists app.sitting_backfill_0046 (
  cycle_id    uuid primary key references public.exam_cycles(id) on delete cascade,
  old_sitting sitting_period,
  new_sitting sitting_period not null,
  changed_at  timestamptz not null default now()
);

do $backfill$
declare
  c         record;
  v_derived sitting_period;
begin
  for c in
    select ec.*
      from exam_cycles ec
      left join exam_years y   on y.id = ec.year_id
      left join test_centres t on t.id = y.test_centre_id
     where coalesce(t.is_synthetic, false) = false
  loop
    v_derived := app.derive_cycle_sitting(c.id);
    if v_derived is null or v_derived is not distinct from c.sitting then
      continue;
    end if;
    insert into app.sitting_backfill_0046 (cycle_id, old_sitting, new_sitting)
    values (c.id, c.sitting, v_derived)
    on conflict (cycle_id) do nothing;
    update exam_cycles set sitting = v_derived, updated_at = now() where id = c.id;
    insert into audit_log (cycle_id, actor_id, action, entity, entity_id, before, after)
    values (c.id, coalesce(auth.uid(), c.created_by), 'derive_sitting', 'exam_cycle', c.id::text,
            jsonb_build_object('sitting', c.sitting),
            jsonb_build_object('sitting', v_derived, 'source', 'migration_0046_backfill',
                               'locked', c.status = 'locked'));
  end loop;
end
$backfill$;

commit;
