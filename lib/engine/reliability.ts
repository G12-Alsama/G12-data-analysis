/**
 * Cronbach's Alpha (internal-consistency reliability) — an ADDITIVE engine
 * output. It is computed from the same item × student score matrix the engine
 * already uses for point-biserials, and does NOT touch any existing statistic or
 * score (p-values, item-total/point-biserial correlations, discrimination). The
 * parity gate (tests/engine.parity.test.ts) is therefore unaffected.
 *
 * ## Formula — general form (handles MCQ and essays)
 *   α = (k / (k − 1)) · (1 − (Σ σ²ᵢ) / σ²ₜ)
 * where k = items in the group, σ²ᵢ = variance of item i's scores across
 * students, σ²ₜ = variance of the total (summed) score across students. Using
 * item SCORE variances (not a binary-only shortcut) makes this correct for
 * polytomous essay items as well as 0/1 MCQs; for dichotomous items it reduces to
 * KR-20 exactly.
 *
 * ## Small-cohort honesty
 *   - k < 2 → α is undefined (returned as null with a note); never a number.
 *   - k and n (the complete-case participant count) are reported alongside every
 *     α so callers can judge how much to trust it.
 *   - `lowItems` (k < 5) and `smallSample` (n < 30) flag fragile estimates.
 *   - Negative α is returned as-is — it is a real signal, never clamped to zero.
 *
 * Items entering a grouping are whatever responses the caller passes in (already
 * filtered to the usable, post-exclusion set). Items that lack a given tag simply
 * don't enter that grouping (e.g. essays with no demand tag skip demand-level α).
 */

import type { ItemMeta, ResponseRecord } from "./types";
import { round } from "./stats";

/** Below this item count an α estimate is flagged as fragile. */
export const LOW_ITEMS_THRESHOLD = 5;
/** Below this participant count an α estimate is flagged as small-sample. */
export const SMALL_SAMPLE_THRESHOLD = 30;

export type ReliabilityLevel =
  | "overall"
  | "subject"
  | "majorElement"
  | "subElement"
  | "demandLevel"
  | "context";

export interface ReliabilityGroup {
  level: ReliabilityLevel;
  /** Subject (assessment) this group belongs to; null for the overall-exam group. */
  assessmentId: string | null;
  /** Unique key within the level. */
  key: string;
  /** Display label (tag value; assessmentId for the subject level). */
  label: string;
  /** Number of items in the group (k). */
  k: number;
  /** Complete-case participant count used for α (n). */
  n: number;
  /** Cronbach's α, or null when undefined (k < 2, n < 2, or no total variance). */
  alpha: number | null;
  /** Why α is null, when it is; otherwise null. */
  note: string | null;
  /** True when k is small (< LOW_ITEMS_THRESHOLD) — α is fragile. */
  lowItems: boolean;
  /** True when n is small (< SMALL_SAMPLE_THRESHOLD) — α is unstable. */
  smallSample: boolean;
  /** Every participant who attempted at least one item in the group (not just the complete-case n used for α). */
  totalParticipants: number;
  /** Raw item-response rows feeding the group (one per participant × item they answered). */
  itemResponses: number;
  /** Predicted α if the group's item count were doubled with similar-quality items: SB = 2α / (1 + α). */
  spearmanBrown: number | null;
  /** Test-length multiplier needed to reach α = 0.80 by the Spearman-Brown prophecy formula. */
  sbMultiplier80: number | null;
  /** Test-length multiplier needed to reach α = 0.90 by the Spearman-Brown prophecy formula. */
  sbMultiplier90: number | null;
  /** Average pairwise Pearson correlation across the group's items, over the same complete-case matrix used for α. */
  avgInterItemCorrelation: number | null;
  /** Interpretation band for α (Excellent/Good/Acceptable/Questionable/Flag / Low/Not Available). */
  status: ReliabilityStatus;
  /** Plain-language reading of `status`. */
  interpretation: string;
}

export type ReliabilityStatus = "Excellent" | "Good" | "Acceptable" | "Questionable" | "Flag / Low" | "Not Available";

/** Predicted α if the test length were doubled with similarly-good items: SB = 2α / (1 + α). */
export function spearmanBrown(alpha: number | null): number | null {
  if (alpha === null) return null;
  const denom = 1 + alpha;
  return denom > 0 ? (2 * alpha) / denom : null;
}

/**
 * Spearman-Brown prophecy solved for the test-length multiplier N needed to raise
 * the current α to `target`: N = target·(1−α) / (α·(1−target)). Undefined (null)
 * when α is null or ≤ 0, or already at/above the target — there is no finite
 * multiplier that solves the equation in that case.
 */
