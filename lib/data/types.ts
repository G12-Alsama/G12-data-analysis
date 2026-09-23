/**
 * Read-model and action types exposed by the DataProvider to the UI. Components
 * depend only on these — never on the engine, ingest, export modules or Supabase
 * directly. The Supabase-backed provider will implement the same interface.
 */

import type { QualityRating } from "@/lib/engine";
import type { PerCutSuggestion } from "@/lib/engine/cut-scores";
import type { AssessmentDiagnostics } from "@/lib/diagnostics";
import type { ValidationReport } from "@/lib/ingest/types";
import type { SeedAnswerOption, SeedPreview } from "./seed-types";
import type { IncidentAdjustmentConfig } from "@/lib/incidents/types";

/** A question's multiple-choice answer option, surfaced to the review UI. */
export type AnswerOption = SeedAnswerOption;

// A signed-in user's stored privilege role (the `member_role` DB enum). The
// canonical hierarchy and the hasRole / canOverride primitives that reason over
// these values live in lib/auth/roles.ts — gate on those, not on raw equality.
export type Role = "lead_admin" | "analyst" | "reviewer" | "viewer";

export interface CurrentUser {
  id: string;
  name: string;
  initials: string;
  role: Role;
  /**
   * The membership's dynamic role id (migration 0040). When present, `can()`
   * resolves against the hydrated role_id → actions grid; when absent (demo /
   * pre-hydration), it falls back to the seeded role id derived from `role`.
   */
  roleId?: string | null;
  /**
   * The membership's dynamic role display name (migration 0042 — resolved from
   * `role_id → roles.name`). Drives the account-menu label so it shows the real
   * role (incl. a custom role), not the enum-derived tier label. Absent in the
   * in-memory demo, where the label falls back to `role`.
   */
  roleName?: string | null;
}

// Document/certificate generation is NOT a per-sitting pipeline step: certificates
// and performance reports issue from the cycle/overall best-of-two award
// (app/years/[yearId]/overall/documents), not a single sitting. The per-sitting
// pipeline therefore ends at Grades. (Per-page CSV/Excel data exports remain — they
// are legitimately per-sitting, but they are page actions, not a pipeline stage.)
// Essay marks are NOT a standalone pipeline step: the offline-marked English /
// Arabic essays are uploaded up front on Upload (step 1) alongside the QM exports
// and fold automatically into the scored subject totals (a post-engine layer, see
// lib/engine/scores.ts). There is no separate essay stage to visit.
export const PIPELINE = [
  "Upload",
  "Clean",
  "Raw scores",
  "Question review",
  "Assessment Health",
  "Incident adjustments",
  "Score",
  "Cut scores",
  // CGJ (Centre Grade Judgement) sits directly after Cut scores, before Grades:
  // once the boundaries are set the partner centre's EXPECTED grades can be lined
  // up against the actuals, as a check on the cut scores before grades are
  // confirmed. Upload + comparison only — not a full standard-setting method.
  "CGJ",
  "Grades",
] as const;
export type PipelineStage = (typeof PIPELINE)[number];

/**
 * A test centre — the top-level scoping dimension (migration 0010). A centre
 * owns its own exam years; each year owns its February + May sittings. Centre is
 * a partition / labelling key only — it never feeds scoring.
 */
export interface TestCentreSummary {
  id: string;
  name: string;
  /** Short tag, e.g. "SHA1". */
  code: string;
  /** Route-safe, e.g. "shatila-1". */
  slug: string;
  active: boolean;
}

export interface CycleSummary {
  id: string;
  name: string;
  stageIndex: number;
  stageLabel: string;
  stepsDone: number;
  participants: number;
  assessments: number;
  lastActivity: string;
  locked: boolean;
  live: boolean;
  mock: boolean;
  /** 0010 — the test centre this sitting belongs to (via its year). */
  testCentreId: string;
  testCentreName: string;
  /** 0013 — the real exam_years.id this sitting groups under (live data only;
   *  undefined in the demo seed, which has no database year rows). Used to target
   *  the year-reassignment RPC. */
  examYearId?: string;
}

/** Which sitting of a year. "overall" is the derived best-of-two view. */
export type SittingKey = "february" | "may";

/**
 * One sitting tile inside a year. A sitting is a full pipeline run (an
 * exam_cycle). When no run exists yet for the slot, `started` is false and
 * `cycleId` is null — the year view offers to start it.
 */
export interface SittingRef {
  sitting: SittingKey;
  /** Display label, e.g. "February" / "May". */
  label: string;
  /** 0010 — the test centre this sitting's year belongs to (for labelling). */
  testCentreName: string;
  /** The exam_cycle id for this sitting, or null when not started. */
  cycleId: string | null;
  cycleName: string | null;
  started: boolean;
  locked: boolean;
  stageLabel: string;
  stepsDone: number;
  participants: number;
  assessments: number;
  lastActivity: string;
  live: boolean;
  mock: boolean;
}

/** One row in the year list (was the cycles list). */
export interface YearSummary {
  id: string;
  name: string;
  /** 0010 — the test centre this year belongs to. */
  testCentreId: string;
  testCentreName: string;
  /** 0013 — the real exam_years.id (live data only; undefined in the demo seed).
   *  Target of move_exam_year_to_centre when an admin reassigns the year. */
  examYearId?: string;
  february: SittingRef;
  may: SittingRef;
  /** Distinct participants across the year's sittings (max of the two). */
  participants: number;
  lastActivity: string;
  /** True when one of the sittings is the live (active) run. */
  live: boolean;
  /** True when every sitting in the year is mock decoration. */
  mock: boolean;
}

/** A year opened: its two sittings + the (stubbed) Overall rollup. */
export interface YearDetail {
  id: string;
  name: string;
  /** 0010 — the test centre this year belongs to. */
  testCentreId: string;
  testCentreName: string;
  /** 0013 — the real exam_years.id (live data only; undefined in the demo seed). */
  examYearId?: string;
  february: SittingRef;
  may: SittingRef;
  /**
   * Overall is DERIVED (best-of-two by award level, per student per subject) —
   * the rollup lives in `getOverallGrades` / `lib/data/overall.ts`. `ready` is
   * true only once both sittings are locked, which is when an Overall is final.
   */
  overall: { ready: boolean; note: string };
}

export interface AssessmentRef {
  id: string;
  name: string;
  shortName: string;
  rtl: boolean;
  itemCount: number;
  excludedCount: number;
  stageIndex: number;
}

export interface CycleDetail {
  id: string;
  name: string;
  participants: number;
  assessmentCount: number;
  startedAt: string;
  stageIndex: number;
  locked: boolean;
  mock: boolean;
  /** 0010 — the test centre this sitting belongs to (via its year). */
  testCentreName: string;
  doNext: { title: string; body: string; href: string; cta: string };
  assessments: AssessmentRef[];
}

/** Optional technical-errors spreadsheet attached at ingest (never gates progress). */
export interface TechnicalErrorsUpload {
  uploaded: boolean;
  fileName: string | null;
  incidentCount: number;
  matchedCount: number;
  preview: { headers: string[]; rows: (string | number | null)[][] };
  /** True when populated from the labelled sample fixture rather than a real file. */
  sample: boolean;
}

export interface IngestModel {
  cycleId: string;
  /** Whether a raw exam export has actually been ingested for this cycle. An
   *  empty/draft cycle is the normal starting state — the screen renders an
   *  upload prompt rather than a (meaningless, all-zero) validation report. */
  uploaded: boolean;
  fileName: string;
  fileSizeMB: number;
  uploadedAgo: string;
  /**
   * The three Questionmark CSVs recognised at ingest — what each uploaded file was
   * detected as, by its columns (not its filename). A value is null when that kind
   * wasn't recognised in the upload (e.g. a legacy single-file row, or a re-upload
   * that predates the 3-CSV intake). Drives the per-file recognition display, and
   * the "missing / unrecognised" message, on the Upload step.
   */
  files: { items: string | null; assessments: string | null; topics: string | null };
  report: ValidationReport;
  preview: SeedPreview;
  duplicates: number;
  canContinue: boolean;
  technicalErrors: TechnicalErrorsUpload;
}

// --- Front-of-pipeline: combined upload, raw data, cleaning, naive scores ----
export type CleaningStatus = "pass" | "warn" | "fail";

