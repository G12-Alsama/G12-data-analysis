/**
 * Pure helpers for creating a sitting (exam_cycle) — kept free of provider/Supabase
 * imports so the RPC contract is unit-testable.
 *
 * A sitting's PERIOD (february | may) and its YEAR are explicit choices made in the
 * create form and persisted through `create_cycle_with_assessments(p_sitting,
 * p_year_id, …)`. They are never inferred from the sitting's display name: the name
 * is a free-text label, and guessing a period from it silently stored every UI-created
 * sitting as 'may' (the RPC default) whatever it was called.
 */
import type { CreateCycleInput, YearSummary } from "./types";
import { periodLabel, type SittingKey } from "./periods";

/** The exam_years region every sitting is created in (unchanged from before). */
export const SITTING_REGION = "eu-west";

/** Display label for a period. */
export function sittingLabel(sitting: SittingKey): string {
  return periodLabel(sitting);
}

/** A year name must carry a real 4-digit year — the app parses it everywhere. */
const YEAR_NAME_RE = /^(?:19|20)\d{2}$/;

/** Trimmed year name if valid, else null. */
export function normalizeYearName(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim();
  return YEAR_NAME_RE.test(v) ? v : null;
}

/** ISO `yyyy-mm-dd` passes through; anything else becomes null so the `date`
 *  column never rejects the insert. */
export function isoDateOrNull(raw: string | undefined | null): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw ?? "") ? (raw as string) : null;
}

/**
 * The period already taken in an existing year, or null if the slot is free.
 * `years` is the provider's grouped list (`listYears()`); only real DB years
 * (carrying an `examYearId`) are considered.
 */
export function findPeriodConflict(
  years: readonly YearSummary[],
  examYearId: string,
  sitting: SittingKey,
): { yearName: string; centreName: string; cycleName: string | null } | null {
  const y = years.find((yr) => yr.examYearId === examYearId);
  if (!y) return null;
  const slot = sitting === "february" ? y.february : y.may;
  return slot.started
    ? { yearName: y.name, centreName: y.testCentreName, cycleName: slot.cycleName }
    : null;
}

/**
 * Arguments for `create_cycle_with_assessments`. `examYearId` is the RESOLVED year
 * (an existing one, or the one `create_exam_year` just find-or-created); `sitting`
 * is always sent explicitly. When a year is given the centre is taken from the year
 * server-side, so no separate centre is passed (the RPC raises if they disagree).
 */
export function buildCreateCycleArgs(
  input: Pick<CreateCycleInput, "name" | "sitting" | "sittingDate">,
  examYearId: string,
  assessmentNames: readonly string[],
): {
  p_name: string;
  p_region: string;
  p_assessments: { name: string }[];
  p_year_id: string;
  p_sitting: SittingKey;
  p_test_centre_id: null;
  p_sitting_date: string | null;
} {
  return {
    p_name: input.name,
    p_region: SITTING_REGION,
    p_assessments: assessmentNames.map((name) => ({ name })),
    p_year_id: examYearId,
    p_sitting: input.sitting,
    p_test_centre_id: null,
    p_sitting_date: isoDateOrNull(input.sittingDate),
  };
}

/**
 * A readable message for a failed create. The database enforces one sitting per
 * (year, period) with `exam_cycles_year_sitting_key` (migration 0050); the provider
 * checks first, but two people creating the same slot at once can still reach the
 * constraint — surface that as plain English, not a raw Postgres error.
 */
export function friendlyCreateCycleError(
  message: string | undefined | null,
  input: Pick<CreateCycleInput, "sitting">,
): string {
  const raw = message ?? "";
  if (/exam_cycles_year_sitting_key/.test(raw)) {
    return `A ${sittingLabel(input.sitting)} sitting already exists for this year at this centre.`;
  }
  return raw || "Could not create the cycle.";
}
