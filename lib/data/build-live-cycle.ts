/**
 * Build the in-memory provider's live-cycle data from cleaned responses.
 *
 * This is the same transform `scripts/build-seed.mts` runs at build time, but
 * generalised so it works on ANY combined export uploaded at runtime (it never
 * drops a subject it doesn't recognise). It runs the REAL engine over the
 * response matrix to compute item statistics, then assembles the SeedAssessment /
 * SeedParticipant / diagnostics shapes the rest of the in-memory provider reads.
 *
 * It does not change how statistics are computed — it produces exactly the same
 * per-subject grouping + engine inputs the pipeline already consumes, so engine
 * parity is unaffected. It is the in-memory mirror of the Supabase ingest write
 * path (lib/server/ingest-write.ts): both take CleanResponse[] and make the
 * pipeline run on it.
 */

import { getEngine, type ItemMeta, type QualityRating, type ResponseRecord } from "@/lib/engine";
import { buildAssessmentDiagnostics, cleanDiagResponses, type DiagResponse } from "@/lib/diagnostics";
import type {
  SeedAssessment,
  SeedAssessmentDiagnostics,
  SeedItem,
  SeedParticipant,
  SeedPreview,
  SeedResponse,
  SeedSitting,
  SeedTechnicalIncident,
} from "./seed-types";
import type { CleanResponse } from "@/lib/ingest/types";
import { isTechnicalIncidentStatus } from "./result-status";

const RATING_SCORE: Record<QualityRating, number> = { Good: 1, Review: 0.55, Flag: 0.12 };
/** Transparent 0–100 quality index: mean of the four per-stat rating scores. */
function qualityIndex(stat: {
  pRating: QualityRating;
  itRating: QualityRating;
  pbRating: QualityRating;
  discRating: QualityRating;
}): number {
  const avg =
    (RATING_SCORE[stat.pRating] + RATING_SCORE[stat.itRating] + RATING_SCORE[stat.pbRating] + RATING_SCORE[stat.discRating]) / 4;
  return Math.round(avg * 100);
}

const RTL_SCRIPT = /[؀-ۿ]/;
/** A compact display name for the subject chips (keep it short, ASCII-safe). */
function shortNameOf(name: string): string {
  if (/applicable math/i.test(name)) return "Applicable Math";
  if (/english/i.test(name)) return "English 2nd Lang";
  if (/scientific/i.test(name)) return "Scientific";
  if (/life/i.test(name)) return "Life Skills";
  if (RTL_SCRIPT.test(name) || /arabic/i.test(name)) return "Arabic 1st Lang";
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}

export interface LiveCycleData {
  participants: SeedParticipant[];
  assessments: SeedAssessment[];
  diagnostics: SeedAssessmentDiagnostics[];
  preview: SeedPreview;
  /** The per-sitting ingest roster (one entry per participant × subject) — the
   *  authoritative source for the ingest-stage participant counts. */
  sittings: SeedSitting[];
}

/**
 * Turn cleaned MCQ responses into the live-cycle seed data (participants,
 * per-subject assessments with engine-computed item stats, diagnostics, preview).
 * Subjects keep first-appearance order; the subject's raw assessmentName is used
 * as its stable id (so boundary scopes / exclusions key off it consistently).
 */
