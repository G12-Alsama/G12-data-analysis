/**
 * The sitting PERIODS of an exam year — THE single place that knows which exist, in what
 * order, and how they read.
 *
 * Adding a period is exactly two edits:
 *   1. one entry in `PERIOD_DEFS` below, and
 *   2. one migration that adds the value to the DB enum `sitting_period`
 *      (template: `supabase/templates/add-sitting-period.template.sql`).
 * Nothing else in app code names a period: pages, the rollup, ingest and the provider all
 * read this module. `tests/periods.registry.test.ts` fails if the registry and the enum
 * declared by the migrations ever disagree.
 *
 * Order matters: `order` is oldest → newest within a year. It is what "the LATEST sitting
 * wins a tie" means in the Overall rollup (period order, never `sitting_date`).
 *
 * Years that already exist keep expecting the periods flagged `expectedByDefault`
 * (February + May today) — a new registry entry does NOT silently make every old year "not
 * ready" because it lacks the new sitting. A year opts in via `exam_years.expected_periods`.
 */

export interface PeriodDef {
  /** Stored value — must equal a value of the DB enum `sitting_period`. */
  readonly key: string;
  /** Display label, e.g. "February". */
  readonly label: string;
  /** Short tag for dense UI / documents, e.g. "Feb". */
  readonly shortLabel: string;
  /** Nominal calendar month (1–12) the sitting is held in; display / default date only. */
  readonly month: number;
  /** Position within a year, oldest first. Unique. */
  readonly order: number;
  /**
   * The calendar months (1–12) a QM export dated in them is attributed to this period.
   * Across the registry every month is covered by exactly one period.
   */
  readonly covers: readonly number[];
  /**
   * Whether a year that has not been configured expects this period (see header). Keep
   * it `false` for a new period unless every existing year should start expecting it.
   */
  readonly expectedByDefault: boolean;
}

/** The registry data. February + May are the only periods that exist today. */
export const PERIOD_DEFS = [
  { key: "february", label: "February", shortLabel: "Feb", month: 2, order: 1, covers: [1, 2, 3, 4], expectedByDefault: true },
  { key: "may", label: "May", shortLabel: "May", month: 5, order: 2, covers: [5, 6, 7, 8, 9, 10, 11, 12], expectedByDefault: true },
] as const satisfies readonly PeriodDef[];

/** Which sitting of a year. Derived from the registry — never spelled out elsewhere. */
export type SittingKey = (typeof PERIOD_DEFS)[number]["key"];

/** Why a set of period definitions is unusable, or null when it is sound. */
export function validatePeriodDefs(defs: readonly PeriodDef[]): string | null {
  if (defs.length === 0) return "no periods defined";
  const keys = new Set<string>();
  const orders = new Set<number>();
  const monthOwner = new Map<number, string>();
  for (const d of defs) {
    if (!/^[a-z][a-z0-9_]*$/.test(d.key)) return `period key "${d.key}" must be lowercase snake_case`;
    if (keys.has(d.key)) return `duplicate period key "${d.key}"`;
    keys.add(d.key);
    if (orders.has(d.order)) return `duplicate period order ${d.order}`;
    orders.add(d.order);
    if (!Number.isInteger(d.month) || d.month < 1 || d.month > 12) return `period "${d.key}": month must be 1–12`;
    for (const m of d.covers) {
      if (!Number.isInteger(m) || m < 1 || m > 12) return `period "${d.key}": covers month ${m} out of range`;
      const owner = monthOwner.get(m);
      if (owner) return `month ${m} is covered by both "${owner}" and "${d.key}"`;
      monthOwner.set(m, d.key);
    }
  }
  for (let m = 1; m <= 12; m++) if (!monthOwner.has(m)) return `month ${m} is covered by no period`;
  return null;
}

/**
 * Build the registry's accessors over a list of definitions. The module's own exports are
 * built over `PERIOD_DEFS`; the factory exists so a test can run the same code over a
 * registry with another period and prove nothing else needed to change.
 */