/** One subject detected when a combined export is split. */
export interface DetectedSubject {
  id: string;
  name: string;
  shortName: string;
  items: number;
  participants: number;
  /** Major element names found in this subject (3–5, never hard-coded). */
  elements: string[];
  rtl: boolean;
  hasEssay: boolean;
  status: "ok" | "warn";
  note: string | null;
}
export interface CombinedSplitModel {
  cycleId: string;
  fileName: string;
  fileSizeMB: number;
  uploadedAgo: string;
  totalItems: number;
  totalParticipants: number;
  subjects: DetectedSubject[];
}

/** Column metadata for the raw spreadsheet view. */
export interface RawColumnMeta {
  id: string;
  qLabel: string;
  major: string | null;
  sub: string | null;
  demand: string | null;
  /**
   * The item's maximum score. `0` marks an unscored stimulus / instruction /
   * welcome page (the "41st item" that is counted but sits outside the scored
   * denominator — see docs/diagnostics/2026-07-clean-count-and-cr-flow.md).
   */
  maxScore: number;
  /** Configured A–E letter for this item's major element (Settings → Element labels). */
  elLetter?: string | null;
  /** Configured display label for this item's major element. */
  elLabel?: string | null;
}
/** One participant row in the raw spreadsheet (cells aligned to `columns`). */
export interface RawDataRow {
  id: string;
  studentId: string;
  name: string;
  /** 1 correct · 0 incorrect · null omitted/blank, in column order. */
  cells: (number | null)[];
}
export interface RawElementBreak {
  major: string;
  subs: string[];
  items: number;
  /** Configured A–E letter for this major element (Settings → Element labels). */
  letter?: string;
  /** Configured display label (falls back to `major` when unconfigured). */
  label?: string;
}
export interface RawDataModel {
  assessment: AssessmentRef;
  assessments: AssessmentRef[];
  participants: number;
  items: number;
  /**
   * Items that count toward marks (`maxScore ≥ 1`). `items - scoredItems` is the
   * number of unscored stimulus/instruction items — the source of the Clean tab's
   * "41 total vs 40 scored" split.
   */
  scoredItems: number;
  /** Number of major elements present (varies by subject). */
  elementsCount: number;
  subElementsCount: number;
  demand: { D1: number; D2: number; D3: number };
  byElement: RawElementBreak[];
  columns: RawColumnMeta[];
  rows: RawDataRow[];
}

export interface CleaningCheck {
  id: string;
  status: CleaningStatus;
  title: string;
  detail: string | null;
  count: string | null;
  /** Suggested action label (e.g. "Resolve", "Delete column"); null = informational. */
  action: string | null;
}
export interface DataCleaningModel {
  assessment: AssessmentRef;
  assessments: AssessmentRef[];
  checks: CleaningCheck[];
  counts: { pass: number; warn: number; fail: number };
  rowsBefore: number;
  /** Rows remaining after the current (UI-selected) removals. */
  rowsAfter: number;
  /** True when no must-fix blocker remains. Warnings never block. */
  canProceed: boolean;
  columns: RawColumnMeta[];
  rows: RawDataRow[];
  /**
   * Participant ids (of rows still shown) that are EXCLUDED from the cleaned set for
   * THIS subject — the struck-through rows. Two scopes are unioned here (see the
   * split fields below): a per-subject removal (this sitting only) and a cohort-wide
   * exclusion (every subject). The Clean table keeps both visible but strikes them
   * through; the exclusion propagates to Scores/Grades and is fully reversible.
   */
  excludedRows: string[];
  /**
   * The subset of `excludedRows` removed from THIS subject only (the per-sitting
   * scope — `setCleanRemoval` row targets). Present in the participant's other
   * subjects. Drives the "Remove from <subject>" vs "Remove from all subjects"
   * distinction in the Clean UI and the correct-scope restore.
   */
  subjectExcludedRows: string[];
  /**
   * The subset of `excludedRows` excluded across the WHOLE cohort (every subject —
   * `excludeParticipantFromCohort`). Staff/test accounts and any participant the
   * reviewer removed from all subjects land here; they are the rows a data-flow
   * inspector shows as struck cohort removals.
   */
  cohortExcludedRows: string[];
  /**
   * Item (column) ids soft-deleted at the Clean stage (`setCleanRemoval` col
   * targets). Kept VISIBLE in `columns` and struck through — like excluded rows —
   * so a column removal reads as "still here, just excluded" and can be reversed
   * in place. The exclusion propagates to scoring/denominator through the same
   * parity-safe path item-review exclusions use; the raw file is never touched.
   */
  excludedCols: string[];
}

/**
 * The prominent, live "cleaning impact" figures pinned at the top of the Clean
 * tab — key counts BEFORE cleaning vs AFTER cleaning, recomputed on every
 * soft-delete / restore / undo. Because cleaning is soft-delete, "before" is the
 * full ingested set and "after" is the full set minus the currently-excluded
 * rows; both are always computable. Non-exam surveys are excluded from the
 * per-subject / per-element breakdowns (they carry no scored data).
 */
export interface CleaningImpactStat {
  /** Full ingested figure (ignores exclusions). */
  before: number;
  /** Figure after removing the currently-excluded rows. */
  after: number;
}
export interface CleaningImpactSubject {
  assessmentId: string;
  shortName: string;
  name: string;
  /** Response records for this subject (one per answered item), before → after. */
  records: CleaningImpactStat;
  /** Distinct participants sitting this subject, before → after. */
  participants: CleaningImpactStat;
  /** This subject's records by `QuestionMajorElement`, before → after. */
  byElement: CleaningImpactElement[];
}
export interface CleaningImpactElement {
  major: string;
  label: string;
  /** Answered-item records carrying this `QuestionMajorElement`, before → after. */
  records: CleaningImpactStat;
}
export interface CleaningImpactModel {
  cycleId: string;
  /** Distinct cohort participants, before → after. */
  participants: CleaningImpactStat;
  /** Total response records across the scored exams, before → after. */
  records: CleaningImpactStat;
  /** Per-subject records + participants (scored exams only). */
  bySubject: CleaningImpactSubject[];
  /** Records by `QuestionMajorElement` across the scored exams. */
  byElement: CleaningImpactElement[];
  /** Records currently excluded (the delta = records.before − records.after). */
  excludedRecords: number;
  /** Distinct participants currently excluded (the delta). */
  excludedParticipants: number;
}

/**
 * Fuller Clean "Summary" statistics (no per-row data) — per-subject score
 * distribution and completion counts by ResultStatus, each shown BEFORE vs AFTER
 * cleaning so staff see the effect on the distributions, not just the counts.
 * Scored exams only (surveys excluded); percentages/averages use the engine's
 * scored denominator (via `computeScores`), never a naive raw-max sum.
 */
export interface CleaningSummaryDist {
  /** Participants scored in this slice. */
  n: number;
  /** Cohort mean % (engine scored denominator). */
  mean: number;
  /** Median %. */
  median: number;
  /** Standard deviation of %. */
  sd: number;
}
export interface CleaningSummarySubject {
  assessmentId: string;
  shortName: string;
  name: string;
  before: CleaningSummaryDist;
  after: CleaningSummaryDist;
  /** This subject's completion counts by ResultStatus, before → after. */
  statusCounts: CleaningSummaryStatusRow[];
}
export interface CleaningSummaryStatusRow {
  status: string;
  /** Sittings with this ResultStatus across the scored exams, before → after. */
  before: number;
  after: number;
}
export interface CleaningSummaryModel {
  cycleId: string;
  /** Per-subject before/after score distribution (scored exams only). */
  subjects: CleaningSummarySubject[];
  /** Completion counts by ResultStatus (scored exams only), before → after. */
  statusCounts: CleaningSummaryStatusRow[];
  /** Human note on scope (exams only, engine denominator, "Summary" naming). */
  note: string;
}

/**
 * The cleaned master dataset as a single flat sheet — the exact columns (in the
 * canonical `CLEANED_DATA_COLUMNS` order) of the team's cleaned export, across
 * every scored exam, reflecting the current post-clean state (excluded rows
 * omitted). The single source of truth for the "Export to Excel" workbook.
 */
