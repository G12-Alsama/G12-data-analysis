/**
 * Overall Score Analysis workbook — reconciled to the canonical
 * `MCQ_Overall_Score_Analysis` template (Section 9). Five sheets:
 *   1. Overall Scores Summary       — KPI blocks + per-assessment / major-element
 *                                     / demand-level summaries.
 *   2. Overall Scores by Assessment — one row per participant × assessment.
 *   3. Overall Scores by Major Element
 *   4. Overall Scores by Demand Level
 *   5. Analysis                     — per-assessment distinct counts + mean score.
 *
 * Every score uses RETAINED items only: cohort-excluded items and per-student
 * (participant, item) exclusions are both dropped upstream by `assembleScoreAnalysis`
 * (which mirrors the engine's scoring), so a participant's total and percentage
 * are computed over exactly the items that counted toward their score.
 */

import { XLSX, styleCell, roundOrNull } from "./sheet-utils";
import {
  SA_TITLE_STYLE,
  SA_SUBTITLE_STYLE,
  SA_BANNER_STYLE,
  SA_HEADER_STYLE,
  applyAlsamaTheme,
  fullWidthMerge,
  computeColWidths,
  buildRowHeights,
  applyAutoFilter,
} from "./score-analysis-theme";
import type {
  AssembleScoreAnalysisArgs,
  ScoreAnalysisInput,
  ScoredItemResponse,
} from "./types";

export const SCORE_ANALYSIS_SHEETS = [
  "Overall Scores Summary",
  "Overall Scores by Assessment",
  "Overall Scores by Major Element",
  "Overall Scores by Demand Level",
  "Analysis",
] as const;

const DEFAULT_RUN_NOTE =
  "Scores use retained items only — cohort-excluded items are dropped (the same " +
  "score run the engine uses for grading). Essay marks and alterations add to the " +
  "subject totals where applicable.";

// ── assembler ────────────────────────────────────────────────────────────────

/**
 * Build `ScoreAnalysisInput` from engine primitives, dropping both exclusion
 * kinds so only retained responses remain.
 */
export function assembleScoreAnalysis(args: AssembleScoreAnalysisArgs): ScoreAnalysisInput {
  const { assessments, participants, responses, items } = args;
  const cohortExcluded = new Set(args.excludedItemIds ?? []);
  const itemMeta = new Map(items.map((i) => [i.itemId, i]));

  const scoredResponses: ScoredItemResponse[] = [];
  for (const r of responses) {
    if (cohortExcluded.has(r.itemId)) continue;
    const meta = itemMeta.get(r.itemId);
    scoredResponses.push({
      participantId: r.participantId,
      assessmentId: r.assessmentId,
      itemId: r.itemId,
      majorElement: meta?.majorElement ?? null,
      demandLevel: meta?.demandLevel ?? null,
      score: r.score,
      maxScore: meta?.maxScore ?? 1,
    });
  }

  return {
    assessments,
    participants,
    scoredResponses,
    scoreRunNote: args.scoreRunNote ?? DEFAULT_RUN_NOTE,
  };
}

// ── aggregation helpers ──────────────────────────────────────────────────────

interface Agg {
  score: number;
  max: number;
}
function emptyAgg(): Agg {
  return { score: 0, max: 0 };
}
function add(agg: Agg, r: ScoredItemResponse): void {
  agg.score += r.score;
  agg.max += r.maxScore;
}
function pct(agg: Agg): number | null {
  return agg.max > 0 ? roundOrNull((agg.score / agg.max) * 100, 2) : null;
}

function mean(xs: number[]): number | null {
  return xs.length ? roundOrNull(xs.reduce((a, b) => a + b, 0) / xs.length, 2) : null;
}

// ── sheet builders ───────────────────────────────────────────────────────────

