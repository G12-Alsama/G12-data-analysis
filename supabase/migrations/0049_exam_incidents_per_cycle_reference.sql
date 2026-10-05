-- ============================================================================
-- 0049 — exam_incidents: `reference` is unique PER SITTING, not globally
--
-- THE BUG (0044)
--   `exam_incidents.reference` carried a GLOBAL `unique (reference)`, and
--   `upsert_exam_incidents` did `on conflict (reference) do update set
--   cycle_id = excluded.cycle_id, …`. A technical-incident export's `reference`
--   (e.g. an incident ref or a row number) is only unique WITHIN one export. The
--   moment a second sitting imported a file that reused any reference, the upsert
--   did not add rows to that sitting — it silently MOVED the existing rows out of
--   the first sitting into the second (cycle_id was overwritten). The first
--   sitting lost those incidents with no error and no audit trace.
--
-- THE FIX
--   1. Uniqueness is per sitting: `unique (cycle_id, reference)`. The same
--      reference may exist once in each sitting.
--   2. `upsert_exam_incidents` now conflicts on `(cycle_id, reference)` and no
--      longer assigns `cycle_id` on update — a re-upload of a corrected file still
--      UPDATES that sitting's rows in place (never duplicates), and can never touch
--      another sitting's rows.
--   Everything else in the function is byte-for-byte the 0044 body (same role
--   check, same columns, still STAGING ONLY — no adjustment_* is ever written).
--
-- SAFETY
--   * Widening a unique key can never be violated by existing data: every current
--     row is already unique on `reference` alone, hence on (cycle_id, reference).
--   * Additive/forward-only; the new constraint is created BEFORE the old one is
--     dropped so there is never a window without a uniqueness guarantee.
--   * Touches no scoring path and no other table. Reversible via
--     0049_exam_incidents_per_cycle_reference.rollback.sql (which refuses to run
--     if the same reference now legitimately exists in two sittings).
--
-- ALREADY-AFFECTED DATA
--   Rows that the old behaviour moved between sittings cannot be reconstructed
--   (the original sitting's copy was overwritten in place). To see which sittings
--   hold incidents whose export label disagrees with the sitting they are filed
--   under, run the read-only query in the VERIFY block below; re-import the
--   affected sitting's incident file to restore its rows (safe now).
--
-- Run AFTER 0001–0048, once, in the Supabase SQL editor (EU). Idempotent.
-- ============================================================================

begin;

set local lock_timeout = '30s';

-- ----------------------------------------------------------------------------
-- 1. Per-sitting uniqueness (new constraint first, then drop the global one).
-- ----------------------------------------------------------------------------
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.exam_incidents'::regclass
       and conname = 'exam_incidents_cycle_reference_key'
  ) then
    alter table public.exam_incidents
      add constraint exam_incidents_cycle_reference_key unique (cycle_id, reference);
  end if;
end $$;

alter table public.exam_incidents
  drop constraint if exists exam_incidents_reference_key;