export interface CleanedMasterDataset {
  /** The cleaned-export column headers, in canonical order (43 columns). */
  headers: string[];
  /** One row per retained response, aligned to `headers`. */
  rows: string[][];
  /** Retained totals reflected in the sheet. */
  retained: { participants: number; responses: number; subjects: number };
}

/**
 * A read-only view of the cleaned set in the Questionmark "cleaned" column layout
 * (see lib/data/cleaned-schema.ts) — one row per retained (participant, item)
 * response, so the Clean step mirrors the team's Excel spreadsheet. De-identified:
 * PII and QM-only metadata columns are present (in position) but blank.
 */
export interface CleanedDataModel {
  assessment: AssessmentRef;
  assessments: AssessmentRef[];
  /** The cleaned-export column headers, in canonical order. */
  headers: string[];
  /** Header keys the de-identified app does not populate (shown blank). */
  blankColumns: string[];
  /** One row per retained response; each cell is a string aligned to `headers`. */
  rows: string[][];
  /** Retained counts after Clean-stage removals. */
  retained: { participants: number; items: number; responses: number };
}

export interface NaiveElementCol {
  major: string;
  /** Configured A–E letter (Settings → Element labels); falls back to appearance order. */
  shortId: string;
  items: number;
  /** Configured display label (falls back to `major` when unconfigured). */
  label?: string;
  /**
   * Set ONLY on the offline essay ("Writing") column for essay subjects (English /
   * Arabic): the mark's max, i.e. the reserved /20. Its header shows `/essayMax`
   * instead of an item count, and its cell is the participant's essay mark already
   * folded into `raw`. Display-only — never present on non-essay subjects.
   */
  essayMax?: number;
}
export interface NaiveStudentRow {
  id: string;
  studentId: string;
  name: string;
  /** Raw correct count per major element (MCQ breakdown, display-only). */
  perElement: Record<string, number>;
  /**
   * Subject total on the SAME engine score path as the final Score, minus the
   * item-review deletion step: retained-MCQ marks + the half-weighted essay mark
   * (ESL/Arabic only). Equals the final Score on a cohort with no deletions.
   */
  raw: number;
  pct: number;
  /** Subject max the `raw` is out of = retained-MCQ max + reserved essay max. */
  max: number;
}
export interface NaiveScoresModel {
  assessment: AssessmentRef;
  assessments: AssessmentRef[];
  hasEssay: boolean;
  /** Count of scored MCQ items (the per-element breakdown denominator). */
  mcqItems: number;
  /** Subject max the row totals are out of (retained-MCQ max + reserved essay max). */
  subjectMax: number;
  totalItems: number;
  cohortAvgPct: number;
  elements: NaiveElementCol[];
  students: NaiveStudentRow[];
}

export interface ItemRow {
  id: string;
  wording: string | null;
  major: string | null;
  sub: string | null;
  demand: string | null;
  pValue: number;
  itemTotal: number | null;
  pointBiserial: number | null;
  discrimination: number;
  overallReview: QualityRating;
  qualityIndex: number;
  excluded: boolean;
  reason: string | null;
  /** Multiple-choice answer options (null when not available for this item). */
  options: AnswerOption[] | null;
}

export interface BreakItem {
  k: string;
  v: number;
}

// --- Essay marks (optional upload at Ingest; English/Arabic only) ------------
export interface EssaySubjectRef {
  assessmentId: string;
  /** Subject code in the file (AFL / ESL). */
  code: string;
  name: string;
  /** Students with an essay mark for this subject. */
  count: number;
}
export interface EssayStudentMark {
  participantId: string;
  name: string;
  /** assessmentId → essay mark out of 20 (averaged across the student's essays). */
  marks: Record<string, number>;
  /** How many essays were averaged into each subject mark (assessmentId → n). */
  essayCounts: Record<string, number>;
}
export interface EssayMarksModel {
  cycleId: string;
  uploaded: boolean;
  sample: boolean;
  fileName: string | null;
  subjects: EssaySubjectRef[];
  students: EssayStudentMark[];
  /** Distinct file ParticipantIDs that matched a roster student. */
  matchedCount: number;
  /** File ParticipantIDs that did not match any roster student. */
  unmatchedIds: string[];
  preview: { headers: string[]; rows: (string | number | null)[][] };
}

// --- Essay marks: upload context (template + pre-write validation) -----------
/** One roster participant for an essay subject, as the template pre-populates it. */
export interface EssayRosterEntry {
  /** The identifier the parser/matcher consumes (P-A internal id / ParticipantID). */
  participantId: string;
  /**
   * The real external Student ID (`qm_participant_id`, e.g. `A-A-260506`) — the
   * masterfile join key. Mirrors the provider's matcher, which accepts either the
   * internal id OR this Student ID; validation matches the uploaded file on it.
   */
  studentId: string;
  /** Human label for the template + review table. */
  name: string;
  /** True when this participant's sitting is already excluded on the Clean tab. */
  excluded: boolean;
}
/** An essay subject with its roster, for the template builder + validator. */
export interface EssaySubjectContext {
  assessmentId: string;
  /** File sheet code — AFL (Arabic) / ESL (English). */
  code: "AFL" | "ESL";
  name: string;
  participants: EssayRosterEntry[];
}
/**
 * Everything the client needs to build the essay-marks template and validate an
 * uploaded file BEFORE writing: the essay subjects, their current rosters, and
 * the max mark per essay cell. Read-only — this never touches a persistence path.
 */
export interface EssayUploadContext {
  cycleId: string;
  /** Max mark for a single essay entry (each `essay_mark` cell is 0..this). */
  essayItemMax: number;
  subjects: EssaySubjectContext[];
}

// --- Adjustments: incident triage → alterations ------------------------------
export interface AdjustmentIncident {
  id: string;
  source: "incident_log" | "complaint";
  /** Free-text context straight from the file. */
  studentName: string;
  exam: string | null;
  issueType: string | null;
  actionTaken: string | null;
  questionsAffected: string | null;
  staff: string | null;
  email: string | null;
  school: string | null;
  description: string | null;
  /** Non-binding suggestions (never auto-applied). */
  suggestedStudentId: string | null;
  suggestedSubjectId: string | null;
  /** Decision (null applyTo = still in the queue). */
  applyTo: "student" | "subject" | "none" | null;
  studentId: string | null;
  subjectId: string | null;
  marks: number;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}
export interface AdjustmentsModel {
  cycleId: string;
  uploaded: boolean;
  sample: boolean;
  fileName: string | null;
  incidents: AdjustmentIncident[];
  /** Roster for the student typeahead. */
  roster: { id: string; name: string }[];
  /** Subjects for the subject picker. */
  subjects: { id: string; name: string; code: string | null }[];
  counts: { incidents: number; decided: number; awaiting: number; alterations: number };
  /** Net alteration marks applied per subject (assessmentId → net marks). */
  netBySubject: Record<string, number>;
}

// --- Diagnostics (speededness & timing — informational) ----------------------
/**
 * Diagnostics for one assessment. A single whole-assessment speededness + timing
 * measure (`whole`), a demand-level speededness lens (`byDemand`), and omission
 * rate by item position (`omissionByPosition`). Element/construct breakdowns were
 * removed as non-actionable.
 */
export interface DiagnosticsAssessment extends AssessmentDiagnostics {
  assessmentId: string;
  assessmentName: string;
  shortName: string;
}
export interface DiagnosticsModel {
  cycleId: string;
  assessments: DiagnosticsAssessment[];
}

// --- Reliability (Cronbach's Alpha) — read-only, additive --------------------
export type ReliabilityLevelKey =
  | "overall"
  | "subject"
  | "majorElement"
  | "subElement"
  | "demandLevel"
  | "context";

