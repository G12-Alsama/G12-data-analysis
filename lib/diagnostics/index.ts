/**
 * Speededness & timing diagnostics — informational, computed from the raw QM
 * export (response-time + answer columns), exactly as the team's Python notebooks
 * do. These never affect grading; they flag whether an assessment was speeded
 * (students running out of time) and whether time-on-task relates to score.
 *
 * Definitions (matched to the notebooks):
 *  - Omission rate   = omitted presentations ÷ total (omitted = blank answer).
 *  - Completion      = 1 − omission.
 *  - Late items      = final 25% of unique items by earliest presented order,
 *                      ceil(0.25 × n_items), min 1; early items = the rest.
 *  - Speededness Index = ( max(0, lateOmission − earlyOmission)
 *                          + max(0, earlyAccuracy − lateAccuracy) ) ÷ 2,
 *                      where accuracy = correct ÷ answered (among attempts).
 *  - Timing–performance: aggregate to student level (score %, median item time),
 *                      then Pearson + Spearman between median item time and
 *                      score %. Also split by demand level for the Analytics tab.
 *
 * Keying: callers first pass raw records through `cleanDiagResponses` so every
 * measure runs on the SAME corrected matrix P-B uses for item stats — keyed on
 * P-A's stable internal participant id, with cohort-excluded (staff/test) accounts
 * dropped and `(participant, item)` deduped keeping the last row. That is why the
 * per-assessment student count matches the corrected matrix (15 for Applicable
 * Math), not a collapsed or staff-inflated count.
 */

export interface DiagResponse {
  participantId: string;
  itemId: string;
  /** Demand level (D1/D2/D3) of the item, or null when untagged. */
  demandLevel: string | null;
  /** Item-set / shared-stimulus name of the item, or null when ungrouped. */
  itemSet: string | null;
  /** Presentation order (lower = earlier). */
  order: number;
  /** Whether a (non-blank) answer was given. */
  answered: boolean;
  /** Whether the answer was correct (score === 1). */
  correct: boolean;
  /** Response time in seconds; null when missing. */
  responseTime: number | null;
}

export type DiagStatus = "Good" | "Review" | "Flag";

export interface SpeededResult {
  nItems: number;
  nPresentations: number;
  omissionRate: number;
  completion: number;
  speedednessIndex: number;
  earlyOmission: number;
  lateOmission: number;
  earlyAccuracy: number;
  lateAccuracy: number;
  omissionStatus: DiagStatus;
  completionStatus: DiagStatus;
  speededStatus: DiagStatus;
}

export interface TimingResult {
  nStudents: number;
  pearson: number | null;
  spearman: number | null;
  pearsonStrength: string;
  spearmanStrength: string;
}

const rnd = (v: number, d = 4) => {
  const f = 10 ** d;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
};

/** Pearson product-moment correlation; null when either side has zero variance. */
export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n < 2 || y.length !== n) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i]!, yi = y[i]!;
    sx += xi; sy += yi; sxx += xi * xi; syy += yi * yi; sxy += xi * yi;
  }
  const denom = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  if (denom === 0) return null;
  return (n * sxy - sx * sy) / denom;
}

