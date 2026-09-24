/**
 * Build the in-memory provider's seed by running the REAL ingest + engine over
 * data/sample_qm_export.xlsx. Output: lib/data/seed.generated.json.
 *
 * Run with:  npx tsx scripts/build-seed.mts
 *
 * This keeps the browser from parsing the 1.3 MB xlsx and ships genuine computed
 * numbers (item stats, scores, distributions) to the client. Re-run whenever the
 * sample data or the engine changes; commit the result.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseExport, ingestAndClean } from "../lib/ingest/index";
import { stripHtml } from "../lib/ingest/normalize";
import type { CleanResponse } from "../lib/ingest/types";
import { getEngine, ENGINE_VERSION } from "../lib/engine/index";
import type { ItemMeta, QualityRating, ResponseRecord } from "../lib/engine";
import type {
  Seed,
  SeedAnswerOption,
  SeedAssessment,
  SeedAssessmentDiagnostics,
  SeedItem,
  SeedResponse,
  SeedTechnicalIncident,
} from "../lib/data/seed-types";
import { buildAssessmentDiagnostics, type DiagResponse } from "../lib/diagnostics";
import { isTechnicalIncidentStatus } from "../lib/data/result-status";

const engine = getEngine();

// Map the raw Questionmark assessment names to clean display names + order.
interface NameInfo {
  name: string;
  shortName: string;
  rtl: boolean;
  order: number;
}
function classify(rawName: string): NameInfo | null {
  if (/[؀-ۿ]/.test(rawName))
    return { name: "Arabic as a 1st Language", shortName: "Arabic 1st Lang", rtl: true, order: 3 };
  if (/Applicable Math/i.test(rawName))
    return { name: "Applicable Math", shortName: "Applicable Math", rtl: false, order: 0 };
  if (/English/i.test(rawName))
    return { name: "English as a 2nd Language", shortName: "English 2nd Lang", rtl: false, order: 1 };
  if (/Scientific/i.test(rawName))
    return { name: "Scientific Thinking", shortName: "Scientific", rtl: false, order: 2 };
  if (/Life Success/i.test(rawName))
    return { name: "Life Success Skills", shortName: "Life Skills", rtl: false, order: 4 };
  return null;
}

const RATING_SCORE: Record<QualityRating, number> = { Good: 1, Review: 0.55, Flag: 0.12 };
/** Transparent 0–100 quality index: mean of the four per-stat rating scores. */
function qualityIndex(stat: {
  pRating: QualityRating;
  itRating: QualityRating;
  pbRating: QualityRating;
  discRating: QualityRating;
}): number {
  const avg =
    (RATING_SCORE[stat.pRating] +
      RATING_SCORE[stat.itRating] +
      RATING_SCORE[stat.pbRating] +
      RATING_SCORE[stat.discRating]) /
    4;
  return Math.round(avg * 100);
}

/**
 * Parse the QM `QuestionPossibleAnswers` / `QuestionCorrectAnswers` fields into
 * clean answer options. Possible answers arrive as `"1==Foo||2==Bar||3==Baz"`;
 * the correct field is the option text (occasionally several, `||`-joined).
 * Returns null when there are no real options (e.g. essays carry
 * "1==<Not applicable>", which stripHtml reduces to nothing).
 */
function parseAnswerOptions(possibleRaw: unknown, correctRaw: unknown): SeedAnswerOption[] | null {
  const possible = typeof possibleRaw === "string" ? possibleRaw : "";
  if (!possible.trim()) return null;
  const correctSet = new Set(
    (typeof correctRaw === "string" ? correctRaw : "")
      .split("||")
      .map((c) => stripHtml(c))
      .filter((c): c is string => !!c)
      .map((c) => c.toLowerCase()),
  );
  const options: SeedAnswerOption[] = [];
  for (const part of possible.split("||")) {
    const eq = part.indexOf("==");
    const text = stripHtml(eq >= 0 ? part.slice(eq + 2) : part);
    if (!text) continue; // drops "<Not applicable>" and other empty/markup-only entries
    options.push({
      label: String.fromCharCode(65 + options.length), // A, B, C…
      text,
      correct: correctSet.has(text.toLowerCase()),
    });
  }
  return options.length >= 2 ? options : null;
}

