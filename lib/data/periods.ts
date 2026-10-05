/**
 * The sitting PERIODS of an exam year — the single place that knows which exist, in
 * what order, and how they read.
 *
 * Only February and May exist today. Phase 2 generalises periods, so everything that
 * needs "all periods", "the order of periods" or "a period's label" goes through here
 * instead of spelling the two literals out again: adding a period then means changing
 * this list (plus the DB enum), not hunting for `"february" | "may"`.
 *
 * Order matters: it is oldest → newest within a year, which is what "latest sitting
 * wins ties" in the Overall rollup means.
 */
export const SITTING_PERIODS = ["february", "may"] as const;

export type SittingKey = (typeof SITTING_PERIODS)[number];

/** Periods oldest → newest within a year. */
export const SITTING_ORDER: readonly SittingKey[] = SITTING_PERIODS;

/** 0 = oldest period of the year. */
export function periodRank(period: SittingKey): number {
  return SITTING_ORDER.indexOf(period);
}

/** Display label, e.g. "February". */
export function periodLabel(period: SittingKey): string {
  return period.charAt(0).toUpperCase() + period.slice(1);
}

/** An index per period → value, built without naming the periods. */
export function perPeriod<T>(make: (period: SittingKey) => T): Record<SittingKey, T> {
  return Object.fromEntries(SITTING_ORDER.map((p) => [p, make(p)])) as Record<SittingKey, T>;
}
