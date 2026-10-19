-- ============================================================================
-- G12++ — ANSWER GIVEN CHOICE NUMBER: capture the one QM field that can tell an
-- unanswered item from an answered one without ambiguity.
-- Migration 0046_answer_given_choice_number.sql
--
-- WHY THIS EXISTS
--   Omission Rate, Completion Rate, the Speededness Index and the Pearson/Spearman
--   timing correlations all derive "was this item answered?" from `answer_given`.
--   QM's export writes the sentinel text "<Not defined>" into `AnswerGiven` for an
--   unanswered item — a non-empty, truthy string/non-null value that survives every
--   `!= null` / truthy check in the diagnostics code, so every omitted item was
--   silently counted as answered.
--
--   `AnswerGivenChoiceNumber` is QM's own answer-index field and is genuinely blank
--   (empty string in the CSV) for an unanswered item, with no sentinel-string
--   ambiguity. It was never captured anywhere in the ingest pipeline — this column
--   is step one of threading it end-to-end (types → normalise → persist → hydrate →
--   diagnostics). `answer_given` itself is untouched: it remains the correct field
--   for raw-text display and is not read by this migration.
--
-- WHAT THIS DOES (additive, non-destructive)
--   1. `responses.answer_given_choice_number text` (nullable) — the raw
--      `AnswerGivenChoiceNumber` value, blank/omitted normalised to NULL upstream in
--      the app layer before it ever reaches this column. Text, not int: QM's export
--      is a CSV feed and the app never trusts it to only ever emit digits.
--   2. Re-affirms `public.ingest_persist` so the new column is actually threaded
--      from the JSON payload into the table — the JS-side write layer can build the
--      field, but a stale `ingest_persist` would insert every other column and
--      silently drop this one. Body is otherwise IDENTICAL to 0030 (same guards).
--
-- SCOPE / SAFETY
--   One additive column + one `create or replace function` (added column to two
--   column lists, nothing else touched). Does NOT alter or rename any existing
--   response column, touch scoring (`answer_score` untouched), or change any guard
--   0030 already enforces. Forward-only; reversible via
--   0046_answer_given_choice_number.rollback.sql. Run AFTER 0001–0045 in the
--   Supabase SQL editor (EU).
-- ============================================================================

begin;

set local lock_timeout = '30s';

-- ----------------------------------------------------------------------------
-- 1. The column (nullable, additive).
-- ----------------------------------------------------------------------------
alter table public.responses
  add column if not exists answer_given_choice_number text;

comment on column public.responses.answer_given_choice_number is
  '0046 — raw QM AnswerGivenChoiceNumber, normalised blank -> NULL upstream. The '
  'correct field for "was this item answered?" (answer_given carries the sentinel '
  '"<Not defined>" for unanswered items and stays truthy/non-null, so it cannot be '
  'used for this check). Never used for scoring.';

-- ----------------------------------------------------------------------------
-- 2. Re-affirm ingest_persist (body identical to 0030 + the new column threaded
--    through the responses insert/select).
-- ----------------------------------------------------------------------------
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

  -- Clear-then-write: never upsert-merge onto stale rows.
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

  -- The sitting spine FIRST (responses/topic_rollups FK to it).
  insert into sittings (cycle_id, qm_result_id, participant_email, participant_id,
                        assessment_id, subject_name, result_status, attempt_number,
                        total_score, maximum_score, percentage_score, scoreband,
                        sitting, reconciled)
  select cycle_id, qm_result_id, participant_email, participant_id,
         assessment_id, subject_name, result_status, attempt_number,
         total_score, maximum_score, percentage_score, scoreband,
         sitting, reconciled
  from jsonb_populate_recordset(null::sittings, p_payload->'sittings');

  -- responses — one row per sitting × question. PLAIN insert on the sitting-qualified
  -- natural key (cycle_id, qm_result_id, question_id): a genuine duplicate raises;
  -- NO ON CONFLICT collapses a distinct sitting.
  -- 0046: answer_given_choice_number threaded through (additive column, same guards).
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

  -- ── roster ↔ responses guard: every sitting must carry ≥1 attached response ──
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

  -- ── whole-sitting completeness guard: every sitting present on BOTH sides ────
  -- If any sitting exists in `sittings` but has zero rows in `responses` (or vice
  -- versa), the ingest ABORTS instead of persisting a collapsed matrix.
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

  -- ── PER-SUBJECT sitting-count guard: count(distinct qm_result_id) in responses
  --    MUST equal count(distinct qm_result_id) in sittings, for every subject that
  --    has responses. This is the decisive assertion against the string-sort collapse
  --    (some of a subject's sittings kept, the rest silently dropped) — the ingest
  --    ABORTS naming the subject and both counts. Subjects whose sittings carry no
  --    MCQ responses are excluded (they have no responses rows to reconcile).
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
    join resp r on r.assessment_id = s.assessment_id   -- only subjects that HAVE responses
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

commit;

-- ----------------------------------------------------------------------------
-- VERIFY (run after the migration).
--   select column_name from information_schema.columns
--    where table_name = 'responses' and column_name = 'answer_given_choice_number';
--
-- Then re-ingest a sitting and confirm the column is actually populated (not just
-- present) for at least one answered and one omitted item:
--   select answer_given, answer_given_choice_number
--     from responses where cycle_id = '<CYCLE_UUID>' limit 20;
-- ----------------------------------------------------------------------------