export interface ReliabilityRow {
  level: ReliabilityLevelKey;
  /** Subject this group belongs to (null for the overall-exam group). */
  assessmentId: string | null;
  assessmentName: string | null;
  key: string;
  /** Display label (subject name for the subject level; tag value otherwise). */
  label: string;
  /** Items in the group. */
  k: number;
  /** Complete-case participant count used for α. */
  n: number;
  /** Cronbach's α, or null when n/a (k<2 / n<2 / no variance). */
  alpha: number | null;
  /** Why α is n/a, when it is. */
  note: string | null;
  /** k below the low-items threshold — α is fragile. */
  lowItems: boolean;
  /** n below the small-sample threshold — α is unstable. */
  smallSample: boolean;
  /** Every participant who attempted at least one item in the group (not just the complete-case n used for α). */
  totalParticipants: number;
  /** Raw item-response rows feeding the group (one per participant × item they answered). */
  itemResponses: number;
  /** Predicted α if the group's item count were doubled with similar-quality items. */
  spearmanBrown: number | null;
  /** Test-length multiplier needed to reach α = 0.80 (Spearman-Brown prophecy). */
  sbMultiplier80: number | null;
  /** Test-length multiplier needed to reach α = 0.90 (Spearman-Brown prophecy). */
  sbMultiplier90: number | null;
  /** Average pairwise Pearson correlation across the group's items (complete-case). */
  avgInterItemCorrelation: number | null;
  /** Interpretation band for α. */
  status: ReliabilityStatus;
  /** Plain-language reading of `status`. */
  interpretation: string;
}

export type ReliabilityStatus = "Excellent" | "Good" | "Acceptable" | "Questionable" | "Flag / Low" | "Not Available";

export interface ReliabilityModel {
  cycleId: string;
  engineVersion: string;
  participants: number;
  lowItemsThreshold: number;
  smallSampleThreshold: number;
  /** The overall-exam α (all usable items across subjects). */
  overall: ReliabilityRow;
  /** Every α group (including overall); pages filter by level / assessmentId. */
  rows: ReliabilityRow[];
}

// --- Mark composition (MCQ + Essay + Alterations = subject total) ------------
/**
 * A student's MCQ score on the items carrying one demand tag (D1/D2/D3), out of
 * that group's max. A rollup of the already-computed item scores by demand tag —
 * additive reporting only, no change to scoring. Mirrors the "Overall Scores by
 * Demand Level" sheet of the MCQ_Overall_Score_Analysis export.
 */
export interface DemandScore {
  demand: string;
  score: number;
  max: number;
}
export interface SubjectComposition {
  assessmentId: string;
  name: string;
  hasEssay: boolean;
  mcq: number;
  essay: number;
  alterations: number;
  total: number;
  max: number;
  pct: number;
  /** Retained-MCQ score split by demand level (D1/D2/D3), in fixed order. */
  byDemand: DemandScore[];
  /**
   * Per-subject top-difficulty (D3) correctness — display-only. Of the retained
   * D3 items on THIS subject, how many the student answered correctly (score > 0)
   * out of how many were available. `pct` is null when the subject carries no D3
   * items. This is a reporting breakdown; it does NOT change the D3 majority cap
   * (which stays per-exam aggregate — see open G12 decision #2 in the PR notes).
   */
  d3?: { correct: number; available: number; pct: number | null } | null;
  /**
   * The active manual mark adjustment on this subject, if any — surfaced so the
   * manual delta (already folded into `alterations`) and its reason are visible
   * in the breakdown rather than hidden.
   */
  adjustment?: ManualMarkAdjustment | null;
}
/**
 * Display-only per-student attempt + technical signals, alongside the score
 * composition. Both are aggregations of data already held (demand tags +
 * result-status flags); neither changes any score or grade.
 */
export interface StudentSignals {
  /**
   * The student's engagement with the top-difficulty (D3) items: how many of the
   * D3 items presented to them (across all subjects) they actually attempted.
   * `pct` is null when the student had no D3 items.
   */
  d3: { attempted: number; available: number; pct: number | null };
  /** Number of the student's sittings flagged with a technical result status. */
  incidents: number;
}
export interface StudentComposition {
  participantId: string;
  name: string;
  subjects: SubjectComposition[];
  overall: { total: number; max: number; pct: number };
  /** Display-only attempt/technical signals (D3-answered share + incident count). */
  signals: StudentSignals;
}
export interface CompositionModel {
  cycleId: string;
  subjects: { id: string; name: string; shortName: string; hasEssay: boolean }[];
  students: StudentComposition[];
}

// --- Performance report (Students_Performance_Report export) -----------------
export interface PerfElementResult {
  /** Overall performance level for the subject. */
  level: string;
  /** Major element → performance level. */
  elements: Record<string, string>;
  /** Major element → (sub-element → performance level). Finer-grained breakdown. */
  subElements: Record<string, Record<string, string>>;
}
export interface PerfReportStudent {
  participantId: string;
  name: string;
  award: string;
  /** Keyed by assessmentId. */
  subjects: Record<string, PerfElementResult>;
}
export interface PerfReportSubject {
  assessmentId: string;
  name: string;
  majorElements: string[];
  /** Major element → its ordered sub-elements (the construct structure, read from data). */
  subElements: Record<string, string[]>;
}
export interface PerfReportSummarySubject {
  label: string;
  assessmentId: string | null;
}
export interface PerformanceReportModel {
  cycleName: string;
  performanceLevels: string[];
  awardLevels: string[];
  subjects: PerfReportSubject[];
  summarySubjects: PerfReportSummarySubject[];
  students: PerfReportStudent[];
  awardDistribution: { level: string; count: number; pct: number }[];
}

/** Full per-question deep-dive for the Item review right panel. */
export interface ItemDetailModel {
  id: string;
  qLabel: string;
  wording: string | null;
  /** `QuestionDescription` — an internal code/label for the item (may be null). */
  description: string | null;
  /** `QuestionParentQuestionWording` — the stimulus/parent passage shown above
   *  the question (e.g. an English reading/listening passage), or null. */
  parentWording: string | null;
  major: string | null;
  sub: string | null;
  demand: string | null;
  /** The item's maximum score (`QuestionMaximumScore`). */
  maxScore: number;
  excluded: boolean;
  reason: string | null;
  /** Multiple-choice answer options (null when not available for this item). */
  options: AnswerOption[] | null;
  /** Participants who answered (engine n) and were presented the item. */
  answered: number;
  presented: number;
  notAnswered: number;
  pValue: number;
  pRating: QualityRating;
  itemTotal: number | null;
  itRating: QualityRating;
  pointBiserial: number | null;
  pbRating: QualityRating;
  discrimination: number;
  discRating: QualityRating;
  overallReview: QualityRating;
  qualityIndex: number;
  /** Discrimination upper/lower groups (top/bottom ~third by rest-total). */
  groups: { size: number; upperMean: number; lowerMean: number };
  /**
   * Outcome distribution for this dichotomous item — the Questionmark score
   * export carries only correct/incorrect (not the chosen option), so this is the
   * honest response breakdown, not a fabricated per-option A/B/C/D split.
   */
  outcome: { correct: number; incorrect: number; notAnswered: number };
  /** Plain-language reasoning for each statistic's Good/Review/Flag rating. */
  reasons: { p: string; it: string; pb: string; disc: string; overall: string };
}

export interface ReviewModel {
  assessment: AssessmentRef;
  assessments: AssessmentRef[];
  kpis: { items: number; excluded: number; medianDifficulty: number; cohortMean: number };
  items: ItemRow[];
  distribution: number[];
  cohortMean: number;
  cohortSd: number;
  byElement: BreakItem[];
  byDemand: BreakItem[];
}

export interface GradeBandRow {
  /** Named level (e.g. "Exceeds expectations" or "Distinction award"). */
  level: string;
  /** Star string for performance bands; null for award bands. */
  stars: string | null;
  /** Minimum score for this band; null for the lowest (remainder) band. */
  cut: number | null;
  students: number;
  pct: number;
}

export type BoundaryMode = "cuts" | "pct";

export interface BoundaryScopeRef {
  id: string;
  label: string;
}

/**
 * Cohort-level ½-D3 sanity check on the Outstanding cut (Wave 3b Part 3).
 * A WARNING, not a hard clamp — and the precise "cut implies ½-D3" rule is
 * flagged as a methodology nuance for human confirmation (see cut-scores.ts).
 */
export interface D3HalfWarning {
  /** False when the subject has no D3 items or no Outstanding-band students. */
  applicable: boolean;
  /** True when no Outstanding student cleared the cut without ≥ ½ D3 correct. */
  consistent: boolean;
  d3Total: number;
  halfThreshold: number;
  outstandingCount: number;
  belowHalf: number;
  /** Human copy describing the (confirmation-pending) interpretation. */
  note: string;
}