/** Fractional ranks (ties get the average rank), for Spearman. */
function rank(values: readonly number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank
    for (let k = i; k <= j; k++) ranks[idx[k]!.i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation = Pearson on ranks. */
export function spearman(x: readonly number[], y: readonly number[]): number | null {
  if (x.length !== y.length || x.length < 2) return null;
  return pearson(rank(x), rank(y));
}

export function correlationStrength(r: number | null): string {
  if (r === null) return "Undefined";
  const a = Math.abs(r);
  const dir = r < 0 ? "negative" : "positive";
  if (a < 0.1) return "Negligible";
  if (a < 0.3) return `Weak ${dir}`;
  if (a < 0.5) return `Moderate ${dir}`;
  if (a < 0.7) return `Strong ${dir}`;
  return `Very strong ${dir}`;
}

const band = (v: number, good: (x: number) => boolean, review: (x: number) => boolean): DiagStatus =>
  good(v) ? "Good" : review(v) ? "Review" : "Flag";

/** The late-item set: the final 25% of unique items by earliest presented order. */
export function lateItemIds(records: readonly DiagResponse[]): Set<string> {
  const earliest = new Map<string, number>();
  for (const r of records) {
    const cur = earliest.get(r.itemId);
    if (cur === undefined || r.order < cur) earliest.set(r.itemId, r.order);
  }
  const ordered = [...earliest.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const nLate = Math.max(1, Math.ceil(0.25 * ordered.length));
  return new Set(ordered.slice(ordered.length - nLate));
}

/** Speededness / omission / completion over one group of responses. */
export function speededness(records: readonly DiagResponse[]): SpeededResult {
  const items = new Set(records.map((r) => r.itemId));
  const late = lateItemIds(records);
  const nPres = records.length;
  const omitted = records.filter((r) => !r.answered).length;
  const omissionRate = nPres ? omitted / nPres : 0;

  const omissionOf = (set: (r: DiagResponse) => boolean) => {
    const sub = records.filter(set);
    return sub.length ? sub.filter((r) => !r.answered).length / sub.length : 0;
  };
  const accuracyOf = (set: (r: DiagResponse) => boolean) => {
    const answered = records.filter((r) => set(r) && r.answered);
    return answered.length ? answered.filter((r) => r.correct).length / answered.length : 0;
  };

  const isLate = (r: DiagResponse) => late.has(r.itemId);
  const earlyOmission = omissionOf((r) => !isLate(r));
  const lateOmission = omissionOf(isLate);
  const earlyAccuracy = accuracyOf((r) => !isLate(r));
  const lateAccuracy = accuracyOf(isLate);

  const speedednessIndex = (Math.max(0, lateOmission - earlyOmission) + Math.max(0, earlyAccuracy - lateAccuracy)) / 2;

  return {
    nItems: items.size,
    nPresentations: nPres,
    omissionRate: rnd(omissionRate),
    completion: rnd(1 - omissionRate),
    speedednessIndex: rnd(speedednessIndex),
    earlyOmission: rnd(earlyOmission),
    lateOmission: rnd(lateOmission),
    earlyAccuracy: rnd(earlyAccuracy),
    lateAccuracy: rnd(lateAccuracy),
    omissionStatus: band(omissionRate, (v) => v <= 0.05, (v) => v <= 0.1),
    completionStatus: band(1 - omissionRate, (v) => v >= 0.95, (v) => v >= 0.9),
    speededStatus: band(speedednessIndex, (v) => v <= 0.05, (v) => v <= 0.15),
  };
}

/** Median of a numeric array. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Clean a raw diagnostics record set into the matrix P-B builds for item stats,
 * so speededness/timing key on exactly the same cohort as the scores:
 *   1. drop cohort-excluded participants (staff / test accounts), keyed on P-A's
 *      stable internal participant id — never a per-ingest UUID or a name field;
 *   2. dedupe `(participantId, itemId)` keeping the LAST row (a re-sit or a
 *      corrected row supersedes the earlier one), the same rule the score matrix
 *      applies before `fillna(0.0)`.
 * The result is one record per (participant, item) over the corrected, un-collapsed
 * cohort — so the per-assessment student count matches the corrected matrix (e.g.
 * 15 for Applicable Math, not a collapsed or staff-inflated count).
 */
export function cleanDiagResponses(
  records: readonly DiagResponse[],
  opts: { excludedParticipantIds?: ReadonlySet<string> } = {},
): DiagResponse[] {
  const excluded = opts.excludedParticipantIds;
  const byCell = new Map<string, DiagResponse>();
  for (const r of records) {
    if (excluded?.has(r.participantId)) continue;
    // Overwrite keeps the LAST occurrence for a (participant, item) cell.
    byCell.set(`${r.participantId} ${r.itemId}`, r);
  }
  return [...byCell.values()];
}

// TEMP-DEBUG (maxScore-leak investigation — REMOVE AFTER): a caller (currently
// only in-memory-provider.ts's getDiagnostics()) sets this to a label right
// before invoking buildAssessmentDiagnostics()/timingPerformance() for the one
// assessment under investigation, so timingPerformance() below knows whether to
// emit [TEMP-DEBUG] log lines. Purely a logging gate — never read by any
// computation, so it cannot change a computed value. Set via
// __setTempDebugTimingLabel() (a plain module-level `let` can't be assigned
// from another module's live-binding import).
let __TEMP_DEBUG_TIMING_LABEL: string | null = null;
export function __setTempDebugTimingLabel(label: string | null): void {
  __TEMP_DEBUG_TIMING_LABEL = label;
}

/** Timing–performance correlation over one group of responses. */
export function timingPerformance(records: readonly DiagResponse[]): TimingResult {
  // TEMP-DEBUG (maxScore-leak investigation — REMOVE AFTER)
  const __tempDebugLabel = __TEMP_DEBUG_TIMING_LABEL;
  const __TEMP_DEBUG_ZERO_ITEM_ID = "29cebc7b-adea-4fa7-b99a-e163dceef141";
  if (__tempDebugLabel) {
    const zeroItemLeaked = records.some((r) => r.itemId === __TEMP_DEBUG_ZERO_ITEM_ID && r.responseTime !== null);
    console.log(
      `[TEMP-DEBUG] timingPerformance(${__tempDebugLabel}): records.length=${records.length}; ` +
        `item ${__TEMP_DEBUG_ZERO_ITEM_ID} responseTime present in input=${zeroItemLeaked}`,
    );
  }
  // Aggregate to student level: score % (correct ÷ presented) and median item time.
  // Every presented (scored) item contributes its responseTime to the median,
  // answered or not — QM logs dwell time on a question even when the student
  // leaves it blank, and that time is valid timing signal (ground-truth
  // methodology: "Median Response Time per Item = median of each student's
  // AnswerResponseTimeSeconds inside the analysis unit", no answered-only
  // filter). Only a genuinely missing/non-finite responseTime is excluded below
  // — that's real data absence, distinct from "left blank but still timed".
  // (`answered` still drives omission/completion in speededness(), untouched.)
  const byStudent = new Map<string, { correct: number; presented: number; times: number[] }>();
  for (const r of records) {
    let s = byStudent.get(r.participantId);
    if (!s) { s = { correct: 0, presented: 0, times: [] }; byStudent.set(r.participantId, s); }
    s.presented += 1;
    if (r.correct) s.correct += 1;
    if (r.responseTime !== null && Number.isFinite(r.responseTime)) s.times.push(r.responseTime);
  }
  if (__tempDebugLabel) {
    console.log(`[TEMP-DEBUG] timingPerformance(${__tempDebugLabel}): total students discovered=${byStudent.size}`);
  }
  const scorePct: number[] = [];
  const medTime: number[] = [];
  for (const [participantId, s] of byStudent) {
    if (s.presented === 0 || s.times.length === 0) continue;
    const pct = (s.correct / s.presented) * 100;
    const mt = median(s.times);
    if (__tempDebugLabel) {
      console.log(
        `[TEMP-DEBUG] timingPerformance(${__tempDebugLabel}): participantId=${participantId} ` +
          `timesCount=${s.times.length} medTime=${mt} scorePct=${pct}`,
      );
    }
    scorePct.push(pct);
    medTime.push(mt);
  }
  const p = pearson(medTime, scorePct);
  const sp = spearman(medTime, scorePct);
  if (__tempDebugLabel) {
    const pairs = medTime.map((mt, i) => [mt, scorePct[i]]);
    console.log(`[TEMP-DEBUG] timingPerformance(${__tempDebugLabel}): (medTime, scorePct) pairs=${JSON.stringify(pairs)}`);
    console.log(`[TEMP-DEBUG] timingPerformance(${__tempDebugLabel}): nStudents=${scorePct.length} pearson=${p} spearman=${sp}`);
  }
  return {
    nStudents: scorePct.length,
    pearson: p === null ? null : rnd(p),
    spearman: sp === null ? null : rnd(sp),
    pearsonStrength: correlationStrength(p),
    spearmanStrength: correlationStrength(sp),
  };
}

/** Group records by a key, preserving first-seen order. */
export function groupBy<T>(rows: readonly T[], key: (r: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null || k === "") continue;
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

// --- Actionable lenses: by demand level + omission by item position ----------

/** Fixed display order for demand levels (D1 easiest → D3 top-difficulty). */
const DEMAND_ORDER = ["D1", "D2", "D3"] as const;

/** Speededness/omission for one demand level (D1/D2/D3). */
export interface DemandSpeeded {
  demand: string;
  speeded: SpeededResult;
}

/**
 * Speededness/omission/completion split by demand level. Replaces the old
 * per-element breakdown: difficulty is the actionable axis (high omission on
 * the hardest items flags time pressure on those items). Only levels that
 * actually carry items appear, in fixed D1→D3 order.
 */
export function speededByDemand(records: readonly DiagResponse[]): DemandSpeeded[] {
  const groups = groupBy(records, (r) => r.demandLevel);
  return DEMAND_ORDER.filter((d) => groups.has(d)).map((d) => ({ demand: d, speeded: speededness(groups.get(d)!) }));
}

/** Timing–performance for one demand level (D1/D2/D3). */
export interface DemandTiming {
  demand: string;
  timing: TimingResult;
}

/**
 * Timing–performance split by demand level. The whole-assessment measure lives on
 * the Assessment Health step; this is the per-difficulty-tier lens for the
 * Analytics tab. Uses the identical `timingPerformance` formula per group (median
 * item time ↔ score %, Pearson + Spearman), restricted to that tier's items. Only
 * levels that actually carry items appear, in fixed D1→D3 order.
 */
export function timingByDemand(records: readonly DiagResponse[]): DemandTiming[] {
  const groups = groupBy(records, (r) => r.demandLevel);
  return DEMAND_ORDER.filter((d) => groups.has(d)).map((d) => ({ demand: d, timing: timingPerformance(groups.get(d)!) }));
}

/** Speededness/omission for one item set (a shared stimulus/passage). */
export interface ItemSetSpeeded {
  itemSet: string;
  speeded: SpeededResult;
}

/**
 * Speededness/omission/completion split by item set (shared stimulus/passage).
 * A passage with high omission/speededness is too long or hard to work through
 * in the time given — actionable: shorten or simplify the stimulus. Item sets are
 * listed alphabetically; ungrouped (null) items are ignored.
 */
export function speededByItemSet(records: readonly DiagResponse[]): ItemSetSpeeded[] {
  const groups = groupBy(records, (r) => r.itemSet);
  return [...groups.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((set) => ({ itemSet: set, speeded: speededness(groups.get(set)!) }));
}

/** Omission rate for the item at one presentation position. */
export interface PositionOmission {
  /** 1-based item position by earliest presented order. */
  position: number;
  /** Internal item id (for keys only — not for display). */
  itemId: string;
  /** Demand level of this item, or null when untagged. */
  demandLevel: string | null;
  /** Total presentations of this item across students. */
  nPresentations: number;
  /** Presentations left blank. */
  omitted: number;
  /** omitted ÷ presentations. */
  omissionRate: number;
}

/**
 * Omission rate by item position across the assessment. Each position is one
 * unique item (ordered by earliest presented order), carrying its demand level
 * so the series can be read by difficulty. A rising tail = students running out
 * of time at the end (actionable: shorten the paper or move hard items earlier).
 */
export function omissionByPosition(records: readonly DiagResponse[]): PositionOmission[] {
  const earliest = new Map<string, number>();
  const demand = new Map<string, string | null>();
  const tally = new Map<string, { n: number; omitted: number }>();
  for (const r of records) {
    const cur = earliest.get(r.itemId);
    if (cur === undefined || r.order < cur) earliest.set(r.itemId, r.order);
    if (!demand.has(r.itemId)) demand.set(r.itemId, r.demandLevel);
    let t = tally.get(r.itemId);
    if (!t) { t = { n: 0, omitted: 0 }; tally.set(r.itemId, t); }
    t.n += 1;
    if (!r.answered) t.omitted += 1;
  }
  const ordered = [...earliest.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  return ordered.map((id, i) => {
    const t = tally.get(id)!;
    return {
      position: i + 1,
      itemId: id,
      demandLevel: demand.get(id) ?? null,
      nPresentations: t.n,
      omitted: t.omitted,
      omissionRate: rnd(t.n ? t.omitted / t.n : 0),
    };
  });
}

/** Whole-assessment speededness + timing, the single non-broken-down measures. */
export interface WholeDiagnostics {
  speeded: SpeededResult;
  timing: TimingResult;
}

/**
 * The full actionable diagnostics for one assessment: a single whole-assessment
 * speededness + timing measure, a demand-level speededness lens, and omission
 * rate by item position. Shared by all three build paths (seed script, in-memory
 * build, Supabase hydrate) so they stay identical.
 */
export interface AssessmentDiagnostics {
  whole: WholeDiagnostics;
  byDemand: DemandSpeeded[];
  byItemSet: ItemSetSpeeded[];
  timingByDemand: DemandTiming[];
  omissionByPosition: PositionOmission[];
}

export function buildAssessmentDiagnostics(records: readonly DiagResponse[]): AssessmentDiagnostics {
  return {
    whole: { speeded: speededness(records), timing: timingPerformance(records) },
    byDemand: speededByDemand(records),
    byItemSet: speededByItemSet(records),
    timingByDemand: timingByDemand(records),
    omissionByPosition: omissionByPosition(records),
  };
}
