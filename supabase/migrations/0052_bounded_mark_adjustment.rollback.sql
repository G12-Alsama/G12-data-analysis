-- ============================================================================
-- Rollback for 0052_bounded_mark_adjustment.sql
--   Drops adjust_participant_mark_bounded and the private core/helpers, and restores
--   adjust_participant_mark to its 0041 body (gated on grades.adjust, base taken from
--   participant_scores.raw — i.e. WITH the stale-base and no-range-check defects 0052
--   fixed). No data is touched: manual alterations already written stay as they are.
--   Run in the Supabase SQL editor (EU).
-- ============================================================================

begin;

set local lock_timeout = '30s';

drop function if exists public.adjust_participant_mark_bounded(uuid, uuid, uuid, numeric, text);

-- adjust_participant_mark -> app.can_do(..., 'grades.adjust')
create or replace function public.adjust_participant_mark(
  p_cycle uuid, p_participant uuid, p_assessment uuid,
  p_new_mark numeric, p_reason text)
returns uuid language plpgsql security definer set search_path = public, app as $$
declare
  v_actor    uuid := auth.uid();
  v_base     numeric;
  v_existing numeric;
  v_delta    numeric;
  v_id       uuid;
begin
  if not app.can_do(p_cycle, 'grades.adjust') then
    raise exception 'not authorized';
  end if;
  if v_actor is null then
    raise exception 'adjust_participant_mark requires a signed-in actor (auth.uid() is null)';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required for a manual mark adjustment';
  end if;

  -- Sum of any existing MANUAL delta for this cell (incident_id is null), so the
  -- un-adjusted base = stored subject total minus that delta.
  select coalesce(sum(marks), 0) into v_existing
    from alterations
   where cycle_id = p_cycle and incident_id is null
     and participant_id = p_participant and assessment_id = p_assessment;

  -- Stored subject total (engine raw = MCQ + essay + alterations) from the latest
  -- score run; the un-adjusted base subtracts any existing manual delta.
  select coalesce(ps.raw, 0) - v_existing into v_base
    from participant_scores ps
    join score_runs sr on sr.id = ps.score_run_id
   where sr.cycle_id = p_cycle and sr.assessment_id = p_assessment
     and ps.participant_id = p_participant
   order by sr.computed_at desc
   limit 1;
  v_base := coalesce(v_base, 0);

  v_delta := p_new_mark - v_base;

  -- Supersede any prior manual adjustment on this cell.
  delete from alterations
   where cycle_id = p_cycle and incident_id is null
     and participant_id = p_participant and assessment_id = p_assessment;

  if v_delta <> 0 then
    insert into alterations (cycle_id, incident_id, apply_to, participant_id, assessment_id, marks, reason, decided_by)
    values (p_cycle, null, 'student', p_participant, p_assessment, v_delta, btrim(p_reason), v_actor)
    returning id into v_id;
  end if;

  perform app.audit(
    p_cycle, 'adjust_mark', 'participant_score',
    p_participant::text || ':' || p_assessment::text,
    jsonb_build_object('mark', v_base),
    jsonb_build_object('mark', p_new_mark, 'delta', v_delta, 'reason', btrim(p_reason)));

  return v_id;
end $$;

-- The public function no longer references the core, so the private helpers can go.
drop function if exists app.adjust_participant_mark_core(uuid, uuid, uuid, numeric, text, numeric);
drop function if exists app.subject_mark_inputs(uuid, uuid, uuid);
drop function if exists app.excluded_participants(uuid, uuid);

commit;