/**
 * The backsolved suggestion derived from the current target distribution — the
 * "what the targets imply" working, shown honestly with target-vs-achieved.
 */
export interface BoundarySuggestion {
  /** Suggested cuts after guard-rails, length L−1. */
  cuts: number[];
  /** Per-cut working (distribution value, clamp, tie, target-vs-achieved). */
  perCut: PerCutSuggestion[];
  /** Targets the suggestion was solved from. */
  targets: number[];
  /** ½-D3 sanity check against the suggested Outstanding cut. */
  d3: D3HalfWarning;
}

export interface BoundaryModel {
  cycleId: string;
  scope: string;
  scopeLabel: string;
  scopes: BoundaryScopeRef[];
  mode: BoundaryMode;
  /** True when the scope is the overall award (different vocabulary). */
  isAward: boolean;
  histogram: number[]; // 51 two-point bins (0..100), participant counts
  /** Levels, best → lowest (length L). */
  levels: string[];
  /** Cut-points, length L−1: cuts[i] is the min score for levels[i]. */
  cuts: number[];
  /** Cohort-% targets for the top L−1 bands (pct mode). */
  targets: number[];
  bands: GradeBandRow[];
  stats: { mean: number; median: number; sd: number; itemsScored: number; excluded: number };
  n: number;
  locked: boolean;
  /** Policy hard bounds (percent of subject max). */
  guardrails: { floorPct: number; ceilingPct: number };
  /** Subject total max (raw marks) — lets the UI show raw cut alongside %. */
  maxRaw: number;
  /** Backsolved suggestion from the CURRENT targets (recomputed every read). */
  suggestion: BoundarySuggestion;
  /**
   * Committed suggestion snapshot, per cut. When a cut equals its snapshot it is
   * "suggested"; when it differs the user has "edited" it. null until a
   * suggestion has been adopted as the editable starting point.
   */
  suggestedCuts: number[] | null;
  /** ½-D3 warning evaluated against the EFFECTIVE (current) Outstanding cut. */
  d3Warning: D3HalfWarning;
}

/**
 * A manual, audited mark adjustment on one student's subject. The delta flows
 * through the existing Alterations input the scoring engine consumes (never by
 * touching item-stats or engine logic), so the grade recomputes through the full
 * path — including the D3 distinction safeguard. Surfaced in the score breakdown
 * so the change (and its reason) is never hidden; reversible via its `id`.
 */
export interface ManualMarkAdjustment {
  /** Stable id, for reversal. */
  id: string;
  participantId: string;
  assessmentId: string;
  /** Subject raw mark before the adjustment (the base, excluding this delta). */
  oldMark: number;
  /** Subject raw mark after the adjustment. */
  newMark: number;
  /** newMark − oldMark — the signed delta fed to the engine as an alteration. */
  delta: number;
  /** Required reason for the override (audited). */
  reason: string;
  /** Actor who made the adjustment (resolved server-side). */
  by: string;
  /**
   * The acting user's stored role at the time of the adjustment — captured so a
   * higher role's override can be gated on the canonical `canOverride` (strictly
   * higher) rule against the role that actually took this action.
   */
  byRole?: Role;
  /** ISO timestamp. */
  ts: string;
}

export interface GradeCell {
  level: string;
  stars: string;
  /**
   * True when the subject score is within the configurable borderline band
   * (percentage points) below the cut for the next grade up — the student just
   * missed it, and a small upward mark adjustment would change the grade.
   */
  marginal?: boolean;
  /** Raw marks needed to reach the next grade up (present when `marginal`). */
  marksToNext?: number;
  /** Percentage points below the next grade-up cut (present when `marginal`). */
  pctToNext?: number;
  /** The next grade up's performance level (for the marginal marker tooltip). */
  nextLevel?: string;
  /** The active manual mark adjustment on this subject cell, if any. */
  adjustment?: ManualMarkAdjustment | null;
}

export interface GradeMatrixRow {
  /** Stable internal key. */
  id: string;
  /** Human Student ID for display (the real ID on live data; pseudonym in the demo). */
  studentId: string;
  label: string;
  /** Per-assessment performance level + stars, keyed by assessment id. */
  grades: Record<string, GradeCell>;
  /** Overall award level. */
  award: string;
  /**
   * Present only when the student's level pattern qualified for Distinction but
   * the D3-majority cap denied it — the visible "why" (e.g. 3/7 correct, majority
   * 4 in the named subject). Null/absent otherwise.
   */
  distinctionCap?: {
    /** Short subject name of the exam that failed the majority. */
    subject: string;
    /** D3 items answered correctly on that exam. */
    correct: number;
    /** D3 items available on that exam. */
    available: number;
    /** The majority threshold (strictly more than half of available). */
    majority: number;
  } | null;
  /** Overall raw score across all subjects (MCQ + essay + alterations). */
  overallRaw: number;
  /** Maximum attainable overall score. */
  overallMax: number;
  /** Overall percentage = overallRaw / overallMax × 100. */
  overallPct: number;
}

export interface GradesModel {
  cycleId: string;
  assessments: AssessmentRef[];
  rows: GradeMatrixRow[];
  /** Distribution over the award levels. */
  distribution: { level: string; count: number }[];
  awardLevels: string[];
  /** Performance level → stars, for the matrix legend. */
  starMap: Record<string, string>;
  performanceLevels: string[];
  locked: boolean;
  canLock: boolean;
}

// --- CGJ (Centre Grade Judgement) — expected-vs-actual comparison ------------
/**
 * How an actual performance level compares to the centre's expectation, by RANK:
 * `match` (same level), `above` (student did better than expected), `below`
 * (worse), `missing` (no expectation supplied, or the student isn't in that
 * subject — nothing to compare).
 */
export type CgjMatch = "match" | "above" | "below" | "missing";

/** One subject cell in the CGJ comparison: centre-expected vs pipeline-actual. */
export interface CgjSubjectCompare {
  assessmentId: string;
  /** Expected performance level from the centre file (null = not supplied). */
  expected: string | null;
  /** Actual performance level the pipeline produced (null = student absent here). */
  actual: string | null;
  match: CgjMatch;
}

/** One student row: their centre-expected vs actual levels across every subject. */
export interface CgjStudentRow {
  participantId: string;
  studentId: string;
  name: string;
  /** Per-subject expected-vs-actual, keyed by assessment id. */
  subjects: Record<string, CgjSubjectCompare>;
  /** True when this student was found in the uploaded centre file. */
  inCentreFile: boolean;
  /** Per-row tally over the subjects that had BOTH an expectation and an actual. */
  summary: { matched: number; above: number; below: number; compared: number };
}

/**
 * One row of the assumed PLD→award alignment (O2 — open for G12). Surfaced as a
 * labelled assumption; never used to recompute an award.
 */
export interface PldAwardMapEntry {
  performanceLevel: string;
  awardLevel: string;
}

export interface CgjModel {
  cycleId: string;
  /** Whether a centre expectations file has been uploaded for this sitting. */
  uploaded: boolean;
  /** True when populated from the labelled sample rather than a real file. */
  sample: boolean;
  fileName: string | null;
  assessments: AssessmentRef[];
  rows: CgjStudentRow[];
  /** Performance levels best → lowest (the comparison vocabulary). */
  performanceLevels: string[];
  /** Award levels best → lowest. */
  awardLevels: string[];
  /** Tally across every compared subject cell (both expectation + actual present). */
  counts: {
    studentsInFile: number;
    /** Centre-file students not matched to a roster student. */
    unmatchedStudents: number;
    matched: number;
    above: number;
    below: number;
    compared: number;
  };
  /**
   * The ASSUMED PLD→award mapping (O2). Rendered as a labelled assumption in the
   * UI; not signed off and not baked into grading.
   */
  pldAwardMap: PldAwardMapEntry[];
  /** Always true here — the mapping above is unconfirmed (drives the UI banner). */
  pldAwardMapAssumed: boolean;
}

// --- Overall (best-of-two across the year's two sittings) --------------------
/** Which sitting a chosen per-subject result came from. */
export type OverallSource = "february" | "may";