-- ----------------------------------------------------------------------------
-- 2. upsert_exam_incidents — conflict on (cycle_id, reference); never move a row
--    between sittings. Same signature, same role gate, same audit as 0044.
-- ----------------------------------------------------------------------------
create or replace function public.upsert_exam_incidents(
  p_cycle uuid, p_batch uuid, p_file_name text, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, app as $$
declare r jsonb; n integer := 0;
begin
  if not app.has_role(p_cycle, array['lead_admin','reviewer']::member_role[]) then
    raise exception 'not authorized';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if coalesce(btrim(r->>'reference'), '') = '' then continue; end if;  -- never stage a keyless row
    insert into exam_incidents (
      cycle_id, reference, import_batch_id, file_name, exam_cycle, subject_raw, subject_key,
      exam_date, partner_center, category, issue, code, student_name, student_email,
      student_id_external, time_started, time_resolved, duration_min, action_taken,
      questions_affected_count, questions_affected_list, status, invigilator, source_created_at,
      matched_qm_result_id, match_status, flags, imported_at)
    values (
      p_cycle, btrim(r->>'reference'), p_batch, p_file_name, r->>'exam_cycle', r->>'subject_raw', nullif(r->>'subject_key',''),
      nullif(r->>'exam_date','')::date, r->>'partner_center', r->>'category', r->>'issue', r->>'code',
      r->>'student_name', lower(btrim(r->>'student_email')),
      r->>'student_id_external', r->>'time_started', r->>'time_resolved',
      nullif(r->>'duration_min','')::integer, r->>'action_taken',
      nullif(r->>'questions_affected_count','')::integer,
      case when r->'questions_affected_list' is null or r->>'questions_affected_list' = 'null' then null else r->'questions_affected_list' end,
      r->>'status', r->>'invigilator', nullif(r->>'source_created_at','')::timestamptz,
      nullif(r->>'matched_qm_result_id',''), coalesce(r->>'match_status','unmatched_email'),
      coalesce((select array_agg(x) from jsonb_array_elements_text(r->'flags') x), '{}'),
      now())
    -- Conflict is PER SITTING. `cycle_id` is deliberately NOT in the update list: a
    -- row belongs to the sitting it was staged in, always.
    on conflict (cycle_id, reference) do update set
      import_batch_id = excluded.import_batch_id, file_name = excluded.file_name,
      exam_cycle = excluded.exam_cycle, subject_raw = excluded.subject_raw, subject_key = excluded.subject_key,
      exam_date = excluded.exam_date, partner_center = excluded.partner_center, category = excluded.category,
      issue = excluded.issue, code = excluded.code, student_name = excluded.student_name,
      student_email = excluded.student_email, student_id_external = excluded.student_id_external,
      time_started = excluded.time_started, time_resolved = excluded.time_resolved,
      duration_min = excluded.duration_min, action_taken = excluded.action_taken,
      questions_affected_count = excluded.questions_affected_count,
      questions_affected_list = excluded.questions_affected_list, status = excluded.status,
      invigilator = excluded.invigilator, source_created_at = excluded.source_created_at,
      matched_qm_result_id = excluded.matched_qm_result_id, match_status = excluded.match_status,
      flags = excluded.flags, imported_at = now();
      -- adjustment_type / adjustment_magnitude / adjustment_notes are intentionally
      -- NOT touched here — staging never adjusts (§3 gate).
    n := n + 1;
  end loop;
  perform app.audit(p_cycle, 'upsert_exam_incidents', 'exam_incidents', p_cycle::text, null,
    jsonb_build_object('batch', p_batch, 'file_name', p_file_name, 'count', n));
  return n;
end $$;

grant execute on function public.upsert_exam_incidents(uuid, uuid, text, jsonb) to authenticated;

commit;

-- ----------------------------------------------------------------------------
-- VERIFY (run after the migration; read-only).
--
-- 1. The constraint swap:
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.exam_incidents'::regclass and contype = 'u';
--   -- expect exam_incidents_cycle_reference_key  UNIQUE (cycle_id, reference)
--   -- and NO exam_incidents_reference_key.
--
-- 2. Sittings holding incidents whose export label (`exam_cycle`) does not match
--    the sitting they are filed under — the footprint of the old cross-sitting move:
--   select c.id as cycle_id, c.name as sitting, i.exam_cycle as export_label,
--          count(*) as incidents
--     from exam_incidents i
--     join exam_cycles c on c.id = i.cycle_id
--    where lower(btrim(i.exam_cycle)) <> lower(btrim(c.name))
--    group by c.id, c.name, i.exam_cycle
--    order by c.name, incidents desc;
--   -- Empty = nothing visibly misfiled. Rows here: re-import that sitting's
--   -- incident file(s) (safe now) to restore the sitting's own rows.
-- ----------------------------------------------------------------------------
