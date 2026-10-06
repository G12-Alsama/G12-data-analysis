/**
 * Clean-stage flagging engine — pure, deterministic, dependency-free.
 *
 * Given the cleaned Clean dataset (the per-subject response matrix: columns =
 * items, rows = sittings), it returns a flat list of advisory flags on suspect
 * rows and columns. It NEVER mutates anything and NEVER decides an exclusion —
 * flags are guidance the reviewer acts on with the manual soft-delete controls.
 *
 * Design notes:
 *  - Not under `lib/engine/*` (grade-bearing scoring is off-limits); this is a
 *    view-layer helper with its own unit tests, separate from the engine suite.
 *  - Fields the dataset does not carry are skipped silently, mirroring the rest
 *    of the app: a row with `email === undefined` (the PII-safe pseudonymised
 *    view) skips every email-based rule; a row with no timestamp skips
 *    SUSPECT_TIMESTAMP. Only genuinely present-but-bad data is flagged.
 *  - The 41st item on the Clean tab — a `maxScore: 0` stimulus / instruction
 *    page — is surfaced as an INFORMATIONAL `STIMULUS_ITEM`, never an error (see
 *    docs/diagnostics/2026-07-clean-count-and-cr-flow.md).
 */

export type CleanFlagTarget = "row" | "column";
export type CleanFlagSeverity = "high" | "medium" | "low";

export interface CleanFlag {
  target: CleanFlagTarget;
  /** Sitting id (qm_result_id as string / participant id) or question_id. */
  id: string;
  code: string;
  severity: CleanFlagSeverity;
  /** Human-readable, shown in the UI. */
  message: string;
}

/** One column (item) of the Clean matrix. */
export interface CleanFlagItem {
  /** question_id. */
  id: string;
  maxScore: number;
  /** Optional short label for messages (e.g. "Q1"). Falls back to `id`. */
  label?: string;
  /** A metadata column (timestamp / name / duration), not a scorable question. */
  metadata?: boolean;
}

/** One row (sitting) of the Clean matrix. */
export interface CleanFlagRow {
  /** Sitting / participant id. */
  id: string;
  /**
   * Participant email. `undefined` means the dataset carries no email for this
   * row (the pseudonymised PII-safe view) — every email-based rule is skipped.
   * `null` / "" means the email field is present but empty → MISSING_ID.
   */
  email?: string | null;
  /** Sitting timestamp in ms. Omit / null when the dataset has no timestamp. */
  timestampMs?: number | null;
  /** Response cells aligned to `items` order: 1/0 answered, null blank/omitted. */
  cells: readonly (number | null)[];
}

export interface ExamWindow {
  startMs: number;
  endMs: number;
}

export interface CleanFlagInput {
  items: readonly CleanFlagItem[];
  rows: readonly CleanFlagRow[];
  /** Configurable known test / staff account emails (matched case-insensitively). */
  testAccountEmails?: readonly string[];
  /** Exam window; sittings outside it are SUSPECT_TIMESTAMP. Omit / null to skip. */
  examWindow?: ExamWindow | null;
  /** Answered-fraction below which a (non-empty) row is PARTIAL_EMPTY. Default 0.10. */
  partialThreshold?: number;
}

/**
 * A "real" scored MCQ item has `maxScore > 0`. A `maxScore: 0` item is a
 * stimulus / instruction / welcome page (flagged below as STIMULUS_ITEM) —
 * delivered alongside the real questions but never itself a question. This is
 * the single source of truth for that distinction; other call sites (e.g. the
 * item-analysis export) reference this instead of re-deriving their own
 * `maxScore === 0` check.
 */