/**
 * One subject cell in the Overall (best-of-two) view: the HIGHER of the two
 * sittings' performance levels, with provenance (which sitting it came from) and
 * the raw per-sitting levels for transparency. The comparison is by performance
 * level RANK (best → lowest), never by raw score.
 */
export interface OverallGradeCell {
  /** The chosen (higher) performance level. */
  level: string;
  stars: string;
  /** Which sitting supplied the chosen level (the visible Feb/May tag). */
  source: OverallSource;
  /** Level recorded in the February sitting (null = no February result). */
  februaryLevel: string | null;
  /** Level recorded in the May sitting (null = no May result). */
  mayLevel: string | null;
}

export interface OverallGradeRow {
  /** Stable key — the human Student ID, which matches across the two sittings. */
  id: string;
  studentId: string;
  label: string;
  /** Best-of-two per assessment id. */
  grades: Record<string, OverallGradeCell>;
  /**
   * Overall award DERIVED from the best-of-two per-subject levels via the
   * existing award-derivation rule. The per-sitting D3 safeguard is NOT re-run at
   * the Overall level (each sitting's award is already signed-off, safeguard-checked).
   */
  award: string;
  /** Whether the student appeared in each sitting. */
  inFebruary: boolean;
  inMay: boolean;
}

export interface OverallGradesModel {
  yearId: string;
  yearName: string;
  /** Subjects (union across the two sittings — uses the populated sitting's refs). */
  assessments: AssessmentRef[];
  rows: OverallGradeRow[];
  /** Distribution over the award levels (derived overall awards). */
  distribution: { level: string; count: number }[];
  awardLevels: string[];
  starMap: Record<string, string>;
  performanceLevels: string[];
  february: { cycleId: string | null; cycleName: string | null } | null;
  may: { cycleId: string | null; cycleName: string | null } | null;
  /** True when both sittings are locked (signed off) — Overall is final / certifiable. */
  ready: boolean;
  /** Alias of `ready`: certificates issue only from a signed-off Overall. */
  locked: boolean;
  /**
   * True when the February sitting is DEMO data synthesized from the May cohort.
   * In this build only the live (May) sitting carries real grades and live
   * Supabase is unreachable, so the February baseline is generated locally to
   * exercise the best-of-two rollup. With real two-sitting data this is false.
   */
  demo: boolean;
  note: string;
}

// --- Overall analytics (bird's-eye programme view over time × centres) -------
/**
 * The read-model behind the "Overall" analytics page — a bird's-eye view of
 * programme performance over time across partner centres. It is computed on read
 * from the persisted per-sitting outputs (`computeOverallAnalytics`), grouped by
 * centre × year × sitting × subject, and honours the locked methodology:
 *
 *  1. Combined = best-of-two AWARD (per student × subject, higher performance
 *     LEVEL across the two sittings, then the award rule on the rolled-up levels).
 *     There is no numeric combined score — under Combined only level data exists.
 *  2. Improvement = movement in performance-LEVEL rank (February → May, same
 *     students): `gain` = average levels gained; `up` = % who moved up ≥1 level.
 *  3. Pass = any award above the lowest band ("Record of Learning"). Per-subject
 *     "pass" (a single sitting's score stats) = performance level ≥ Meets.
 *  4. The app only knows who SAT (Questionmark exports) — no "registered" concept.
 *  6. Score statistics (mean/median/high/low/SD) exist only per single sitting.
 */

/** One overall award band (ordinal ramp, best → worst), from the grading config.
 *  The engine's internal lowest band ("No Award") is exposed here as "Record of
 *  Learning". */
export interface AwardBand {
  key: "dist" | "adv" | "sec" | "rol";
  name: string;
  short: string;
}

/** One per-subject performance level (ordinal ramp, best → worst). */
export interface PLevel {
  key: "out" | "exc" | "meet" | "not";
  name: string;
  short: string;
}

/** Score statistics for ONE single sitting (February or May) of one subject.
 *  These are raw-score percentages — they exist only per sitting, never under
 *  Combined. `pass` is the per-subject pass rate (% at performance level ≥ Meets). */
export interface SittingStats {
  mean: number;
  median: number;
  high: number;
  low: number;
  sd: number;
  pass: number;
}

/** One subject × year cell in the performance view. */
export interface SubjectYear {
  /** February single-sitting score stats; null when there is no February sitting. */
  feb: SittingStats | null;
  /** May single-sitting score stats; null when there is no May sitting. */
  may: SittingStats | null;
  /** Best-of-two performance-LEVEL distribution, as % (sums ~100). */
  levels: Record<"out" | "exc" | "meet" | "not", number>;
  /** February→May level movement (same students); null when < 2 sittings exist. */
  change: { gain: number; up: number } | null;
}

/** Participation for one year (aggregated across the year's centres). Pass rates
 *  are %, pass = overall award above the lowest band. */
export interface ParticipationYear {
  centres: number;
  satFeb: number;
  satMay: number;
  both: number;
  passFeb: number;
  passMay: number;
  passComb: number;
}

/** Overall (best-of-two) award distribution for one year/centre, as % (sums ~100). */
export interface AwardDistYear {
  dist: number;
  adv: number;
  sec: number;
  rol: number;
}

/** Best / worst / mean of a per-centre headline metric across the year's centres. */
export interface CentreSpreadYear {
  best: number;
  worst: number;
  mean: number;
}

/** Per-subject spread of a per-centre metric across the year's centres. */
export interface CentreSubjectSpread {
  mean: number;
  best: number;
  worst: number;
  sd: number;
}

/** Optional filter for `getOverallAnalytics`. `centres` re-pools every figure
 *  from just the named centres (the cells are filtered by centre name before
 *  `computeOverallAnalytics` re-runs). Empty/omitted = the full programme view. */
export interface OverallAnalyticsFilter {
  centres?: string[];
}

export interface OverallAnalytics {
  /** Live years present, ascending. */
  years: number[];
  /** Centre names present. */
  centres: string[];
  /** Subjects present (union across cells), each with a stable key. */
  subjects: { key: string; name: string; short: string; rtl?: boolean }[];
  /** Award bands, ordinal ramp best → worst (from the grading config). */
  awards: AwardBand[];
  /** Performance levels, ordinal ramp best → worst. */
  plevels: PLevel[];
  /** Participation per year: `[year]`. */
  participation: Record<number, ParticipationYear>;
  /** Performance per subject/year: `[subjectKey][year]`. */
  perf: Record<string, Record<number, SubjectYear>>;
  /** Overall (best-of-two) award distribution per year: `[year]`. */
  awardDist: Record<number, AwardDistYear>;
  /** Overall award distribution per centre, per year: `[year][centreName]`. */
  awardByCentre: Record<number, Record<string, AwardDistYear>>;
  /** Best/worst/mean pass rate across centres per year: `[year]`. */
  centreAwardSpread: Record<number, CentreSpreadYear>;
  /** Per-subject best/worst/mean/SD across centres per year: `[subjectKey][year]`. */
  centreSubjectSpread: Record<string, Record<number, CentreSubjectSpread>>;
  /** True iff ≥ 2 REAL years exist (drives whether real comparison is shown). */
  hasComparison: boolean;
}

export type DuplicateStrategy = "keep_latest" | "keep_first" | "exclude";

// --- Settings → grading defaults --------------------------------------------
export interface GradingDefaultsModel {
  performanceLevels: string[];
  starMap: Record<string, string>;
  awardLevels: string[];
  performanceCuts: number[];
  awardCuts: number[];
  /** True when the award-derivation rule is still the unverified placeholder. */
  awardRuleUnconfirmed: boolean;
}

// --- Document generation (Student Summary from locked grades) ----------------
export interface SubjectResult {
  /** Canonical template slot S1..S5. */
  slot: string;
  /** The suite assessment mapped to this slot (by alias). */
  assessment: string;
  level: string;
  stars: string;
  /**
   * Which sitting supplied this best-of-two level (Overall documents only). Lets
   * performance reports carry the same Feb/May provenance the Overall table shows.
   * Undefined for a per-sitting document or a subject with no result.
   */
  source?: OverallSource;
}