export function sbMultiplier(alpha: number | null, target: number): number | null {
  if (alpha === null || alpha <= 0 || alpha >= target) return null;
  const n = (target * (1 - alpha)) / (alpha * (1 - target));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** George & Mallery-style α interpretation bands. */
export function reliabilityStatus(alpha: number | null): ReliabilityStatus {
  if (alpha === null) return "Not Available";
  if (alpha >= 0.9) return "Excellent";
  if (alpha >= 0.8) return "Good";
  if (alpha >= 0.7) return "Acceptable";
  if (alpha >= 0.6) return "Questionable";
  return "Flag / Low";
}

/** Plain-language reading of a `reliabilityStatus` band. */
export function reliabilityInterpretation(alpha: number | null, status: ReliabilityStatus): string {
  switch (status) {
    case "Not Available":
      return "Alpha could not be computed for this group — see note.";
    case "Excellent":
      return "Excellent internal consistency; items measure the construct very reliably.";
    case "Good":
      return "Good internal consistency; items measure the construct reliably.";
    case "Acceptable":
      return "Acceptable consistency; adequate for most uses.";
    case "Questionable":
      return "Limited consistency; interpret cautiously and review item alignment.";
    case "Flag / Low":
      return alpha !== null && alpha < 0
        ? "Negative/near-zero reliability suggests weak common measurement, limited score variation, or misaligned items."
        : "Weak consistency; review item quality, dimensionality, and sample size.";
  }
}

/** Average pairwise Pearson correlation across the columns of a complete-case item matrix. Null when fewer than 2 items or 2 rows. */
export function averageInterItemCorrelation(matrix: readonly (readonly number[])[]): number | null {
  const n = matrix.length;
  const k = n > 0 ? matrix[0]!.length : 0;
  if (k < 2 || n < 2) return null;
  const columns: number[][] = Array.from({ length: k }, (_, j) => matrix.map((row) => row[j]!));
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const r = pearsonCorrelation(columns[i]!, columns[j]!);
      if (r !== null) {
        sum += r;
        pairs += 1;
      }
    }
  }
  return pairs > 0 ? sum / pairs : null;
}

/** Pearson product-moment correlation; null when either side has zero variance. */
function pearsonCorrelation(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n < 2 || y.length !== n) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i]!, yi = y[i]!;
    sx += xi; sy += yi; sxx += xi * xi; syy += yi * yi; sxy += xi * yi;
  }
  const denom = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  return denom === 0 ? null : (n * sxy - sx * sy) / denom;
}

export interface ReliabilityResult {
  engineVersion: string;
  groups: ReliabilityGroup[];
}

export interface ReliabilityInput {
  responses: ResponseRecord[];
  items?: ItemMeta[];
}

/** Population variance of a sample (divisor cancels in α's ratio). */
function variance(xs: readonly number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  let mean = 0;
  for (const x of xs) mean += x;
  mean /= n;
  let s = 0;
  for (const x of xs) s += (x - mean) ** 2;
  return s / n;
}

/**
 * Cronbach's α over a complete-case student × item matrix (rows = students that
 * answered every item in the group, cols = items). Returns the coefficient with
 * the item count and participant count, plus a note when α is undefined.
 */
export function cronbachAlpha(matrix: readonly (readonly number[])[]): {
  alpha: number | null;
  k: number;
  n: number;
  note: string | null;
} {
  const n = matrix.length;
  const k = n > 0 ? matrix[0]!.length : 0;

  if (k < 2) return { alpha: null, k, n, note: "n/a — too few items (need at least 2)" };
  if (n < 2) return { alpha: null, k, n, note: "n/a — too few participants (need at least 2)" };

  // Per-item score columns + per-student totals.
  const columns: number[][] = Array.from({ length: k }, () => []);
  const totals: number[] = [];
  for (const row of matrix) {
    let t = 0;
    for (let j = 0; j < k; j++) {
      const v = row[j] ?? 0;
      columns[j]!.push(v);
      t += v;
    }
    totals.push(t);
  }

  const totalVar = variance(totals);
  if (totalVar === 0) return { alpha: null, k, n, note: "n/a — no score variance" };

  const itemVarSum = columns.reduce((acc, col) => acc + variance(col), 0);
  const alpha = (k / (k - 1)) * (1 - itemVarSum / totalVar);
  // Do NOT clamp negatives — a negative α is a real signal worth surfacing.
  return { alpha: round(alpha, 3), k, n, note: null };
}

interface GroupSpec {
  level: ReliabilityLevel;
  assessmentId: string | null;
  key: string;
  label: string;
  itemIds: string[];
}

/**
 * Compute Cronbach's α at every grouping driven by the items' construct tags:
 * overall exam, per subject, per major element, per demand level, and per
 * context (only where a context tag exists). Groups are built from whatever tags
 * are present — nothing about element/demand/context counts is hard-coded.
 * (Sub-element α was dropped: at this cohort size it is essentially noise and is
 * not actionable.)
 */
