import "server-only";

/**
 * Server-side engine write path.
 *
 * Recompute (item statistics + participant scores) MUST run server-side — never
 * in the browser — because `item_stats` and `participant_scores` are not
 * client-writable. This module reads the cycle's responses (plus the essay marks
 * and triaged alterations) with the secret-key admin client, runs the EXISTING
 * TypeScript engine, and writes the computed rows directly.
 *
 * Why direct writes (not the RPCs): the SECURITY DEFINER functions authorize via
 * `app.has_role(auth.uid())`, and the secret-key client has no `auth.uid()`. The
 * secret role bypasses RLS and is not bound by the `authenticated` column revokes,
 * so it is the sanctioned privileged writer for these engine-only tables. The
 * engine itself is unchanged — only where its results get persisted.
 */
import type { SupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  ItemRow,
  ResponseRow,
  AssessmentRow,
  ParticipantRow,
  EssayMarkRow,
  AlterationRow,
  CleanExclusionRow,
  CohortExclusionRow,
} from "@/lib/types/database";
import {
  getEngine,
  ENGINE_VERSION,
  type ItemMeta,
  type ResponseRecord,
  type EssayMark,
  type Alteration,
} from "@/lib/engine";
import { isEssaySubject, ESSAY_MAX_RESERVED } from "@/lib/data/essays";

type Admin = SupabaseAdminClient;

async function sel<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data } = await p;
  return (data ?? []) as T[];
}

/** Loosely-typed table accessor for privileged writes (the typed client marks
 *  these engine-only tables as non-insertable for clients). */
interface LooseWrite {
  insert(rows: unknown): Promise<{ error: { message: string } | null; data: unknown }>;
  upsert(rows: unknown, opts?: { onConflict?: string }): Promise<{ error: { message: string } | null; data: unknown }>;
  delete(): {
    eq(col: string, val: string): Promise<{ error: { message: string } | null }>;
    in(col: string, vals: string[]): Promise<{ error: { message: string } | null }>;
  };
}
function table(admin: Admin, name: string): LooseWrite {
  return (admin.from as unknown as (n: string) => LooseWrite)(name);
}

export interface RecomputeResult {
  items: number;
  scores: number;
  assessments: number;
}

/**
 * Recompute item stats + participant scores for a cycle and persist them.
 * Returns row counts written. Throws on any write error.
 */