/** One sub-element's achieved level within a major element (unofficial report). */
export interface UnofficialSubElement {
  sub: string;
  level: string;
  stars: string;
}
/** One major element's achieved level + its sub-elements (unofficial report). */
export interface UnofficialElement {
  major: string;
  level: string;
  stars: string;
  subs: UnofficialSubElement[];
}
/** One subject's element/sub-element breakdown for the unofficial diagnostic report. */
export interface UnofficialSubject {
  slot: string;
  assessment: string;
  level: string;
  stars: string;
  elements: UnofficialElement[];
}

export interface StudentSummary {
  /** Maps to the {{RESULTID}} token. */
  participantId: string;
  name: string;
  /** Overall award level. */
  award: string;
  /** Per-subject performance level + stars, in canonical S1..S5 order. */
  subjects: SubjectResult[];
  /**
   * Per-subject major-element / sub-element breakdown for the UNOFFICIAL
   * diagnostic report (richer than the official certificate/performance report).
   * Populated only when grades are locked. Marked clearly as unofficial in the UI.
   */
  unofficial?: UnofficialSubject[];
}

export interface DocSettings {
  cycleName: string;
  testCentre: string;
  examDate: string;
  issueDate: string;
}

/**
 * One open methodology decision that gates REAL certificate issuance. Drafts can
 * always be exported (watermarked); official certificates may not be issued until
 * every decision here is `confirmed` by G12.
 */
export interface IssuanceDecision {
  /** Stable reference used in the UI and audit trail (e.g. "O1", "O2"). */
  id: string;
  /** Short human title. */
  title: string;
  /** What G12 must decide before real certificates can carry these results. */
  detail: string;
  /** True once G12 has signed this decision off in the system. */
  confirmed: boolean;
}

/** The pre-issue sign-off state surfaced on the Generate-certificates screen. */
export interface IssuanceSignOff {
  decisions: IssuanceDecision[];
  /** True only when every decision is confirmed — real (non-draft) issuance is permitted. */
  cleared: boolean;
}

/** Stable id for each hard issuance gate (see `IssuanceReadiness`). */
export type IssuanceGateId = "scores" | "locked" | "signoff" | "live";

/**
 * One hard gate that must be satisfied before OFFICIAL (non-draft) issuance.
 * Draft/preview ignores these — they are always available — so corrupted or
 * provisional data can be inspected but never issued.
 */
export interface IssuanceGate {
  id: IssuanceGateId;
  /** Short label for the checklist row. */
  label: string;
  /** True when this gate is satisfied. */
  met: boolean;
  /** What the gate checks / why it is (un)met — shown under the label. */
  detail: string;
}

/**
 * The full pre-issue gate set for Overall certificate/report issuance. Official
 * issuance is permitted only when EVERY gate is met; draft/preview is always fine.
 */
export interface IssuanceReadiness {
  gates: IssuanceGate[];
  /** True only when every gate is met — official (non-draft) issuance permitted. */
  officialAllowed: boolean;
  /** First unmet gate's reason, for a one-line blocked message (null when allowed). */
  blockedReason: string | null;
}

export interface DocumentsModel {
  cycleId: string;
  /**
   * True once all contributing sittings are locked/signed off. Note: `students`
   * is populated regardless (provisional or final) so draft proofs and the
   * preview always work; `locked` only gates OFFICIAL issuance via `readiness`.
   */
  locked: boolean;
  students: StudentSummary[];
  settings: DocSettings;
  /** Canonical slot → assessment mapping for display. */
  subjectOrder: { slot: string; assessment: string }[];
  /**
   * Pre-issue methodology sign-off (O1/O2). Present on the Overall documents
   * model; until `cleared`, only draft proofs may be exported. Optional so the
   * per-sitting documents model (drafts/diagnostics only) need not carry it.
   */
  signOff?: IssuanceSignOff;
  /**
   * Hard issuance gates (scores reconciled, sittings locked, O1/O2 signed off, no
   * synthetic data). Official issuance requires `readiness.officialAllowed`; draft
   * and preview are always available. Present on the Overall documents model.
   */
  readiness?: IssuanceReadiness;
}

// --- Users & access (Settings) ----------------------------------------------
export type MemberStatus = "active" | "invited";

export interface Member {
  id: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  status: MemberStatus;
  lastActive: string;
  /** True when this row IS the authenticated user (matched on the session id). */
  isCurrent: boolean;
  /** Membership scope: workspace-wide vs a specific cycle (real memberships). */
  scope?: string;
}

export interface MembersModel {
  members: Member[];
  roles: { id: string; name: string }[];
}

// --- Audit log --------------------------------------------------------------
export type AuditType =
  | "exclude"
  | "boundary"
  | "lock"
  | "reopen"
  | "export"
  | "document"
  | "upload"
  | "cycle"
  | "validate"
  /** Per-student technical exclusion / keep, and Distinction-safeguard caps & overrides. */
  | "student"
  | "safeguard"
  /** Workspace settings: quality thresholds, grading vocabulary, roles. */
  | "config"
  /** An authorised user reversing another user's grade-bearing action. */
  | "override";

export interface AuditEntry {
  id: string;
  /** ISO timestamp. */
  ts: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  type: AuditType;
  action: string;
  detail: string;
  cycleId: string | null;
  /** True for the seeded illustrative entries (not from this session's actions). */
  seeded: boolean;
  /** True when this entry is an override of another user's action. */
  isOverride?: boolean;
  /** The actor whose action was overridden (display name), when isOverride. */
  priorActor?: string | null;
  /** The required reason captured for an override. */
  reason?: string | null;
}

export interface AuditModel {
  entries: AuditEntry[];
  total: number;
}

// --- Audit & overrides view (admin check-in surface) ------------------------
/**
 * One grade-bearing decision currently in effect for a cycle, with provenance.
 * Powers the admin "Audit & overrides" surface: it shows the CURRENT effective
 * state (not just history) and, where the current state is the result of an
 * override, who overrode whom and why — so nothing looks silently changed.
 */
export interface EffectiveDecision {
  /** Stable key for the row + the override control. */
  key: string;
  /** What kind of grade-bearing action this is. */
  kind: "item_exclusion" | "mark_adjustment";
  /** Human label for the target (e.g. "English 2nd Lang · Q23"). */
  target: string;
  assessmentId: string;
  /** The item id (item_exclusion) — the override control needs it. */
  itemId?: string;
  /** The participant id (mark_adjustment). */
  participantId?: string;
  /** Current effective state, in words (e.g. "Excluded", "+2 marks"). */
  state: string;
  /** Whether the item is currently excluded (item_exclusion only). */
  excluded?: boolean;
  /** Who set the current state, and when. */
  decidedBy: string;
  decidedAt: string;
  /** The role tier (label) that set the current state — the override subject. */
  decidedByRole: string;
  reason: string | null;
  /**
   * Whether the SIGNED-IN user may override THIS decision — true only when their
   * role is strictly higher than the role that took it (`canOverride`), the
   * sitting isn't locked. Drives the per-row Override control; the top-level
   * `canOverride` only says whether the user has override rights at all.
   */
  canOverride: boolean;
  /** Present when the current state is the result of an override. */
  override?: {
    by: string;
    priorActor: string | null;
    reason: string;
    ts: string;
  } | null;
}

export interface OverrideViewModel {
  cycleId: string;
  /**
   * Whether the signed-in user has override rights on this sitting AT ALL (i.e.
   * their role can override at least the lowest tier — analyst or admin — and the
   * sitting isn't locked). Whether a SPECIFIC decision can be overridden is the
   * per-decision `EffectiveDecision.canOverride` (strictly-higher-than-the-setter).
   */
  canOverride: boolean;
  decisions: EffectiveDecision[];
  counts: { decisions: number; overridden: number };
}

export type AuditFilter = "all" | "exclude" | "boundary" | "lock" | "export";

// --- Analytics (Settings/Analytics area) ------------------------------------
/** How to format a KPI's per-cycle `points` value when the selected cycle changes. */
export type KpiFormat = "int" | "intComma" | "pct";

export interface TrendKpi {
  label: string;
  value: string;
  delta: string;
  points: number[];
  /** Format hint so any selected cycle's point can be rendered consistently. */
  format: KpiFormat;
}

export interface AssessmentTrend {
  name: string;
  points: number[];
  now: string;
  delta: string;
}