export function createPeriodRegistry(defs: readonly PeriodDef[]) {
  const problem = validatePeriodDefs(defs);
  if (problem) throw new Error(`Invalid period registry: ${problem}`);
  const sorted = [...defs].sort((a, b) => a.order - b.order);
  const byKey = new Map(sorted.map((d) => [d.key, d] as const));
  const monthToKey = new Map<number, string>();
  for (const d of sorted) for (const m of d.covers) monthToKey.set(m, d.key);

  const SITTING_ORDER = sorted.map((d) => d.key) as unknown as readonly SittingKey[];
  const def = (period: string): PeriodDef => {
    const d = byKey.get(period);
    if (!d) throw new Error(`Unknown sitting period "${period}"`);
    return d;
  };
  return {
    /** Period definitions, oldest → newest. */
    PERIODS: sorted as readonly PeriodDef[],
    SITTING_PERIODS: SITTING_ORDER,
    /** Periods oldest → newest within a year. */
    SITTING_ORDER,
    /** The periods an EXISTING year expects (see header). */
    DEFAULT_EXPECTED_PERIODS: sorted.filter((d) => d.expectedByDefault).map((d) => d.key) as unknown as readonly SittingKey[],
    /** The period the "new sitting" form pre-selects: the latest of the default-expected ones. */
    DEFAULT_NEW_PERIOD: (sorted.filter((d) => d.expectedByDefault).pop() ?? sorted[sorted.length - 1]!).key as SittingKey,
    /** Is this a known period key? */
    isSittingKey: (v: unknown): v is SittingKey => typeof v === "string" && byKey.has(v),
    /** 0 = oldest period of the year; −1 for an unknown key. */
    periodRank: (period: string): number => SITTING_ORDER.indexOf(period as SittingKey),
    /** Display label, e.g. "February". */
    periodLabel: (period: string): string => def(period).label,
    /** Short label, e.g. "Feb". */
    periodShortLabel: (period: string): string => def(period).shortLabel,
    /** Nominal month (1–12). */
    periodMonth: (period: string): number => def(period).month,
    /** The period a calendar month (1–12) belongs to. */
    periodOfMonth: (month: number): SittingKey => {
      const k = monthToKey.get(month);
      if (!k) throw new Error(`No sitting period covers month ${month}`);
      return k as SittingKey;
    },
    /** "February", "February and May", "February, May and August". */
    joinPeriodLabels: (periods: readonly string[]): string => {
      const labels = periods.map((p) => def(p).label);
      return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
    },
    /** A value per period, built without naming the periods. */
    perPeriod: <T>(make: (period: SittingKey) => T): Record<SittingKey, T> =>
      Object.fromEntries(SITTING_ORDER.map((p) => [p, make(p)])) as Record<SittingKey, T>,
    /** Sort period keys oldest → newest (unknown keys last), without mutating the input. */
    sortPeriods: <K extends string>(keys: readonly K[]): K[] =>
      [...keys].sort((a, b) => {
        const ra = SITTING_ORDER.indexOf(a as unknown as SittingKey);
        const rb = SITTING_ORDER.indexOf(b as unknown as SittingKey);
        return (ra < 0 ? Infinity : ra) - (rb < 0 ? Infinity : rb);
      }),
  };
}

const MONTH_NAME_TOKENS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/** The first calendar month (1–12) named in free text by its three-letter prefix, or null. */
export function monthOfText(text: string): number | null {
  const m = text.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  return m ? MONTH_NAME_TOKENS.indexOf(m[1] as (typeof MONTH_NAME_TOKENS)[number]) + 1 : null;
}

const REGISTRY = createPeriodRegistry(PERIOD_DEFS);

export const PERIODS = REGISTRY.PERIODS;
export const SITTING_PERIODS = REGISTRY.SITTING_PERIODS;
export const SITTING_ORDER = REGISTRY.SITTING_ORDER;
export const DEFAULT_EXPECTED_PERIODS = REGISTRY.DEFAULT_EXPECTED_PERIODS;
export const DEFAULT_NEW_PERIOD = REGISTRY.DEFAULT_NEW_PERIOD;
export const isSittingKey = REGISTRY.isSittingKey;
export const periodRank = REGISTRY.periodRank;
export const periodLabel = REGISTRY.periodLabel;
export const periodShortLabel = REGISTRY.periodShortLabel;
export const periodMonth = REGISTRY.periodMonth;
export const periodOfMonth = REGISTRY.periodOfMonth;
export const joinPeriodLabels = REGISTRY.joinPeriodLabels;
export const perPeriod = REGISTRY.perPeriod;
export const sortPeriods = REGISTRY.sortPeriods;
