-- ============================================================================
-- 0052 — bounded manual mark adjustment (Score page) + two fixes to the core
--
-- The Score page lets a reviewer nudge a subject mark by AT MOST ±5 marks. That cap
-- has to live in the database (a client-side clamp is bypassable), so this adds a
-- second public RPC, adjust_participant_mark_bounded, next to the existing
-- adjust_participant_mark that the Grades view keeps using unchanged.
--
-- Both RPCs now share one private core, app.adjust_participant_mark_core, which also
-- fixes two defects in the 0008/0041 body:
--
--   1. STALE BASE. The un-adjusted base was `participant_scores.raw - existing manual
--      delta`. participant_scores is a SNAPSHOT written only by ingest or an explicit
--      /recompute (nothing in the UI triggers one after a nudge), so it does not
--      contain the previous nudge — and subtracting that nudge from a snapshot that
--      never included it stored a wrong delta on every re-adjustment.
--      The base is now derived LIVE from the same inputs lib/server/engine-write.ts
--      feeds the engine (see app.subject_mark_inputs):
--          base = MCQ (retained items) + essay (essay subjects) + INCIDENT alterations
--      Manual rows (incident_id IS NULL) are excluded from the base — they are what is
--      being replaced — so re-adjusting a cell can never compound.
--
--   2. NO RANGE CHECK. 0 <= new mark <= subject max was enforced only in the Grades
--      modal. It is now enforced here, against the max the engine uses (retained MCQ
--      max + the reserved essay max for an essay subject), not a hard-coded number.
--
-- WHAT DOES NOT CHANGE
--   * adjust_participant_mark keeps its signature, grant and gate (grades.adjust) and
--     calls the core with no cap — the Grades-view nudge behaves as before, minus the
--     two fixes above.
--   * remove_mark_adjustment is untouched: any holder of grades.adjust may undo (a
--     deliberate choice, consistent with the Grades view).
--   * No table constraint is added to alterations.marks: that table is shared with
--     incident-triage deltas, which may legitimately exceed 5.
--   * No lib/engine change, so scoring parity is untouched (183/183).
--
-- A participant with no score in the subject (no retained response, or excluded from
-- the cohort / the subject) cannot be adjusted: there is no mark to move. Previously
-- the stale-base code silently treated that base as 0.
--
-- Order: apply after 0051. Reversible: 0052_bounded_mark_adjustment.rollback.sql.
-- ============================================================================

begin;

set local lock_timeout = '30s';

-- ----------------------------------------------------------------------------
-- 1. Participants the engine drops from a subject BEFORE scoring — the same two
--    sources lib/server/engine-write.ts honours:
--      * cohort-wide exclusions (cohort_exclusions, keyed on the stable
--        qm_participant_id), applied to every subject; and
--      * clean-stage per-subject ROW removals (clean_exclusions kind='row'),
--        re-resolved through the stable key when present, else the stored id.
-- ----------------------------------------------------------------------------
create or replace function app.excluded_participants(p_cycle uuid, p_assessment uuid)
returns setof uuid language sql stable set search_path = public, app as $$
  select p.id
    from participants p
   where p.cycle_id = p_cycle
     and (
       exists (select 1 from cohort_exclusions ce
                where ce.cycle_id = p_cycle and ce.participant_key = p.qm_participant_id)
       or exists (select 1 from clean_exclusions x
                   where x.cycle_id = p_cycle and x.assessment_id = p_assessment and x.kind = 'row'
                     and case
                           when x.target_key is not null
                                and exists (select 1 from participants q
                                             where q.cycle_id = p_cycle and q.qm_participant_id = x.target_key)
                             then x.target_key = p.qm_participant_id
                           else x.target_id = p.id
                         end)
     );
$$;

