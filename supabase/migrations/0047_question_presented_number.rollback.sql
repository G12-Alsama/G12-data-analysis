-- ============================================================================
-- Rollback for 0047_question_presented_number.sql
--   Restores the 0046 `ingest_persist` body (no question_presented_number column
--   in the responses insert) and drops the column. Run in the Supabase SQL editor
--   (EU) to reverse 0047.
-- ============================================================================

begin;

set local lock_timeout = '30s';

create or replace function public.ingest_persist(
  p_cycle uuid, p_payload jsonb, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare
  v_counts jsonb;
  v_dropped int;
  v_detail  text;
  v_sitting_gap int;
  v_sitting_detail text;
  v_subject_gap int;
  v_subject_detail text;
begin
  if p_actor is null then
    raise exception 'ingest_persist requires an explicit actor (the service role has no auth.uid())';
  end if;

  perform app.clear_cycle_ingest(p_cycle);

  insert into assessments (id, cycle_id, name, item_count, qm_max_score, sitting)
  select id, cycle_id, name, item_count, qm_max_score, sitting
  from jsonb_populate_recordset(null::assessments, p_payload->'assessments');

  insert into items (id, cycle_id, assessment_id, qm_question_id, wording,
                     major_element, sub_element, demand_level, item_set, max_score,
                     question_type, question_status, topic_name, topic_path)
  select id, cycle_id, assessment_id, qm_question_id, wording,
         major_element, sub_element, demand_level, item_set, max_score,
         question_type, question_status, topic_name, topic_path
  from jsonb_populate_recordset(null::items, p_payload->'items');

  insert into participants (id, cycle_id, qm_participant_id, pseudonym_id,
                            full_name, first_name, last_name, email, dob, gender, group_name)
  select id, cycle_id, qm_participant_id, pseudonym_id,
         full_name, first_name, last_name, email, dob, gender, group_name
  from jsonb_populate_recordset(null::participants, p_payload->'participants');

  insert into sittings (cycle_id, qm_result_id, participant_email, participant_id,
                        assessment_id, subject_name, result_status, attempt_number,
                        total_score, maximum_score, percentage_score, scoreband,
                        sitting, reconciled)
  select cycle_id, qm_result_id, participant_email, participant_id,
         assessment_id, subject_name, result_status, attempt_number,
         total_score, maximum_score, percentage_score, scoreband,
         sitting, reconciled
  from jsonb_populate_recordset(null::sittings, p_payload->'sittings');

  insert into responses (cycle_id, qm_result_id, question_id, participant_email,
                         participant_id, item_id, assessment_id, answer_given,
                         answer_given_choice_number,
                         answer_score, response_time, result_status,
                         question_type, question_status)
  select cycle_id, qm_result_id, question_id, participant_email,
         participant_id, item_id, assessment_id, answer_given,
         answer_given_choice_number,
         answer_score, response_time, result_status,
         question_type, question_status
  from jsonb_populate_recordset(null::responses, p_payload->'responses');

  insert into topic_rollups (cycle_id, qm_result_id, assessment_id, participant_id,
                             qm_topic_id, topic_name, topic_path, score,
                             maximum_score, percentage_score, question_count)
  select cycle_id, qm_result_id, assessment_id, participant_id,
         qm_topic_id, topic_name, topic_path, score,
         maximum_score, percentage_score, question_count
  from jsonb_populate_recordset(null::topic_rollups, p_payload->'topic_rollups');

  insert into import_batches (cycle_id, file_ref, file_size_mb, parsed_rows, validation_passed,
                              report_json, items_file, assessments_file, topics_file,
                              results_total, results_reconciled, created_by)
  select p_cycle, b.file_ref, b.file_size_mb, b.parsed_rows, b.validation_passed,
         b.report_json, b.items_file, b.assessments_file, b.topics_file,
         b.results_total, b.results_reconciled, p_actor
  from jsonb_populate_record(null::import_batches, p_payload->'import_batch') b;

  with roster as (
    select distinct assessment_id, participant_id
    from sittings where cycle_id = p_cycle
  ), attached as (
    select distinct i.assessment_id, r.participant_id
    from responses r join items i on i.id = r.item_id
    where r.cycle_id = p_cycle
  ), dropped as (
    select r.assessment_id, r.participant_id from roster r
    except
    select a.assessment_id, a.participant_id from attached a
  )
  select count(*),
         string_agg(assessment_id::text || '/' || participant_id::text, ', ')
    into v_dropped, v_detail
  from dropped;

  if v_dropped > 0 then
    raise exception
      'ingest_persist: % roster sitter(s) have no attached responses (dropped-sitter / all-dots response-attach collapse): %',
      v_dropped, v_detail;
  end if;

  with rt as (
    select distinct qm_result_id from sittings
    where cycle_id = p_cycle and qm_result_id is not null and qm_result_id <> ''
  ), rr as (
    select distinct qm_result_id from responses
    where cycle_id = p_cycle and qm_result_id is not null and qm_result_id <> ''
  ), gap as (
    select qm_result_id, 'sitting without responses' as side from rt
    where qm_result_id not in (select qm_result_id from rr)
    union all
    select qm_result_id, 'responses without sitting' as side from rr
    where qm_result_id not in (select qm_result_id from rt)
  )
  select count(*), string_agg(qm_result_id || ' (' || side || ')', ', ')
    into v_sitting_gap, v_sitting_detail
  from gap;

  if v_sitting_gap > 0 then
    raise exception
      'ingest_persist: % sitting(s) are not present at the sitting grain in both responses and sittings (whole-sitting drop): %',
      v_sitting_gap, v_sitting_detail;
  end if;

  with sit as (
    select assessment_id, count(distinct qm_result_id) as n
    from sittings
    where cycle_id = p_cycle and qm_result_id is not null and qm_result_id <> ''
    group by assessment_id
  ), resp as (
    select assessment_id, count(distinct qm_result_id) as n
    from responses
    where cycle_id = p_cycle and qm_result_id is not null and qm_result_id <> ''
    group by assessment_id
  ), mism as (
    select s.assessment_id, r.n as responses_n, s.n as sittings_n
    from sit s
    join resp r on r.assessment_id = s.assessment_id
    where s.n <> r.n
  )
  select count(*),
         string_agg(
           coalesce((select name from assessments a where a.id = m.assessment_id), m.assessment_id::text)
             || ' (responses ' || m.responses_n || ' != sittings ' || m.sittings_n || ')', ', ')
    into v_subject_gap, v_subject_detail
  from mism m;

  if v_subject_gap > 0 then
    raise exception
      'ingest_persist: % subject(s) persist a different distinct-sitting count in responses vs sittings (per-subject whole-sitting collapse): %',
      v_subject_gap, v_subject_detail;
  end if;

  insert into audit_log (cycle_id, actor_id, action, entity, entity_id, before, after)
  values (p_cycle, p_actor, 'ingest', 'exam_cycle', p_cycle::text, null,
          jsonb_build_object(
            'assessments', coalesce(jsonb_array_length(p_payload->'assessments'), 0),
            'items',       coalesce(jsonb_array_length(p_payload->'items'), 0),
            'participants',coalesce(jsonb_array_length(p_payload->'participants'), 0),
            'sittings',    coalesce(jsonb_array_length(p_payload->'sittings'), 0),
            'responses',   coalesce(jsonb_array_length(p_payload->'responses'), 0)));

  v_counts := jsonb_build_object(
    'assessments', coalesce(jsonb_array_length(p_payload->'assessments'), 0),
    'items',       coalesce(jsonb_array_length(p_payload->'items'), 0),
    'participants',coalesce(jsonb_array_length(p_payload->'participants'), 0),
    'sittings',    coalesce(jsonb_array_length(p_payload->'sittings'), 0),
    'responses',   coalesce(jsonb_array_length(p_payload->'responses'), 0),
    'topic_rollups', coalesce(jsonb_array_length(p_payload->'topic_rollups'), 0));
  return v_counts;
end $$;

revoke all on function public.ingest_persist(uuid, jsonb, uuid) from public;
grant execute on function public.ingest_persist(uuid, jsonb, uuid) to service_role;

alter table public.responses drop column if exists question_presented_number;

commit;