const BY_ASSESSMENT_HEADER = [
  "AssessmentName",
  "ParticipantID",
  "ParticipantFullName",
  "ParticipantScore",
  "AssessmentTotalScore",
  "ParticipantScorePercentage",
];
const BY_MAJOR_HEADER = [
  "AssessmentName",
  "QuestionMajorElement",
  "ParticipantID",
  "ParticipantFullName",
  "ParticipantScore",
  "MajorElementTotalScore",
  "ParticipantScorePercentage",
];
const BY_DEMAND_HEADER = [
  "AssessmentName",
  "DemandLevel",
  "ParticipantID",
  "ParticipantFullName",
  "ParticipantScore",
  "DemandLevelTotalScore",
  "ParticipantScorePercentage",
];
const ANALYSIS_HEADER = [
  "AssessmentName",
  "Distinct Count of Questions",
  "Average of AnswerScore",
  "Distinct Count of Participants",
];
const ASSESSMENT_SUMMARY_HEADER = [
  "AssessmentName",
  "AssessmentTotalScore",
  "NumberOfParticipants",
  "AverageOfParticipantScores",
  "LowestParticipantScore",
  "HighestParticipantScore",
];

function styleHeaderRow(ws: XLSX.WorkSheet, row: number, ncols: number): void {
  for (let c = 0; c < ncols; c++) styleCell(ws, row, c, SA_HEADER_STYLE);
}