-- ----------------------------------------------------------------------------
-- 2. The live base + max for one (participant, subject) cell, mirroring
--    lib/server/engine-write.ts → engine.computeScores:
--      raw = mcq + essay + alterations          (participant_scores.raw's formula)
--      max = retained MCQ max + (essay subject ? ESSAY_MAX_RESERVED : 0)
--    `base` is raw WITHOUT the manual rows. `scored` is false when the engine would
--    produce no row for the cell (no retained response by a non-excluded participant).
-- ----------------------------------------------------------------------------
create or replace function app.subject_mark_inputs(
  p_cycle uuid, p_participant uuid, p_assessment uuid)
returns table (scored boolean, base numeric, max_mark numeric)
language plpgsql stable set search_path = public, app as $$
declare
  -- lib/data/essays.ts ESSAY_MAX_RESERVED = (2 essays x 20) / 2: the half-weighted essay
  -- block reserved in the denominator. engine-write passes this same constant to the
  -- engine; a test pins the two together.
  c_essay_max constant numeric := 20;
  v_name      text;
  v_mcq       numeric;
  v_seen      integer;
  v_mcq_max   numeric;
  v_has_essay boolean;
  v_essay     numeric := 0;
  v_incident  numeric;
begin
  select a.name into v_name from assessments a where a.id = p_assessment and a.cycle_id = p_cycle;
  if not found
     or not exists (select 1 from participants p where p.id = p_participant and p.cycle_id = p_cycle)
     or p_participant in (select e from app.excluded_participants(p_cycle, p_assessment) e) then
    return query select false, 0::numeric, 0::numeric;
    return;
  end if;

  -- MCQ: the participant's scores on RETAINED (status <> 'excluded') items.
  select coalesce(sum(r.answer_score), 0), count(*) into v_mcq, v_seen
    from responses r
    join items i on i.id = r.item_id
   where r.cycle_id = p_cycle and r.participant_id = p_participant
     and i.assessment_id = p_assessment and i.status <> 'excluded';
  if v_seen = 0 then
    return query select false, 0::numeric, 0::numeric;
    return;
  end if;

  -- Subject max: retained items that at least one non-excluded participant answered.
  select coalesce(sum(i.max_score), 0) into v_mcq_max
    from items i
   where i.cycle_id = p_cycle and i.assessment_id = p_assessment and i.status <> 'excluded'
     and exists (select 1 from responses r
                  where r.item_id = i.id
                    and r.participant_id not in (select e from app.excluded_participants(p_cycle, p_assessment) e));

  -- Essay subject (lib/data/essays.ts isEssaySubject): an item beyond the dichotomous
  -- max of 1, or the script-aware name match (Latin "arabic|english" or Arabic script).
  v_has_essay :=
       exists (select 1 from items i where i.assessment_id = p_assessment and i.max_score > 1)
    or v_name ~* 'arabic|english'
    or v_name ~ ('[' || chr(1536) || '-' || chr(1791) || ']');
  if v_has_essay then
    select coalesce(sum(em.mark), 0) into v_essay
      from essay_marks em
     where em.cycle_id = p_cycle and em.participant_id = p_participant and em.assessment_id = p_assessment;
  end if;

  -- Incident-derived alterations only (incident_id IS NOT NULL): a 'student' row for this
  -- participant, or a whole-'subject' row (applies to every scored participant in it).
  select coalesce(sum(al.marks), 0) into v_incident
    from alterations al
   where al.cycle_id = p_cycle and al.incident_id is not null and al.assessment_id = p_assessment
     and al.apply_to <> 'none'
     and (al.apply_to = 'subject' or al.participant_id = p_participant);

  return query select true, v_mcq + v_essay + v_incident,
                       v_mcq_max + case when v_has_essay then c_essay_max else 0 end;
end $$;

-- ----------------------------------------------------------------------------
-- 3. The shared core. p_max_delta NULL = uncapped (the Grades-view path).
--    Supersedes any existing MANUAL row on the cell (so deltas never compound), stores
--    the signed delta (new − live base), and audits it.
-- ----------------------------------------------------------------------------
create or replace function app.adjust_participant_mark_core(
  p_cycle uuid, p_participant uuid, p_assessment uuid,
  p_new_mark numeric, p_reason text, p_max_delta numeric default null)
returns uuid language plpgsql security definer set search_path = public, app as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_scored boolean;
  v_base   numeric;
  v_max    numeric;
  v_delta  numeric;
  v_id     uuid;
begin
  if not app.can_do(p_cycle, 'grades.adjust') then
    raise exception 'not authorized';
  end if;
  if v_actor is null then
    raise exception 'adjust_participant_mark requires a signed-in actor (auth.uid() is null)';
  end if;
  if v_reason = '' then
    raise exception 'a reason is required for a manual mark adjustment';
  end if;
  if p_new_mark is null then
    raise exception 'a new mark is required for a manual mark adjustment';
  end if;
  if p_max_delta is not null and p_max_delta < 0 then
    raise exception 'p_max_delta must not be negative';
  end if;

  -- Serialise concurrent nudges of the same cell (read base → replace row is not atomic).
  perform pg_advisory_xact_lock(hashtextextended('mark_adjust:' || p_cycle::text || p_participant::text || p_assessment::text, 0));

  select i.scored, i.base, i.max_mark into v_scored, v_base, v_max
    from app.subject_mark_inputs(p_cycle, p_participant, p_assessment) i;
  if not coalesce(v_scored, false) then
    raise exception 'this participant has no score in this subject, so there is no mark to adjust';
  end if;
  if p_new_mark < 0 or p_new_mark > v_max then
    raise exception 'new mark % is outside the valid range 0 to %', p_new_mark, v_max;
  end if;

  v_delta := p_new_mark - v_base;
  if p_max_delta is not null and abs(v_delta) > p_max_delta then
    raise exception 'a mark adjustment of % exceeds the allowed +/-% marks (current mark %, requested %)',
      v_delta, p_max_delta, v_base, p_new_mark;
  end if;

  -- Supersede any prior manual adjustment on this cell.
  delete from alterations
   where cycle_id = p_cycle and incident_id is null
     and participant_id = p_participant and assessment_id = p_assessment;

  if v_delta <> 0 then
    insert into alterations (cycle_id, incident_id, apply_to, participant_id, assessment_id, marks, reason, decided_by)
    values (p_cycle, null, 'student', p_participant, p_assessment, v_delta, v_reason, v_actor)
    returning id into v_id;
  end if;

  perform app.audit(
    p_cycle, 'adjust_mark', 'participant_score',
    p_participant::text || ':' || p_assessment::text,
    jsonb_build_object('mark', v_base),
    jsonb_build_object('mark', p_new_mark, 'delta', v_delta, 'reason', v_reason));

  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Public RPCs. Both are gated on grades.adjust here AND in the core.
-- ----------------------------------------------------------------------------
-- Unchanged contract (Grades view): no cap.
create or replace function public.adjust_participant_mark(
  p_cycle uuid, p_participant uuid, p_assessment uuid,
  p_new_mark numeric, p_reason text)
returns uuid language plpgsql security definer set search_path = public, app as $$
begin
  if not app.can_do(p_cycle, 'grades.adjust') then
    raise exception 'not authorized';
  end if;
  return app.adjust_participant_mark_core(p_cycle, p_participant, p_assessment, p_new_mark, p_reason, null);
end $$;

-- Score page: at most ±5 marks from the current mark.
create or replace function public.adjust_participant_mark_bounded(
  p_cycle uuid, p_participant uuid, p_assessment uuid,
  p_new_mark numeric, p_reason text)
returns uuid language plpgsql security definer set search_path = public, app as $$
begin
  if not app.can_do(p_cycle, 'grades.adjust') then
    raise exception 'not authorized';
  end if;
  return app.adjust_participant_mark_core(p_cycle, p_participant, p_assessment, p_new_mark, p_reason, 5);
end $$;

-- ----------------------------------------------------------------------------
-- 5. Privileges. The private helpers are never callable by an API role directly
--    (the definer RPCs reach them as their owner).
-- ----------------------------------------------------------------------------
revoke all on function app.excluded_participants(uuid, uuid) from public, anon, authenticated;
revoke all on function app.subject_mark_inputs(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function app.adjust_participant_mark_core(uuid, uuid, uuid, numeric, text, numeric) from public, anon, authenticated;

revoke all     on function public.adjust_participant_mark_bounded(uuid, uuid, uuid, numeric, text) from public, anon;
grant  execute on function public.adjust_participant_mark_bounded(uuid, uuid, uuid, numeric, text) to authenticated;

commit;