export interface AnalyticsTrends {
  /** Short cycle labels oldest → newest (the last is the real live cycle). */
  cycleLabels: string[];
  /** Full cycle names, parallel to `cycleLabels` (for explicit labelling + the selector). */
  cycleNames: string[];
  /** Index of the current (live) cycle within the arrays — the default selection. */
  currentIndex: number;
  kpis: TrendKpi[];
  byAssessment: AssessmentTrend[];
  /** Award-distribution percentages per cycle (oldest → newest). */
  awardOverTime: { label: string; dist: Record<string, number> }[];
  awardLevels: string[];
  /** True when prior cycles are mock (no real history). */
  priorsAreMock: boolean;
}

// --- Configuration (Settings) -----------------------------------------------
export interface QualityThresholdRow {
  metric: string;
  good: string;
  review: string;
  flag: string;
}

/**
 * Borderline (marginal) flagging band — a workspace config value the engine reads
 * when flagging students just below a grade boundary. `bandPct` is the symmetric
 * ±% window (percentage points) around each threshold; the flag fires for the
 * just-below side, feeding the mark-adjustment workflow. Grade-bearing input:
 * editing it re-flags through the full grade recompute (incl. the D3 safeguard).
 */
export interface BorderlineConfig {
  /** Borderline band, in percentage points. Bounds enforced server-side. */
  bandPct: number;
}

/**
 * Incident Adjustments configuration read-model. The registry of incident codes,
 * the per-student global cap and the reconfigurable column mapping, plus whether
 * the current user may EDIT it (admin only — lower roles view read-only).
 */
export interface IncidentConfigModel extends IncidentAdjustmentConfig {
  canEdit: boolean;
}

/**
 * Incident Adjustments — per-student REVIEW surface (02b). The team's sanity-check
 * of the auto-apply engine before results are finalised: for each student, the
 * base engine score, the cumulative (capped) incident mark change, the adjusted
 * total, and the per-incident breakdown that produced it — with cap-binding flags.
 *
 * The adjustment is a bounded layer ON TOP of base scores: `adjusted = base +
 * adjustment` is decomposable at all times, and the base column is the untouched
 * engine figure (it reconciles 1:1 with the raw oracle). Viewable by ALL roles;
 * only an admin may commit/apply (`canApply`).
 */
export interface IncidentReviewContribution {
  rowNumber: number;
  incidentType: string;
  questionNumber: string;
  durationMinutes: number | null;
  status: "ok" | "unclassified" | "error";
  /** Matched code (null when unclassified / errored). */
  code: string | null;
  codeLabel: string | null;
  /** Un-capped formula marks, and marks after the per-incident cap. */
  rawMarks: number;
  marks: number;
  perCodeCap: number | null;
  perCodeCapHit: boolean;
  errors: string[];
}
export interface IncidentReviewStudent {
  participantKey: string;
  /** Resolved cohort UUID, or null when the incident row matched no participant. */
  participantId: string | null;
  name: string;
  /** Base engine total (sum of the student's subject raw scores) — untouched. */
  base: number;
  /** The cumulative incident mark change actually applied (capped, add-only ≥ 0). */
  adjustment: number;
  /** Sum before the per-student global cap — shown when the global cap bound. */
  uncappedAdjustment: number;
  /** base + adjustment. */
  adjusted: number;
  perStudentCapHit: boolean;
  perCodeCapHit: boolean;
  /** True when the row could not be matched to a cohort participant. */
  unmatched: boolean;
  contributions: IncidentReviewContribution[];
}
export interface IncidentReviewModel {
  cycleId: string;
  /** True once an admin has committed the adjustments to scores (explicit action). */
  applied: boolean;
  appliedBy: string | null;
  appliedAt: string | null;
  /** Whether the current user may commit/apply (admin only). */
  canApply: boolean;
  /** The per-student global cap in force (null = no cap), for display. */
  perStudentCap: number | null;
  /** What incident data is loaded — the file name and whether it is the labelled
   *  sample (null when nothing is imported). Lets the step surface show the source
   *  and make clear how to replace the sample with a real incident log. */
  source: { fileName: string; sample: boolean } | null;
  students: IncidentReviewStudent[];
  /** Incident rows that matched no cohort participant — surfaced for manual attention. */
  unmatched: IncidentReviewStudent[];
  counts: {
    incidents: number;
    students: number;
    ok: number;
    unclassified: number;
    error: number;
    unmatched: number;
    /** Students whose adjusted total was bound by the per-student global cap. */
    perStudentCapHits: number;
    /** Incidents whose marks were bound by their per-code cap. */
    perCodeCapHits: number;
  };
}

export interface ConfigModel {
  /** The engine's active rating thresholds (read-only — they drive item ratings). */
  thresholds: QualityThresholdRow[];
  safeguard: SafeguardConfig;
  /** The configurable borderline (marginal) flagging band (percentage points). */
  borderline: BorderlineConfig;
}

// --- New cycle --------------------------------------------------------------
export interface NewCycleAssessment {
  id: string;
  name: string;
  rtl: boolean;
  included: boolean;
  fileName: string | null;
}

export interface NewCycleModel {
  defaultName: string;
  sittingDate: string;
  assessments: NewCycleAssessment[];
  /** 0010 — active test centres to choose from (the sitting is created under one). */
  testCentres: TestCentreSummary[];
  /** Pre-selected centre (first active centre), or null when none exist yet. */
  defaultTestCentreId: string | null;
}

export interface CreateCycleInput {
  name: string;
  sittingDate: string;
  assessmentIds: string[];
  /** 0010 — the test centre to create this sitting (and its year) under. */
  testCentreId: string;
}

// --- Per-student technical exclusions (Student review step) ------------------
export type IncidentDecision = "excluded" | "kept" | null;

export interface TechnicalIncident {
  id: string;
  studentId: string;
  studentName: string;
  assessmentId: string;
  assessmentName: string;
  itemId: string | null; // null when the row couldn't be matched to a real item
  questionLabel: string;
  demand: string | null;
  wording: string | null;
  rtl: boolean;
  error: string;
  decision: IncidentDecision;
  reason: string | null;
  by: string | null;
  at: string | null;
}

export interface StudentReviewModel {
  cycleId: string;
  uploaded: boolean;
  sample: boolean;
  fileName: string | null;
  incidents: TechnicalIncident[];
  counts: { incidents: number; excluded: number; kept: number; awaiting: number; students: number };
}

// --- Distinction safeguard (grading stage) ----------------------------------
export type SafeguardResult = "pass" | "capped" | "override";

export interface DistinctionCandidate {
  id: string;
  name: string;
  /** D3 items answered correctly on the selected exam scope. */
  topDifficultyCorrect: number;
  /** D3 items available on the selected exam scope (after exclusions). */
  topDifficultyAvailable: number;
  /** Majority threshold for the selected scope (strictly more than half of available). */
  majority: number;
  /** Whether the student cleared the majority on the selected scope. */
  meets: boolean;
  provisionalAward: string;
  cappedAward: string;
  result: SafeguardResult;
  /** The visible "why" when capped (the failing exam's working); null otherwise. */
  capReason: string | null;
  overrideReason: string | null;
  overrideBy: string | null;
}

export interface DistinctionSafeguardModel {
  cycleId: string;
  threshold: number;
  topDifficultyDemand: string;
  topDifficultyPool: number;
  scope: string;
  scopes: { id: string; label: string }[];
  topAward: string;
  cappedTo: string;
  candidates: DistinctionCandidate[];
  counts: { inLine: number; meet: number; capped: number; overridden: number };
  canOverride: boolean;
  /** Explains the D3 metric: correct (not attempts) vs the dynamic majority of available. */
  attemptedNote: string;
}

// --- Safeguard configuration (Settings → Configuration) ----------------------
export interface SafeguardConfig {
  /**
   * Which demand level counts as "top-difficulty" (D3) for the per-student
   * Distinction safeguard. This genuinely drives the engine — the safeguard reads
   * the D3 pool from this demand level. The *threshold* is NOT a fixed count: it
   * is the dynamic majority of the available D3 items on each exam (see
   * `d3MajorityThreshold` / `passesD3Majority`), so there is no editable "minimum
   * questions" knob.
   */
  topDifficultyDemand: string;
  demandLevels: string[];
}