function buildSummarySheet(input: ScoreAnalysisInput): XLSX.WorkSheet {
  const { assessments, participants, scoredResponses } = input;
  const nameById = new Map(assessments.map((a) => [a.id, a.name]));

  // Per-assessment: per-participant score aggregates + the assessment total.
  const perAssessment = new Map<string, Map<string, Agg>>(); // asmId -> pid -> agg
  const assessmentTotal = new Map<string, Set<string>>(); // asmId -> distinct itemIds
  const assessmentMax = new Map<string, Map<string, number>>(); // asmId -> itemId -> maxScore
  for (const r of scoredResponses) {
    let byP = perAssessment.get(r.assessmentId);
    if (!byP) perAssessment.set(r.assessmentId, (byP = new Map()));
    let agg = byP.get(r.participantId);
    if (!agg) byP.set(r.participantId, (agg = emptyAgg()));
    add(agg, r);
    let items = assessmentTotal.get(r.assessmentId);
    if (!items) assessmentTotal.set(r.assessmentId, (items = new Set()));
    items.add(r.itemId);
    let maxes = assessmentMax.get(r.assessmentId);
    if (!maxes) assessmentMax.set(r.assessmentId, (maxes = new Map()));
    if (!maxes.has(r.itemId)) maxes.set(r.itemId, r.maxScore);
  }

  // KPIs.
  const overallByP = new Map<string, Agg>();
  for (const r of scoredResponses) {
    let agg = overallByP.get(r.participantId);
    if (!agg) overallByP.set(r.participantId, (agg = emptyAgg()));
    add(agg, r);
  }
  const participantCount = overallByP.size;

  let highestAssessment = { name: "—", mean: -Infinity };
  for (const a of assessments) {
    const byP = perAssessment.get(a.id);
    if (!byP || byP.size === 0) continue;
    const m = mean([...byP.values()].map((g) => g.score)) ?? 0;
    if (m > highestAssessment.mean) highestAssessment = { name: a.name, mean: m };
  }
  let highestParticipant = { id: "—", pct: -Infinity };
  const labelById = new Map(participants.map((p) => [p.id, p.label]));
  for (const [pid, agg] of overallByP) {
    const p = pct(agg) ?? -Infinity;
    if (p > highestParticipant.pct) highestParticipant = { id: labelById.get(pid) ?? pid, pct: p };
  }

  const aoa: (string | number | null)[][] = [];
  aoa[0] = ["MCQ Overall Scores - Summary"];
  aoa[2] = [
    "This sheet contains an MCQ overall score summary for assessments, major elements, demand level, and participants.",
  ];
  aoa[4] = ["Number of Assessments", assessments.length, null, "Highest Assessment", highestAssessment.name];
  aoa[5] = ["Number of Participants", participantCount, null, "Highest Participant", highestParticipant.id];
  aoa[8] = ["MCQ score summary of all participants for each assessment"];
  aoa[9] = [...ASSESSMENT_SUMMARY_HEADER];

  const assessmentHeaderRow = 9;
  let row = 10;
  for (const a of assessments) {
    const byP = perAssessment.get(a.id);
    const scores = byP ? [...byP.values()].map((g) => g.score) : [];
    const total = [...(assessmentMax.get(a.id)?.values() ?? [])].reduce((s, m) => s + m, 0);
    aoa[row++] = [
      a.name,
      total,
      byP?.size ?? 0,
      mean(scores),
      scores.length ? Math.min(...scores) : null,
      scores.length ? Math.max(...scores) : null,
    ];
  }
  const assessmentDataEnd = row - 1;

  // Major-element summary block.
  row += 1;
  const majorBannerRow = row;
  aoa[row++] = ["MCQ score summary of all participants for each major element"];
  const majorHeaderRow = row;
  aoa[row++] = ["QuestionMajorElement", "TotalScore", "NumberOfParticipants", "AverageOfParticipantScores", "LowestParticipantScore", "HighestParticipantScore"];
  row = appendGroupSummary(aoa, row, scoredResponses, (r) => r.majorElement);
  const majorDataEnd = row - 1;

  // Demand-level summary block.
  row += 1;
  const demandBannerRow = row;
  aoa[row++] = ["MCQ score summary of all participants for each demand level"];
  const demandHeaderRow = row;
  aoa[row++] = ["DemandLevel", "TotalScore", "NumberOfParticipants", "AverageOfParticipantScores", "LowestParticipantScore", "HighestParticipantScore"];
  row = appendGroupSummary(aoa, row, scoredResponses, (r) => r.demandLevel);
  const demandDataEnd = row - 1;

  void nameById;
  const ncols = ASSESSMENT_SUMMARY_HEADER.length;
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  styleCell(ws, 0, 0, SA_TITLE_STYLE);
  styleCell(ws, 2, 0, SA_SUBTITLE_STYLE);
  styleCell(ws, majorBannerRow, 0, SA_BANNER_STYLE);
  styleCell(ws, demandBannerRow, 0, SA_BANNER_STYLE);
  styleCell(ws, assessmentHeaderRow - 1, 0, SA_BANNER_STYLE); // "...for each assessment" banner
  styleHeaderRow(ws, assessmentHeaderRow, ncols);
  styleHeaderRow(ws, majorHeaderRow, ncols);
  styleHeaderRow(ws, demandHeaderRow, ncols);

  ws["!merges"] = [
    fullWidthMerge(0, ncols),
    fullWidthMerge(2, ncols),
    fullWidthMerge(assessmentHeaderRow - 1, ncols),
    fullWidthMerge(majorBannerRow, ncols),
    fullWidthMerge(demandBannerRow, ncols),
  ];
  ws["!rows"] = buildRowHeights({
    0: 24,
    [assessmentHeaderRow - 1]: 20,
    [majorBannerRow]: 20,
    [demandBannerRow]: 20,
  });

  // Only the Assessment Summary block gets AutoFilter — Excel supports one
  // AutoFilter region per worksheet, and this is the sheet's primary table
  // (see score-analysis-theme.ts for why we can't give every block a Table).
  applyAutoFilter(ws, assessmentHeaderRow, assessmentDataEnd, ncols);

  ws["!cols"] = computeColWidths(ASSESSMENT_SUMMARY_HEADER, [
    ...aoa.slice(10, assessmentDataEnd + 1),
    ...aoa.slice(majorHeaderRow + 1, majorDataEnd + 1),
    ...aoa.slice(demandHeaderRow + 1, demandDataEnd + 1),
  ] as (string | number | null)[][]);
  return ws;
}