export function computeReliability(
  responses: readonly ResponseRecord[],
  engineVersion: string,
  items?: readonly ItemMeta[],
): ReliabilityResult {
  const meta = new Map<string, ItemMeta>();
  if (items) for (const it of items) meta.set(it.itemId, it);

  // Response lookup: participant → (item → score). Last write wins (responses are
  // already de-duplicated upstream).
  const byParticipant = new Map<string, Map<string, number>>();
  // Item registry in first-seen order, with the assessment it belongs to.
  const itemOrder: string[] = [];
  const itemAssessment = new Map<string, string>();
  for (const r of responses) {
    let row = byParticipant.get(r.participantId);
    if (!row) {
      row = new Map();
      byParticipant.set(r.participantId, row);
    }
    row.set(r.itemId, r.score);
    if (!itemAssessment.has(r.itemId)) {
      itemAssessment.set(r.itemId, r.assessmentId);
      itemOrder.push(r.itemId);
    }
  }

  const tagOf = (itemId: string) => meta.get(itemId);

  // Accumulate item ids per group key, preserving item order.
  const specs = new Map<string, GroupSpec>();
  const push = (level: ReliabilityLevel, assessmentId: string | null, key: string, label: string, itemId: string) => {
    let g = specs.get(key);
    if (!g) {
      g = { level, assessmentId, key, label, itemIds: [] };
      specs.set(key, g);
    }
    g.itemIds.push(itemId);
  };

  for (const itemId of itemOrder) {
    const assessmentId = itemAssessment.get(itemId)!;
    const m = tagOf(itemId);

    // overall exam
    push("overall", null, "overall", "Overall exam", itemId);
    // per subject
    push("subject", assessmentId, `subject|${assessmentId}`, assessmentId, itemId);
    // per major element (within subject). Sub-element α was removed as
    // non-actionable noise: at this cohort size α over a handful of sub-element
    // items is essentially meaningless, and nothing is done per sub-element.
    if (m?.majorElement) {
      push("majorElement", assessmentId, `major|${assessmentId}|${m.majorElement}`, m.majorElement, itemId);
    }
    // per demand level (within subject), and — the same computation applied
    // to the cross-subject pool of every item sharing that tag (assessmentId
    // null, mirroring how "overall" already spans every subject) — needed by
    // the reliability report's assessment-agnostic By_Demand_Level view.
    if (m?.demandLevel) {
      push("demandLevel", assessmentId, `demand|${assessmentId}|${m.demandLevel}`, m.demandLevel, itemId);
      push("demandLevel", null, `demandAll|${m.demandLevel}`, m.demandLevel, itemId);
    }
    // per context (within subject) — only where a context tag exists
    if (m?.context) {
      push("context", assessmentId, `context|${assessmentId}|${m.context}`, m.context, itemId);
    }
  }

  // Raw response-row count per item, for the group-level "item responses" total
  // (every attempt, not just complete-case rows).
  const responseCountByItem = new Map<string, number>();
  for (const r of responses) {
    responseCountByItem.set(r.itemId, (responseCountByItem.get(r.itemId) ?? 0) + 1);
  }

  const groups: ReliabilityGroup[] = [];
  for (const spec of specs.values()) {
    // Complete-case students: answered EVERY item in this group.
    const matrix: number[][] = [];
    let totalParticipants = 0;
    for (const row of byParticipant.values()) {
      if (spec.itemIds.some((it) => row.has(it))) totalParticipants += 1;
      if (spec.itemIds.every((it) => row.has(it))) {
        matrix.push(spec.itemIds.map((it) => row.get(it)!));
      }
    }
    const itemResponses = spec.itemIds.reduce((acc, it) => acc + (responseCountByItem.get(it) ?? 0), 0);
    const { alpha, k, n, note } = cronbachAlpha(matrix);
    const status = reliabilityStatus(alpha);
    groups.push({
      level: spec.level,
      assessmentId: spec.assessmentId,
      key: spec.key,
      label: spec.label,
      k,
      n,
      alpha,
      note,
      lowItems: k < LOW_ITEMS_THRESHOLD,
      smallSample: n < SMALL_SAMPLE_THRESHOLD,
      totalParticipants,
      itemResponses,
      spearmanBrown: spearmanBrown(alpha),
      sbMultiplier80: sbMultiplier(alpha, 0.8),
      sbMultiplier90: sbMultiplier(alpha, 0.9),
      avgInterItemCorrelation: averageInterItemCorrelation(matrix),
      status,
      interpretation: reliabilityInterpretation(alpha, status),
    });
  }

  return { engineVersion, groups };
}