export function buildLiveCycleData(
  clean: readonly CleanResponse[],
  /**
   * Participant pseudonyms excluded cohort-wide (staff/test), so the build-time
   * diagnostics run on the corrected cohort. This is DATA supplied by the caller
   * (from the per-cohort `cohort_exclusions` list) — never an email/name matched
   * against a constant baked into this module. Defaults to none.
   */
  opts?: { excludedPseudonyms?: ReadonlySet<string> },
): LiveCycleData {
  const engine = getEngine();

  // Group cleaned responses by raw assessment name (first-appearance order).
  const byName = new Map<string, CleanResponse[]>();
  for (const r of clean) {
    const bucket = byName.get(r.assessmentName);
    if (bucket) bucket.push(r);
    else byName.set(r.assessmentName, [r]);
  }

  // Participants in stable, sorted pseudonym order (no PII leaves the pseudonym).
  // INVARIANT (root cause D): the participant key must be GUARANTEED-UNIQUE — one
  // pseudonym per real participant id and vice versa. A non-bijective key would
  // silently overwrite participants in the per-subject maps below (the "fewer
  // output participants than input results" signature), so we fail loudly here.
  const realIdByPseudonym = new Map<string, string>();
  const pseudonymByRealId = new Map<string, string>();
  for (const r of clean) {
    if (!realIdByPseudonym.has(r.participantPseudonym)) realIdByPseudonym.set(r.participantPseudonym, r.qmParticipantId);
    if (!pseudonymByRealId.has(r.qmParticipantId)) pseudonymByRealId.set(r.qmParticipantId, r.participantPseudonym);
    const mappedId = realIdByPseudonym.get(r.participantPseudonym);
    const mappedPseudo = pseudonymByRealId.get(r.qmParticipantId);
    if (mappedId !== r.qmParticipantId || mappedPseudo !== r.participantPseudonym) {
      throw new Error(
        `buildLiveCycleData: non-unique participant key — pseudonym "${r.participantPseudonym}" / id "${r.qmParticipantId}" collides (mapped to "${mappedId}" / "${mappedPseudo}"). Aggregation would drop or corrupt participants.`,
      );
    }
  }
  // INVARIANT (identity, root cause D): distinct input participants (internal ids)
  // must equal distinct output participants (pseudonyms). The bijection loop above
  // enforces this pairwise; assert the cardinality explicitly so any collapse fails
  // loudly in buildLiveCycleData, not silently downstream.
  const distinctInputIds = new Set(clean.map((r) => r.qmParticipantId)).size;
  if (distinctInputIds !== realIdByPseudonym.size) {
    throw new Error(
      `buildLiveCycleData: ${distinctInputIds} distinct input participant id(s) collapsed to ` +
        `${realIdByPseudonym.size} output participant(s) — participant identity collapse.`,
    );
  }
  // Cohort-excluded (staff / test) accounts, supplied by the caller as data — so
  // speededness/timing run on the identical corrected cohort as the scores path,
  // never on staff-inflated rows, and never keyed on a value hard-coded here.
  const cohortExcludedPseudonyms = opts?.excludedPseudonyms ?? new Set<string>();
  const partOrder = [...realIdByPseudonym.keys()].sort();
  const participants: SeedParticipant[] = partOrder.map((id, i) => ({
    id,
    label: `Student ${String(i + 1).padStart(2, "0")}`,
    studentId: realIdByPseudonym.get(id) ?? id,
  }));

  const assessments: SeedAssessment[] = [];
  const diagnostics: SeedAssessmentDiagnostics[] = [];
  // The per-sitting ingest roster (one entry per participant × subject), staff
  // INCLUDED — the authoritative source for ingest-stage counts (mirrors the DB
  // `sittings` table). Email is the participant's stable studentId.
  const emailByPseudonym = new Map(participants.map((p) => [p.id, p.studentId ?? p.id]));
  const sittings: SeedSitting[] = [];

  for (const [name, recs] of byName) {
    const assessmentId = name;
    for (const pseudo of new Set(recs.map((r) => r.participantPseudonym))) {
      sittings.push({ assessmentId, participantId: pseudo, participantEmail: emailByPseudonym.get(pseudo) ?? pseudo });
    }

    // Distinct items (first occurrence) with metadata, keyed by qm question id.
    const itemMetaMap = new Map<string, ItemMeta>();
    for (const r of recs) {
      if (!itemMetaMap.has(r.qmQuestionId)) {
        itemMetaMap.set(r.qmQuestionId, {
          itemId: r.qmQuestionId,
          assessmentId,
          wording: r.wording,
          majorElement: r.majorElement,
          subElement: r.subElement,
          demandLevel: r.demandLevel ?? null,
          maxScore: r.maxScore,
        });
      }
    }
    const itemMetas = [...itemMetaMap.values()];

    // Item-set (shared-stimulus) tag per item (first occurrence), kept off ItemMeta
    // (an engine type) since it's display/diagnostics-only — feeds live Assessment
    // Health recompute via `SeedItem.itemSet`.
    const itemSetMap = new Map<string, string | null>();
    for (const r of recs) {
      if (!itemSetMap.has(r.qmQuestionId)) itemSetMap.set(r.qmQuestionId, r.itemSet ?? null);
    }

    const responses: ResponseRecord[] = recs.map((r) => ({
      participantId: r.participantPseudonym,
      itemId: r.qmQuestionId,
      assessmentId,
      score: r.answerScore,
    }));

    const stats = engine.computeItemStats({ responses, items: itemMetas });
    const statById = new Map(stats.map((s) => [s.itemId, s]));

    // Per-item presented/answered/avg response time from the cleaned rows.
    interface Agg { presented: number; answered: number; timeSum: number; timeCount: number }
    const agg = new Map<string, Agg>();
    for (const r of recs) {
      let a = agg.get(r.qmQuestionId);
      if (!a) { a = { presented: 0, answered: 0, timeSum: 0, timeCount: 0 }; agg.set(r.qmQuestionId, a); }
      a.presented += 1;
      if (r.answerGiven) a.answered += 1;
      if (r.responseTime !== null && Number.isFinite(r.responseTime)) {
        a.timeSum += r.responseTime;
        a.timeCount += 1;
      }
    }

    const items: SeedItem[] = itemMetas.map((m) => {
      const s = statById.get(m.itemId)!;
      const a = agg.get(m.itemId);
      return {
        id: m.itemId,
        wording: m.wording ?? null,
        major: m.majorElement ?? null,
        sub: m.subElement ?? null,
        demand: m.demandLevel ?? null,
        itemSet: itemSetMap.get(m.itemId) ?? null,
        maxScore: m.maxScore ?? 1,
        participantsAnswered: a?.answered ?? s.n,
        participantsPresented: a?.presented ?? s.n,
        avgResponseTime: a && a.timeCount > 0 ? Math.round((a.timeSum / a.timeCount) * 10) / 10 : null,
        pValue: s.pValue,
        pRating: s.pRating,
        itemTotal: s.itemTotal,
        itRating: s.itRating,
        pointBiserial: s.pointBiserial,
        pbRating: s.pbRating,
        discrimination: s.discrimination,
        discRating: s.discRating,
        overallReview: s.overallReview,
        qualityIndex: qualityIndex(s),
      };
    });

    // Responses straight from the cleaned rows so the answered flag rides along
    // (answered unless explicitly blank) — feeds the display-only D3% metric.
    const seedResponses: SeedResponse[] = recs.map((r) => {
      const resp: SeedResponse = {
        p: r.participantPseudonym,
        i: r.qmQuestionId,
        s: r.answerScore,
        answerGiven: r.answerGiven,
        answerGivenChoiceNumber: r.answerGivenChoiceNumber,
        responseTime: r.responseTime,
      };
      // Answered iff AnswerGivenChoiceNumber is present — AnswerGiven carries QM's
      // "<Not defined>" sentinel for an unanswered item, so it is never used here.
      if (!r.answerGivenChoiceNumber) resp.a = false;
      return resp;
    });

    // Per-participant SITTING key for this subject: pseudonym → QM ResultId. One
    // sitting per participant × subject, so the cleaned export keys ResultId on the
    // real sitting rather than the participant id (first ResultId seen wins).
    const resultIdByParticipant: Record<string, string> = {};
    for (const r of recs) {
      if (r.qmResultId && resultIdByParticipant[r.participantPseudonym] === undefined) {
        resultIdByParticipant[r.participantPseudonym] = r.qmResultId;
      }
    }

    // INVARIANT (root cause D): every distinct participant in this subject's input
    // responses must survive to a distinct output participant — no silent overwrite.
    const inParticipants = new Set(recs.map((r) => r.participantPseudonym)).size;
    const outParticipants = new Set(seedResponses.map((r) => r.p)).size;
    if (inParticipants !== outParticipants) {
      throw new Error(
        `buildLiveCycleData: ${name} aggregated ${inParticipants} input participants into ${outParticipants} output participants — participant collapse.`,
      );
    }

    // Per-participant technical incidents from the sitting's result_status flag.
    const statusByP = new Map<string, string>();
    for (const r of recs) {
      if (r.resultStatus && !statusByP.has(r.participantPseudonym)) statusByP.set(r.participantPseudonym, r.resultStatus);
    }
    const technicalIncidents: SeedTechnicalIncident[] = [...statusByP.entries()]
      .filter(([, status]) => isTechnicalIncidentStatus(status))
      .map(([p, status]) => ({ p, status }));

    // Speededness & timing diagnostics over the RAW sitting (export order proxy).
    // Max Score = 0 items (instructions/stimuli) were never scored — exclude their
    // responses here too, so they don't inflate omission/completion/correlation inputs.
    const diagSourceRecs = recs.filter((r) => (r.maxScore ?? 1) >= 1);
    const itemOrder = new Map<string, number>();
    for (const r of diagSourceRecs) if (!itemOrder.has(r.qmQuestionId)) itemOrder.set(r.qmQuestionId, itemOrder.size);
    const diagRecs: DiagResponse[] = diagSourceRecs.map((r) => ({
      participantId: r.participantPseudonym,
      itemId: r.qmQuestionId,
      demandLevel: r.demandLevel,
      itemSet: r.itemSet,
      order: itemOrder.get(r.qmQuestionId)!,
      // AnswerGiven carries QM's "<Not defined>" sentinel for an unanswered item
      // (truthy), so omission/speededness/timing key off AnswerGivenChoiceNumber,
      // which is genuinely blank instead.
      answered: !!r.answerGivenChoiceNumber,
      correct: r.answerScore === 1,
      responseTime: r.responseTime,
    }));
    // Match P-B's matrix: drop staff/test accounts and dedupe (student, item)
    // keeping the last row, keyed on P-A's stable pseudonym, before computing.
    const cleanDiag = cleanDiagResponses(diagRecs, { excludedParticipantIds: cohortExcludedPseudonyms });
    diagnostics.push({ assessmentId, assessmentName: name, ...buildAssessmentDiagnostics(cleanDiag) });

    assessments.push({
      id: assessmentId,
      name,
      shortName: shortNameOf(name),
      rtl: RTL_SCRIPT.test(name) || /arabic/i.test(name),
      stageIndex: 1, // freshly ingested → next action is Clean
      items,
      responses: seedResponses,
      technicalIncidents,
      resultIdByParticipant,
    });
  }

  // Cleaned-data preview: first 5 participants × first few items of subject 1.
  const first = assessments[0];
  let preview: SeedPreview = { headers: [], rows: [] };
  if (first) {
    const previewItems = first.items.slice(0, 4).map((it) => it.id);
    const scoreLookup = new Map<string, number>();
    for (const r of first.responses) scoreLookup.set(`${r.p}:${r.i}`, r.s);
    const previewParticipants = participants.filter((p) => first.responses.some((r) => r.p === p.id)).slice(0, 5);
    preview = {
      headers: ["ID", "Q1", "Q2", "Q3", "Q4", "…"],
      rows: previewParticipants.map((p) => [
        p.label,
        ...previewItems.map((i) => {
          const v = scoreLookup.get(`${p.id}:${i}`);
          return v === undefined ? "—" : v;
        }),
        "…",
      ]),
    };
  }

  return { participants, assessments, diagnostics, preview, sittings };
}
