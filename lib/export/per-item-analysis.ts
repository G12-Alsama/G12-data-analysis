/**
 * Per-item Speededness / Omission / Completion analysis — pure data shaping for
 * the 4th Assessment Health workbook (lib/export/per-item-report.ts).
 *
 * This is a NEW, self-contained computation. It reads the same INPUTS the existing
 * diagnostics start from (see `InMemoryDataProvider.getPerItemSource`) and applies
 * the same selection rules, but it neither calls nor changes lib/diagnostics/**:
 *   - the same participant drop-set (Clean-stage removals + cohort exclusions);
 *   - the same Max Score >= 1 item filter (unscored stimulus items never count);
 *   - the same de-duplication — one record per (participant, item), LAST row wins;
 *   - the same "omitted" definition — AnswerGivenChoiceNumber blank (`answered:false`);
 *   - the same QuestionPresentedNumber source — QM's real per-sitting value, with
 *     the item-array position used ONLY to ORDER an item that has none (never shown).
 *
 * Definitions (from the README sheet of the reference workbook):
 *   Item Accuracy       = mean AnswerScore for the item.
 *   Omission Rate       = omitted responses / total responses; Completion = 1 − Omission.
 *   Late-Item           = within each assessment, items ordered by MEDIAN
 *                         QuestionPresentedNumber; the final ceil(25% × unique items)
 *                         are "Late (final 25%)", the rest "Early / Middle".
 *   Speededness Index   = for EVERY item: average of
 *                         max(0, itemOmission − earlyOmission) and
 *                         max(0, earlyAccuracy − itemAccuracy),
 *                         where the baseline is the assessment's Early / Middle items,
 *                         POOLED over their responses (reproduces the reference
 *                         workbook's stored indices exactly).
 * Values are kept at full precision (the reference stores unrounded floats); every
 * status is derived from the SAME stored value the workbook's conditional-formatting
 * rules read, so a cell's label and its colour can never disagree.
 *
 * Labels and Notes text come from the spec JSON (never retyped). A value that
 * genuinely can't be computed is `null` (an EMPTY cell) — never placeholder text.
 */
import type { PerItemSource, PerItemSourceAssessment } from "@/lib/data/per-item-source";
import spec from "@/reference/assessment_health_reports/per_item_export_spec.json";
import { median } from "./sheet-utils";

// --- thresholds (identical to the diagnostics bands and the CF rules in the spec) ---

/** Speededness Index: <= GOOD Good, <= REVIEW Review, otherwise Flag. */
export const SPEEDEDNESS_THRESHOLDS = { good: 0.05, review: 0.15 } as const;
/** Omission Rate: <= GOOD Good, <= REVIEW Review, otherwise Flag. */
export const OMISSION_THRESHOLDS = { good: 0.05, review: 0.1 } as const;
/** Completion Rate: >= GOOD Good, >= REVIEW Review, otherwise Flag. */
export const COMPLETION_THRESHOLDS = { good: 0.95, review: 0.9 } as const;
/** Fraction of an assessment's unique items (rounded up) classed as Late. */
export const LATE_FRACTION = 0.25;

export type Tier = "Good" | "Review" | "Flag";
const TIERS: readonly Tier[] = ["Good", "Review", "Flag"];

const LABELS = spec.item_sheet.status_labels;
const SECTIONS = spec.item_sheet.test_section_labels;
const NOTES = spec.item_sheet.notes_templates;

export const TEST_SECTION_EARLY = SECTIONS[0]!;
export const TEST_SECTION_LATE = SECTIONS[1]!;

export function speedednessTier(v: number): Tier {
  return v <= SPEEDEDNESS_THRESHOLDS.good ? "Good" : v <= SPEEDEDNESS_THRESHOLDS.review ? "Review" : "Flag";
}
export function omissionTier(v: number): Tier {
  return v <= OMISSION_THRESHOLDS.good ? "Good" : v <= OMISSION_THRESHOLDS.review ? "Review" : "Flag";
}
export function completionTier(v: number): Tier {
  return v >= COMPLETION_THRESHOLDS.good ? "Good" : v >= COMPLETION_THRESHOLDS.review ? "Review" : "Flag";
}

export const speedednessLabel = (t: Tier): string => LABELS.speededness[TIERS.indexOf(t)]!;
export const omissionLabel = (t: Tier): string => LABELS.omission[TIERS.indexOf(t)]!;
export const completionLabel = (t: Tier): string => LABELS.completion[TIERS.indexOf(t)]!;

/** The Notes text — fully determined by (Test Section, Speededness tier). */
export function noteFor(section: string, tier: Tier): string {
  return NOTES[section === TEST_SECTION_LATE ? "late" : "early_middle"][tier];
}

// --- output model ---

export interface PerItemRow {
  assessmentName: string;
  /** Real QM QuestionId — a number when it is a safe integer (so it can format as `0`). */
  questionId: number | string;
  description: string | null;
  wording: string | null;
  majorElement: string | null;
  subElement: string | null;
  demandLevel: string | null;
  /** Median QuestionPresentedNumber across the item's responses; null when none was captured. */
  presentedNumber: number | null;
  testSection: string;
  participants: number;
  responses: number;
  medianResponseTime: number | null;
  accuracy: number;
  /** null only when the assessment has no Early / Middle items to baseline against. */
  speedednessIndex: number | null;
  speedednessStatus: string | null;
  omissionRate: number;
  completionRate: number;
  omissionStatus: string;
  completionStatus: string;
  notes: string | null;
}

export interface PerItemAssessment {
  assessmentId: string;
  assessmentName: string;
  rows: PerItemRow[];
}