export function isScoredItem(item: { maxScore: number }): boolean {
  return item.maxScore > 0;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** answered = non-null cells; skips cells beyond the row's own length. */
function answeredCount(cells: readonly (number | null)[]): number {
  let n = 0;
  for (const c of cells) if (c !== null && c !== undefined) n += 1;
  return n;
}

/**
 * Compute the advisory row/column flags for one Clean matrix. Deterministic:
 * same input → same output, in a stable order (all column flags in item order,
 * then all row flags in row order; within a target, by rule order below).
 */
export function computeCleanFlags(input: CleanFlagInput): CleanFlag[] {
  const { items, rows } = input;
  const testAccounts = new Set((input.testAccountEmails ?? []).map(normEmail));
  const partialThreshold = input.partialThreshold ?? 0.1;
  const window = input.examWindow ?? null;
  const flags: CleanFlag[] = [];

  // ── Column (item) flags ────────────────────────────────────────────────────
  items.forEach((item, ci) => {
    const label = item.label ?? item.id;

    // NON_QUESTION_FIELD — a metadata column that slipped into the matrix.
    if (item.metadata) {
      flags.push({
        target: "column",
        id: item.id,
        code: "NON_QUESTION_FIELD",
        severity: "medium",
        message: `"${label}" looks like a metadata field, not a scored question — consider removing it from the analysis set.`,
      });
    }

    // STIMULUS_ITEM — a maxScore-0 instruction / stimulus / welcome page. This is
    // the 41st item behind "41 total vs 40 scored"; informational, not an error.
    const isStimulus = !isScoredItem(item);
    if (isStimulus) {
      flags.push({
        target: "column",
        id: item.id,
        code: "STIMULUS_ITEM",
        severity: "low",
        message: `"${label}" is an unscored stimulus / instruction item (max score 0). It's shown for context and does not count toward student marks — no action needed.`,
      });
    }

    // Presence / variance over this column's cells.
    let present = 0;
    let first: number | null = null;
    let allEqual = true;
    for (const r of rows) {
      const v = r.cells[ci] ?? null;
      if (v === null) continue;
      present += 1;
      if (first === null) first = v;
      else if (v !== first) allEqual = false;
    }

    // ALL_BLANK — no participant has a non-null response for this item.
    if (present === 0) {
      flags.push({
        target: "column",
        id: item.id,
        code: "ALL_BLANK",
        severity: "high",
        message: `"${label}" has no responses from any participant — every cell is blank.`,
      });
      return; // nothing more to say about an empty column
    }

    // ZERO_VARIANCE — every candidate scored identically. Advisory only, and only
    // meaningful for a scored item (a stimulus item is trivially all-zero).
    if (!isStimulus && present > 1 && allEqual) {
      flags.push({
        target: "column",
        id: item.id,
        code: "ZERO_VARIANCE",
        severity: "low",
        message: `Every participant scored the same on "${label}" (${first}). It carries no discriminating information — review only.`,
      });
    }
  });

  // ── Row (sitting) flags ────────────────────────────────────────────────────
  // Group by normalised email up-front for DUPLICATE_SITTING (only rows that
  // actually carry a usable email participate).
  const emailGroups = new Map<string, string[]>();
  for (const r of rows) {
    if (r.email === undefined || r.email === null) continue;
    const e = normEmail(r.email);
    if (!e) continue;
    const g = emailGroups.get(e);
    if (g) g.push(r.id);
    else emailGroups.set(e, [r.id]);
  }
  const duplicatedEmails = new Map<string, number>();
  for (const [e, ids] of emailGroups) if (ids.length > 1) duplicatedEmails.set(e, ids.length);

  // Optional timestamp-outlier bounds (used only when there is no exam window).
  const outlierBounds = window ? null : timestampOutlierBounds(rows);

  for (const r of rows) {
    const total = items.length;
    const answered = answeredCount(r.cells);

    // Email-based rules only run when the dataset provides an email for the row.
    const hasEmailField = r.email !== undefined;
    if (hasEmailField) {
      const raw = r.email ?? "";
      const email = normEmail(raw);
      // MISSING_ID — present but empty, or not a valid email shape.
      if (email === "" || !EMAIL_SHAPE.test(email)) {
        flags.push({
          target: "row",
          id: r.id,
          code: "MISSING_ID",
          severity: "high",
          message:
            email === ""
              ? "This sitting has no participant email — it can't be attributed to a student."
              : `"${raw}" isn't a valid email address — this sitting may be mis-keyed.`,
        });
      } else {
        // KNOWN_TEST_ACCOUNT — matches the configurable exclusion list.
        if (testAccounts.has(email)) {
          flags.push({
            target: "row",
            id: r.id,
            code: "KNOWN_TEST_ACCOUNT",
            severity: "high",
            message: `"${raw}" is a known test / staff account — exclude it from the cohort.`,
          });
        }
        // DUPLICATE_SITTING — same email sits this subject more than once.
        const dup = duplicatedEmails.get(email);
        if (dup) {
          flags.push({
            target: "row",
            id: r.id,
            code: "DUPLICATE_SITTING",
            severity: "medium",
            message: `"${raw}" has ${dup} sittings for this subject — keep one and remove the duplicate(s).`,
          });
        }
      }
    }

    // NO_RESPONSES — zero questions answered.
    if (answered === 0) {
      flags.push({
        target: "row",
        id: r.id,
        code: "NO_RESPONSES",
        severity: "high",
        message: "This participant answered no questions — the whole sitting is blank.",
      });
    } else if (total > 0 && answered / total < partialThreshold) {
      // PARTIAL_EMPTY — answered very few questions (but not none).
      flags.push({
        target: "row",
        id: r.id,
        code: "PARTIAL_EMPTY",
        severity: "low",
        message: `Only ${answered} of ${total} questions answered (${Math.round((answered / total) * 100)}%) — a near-empty sitting worth reviewing.`,
      });
    }

    // SUSPECT_TIMESTAMP — outside the exam window, or a clear outlier when no
    // window is configured. Skipped silently when the row has no timestamp.
    const ts = r.timestampMs;
    if (ts !== undefined && ts !== null && Number.isFinite(ts)) {
      let suspect = false;
      let why = "";
      if (window) {
        if (ts < window.startMs || ts > window.endMs) {
          suspect = true;
          why = "outside the exam window";
        }
      } else if (outlierBounds && (ts < outlierBounds.low || ts > outlierBounds.high)) {
        suspect = true;
        why = "a clear outlier vs the other sittings";
      }
      if (suspect) {
        flags.push({
          target: "row",
          id: r.id,
          code: "SUSPECT_TIMESTAMP",
          severity: "medium",
          message: `This sitting's timestamp is ${why} — check it isn't a re-sit or a clock error.`,
        });
      }
    }
  }

  return flags;
}

/**
 * IQR-based outlier bounds over the rows' timestamps, used only when no exam
 * window is configured. Returns null when there are too few timestamps (< 4) to
 * judge — in which case SUSPECT_TIMESTAMP is skipped rather than guessed.
 */
function timestampOutlierBounds(rows: readonly CleanFlagRow[]): { low: number; high: number } | null {
  const ts: number[] = [];
  for (const r of rows) {
    const t = r.timestampMs;
    if (t !== undefined && t !== null && Number.isFinite(t)) ts.push(t);
  }
  if (ts.length < 4) return null;
  ts.sort((a, b) => a - b);
  const q = (p: number): number => {
    const idx = (ts.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return ts[lo]!;
    return ts[lo]! + (ts[hi]! - ts[lo]!) * (idx - lo);
  };
  const q1 = q(0.25);
  const q3 = q(0.75);
  const iqr = q3 - q1;
  return { low: q1 - 3 * iqr, high: q3 + 3 * iqr };
}