export async function recomputeAndWrite(admin: Admin, cycleId: string): Promise<RecomputeResult> {
  const [assessments, items, participants, responses, essayRows, alterationRows, cleanExclusions, cohortExclusions] = await Promise.all([
    sel<AssessmentRow>(admin.from("assessments").select("*").eq("cycle_id", cycleId)),
    sel<ItemRow>(admin.from("items").select("*").eq("cycle_id", cycleId)),
    sel<ParticipantRow>(admin.from("participants").select("*").eq("cycle_id", cycleId)),
    sel<ResponseRow>(admin.from("responses").select("*").eq("cycle_id", cycleId)),
    sel<EssayMarkRow>(admin.from("essay_marks").select("*").eq("cycle_id", cycleId)),
    sel<AlterationRow>(admin.from("alterations").select("*").eq("cycle_id", cycleId)),
    sel<CleanExclusionRow>(admin.from("clean_exclusions").select("*").eq("cycle_id", cycleId)),
    sel<CohortExclusionRow>(admin.from("cohort_exclusions").select("*").eq("cycle_id", cycleId)),
  ]);

  const engine = getEngine();
  const itemAssessment = new Map(items.map((it) => [it.id, it.assessment_id]));
  const excludedItemIds = items.filter((it) => it.status === "excluded").map((it) => it.id);

  // ── participant / cohort exclusions ──────────────────────────────────────
  // The materialized participant_scores MUST reflect the CLEANED cohort, so the
  // Candidate Scores page never shows excluded accounts. Two sources, matching the
  // client provider's cohort boundary:
  //   1. COHORT-WIDE exclusions (cohort_exclusions, migration 0033) — staff/test/
  //      withdrawn, keyed on the stable qm_participant_id (editable data, never an
  //      email hard-coded in source), applied to EVERY subject; and
  //   2. Clean-stage PER-SUBJECT row removals (clean_exclusions kind='row') —
  //      re-resolved through the participant's stable key so a removal recorded
  //      before a re-import still matches the freshly-minted row (migration 0016).
  const qmToUuid = new Map(participants.map((p) => [p.qm_participant_id, p.id]));
  const liveIds = new Set(participants.map((p) => p.id));
  const staffExcluded = new Set(
    cohortExclusions
      .map((ce) => qmToUuid.get(ce.participant_key))
      .filter((id): id is string => id != null),
  );
  const rowExcludedByAssessment = new Map<string, Set<string>>();
  for (const ce of cleanExclusions) {
    if (ce.kind !== "row") continue;
    const pid = (ce.target_key && qmToUuid.get(ce.target_key)) || (liveIds.has(ce.target_id) ? ce.target_id : undefined);
    if (!pid) continue;
    (rowExcludedByAssessment.get(ce.assessment_id) ?? rowExcludedByAssessment.set(ce.assessment_id, new Set()).get(ce.assessment_id)!).add(pid);
  }
  const isExcludedResponse = (participantId: string, assessmentId: string): boolean =>
    staffExcluded.has(participantId) || (rowExcludedByAssessment.get(assessmentId)?.has(participantId) ?? false);

  // Engine inputs keyed by the item/participant/assessment UUIDs.
  const itemMetas: ItemMeta[] = items.map((it) => ({
    itemId: it.id,
    assessmentId: it.assessment_id,
    wording: it.wording,
    majorElement: it.major_element,
    subElement: it.sub_element,
    demandLevel: it.demand_level,
    maxScore: it.max_score ?? 1,
  }));
  const allResponses: ResponseRecord[] = responses
    .map((r) => ({
      participantId: r.participant_id,
      itemId: r.item_id,
      assessmentId: itemAssessment.get(r.item_id) ?? "",
      score: Number(r.answer_score),
    }))
    // Drop excluded participants' responses BEFORE the engine sees them, so both
    // item_stats and participant_scores are computed on the cleaned cohort.
    .filter((r) => !isExcludedResponse(r.participantId, r.assessmentId));

  // ── item stats (per assessment, like the seed builder/parity path) ──────
  const statRows: Record<string, unknown>[] = [];
  for (const a of assessments) {
    const aItems = itemMetas.filter((m) => m.assessmentId === a.id);
    const aResp = allResponses.filter((r) => r.assessmentId === a.id);
    if (aItems.length === 0) continue;
    const stats = engine.computeItemStats({ responses: aResp, items: aItems });
    for (const s of stats) {
      statRows.push({
        item_id: s.itemId,
        p_value: s.pValue,
        p_rating: s.pRating,
        item_total: s.itemTotal,
        it_rating: s.itRating,
        point_biserial: s.pointBiserial,
        pb_rating: s.pbRating,
        discrimination: s.discrimination,
        disc_rating: s.discRating,
        overall_review: s.overallReview,
        engine_version: ENGINE_VERSION,
      });
    }
  }
  if (statRows.length) {
    const { error } = await table(admin, "item_stats").upsert(statRows, { onConflict: "item_id" });
    if (error) throw new Error(`write item_stats: ${error.message}`);
  }

  // ── participant scores (three-component) ────────────────────────────────
  const essayAssessmentIds = assessments
    .filter((a) => isEssaySubject({ name: a.name, items: itemMetas.filter((m) => m.assessmentId === a.id) }))
    .map((a) => a.id);
  const essayMarks: EssayMark[] = essayRows.map((e) => ({
    participantId: e.participant_id,
    assessmentId: e.assessment_id,
    mark: Number(e.mark),
  }));

  // roster per assessment (for whole-subject alterations)
  const rosterByAssessment = new Map<string, Set<string>>();
  for (const r of allResponses) {
    (rosterByAssessment.get(r.assessmentId) ?? rosterByAssessment.set(r.assessmentId, new Set()).get(r.assessmentId)!).add(r.participantId);
  }
  const alterations: Alteration[] = [];
  for (const al of alterationRows) {
    if (al.apply_to === "none" || !al.assessment_id) continue;
    if (al.apply_to === "subject") {
      for (const pid of rosterByAssessment.get(al.assessment_id) ?? []) {
        alterations.push({ participantId: pid, assessmentId: al.assessment_id, marks: Number(al.marks) });
      }
    } else if (al.participant_id) {
      alterations.push({ participantId: al.participant_id, assessmentId: al.assessment_id, marks: Number(al.marks) });
    }
  }

  const scores = engine.computeScores(allResponses, excludedItemIds, {
    essayMarks,
    alterations,
    essayAssessmentIds,
    // Half-weighted essay max (sum of essay item max / 2), derived — not 20.
    essayMax: ESSAY_MAX_RESERVED,
    items: itemMetas,
  });

  // Replace prior runs for a clean snapshot, then one score_run per assessment.
  //
  // Scope EVERYTHING to this cycle. participant_scores has no cycle_id of its own;
  // it belongs to a cycle through its score_run, so we clear exactly the rows that
  // hang off THIS cycle's runs. An unscoped delete here would wipe every sitting's
  // scores on each recompute (and Overall analytics reads across sittings).
  const priorRuns = await sel<{ id: string }>(
    admin.from("score_runs").select("id").eq("cycle_id", cycleId),
  );
  const priorRunIds = priorRuns.map((r) => r.id);
  if (priorRunIds.length > 0) {
    const { error } = await table(admin, "participant_scores").delete().in("score_run_id", priorRunIds);
    if (error) throw new Error(`clear participant_scores: ${error.message}`);
  }
  await table(admin, "score_runs").delete().eq("cycle_id", cycleId);

  let scoreCount = 0;
  for (const a of assessments) {
    const aScores = scores.filter((s) => s.assessmentId === a.id);
    if (aScores.length === 0) continue;
    const excludedHere = excludedItemIds.filter((id) => itemAssessment.get(id) === a.id);
    const run = await sel<{ id: string }>(
      (admin.from as unknown as (n: string) => {
        insert(v: unknown): { select(c: string): PromiseLike<{ data: unknown; error: unknown }> };
      })("score_runs").insert({
        cycle_id: cycleId,
        assessment_id: a.id,
        excluded_item_ids: excludedHere,
        engine_version: ENGINE_VERSION,
      }).select("id"),
    );
    const runId = run[0]?.id;
    if (!runId) continue;
    const rows = aScores.map((s) => ({
      score_run_id: runId,
      participant_id: s.participantId,
      assessment_id: s.assessmentId,
      raw: s.raw,
      pct: s.pct,
      items_seen: s.itemsSeen,
    }));
    const { error } = await table(admin, "participant_scores").insert(rows);
    if (error) throw new Error(`write participant_scores: ${error.message}`);
    scoreCount += rows.length;
  }

  void participants; // (reserved: per-participant overall roll-up writes)
  return { items: statRows.length, scores: scoreCount, assessments: assessments.length };
}