function main() {
  const file = readFileSync("data/sample_qm_export.xlsx");
  const { rows } = parseExport(file);
  const { cleanedResponses, validationReport } = ingestAndClean(rows);

  // Answer options per question id (first occurrence), straight from the raw
  // export. Item metadata only — never feeds the engine, so parity is untouched.
  const optionsByQid = new Map<string, SeedAnswerOption[]>();
  for (const row of rows) {
    const qid = String(row["QuestionId"] ?? "").trim();
    if (!qid || optionsByQid.has(qid)) continue;
    const options = parseAnswerOptions(row["QuestionPossibleAnswers"], row["QuestionCorrectAnswers"]);
    if (options) optionsByQid.set(qid, options);
  }

  // Group cleaned responses by raw assessment name.
  const byRaw = new Map<string, CleanResponse[]>();
  for (const r of cleanedResponses) {
    const bucket = byRaw.get(r.assessmentName) ?? [];
    bucket.push(r);
    byRaw.set(r.assessmentName, bucket);
  }

  // Stable participant ids → friendly labels (no PII; pseudonyms only).
  const participantOrder: string[] = [];
  for (const r of cleanedResponses) {
    if (!participantOrder.includes(r.participantPseudonym)) participantOrder.push(r.participantPseudonym);
  }
  participantOrder.sort();
  const participants = participantOrder.map((id, i) => ({
    id,
    label: `Student ${String(i + 1).padStart(2, "0")}`,
    // Demo data is de-identified — the pseudonym IS the Student ID here.
    studentId: id,
  }));

  const assessments: SeedAssessment[] = [];
  const diagnosticsRaw: (SeedAssessmentDiagnostics & { _order: number })[] = [];

  for (const [rawName, recs] of byRaw) {
    const info = classify(rawName);
    if (!info) continue;
    const assessmentId = info.name;

    // Speededness & timing diagnostics over the RAW sitting (all responses).
    // Presentation order = first appearance of each item in the export rows.
    // CONFIRM: there is no explicit presented-order column; export order is the
    // proxy. correct = full mark (dichotomous items). Max Score = 0 items
    // (instructions/stimuli) were never scored — exclude their responses here too,
    // so they don't inflate omission/completion/correlation inputs (mirrors
    // buildLiveCycleData's diagSourceRecs filter).
    const diagSourceRecs = recs.filter((r) => (r.maxScore ?? 1) >= 1);
    const itemOrder = new Map<string, number>();
    for (const r of diagSourceRecs) if (!itemOrder.has(r.qmQuestionId)) itemOrder.set(r.qmQuestionId, itemOrder.size);
    const diagRecs: DiagResponse[] = diagSourceRecs.map((r) => ({
      participantId: r.participantPseudonym,
      itemId: r.qmQuestionId,
      demandLevel: r.demandLevel,
      itemSet: r.itemSet,
      majorElement: r.majorElement,
      order: itemOrder.get(r.qmQuestionId)!,
      // AnswerGiven carries QM's "<Not defined>" sentinel for an unanswered item
      // (truthy), so omission/speededness/timing key off AnswerGivenChoiceNumber,
      // which is genuinely blank instead.
      answered: !!r.answerGivenChoiceNumber,
      correct: r.answerScore === 1,
      responseTime: r.responseTime,
    }));
    diagnosticsRaw.push({ assessmentId, assessmentName: info.name, ...buildAssessmentDiagnostics(diagRecs), _order: info.order });

    // Distinct items (first occurrence) with metadata.
    const itemMetaMap = new Map<string, ItemMeta>();
    // Display-only content per item (QuestionDescription + parent/stimulus
    // wording), captured from the first cleaned row for the item. Never feeds the
    // engine — item metadata only, so parity is untouched.
    const contentByQid = new Map<string, { description: string | null; parentWording: string | null }>();
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
        contentByQid.set(r.qmQuestionId, { description: r.description, parentWording: r.parentWording });
      }
    }
    const itemMetas = [...itemMetaMap.values()];

    // Item-set (shared-stimulus) tag per item (first occurrence), kept off ItemMeta
    // (an engine type) since it's display/diagnostics-only.
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
        description: contentByQid.get(m.itemId)?.description ?? null,
        parentWording: contentByQid.get(m.itemId)?.parentWording ?? null,
        major: m.majorElement ?? null,
        sub: m.subElement ?? null,
        demand: m.demandLevel ?? null,
        itemSet: itemSetMap.get(m.itemId) ?? null,
        maxScore: m.maxScore ?? 1,
        options: optionsByQid.get(m.itemId) ?? null,
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

    // Build responses straight from the cleaned rows so the answered flag rides
    // along (answered unless explicitly blank) — feeds the display-only D3% metric.
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

    // Per-participant SITTING key for this subject: pseudonym → QM ResultId (one
    // sitting per participant × subject). Keys the cleaned export's ResultId.
    const resultIdByParticipant: Record<string, string> = {};
    for (const r of recs) {
      if (r.qmResultId && resultIdByParticipant[r.participantPseudonym] === undefined) {
        resultIdByParticipant[r.participantPseudonym] = r.qmResultId;
      }
    }

    // Per-participant technical incidents from the sitting's result_status flag
    // (one status per participant-assessment). Display-only; no scoring impact.
    const statusByP = new Map<string, string>();
    for (const r of recs) {
      if (r.resultStatus && !statusByP.has(r.participantPseudonym)) statusByP.set(r.participantPseudonym, r.resultStatus);
    }
    const technicalIncidents: SeedTechnicalIncident[] = [...statusByP.entries()]
      .filter(([, status]) => isTechnicalIncidentStatus(status))
      .map(([p, status]) => ({ p, status }));

    assessments.push({
      id: assessmentId,
      name: info.name,
      shortName: info.shortName,
      rtl: info.rtl,
      stageIndex: 3, // Question review (Upload → Clean → Raw scores done)
      items,
      responses: seedResponses,
      technicalIncidents,
      resultIdByParticipant,
      // carry order for sorting below
      ...( { _order: info.order } as object ),
    } as SeedAssessment & { _order: number });
  }

  assessments.sort(
    (a, b) => (a as unknown as { _order: number })._order - (b as unknown as { _order: number })._order,
  );
  for (const a of assessments) delete (a as unknown as { _order?: number })._order;

  diagnosticsRaw.sort((a, b) => a._order - b._order);
  const diagnostics: SeedAssessmentDiagnostics[] = diagnosticsRaw.map(({ _order, ...d }) => {
    void _order;
    return d;
  });

  // Cleaned-data preview: first 5 participants × first few items of assessment 1.
  const first = assessments[0]!;
  const previewItems = first.items.slice(0, 4).map((it) => it.id);
  const scoreLookup = new Map<string, number>();
  for (const r of first.responses) scoreLookup.set(`${r.p}:${r.i}`, r.s);
  const previewParticipants = participants
    .filter((p) => first.responses.some((r) => r.p === p.id))
    .slice(0, 5);
  const preview = {
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

  const seed: Seed = {
    generatedAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    liveCycle: {
      id: "may-2026",
      name: "May 2026",
      region: "eu-west",
      startedAt: "2026-05-14",
      lastActivity: "2h ago",
      stageIndex: 3, // Question review
      // The demo sitting was ingested via the 3-CSV upload; the assessments
      // export is the representative source name (matching the live path).
      fileName: "qm_assessments_may26.csv",
      fileSizeMB: 1.3,
      uploadedAgo: "2h ago",
      validation: validationReport,
      preview,
      duplicates: validationReport.checks.find((c) => c.id === "duplicates")?.count ?? 0,
      participants,
      assessments,
      diagnostics,
    },
    priorCycles: [
      { id: "jan-2026", name: "February 2026", stageIndex: 9, stepsDone: 10, participants: 4503, assessments: 5, lastActivity: "12 Feb 2026", locked: true, mock: true },
      { id: "nov-2025", name: "February 2025", stageIndex: 9, stepsDone: 10, participants: 4390, assessments: 4, lastActivity: "03 Dec 2025", locked: true, mock: true },
      { id: "may-2025", name: "May 2025", stageIndex: 9, stepsDone: 10, participants: 4201, assessments: 4, lastActivity: "11 Jun 2025", locked: true, mock: true },
    ],
  };

  writeFileSync("lib/data/seed.generated.json", JSON.stringify(seed));
  const totalItems = assessments.reduce((n, a) => n + a.items.length, 0);
  console.log(
    `Seed written: ${assessments.length} assessments, ${totalItems} items, ` +
      `${participants.length} participants, validation passed=${validationReport.passed}`,
  );
}

main();