export interface PerItemAnalysis {
  sourceFileName: string | null;
  /** Only assessments with at least one scored item that has responses. */
  assessments: PerItemAssessment[];
  /** Data-quality notes the caller should surface (never written into a cell). */
  warnings: string[];
}

// --- shaping ---

interface Rec {
  participantId: string;
  itemId: string;
  score: number;
  answered: boolean;
  presentedNumber: number | null;
  responseTime: number | null;
}

function questionIdValue(raw: string): number | string {
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : raw;
}

/** One record per (participant, item) over the corrected cohort — LAST row wins. */
function cleanRecords(a: PerItemSourceAssessment, scored: ReadonlySet<string>): Rec[] {
  const excluded = new Set(a.excludedParticipantIds);
  const byCell = new Map<string, Rec>();
  for (const r of a.responses) {
    if (excluded.has(r.participantId) || !scored.has(r.itemId)) continue;
    byCell.set(`${r.participantId} ${r.itemId}`, r);
  }
  return [...byCell.values()];
}

function analyseAssessment(a: PerItemSourceAssessment, warnings: string[]): PerItemAssessment | null {
  // Max Score >= 1 only; position among scored items is the order proxy of last resort.
  const scoredItems = a.items.filter((it) => (it.maxScore ?? 1) >= 1);
  const fallbackOrder = new Map(scoredItems.map((it, i) => [it.id, i]));
  const recs = cleanRecords(a, new Set(scoredItems.map((it) => it.id)));

  const byItem = new Map<string, Rec[]>();
  for (const r of recs) {
    const list = byItem.get(r.itemId);
    if (list) list.push(r);
    else byItem.set(r.itemId, [r]);
  }

  const items = scoredItems.filter((it) => byItem.has(it.id));
  if (items.length === 0) return null;

  type Stat = {
    item: (typeof items)[number];
    recs: Rec[];
    presented: number | null;
    order: number;
    omitted: number;
    scoreSum: number;
  };
  const stats: Stat[] = items.map((item) => {
    const rs = byItem.get(item.id)!;
    const presented = median(rs.map((r) => r.presentedNumber));
    return {
      item,
      recs: rs,
      presented,
      order: presented ?? fallbackOrder.get(item.id)!,
      omitted: rs.filter((r) => !r.answered).length,
      scoreSum: rs.reduce((s, r) => s + r.score, 0),
    };
  });

  const missingPresented = stats.filter((s) => s.presented === null).length;
  if (missingPresented > 0) {
    warnings.push(
      `${a.assessmentName}: ${missingPresented} of ${stats.length} item(s) have no QuestionPresentedNumber ` +
        `(sitting ingested before it was captured) — ordered by stored item position and shown with an empty ` +
        `QuestionPresentedNumber; re-ingest the sitting for the real order.`,
    );
  }

  // Stable sort: median QuestionPresentedNumber ascending, ties by stored item position.
  stats.sort((x, y) => x.order - y.order || fallbackOrder.get(x.item.id)! - fallbackOrder.get(y.item.id)!);

  const nLate = Math.ceil(LATE_FRACTION * stats.length);
  const firstLate = stats.length - nLate;

  // Assessment early-item baseline — Early / Middle items, pooled over their responses.
  const early = stats.slice(0, firstLate);
  const earlyN = early.reduce((s, x) => s + x.recs.length, 0);
  const baseline =
    earlyN > 0
      ? {
          omission: early.reduce((s, x) => s + x.omitted, 0) / earlyN,
          accuracy: early.reduce((s, x) => s + x.scoreSum, 0) / earlyN,
        }
      : null;
  if (!baseline) {
    warnings.push(`${a.assessmentName}: no Early / Middle items to baseline against — Speededness Index left empty.`);
  }

  const rows: PerItemRow[] = stats.map((s, i) => {
    const n = s.recs.length;
    const omissionRate = s.omitted / n;
    const completionRate = 1 - omissionRate;
    const accuracy = s.scoreSum / n;
    const testSection = i >= firstLate ? TEST_SECTION_LATE : TEST_SECTION_EARLY;
    const speedednessIndex = baseline
      ? (Math.max(0, omissionRate - baseline.omission) + Math.max(0, baseline.accuracy - accuracy)) / 2
      : null;
    const tier = speedednessIndex === null ? null : speedednessTier(speedednessIndex);
    return {
      assessmentName: a.assessmentName,
      questionId: questionIdValue(s.item.qmQuestionId ?? s.item.id),
      description: s.item.description,
      wording: s.item.wording,
      majorElement: s.item.major,
      subElement: s.item.sub,
      demandLevel: s.item.demand,
      presentedNumber: s.presented,
      testSection,
      participants: new Set(s.recs.map((r) => r.participantId)).size,
      responses: n,
      medianResponseTime: median(s.recs.map((r) => r.responseTime)),
      accuracy,
      speedednessIndex,
      speedednessStatus: tier === null ? null : speedednessLabel(tier),
      omissionRate,
      completionRate,
      omissionStatus: omissionLabel(omissionTier(omissionRate)),
      completionStatus: completionLabel(completionTier(completionRate)),
      notes: tier === null ? null : noteFor(testSection, tier),
    };
  });

  return { assessmentId: a.assessmentId, assessmentName: a.assessmentName, rows };
}

/**
 * Shape a cycle's per-item source into one row set per assessment, in the app's
 * existing assessment order (assessments with no scored, answered items are
 * omitted — a table needs at least one data row).
 */
export function buildPerItemAnalysis(source: PerItemSource): PerItemAnalysis {
  const warnings: string[] = [];
  const assessments: PerItemAssessment[] = [];
  for (const a of source.assessments) {
    const out = analyseAssessment(a, warnings);
    if (out) assessments.push(out);
  }
  return { sourceFileName: source.sourceFileName, assessments, warnings };
}
