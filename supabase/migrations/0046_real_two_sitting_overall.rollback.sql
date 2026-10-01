-- ============================================================================
-- ROLLBACK for 0046_real_two_sitting_overall.sql
--
-- Restores the pre-0046 state:
--   * every cycle the 0046 backfill re-designated gets its prior `sitting` back
--     (from app.sitting_backfill_0046), each restore APPENDED to audit_log;
--   * the sittings trigger and the 0046 helper functions are dropped;
--   * create_cycle_with_assessments is restored to its exact 0031 body;
--   * the test_centres.is_synthetic marker column is dropped.
--
-- audit_log is append-only: no audit row is deleted or edited — 0046's own
-- 'derive_sitting' rows stay, and the restores are recorded as new rows.
-- Sittings re-designated by the INGEST trigger after 0046 (not the backfill)
-- are left as derived: they reflect each export's own result dates. Revert those
-- by hand from audit_log (action = 'derive_sitting', after->>'source' = 'ingest')
-- if required.
--
-- Touches no score / grade / lock data. Run in the Supabase SQL editor (EU).
-- ============================================================================

begin;

set local lock_timeout = '30s';

-- 1. Restore backfilled sittings (audited).
do $restore$
declare
  b record;
  c exam_cycles;
begin
  if to_regclass('app.sitting_backfill_0046') is null then
    return;
  end if;
  for b in select * from app.sitting_backfill_0046 loop
    select * into c from exam_cycles where id = b.cycle_id;
    if not found then
      continue;
    end if;
    update exam_cycles set sitting = b.old_sitting, updated_at = now() where id = b.cycle_id;
    insert into audit_log (cycle_id, actor_id, action, entity, entity_id, before, after)
    values (b.cycle_id, coalesce(auth.uid(), c.created_by), 'derive_sitting', 'exam_cycle', b.cycle_id::text,
            jsonb_build_object('sitting', c.sitting),
            jsonb_build_object('sitting', b.old_sitting, 'source', 'migration_0046_rollback'));
  end loop;
end
$restore$;

drop table if exists app.sitting_backfill_0046;

-- 2. Trigger + helpers.
drop trigger if exists sittings_sync_cycle_sitting on public.sittings;
drop function if exists app.trg_sittings_sync_cycle_sitting();
drop function if exists app.sync_cycle_sitting(uuid, text);
drop function if exists app.derive_cycle_sitting(uuid);
drop function if exists app.sitting_period_of(text);

-- 3. create_cycle_with_assessments — exact 0031 body (same signature, so the
--    0031 grant stands).
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
begin
  -- Resolve the year and its centre. The audit payload below records v_centre,
  -- so it must ALWAYS be the year's REAL centre — never a passed-in guess that
  -- could disagree with it. (The audit trail is load-bearing for the Cambridge
  -- check-ins.)
  if v_year_id is null then
    -- New year: resolve the centre (explicit, else placeholder) and
    -- find-or-create the year within it.
    v_centre := coalesce(p_test_centre_id, app.default_test_centre());
    v_year_name := coalesce(substring(p_name from '(?:19|20)\d{2}'),
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
  values (p_name, p_region, auth.uid(), v_year_id, p_sitting, p_sitting_date)
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

-- 4. Synthetic marker column.
alter table public.test_centres drop column if exists is_synthetic;

commit;