/** Append a group summary block (TotalScore / participants / avg / lo / hi). */
function appendGroupSummary(
  aoa: (string | number | null)[][],
  startRow: number,
  scored: ScoredItemResponse[],
  keyOf: (r: ScoredItemResponse) => string | null,
): number {
  const byKey = new Map<string, { perP: Map<string, Agg>; items: Map<string, number> }>();
  const order: string[] = [];
  for (const r of scored) {
    const k = keyOf(r);
    if (k == null) continue;
    let g = byKey.get(k);
    if (!g) {
      byKey.set(k, (g = { perP: new Map(), items: new Map() }));
      order.push(k);
    }
    let agg = g.perP.get(r.participantId);
    if (!agg) g.perP.set(r.participantId, (agg = emptyAgg()));
    add(agg, r);
    if (!g.items.has(r.itemId)) g.items.set(r.itemId, r.maxScore);
  }
  order.sort();
  let row = startRow;
  for (const k of order) {
    const g = byKey.get(k)!;
    const scores = [...g.perP.values()].map((a) => a.score);
    const total = [...g.items.values()].reduce((s, m) => s + m, 0);
    aoa[row++] = [
      k,
      total,
      g.perP.size,
      mean(scores),
      scores.length ? Math.min(...scores) : null,
      scores.length ? Math.max(...scores) : null,
    ];
  }
  return row;
}

interface BreakdownSpec {
  title: string;
  description: string;
  note: string;
  header: string[];
  keyOf: (r: ScoredItemResponse) => string | null;
}

/** Generic per-participant breakdown sheet (assessment / major / demand). */
function buildBreakdownSheet(input: ScoreAnalysisInput, spec: BreakdownSpec): XLSX.WorkSheet {
  const { assessments, participants, scoredResponses } = input;
  const nameById = new Map(assessments.map((a) => [a.id, a.name]));
  const labelById = new Map(participants.map((p) => [p.id, p.label]));
  const asmOrder = new Map(assessments.map((a, i) => [a.id, i]));
  const pOrder = new Map(participants.map((p, i) => [p.id, i]));

  // group by assessment + breakdown key + participant
  const groups = new Map<string, Agg>(); // `${asm}␟${key}␟${pid}`
  for (const r of scoredResponses) {
    const k = spec.keyOf(r);
    if (k == null) continue;
    const gk = `${r.assessmentId}␟${k}␟${r.participantId}`;
    let agg = groups.get(gk);
    if (!agg) groups.set(gk, (agg = emptyAgg()));
    add(agg, r);
  }

  const rows = [...groups.entries()].map(([gk, agg]) => {
    const [asmId, key, pid] = gk.split("␟") as [string, string, string];
    return { asmId, key, pid, agg };
  });
  rows.sort(
    (a, b) =>
      (asmOrder.get(a.asmId)! - asmOrder.get(b.asmId)!) ||
      a.key.localeCompare(b.key) ||
      (pOrder.get(a.pid)! - pOrder.get(b.pid)!),
  );

  const hasBreakdownKey = spec.header.length === 7; // major/demand sheets carry the key column
  const aoa: (string | number | null)[][] = [];
  aoa[0] = [spec.title];
  aoa[2] = [spec.description];
  aoa[3] = [spec.note];
  aoa[5] = [...spec.header];
  let r = 6;
  for (const row of rows) {
    const base: (string | number | null)[] = [nameById.get(row.asmId) ?? row.asmId];
    if (hasBreakdownKey) base.push(row.key);
    base.push(row.pid, labelById.get(row.pid) ?? row.pid, row.agg.score, row.agg.max, pct(row.agg));
    aoa[r++] = base;
  }

  const ncols = spec.header.length;
  const lastDataRow = r - 1;
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  styleCell(ws, 0, 0, SA_TITLE_STYLE);
  styleCell(ws, 2, 0, SA_SUBTITLE_STYLE);
  styleCell(ws, 3, 0, SA_SUBTITLE_STYLE);
  styleHeaderRow(ws, 5, ncols);

  ws["!merges"] = [fullWidthMerge(0, ncols), fullWidthMerge(2, ncols), fullWidthMerge(3, ncols)];
  ws["!rows"] = buildRowHeights({ 0: 24 });
  applyAutoFilter(ws, 5, lastDataRow, ncols);
  ws["!cols"] = computeColWidths(spec.header, aoa.slice(6, lastDataRow + 1) as (string | number | null)[][]);
  return ws;
}

