/**
 * Does a QM export belong to the sitting it is being uploaded into?
 *
 * Pure and UI-free so it is testable on its own. The check compares what the export says
 * about itself — the sitting tag parsed from `ResultGroupName` (e.g. "MAY2026") and, when the
 * export carries them, the dates of its results — with the target sitting's YEAR and
 * PERIOD. It never blocks: a mismatch becomes a warning the user must confirm.
 *
 * What is compared, and what is deliberately not:
 *   - tag year / period      vs the sitting's year / period
 *   - result dates           their year, and the period (via the registry's month coverage)
 *                            of the first and last date, vs the sitting's year / period
 *   - several sittings in one file (more than one tag) is itself reported
 *   - `exam_cycles.sitting_date` is display-only and is NOT compared (a sitting runs over
 *     days; the date is an indicative label)
 * Anything missing is skipped: an export with no date columns compares its tag only, an
 * untagged export with no dates (or a target with no year/period) is "unknown" — no warning,
 * because there is nothing to compare.
 */
import { isSittingKey, periodLabel, periodOfMonth, type SittingKey } from "@/lib/data/periods";
import type { CanonicalModel } from "./model";

/** The sitting being uploaded into (all optional: demo / legacy sittings carry none). */
export interface SittingTarget {
  /** exam_years.name, e.g. "2026". */
  yearName?: string;
  /** exam_cycles.sitting. */
  sitting?: string;
}

export type MismatchKind = "year" | "period" | "dates" | "mixed";

export interface MismatchIssue {
  kind: MismatchKind;
  message: string;
}

export interface SittingMatchReport {
  /** `match` — compared something, all agrees; `mismatch` — see `issues`; `unknown` — nothing to compare. */
  status: "match" | "mismatch" | "unknown";
  issues: MismatchIssue[];
  /** What the sitting is, e.g. "May 2026" (for the message). */
  targetLabel: string;
  /** What the export says it is, e.g. "February 2026", or null. */
  exportLabel: string | null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-05-14" → "14 May 2026". */
export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function targetYear(name: string | undefined): number | null {
  const m = (name ?? "").match(/(?:19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

export function compareExportToSitting(
  canonical: Pick<CanonicalModel, "sitting" | "dateRange" | "results">,
  target: SittingTarget | null | undefined,
): SittingMatchReport {
  const year = targetYear(target?.yearName);
  const period: SittingKey | null = isSittingKey(target?.sitting) ? target!.sitting as SittingKey : null;
  const targetLabel = [period ? periodLabel(period) : null, year].filter((x) => x !== null).join(" ") || "this sitting";

  const issues: MismatchIssue[] = [];
  let compared = false;
  const tag = canonical.sitting;
  const exportLabel = tag?.label ?? null;

  // 1. The sitting tag the export carries (from ResultGroupName).
  if (tag) {
    if (year !== null) {
      compared = true;
      if (tag.year !== year) {
        issues.push({ kind: "year", message: `The export is tagged ${tag.label} (year ${tag.year}), but this sitting belongs to the year ${year}.` });
      }
    }
    if (period !== null) {
      compared = true;
      if (tag.period !== period) {
        issues.push({ kind: "period", message: `The export is tagged ${tag.label} (the ${periodLabel(tag.period)} period), but this is the ${periodLabel(period)} sitting.` });
      }
    }
  }

  // 2. A file that mixes several sittings' tags.
  const codes = [...new Set(canonical.results.map((r) => r.sitting?.code).filter((c): c is string => !!c))];
  if (codes.length > 1) {
    issues.push({ kind: "mixed", message: `The export mixes more than one sitting (${codes.join(", ")}).` });
  }

  // 3. The dates of the results, when the export has them.
  const range = canonical.dateRange;
  if (range && (year !== null || period !== null)) {
    compared = true;
    const [fy, fm] = range.from.split("-").map(Number) as [number, number];
    const [ty, tm] = range.to.split("-").map(Number) as [number, number];
    const span = range.from === range.to ? formatIsoDate(range.from) : `${formatIsoDate(range.from)} – ${formatIsoDate(range.to)}`;
    if (year !== null && (fy !== year || ty !== year)) {
      issues.push({ kind: "dates", message: `The results are dated ${span}, which is outside the sitting's year (${year}).` });
    } else if (period !== null) {
      const fromPeriod = periodOfMonth(fm);
      const toPeriod = periodOfMonth(tm);
      if (fromPeriod !== period || toPeriod !== period) {
        const where = fromPeriod === toPeriod ? `the ${periodLabel(fromPeriod)} period` : `the ${periodLabel(fromPeriod)} and ${periodLabel(toPeriod)} periods`;
        issues.push({ kind: "dates", message: `The results are dated ${span}, which falls in ${where}, but this is the ${periodLabel(period)} sitting.` });
      }
    }
  }

  return {
    status: issues.length > 0 ? "mismatch" : compared ? "match" : "unknown",
    issues,
    targetLabel,
    exportLabel,
  };
}

/**
 * What the uploader does with a report: go straight on, or hold the file until the user
 * confirms. Only a mismatch is held; a match and "nothing to compare" proceed untouched.
 */
export function planUpload(report: SittingMatchReport): "proceed" | "confirm" {
  return report.status === "mismatch" ? "confirm" : "proceed";
}
