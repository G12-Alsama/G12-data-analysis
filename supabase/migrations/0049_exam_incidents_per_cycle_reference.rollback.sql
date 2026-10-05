-- ============================================================================
-- Rollback for 0049_exam_incidents_per_cycle_reference.sql
--   Restores the 0044 behaviour: GLOBAL `unique (reference)` and the 0044
--   `upsert_exam_incidents` body (`on conflict (reference)`, which reassigns
--   `cycle_id` — i.e. moves rows between sittings). Run in the Supabase SQL editor
--   (EU) to reverse 0049.
--
--   REFUSES TO RUN if the same `reference` now exists in more than one sitting
--   (which 0049 makes legal): restoring the global unique key would fail, and
--   silently de-duplicating would delete a sitting's incidents. Resolve those rows
--   by hand first; the offending references are listed in the error.
-- ============================================================================

begin;

set local lock_timeout = '30s';

do $$
declare v_dupes text;
begin
  select string_agg(reference || ' (' || n || ' sittings)', ', ')
    into v_dupes
    from (select reference, count(*) as n
            from public.exam_incidents
           group by reference having count(*) > 1) d;
  if v_dupes is not null then
    raise exception
      'cannot restore global unique(reference): reference(s) exist in several sittings: %', v_dupes;
  end if;
end $$;

alter table public.exam_incidents
  add constraint exam_incidents_reference_key unique (reference);

alter table public.exam_incidents
  drop constraint if exists exam_incidents_cycle_reference_key;

-- 0044 body (global conflict key; reassigns cycle_id).
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
    on conflict (reference) do update set
      cycle_id = excluded.cycle_id, import_batch_id = excluded.import_batch_id, file_name = excluded.file_name,
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