function buildAnalysisSheet(input: ScoreAnalysisInput): XLSX.WorkSheet {
  const { assessments, scoredResponses } = input;
  const stats = new Map<string, { items: Set<string>; participants: Set<string>; scoreSum: number; n: number }>();
  for (const r of scoredResponses) {
    let s = stats.get(r.assessmentId);
    if (!s) stats.set(r.assessmentId, (s = { items: new Set(), participants: new Set(), scoreSum: 0, n: 0 }));
    s.items.add(r.itemId);
    s.participants.add(r.participantId);
    s.scoreSum += r.score;
    s.n += 1;
  }
  const aoa: (string | number | null)[][] = [];
  aoa[0] = ["MCQ Overall Scores - Analysis"];
  aoa[2] = [...ANALYSIS_HEADER];
  let row = 3;
  for (const a of assessments) {
    const s = stats.get(a.id);
    aoa[row++] = [
      a.name,
      s?.items.size ?? 0,
      s && s.n > 0 ? roundOrNull(s.scoreSum / s.n, 3) : null,
      s?.participants.size ?? 0,
    ];
  }
  const ncols = ANALYSIS_HEADER.length;
  const lastDataRow = row - 1;
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  styleCell(ws, 0, 0, SA_TITLE_STYLE);
  styleHeaderRow(ws, 2, ncols);

  ws["!merges"] = [fullWidthMerge(0, ncols)];
  ws["!rows"] = buildRowHeights({ 0: 24 });
  applyAutoFilter(ws, 2, lastDataRow, ncols);
  ws["!cols"] = computeColWidths(ANALYSIS_HEADER, aoa.slice(3, lastDataRow + 1) as (string | number | null)[][]);
  return ws;
}

export function buildScoreAnalysisWorkbook(input: ScoreAnalysisInput): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  applyAlsamaTheme(wb);
  XLSX.utils.book_append_sheet(wb, buildSummarySheet(input), SCORE_ANALYSIS_SHEETS[0]);
  XLSX.utils.book_append_sheet(
    wb,
    buildBreakdownSheet(input, {
      title: "MCQ Overall Scores - Assessment Level",
      description: "This sheet contains the MCQ overall score for all students per assessments.",
      note: "Note: use the column filter dropdowns (AutoFilter) to filter by students or assessments.",
      header: BY_ASSESSMENT_HEADER,
      keyOf: () => "all",
    }),
    SCORE_ANALYSIS_SHEETS[1],
  );
  XLSX.utils.book_append_sheet(
    wb,
    buildBreakdownSheet(input, {
      title: "MCQ Overall Scores - Major Element Level",
      description: "This sheet contains the MCQ overall score for all students per major element.",
      note: "Note: use the column filter dropdowns (AutoFilter) to filter by students, assessments or major elements.",
      header: BY_MAJOR_HEADER,
      keyOf: (r) => r.majorElement,
    }),
    SCORE_ANALYSIS_SHEETS[2],
  );
  XLSX.utils.book_append_sheet(
    wb,
    buildBreakdownSheet(input, {
      title: "MCQ Overall Scores - Demand Level",
      description: "This sheet contains the MCQ overall score for all students per demand level.",
      note: "Note: use the column filter dropdowns (AutoFilter) to filter by students, assessments or demand level.",
      header: BY_DEMAND_HEADER,
      keyOf: (r) => r.demandLevel,
    }),
    SCORE_ANALYSIS_SHEETS[3],
  );
  XLSX.utils.book_append_sheet(wb, buildAnalysisSheet(input), SCORE_ANALYSIS_SHEETS[4]);
  return wb;
}
