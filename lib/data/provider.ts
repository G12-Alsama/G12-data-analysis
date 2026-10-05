/**
 * DataProvider — the repository interface every screen talks to. This is the
 * swap point for persistence, mirroring the discipline used for the computation
 * engine.
 *
 * ## Swap point (read before wiring Supabase)
 *
 * The UI imports only this interface and the read-model types in `./types`. The
 * current implementation, `InMemoryDataProvider`, seeds itself from genuine
 * engine output (`seed.generated.json`) and keeps decisions (exclusions,
 * boundaries, locks) in memory — they reset on reload. To go live:
 *   1. Implement `DataProvider` with a class backed by Supabase (queries +
 *      the SECURITY DEFINER RPCs from migration 0001), mapping rows to the same
 *      read models.
 *   2. Provide it through `DataProviderContext` instead of the in-memory one.
 * No screen or component changes — only the provider does.
 */

import type { AssembleScoreAnalysisArgs, AssembleItemAnalysisArgs } from "@/lib/export/types";
import type { CleanResponse, ValidationReport } from "@/lib/ingest/types";
import type { PerItemSource } from "@/lib/data/per-item-source";
import type { CanonicalModel } from "@/lib/ingest/qm";

/**
 * Schema drift report — whether the live DB has the columns/functions the code
 * requires. `ok` false means a migration hasn't been run (see `migration`); the
 * app surfaces this so "did you run the migration?" is answered by the app, not
 * by a failed import. The in-memory demo has no DB, so it is always `ok`.
 */
export interface SchemaHealth {
  ok: boolean;
  migration: string;
  missingColumns: string[];
  missingFunctions: string[];
}
import type {
  AnalyticsTrends,
  OverallAnalytics,
  OverallAnalyticsFilter,
  AuditFilter,
  AuditModel,
  OverrideViewModel,
  BoundaryMode,
  ConfigModel,
  CreateCycleInput,
  CurrentUser,
  CycleDetail,
  CycleLoadState,
  CycleSummary,
  TestCentreSummary,
  YearSummary,
  YearDetail,
  DocSettings,
  DocumentsModel,
  DuplicateStrategy,
  GradesModel,
  CgjModel,
  OverallGradesModel,
  GradingDefaultsModel,
  IngestModel,
  CombinedSplitModel,
  RawDataModel,
  DataCleaningModel,
  CleanedDataModel,
  CleaningImpactModel,
  CleaningSummaryModel,
  CleanedMasterDataset,
  NaiveScoresModel,
  MembersModel,
  NewCycleModel,
  PerformanceReportModel,
  ReviewModel,
  ItemDetailModel,
  BoundaryModel,
  BorderlineConfig,
  StudentReviewModel,
  DistinctionSafeguardModel,
  EssayMarksModel,
  EssayUploadContext,
  AdjustmentsModel,
  CompositionModel,
  DiagnosticsModel,
  ReliabilityModel,
  IncidentDecision,
  IncidentConfigModel,
  IncidentReviewModel,
} from "./types";
import type { IncidentCodeInput, IncidentColumnMapping } from "@/lib/incidents/types";
import type { ResolvedIncidentRow, RosterParticipant } from "@/lib/incidents/import";
import type {
  ExamIncidentMatchContext,
  ExamIncidentRecord,
  ExamIncidentReconciliation,
} from "@/lib/incidents/exam-incident-match";
import type { GradingConfig } from "./grading";
import type { ElementLabelsConfig } from "./element-labels";
import type { ScoringConfig, QualityThresholds } from "@/lib/engine";
import type { ActionDef, ActionKey, Role } from "@/lib/auth/actions";

/** One row of the optional technical-errors spreadsheet (columns: student, question, error). */
export interface TechnicalErrorRow {
  student: string;
  question: string;
  error: string;
}

/** One row of the optional incident log / complaints file (free-text, untriaged). */
export interface IncidentInput {
  source: "incident_log" | "complaint";
  /** Free-text student name from the file. */
  studentName: string;
  /** Exam code (AM/ST/AFL/ESL…) — incident_log only. */
  exam?: string;
  issueType?: string;
  actionTaken?: string;
  questionsAffected?: string;
  staff?: string;
  // complaint-only fields
  email?: string;
  school?: string;
  description?: string;
}

/** A human triage decision recorded against one incident on the Adjustments screen. */
export interface IncidentDecisionInput {
  /** Who the alteration applies to (null = undecided). */
  applyTo: "student" | "subject" | "none";
  /** Roster student id when applyTo === "student". */
  studentId?: string | null;
  /** Subject (assessment) id for the alteration; defaulted from the exam code. */
  subjectId?: string | null;
  /** Raw marks added (+) or subtracted (−). */
  marks?: number;
  reason?: string | null;
}

/**
 * One row of the optional CGJ centre-expectations file: a student plus their
 * expected level per subject. `levels` is keyed by the raw subject header from
 * the file (a code like "AM"/"ESL" or a full subject name); the provider resolves
 * those to assessments and normalises the level strings.
 */
export interface CgjUploadRow {
  studentName: string;
  levels: Record<string, string>;
}

/** One resolved essay mark handed to `uploadEssayMarks` (one per student per subject). */
export interface EssayUploadRow {
  /** The join key from the fixed template — the student's QM email (lower-cased). */
  participantId: string;
  /** Subject sheet code: AFL (Arabic 1st Language) or ESL (English 2nd Language). */
  subjectCode: "AFL" | "ESL";
  /**
   * The ONE subject essay /20 for this student, read directly from the template's
   * `Final essay mark (/20)` column (after `ESSAY_MARK_ROUNDING`). Exactly one row
   * per student, so the provider's averaging is identity and the value reaches the
   * engine at FULL weight (against the reserved /20 max — never halved again).
   */
  totalScore: number;
  /**
   * How many essays this row represents, for the "pending" disclosure only. The
   * fixed-template flow emits ONE row per student (essayCount 1). Never used as the
   * averaging divisor.
   */
  essayCount?: number;
}

export interface SetBoundaryInput {
  mode?: BoundaryMode;
  /** Replace the whole cut-point array. */
  cuts?: number[];
  /** Replace the whole target-% array. */
  targets?: number[];
  /** Update a single cut-point (drag / type). */
  cutIndex?: number;
  cutValue?: number;
  /** Update a single target %. */
  targetIndex?: number;
  targetValue?: number;
  /**
   * Drag a handle in "Set distribution" mode: a dragged score-axis position is
   * translated into the implied target share for that band, then the existing
   * Wave 3b backsolver re-solves so the handle settles at the nearest achievable
   * cut. Same underlying value as the table's % column (two-way sync).
   */
  dragTargetIndex?: number;
  dragScoreValue?: number;
  /**
   * Backsolve cuts from the current targets, store them as the editable starting
   * point + snapshot, and switch to "cuts" mode. Used for both "use suggestion"
   * and "re-suggest".
   */
  suggest?: boolean;
  /** Reset a single cut back to the stored suggestion snapshot. */
  resetCutIndex?: number;
  /** Reset all cuts back to the stored suggestion snapshot. */
  resetToSuggestion?: boolean;
  /**
   * Mark a cut as a deliberate waiver of a guard-rail (value knowingly set
   * outside policy bounds). Recorded in the audit trail; the value is NOT
   * silently re-clamped.
   */
  waiveGuardrail?: boolean;
}

/**
 * The authoritative ingest roster read from the `sittings` spine (migration 0026).
 * Every INGEST-stage participant count reads from here (staff INCLUDED) instead of
 * the MCQ `responses` matrix, so the UI matches `count(distinct participant_email)`
 * in the DB.
 */
export interface SittingRoster {
  /** assessmentId → (participant row id → participant email) for that subject. */
  byAssessment: Map<string, Map<string, string>>;
  /** Distinct participant emails across the whole cycle (staff included). */
  totalParticipants: number;
}

export interface DataProvider {
  // identity / auth (mocked for now)
  getCurrentUser(): CurrentUser;

  // reads
  /**
   * Year list (the home screen). Each year groups its February + May sittings.
   * `listCycles` remains the per-sitting list used internally and by the
   * pipeline; a year is just a grouping over it.
   */
  listYears(): YearSummary[];
  /** One year opened: its February / May sittings + the (stubbed) Overall. */
  getYear(yearId: string): YearDetail | null;
  listCycles(): CycleSummary[];
  getCycle(cycleId: string): CycleDetail | null;
  /**
   * Lazy loading. The live provider holds each sitting's detailed data separately and
   * loads it only when the sitting is opened. `getCycleLoadState` says whether a
   * sitting's pipeline reads are ready; `ensureCycleLoaded` loads it (idempotent,
   * concurrent callers share one load); `ensureYearLoaded` loads the sittings an
   * Overall needs (the year's LOCKED ones). The in-memory demo is always "ready".
   */
  getCycleLoadState(cycleId: string): CycleLoadState;
  ensureCycleLoaded(cycleId: string): Promise<void>;
  ensureYearLoaded(yearId: string): Promise<void>;
  getIngest(cycleId: string): IngestModel | null;
  /**
   * The authoritative per-sitting ingest roster (migration 0026 `sittings`): which
   * participants sat each subject, staff INCLUDED. Every ingest-stage participant
   * count (`count(distinct participant_email)`) reads from this, not the MCQ
   * response matrix. Null when the cycle is unknown.
   */
  getSittingRoster(cycleId: string): SittingRoster | null;
  /** Combined-upload detection: subjects split out of the single export. */
  getCombinedSplit(cycleId: string): CombinedSplitModel | null;
  /** Raw "show me my data" view for one subject (summary + breakdown + matrix). */
  getRawData(cycleId: string, assessmentId: string): RawDataModel | null;
  /** Data-cleaning view for one subject (validation report + raw matrix). */
  getDataCleaning(cycleId: string, assessmentId: string): DataCleaningModel | null;
  /** Cleaned-set view in the QM cleaned-export column layout (mirrors the Excel). */
  getCleanedData(cycleId: string, assessmentId: string): CleanedDataModel | null;
  /**
   * Live before/after "cleaning impact" figures for the Clean tab's top panel:
   * participants, per-subject records, and per-`QuestionMajorElement` records,
   * each as full-ingested (before) vs post-clean (after). Recomputes on every
   * soft-delete / restore / undo.
   */
  getCleaningImpact(cycleId: string): CleaningImpactModel | null;
  /**
   * Fuller Clean "Summary" statistics (no per-row data): per-subject score
   * distribution + completion counts by ResultStatus, before vs after cleaning.
   * Scored exams only; uses the engine's scored denominator.
   */
  getCleaningSummary(cycleId: string): CleaningSummaryModel | null;
  /**
   * The cleaned master dataset as one flat sheet (canonical columns, all scored
   * exams), reflecting the current post-clean state — the source for the Clean
   * "Export to Excel" workbook.
   */
  getCleanedMasterDataset(cycleId: string): CleanedMasterDataset | null;
  /** Naive (pre-exclusion) overall scores for one subject. */
  getNaiveScores(cycleId: string, assessmentId: string): NaiveScoresModel | null;
  getReview(cycleId: string, assessmentId: string): ReviewModel | null;
  /** Full per-question deep-dive for the Item review right panel. */
  getItemDetail(cycleId: string, assessmentId: string, itemId: string): ItemDetailModel | null;
  getBoundaries(cycleId: string, scope: string): BoundaryModel | null;
  getGrades(cycleId: string): GradesModel | null;
  /**
   * The year's Overall (best-of-two) grades: per student, per subject, the higher
   * award of the February and May sittings, with Feb/May provenance, plus the
   * derived overall award. Aggregation only — consumes each sitting's signed-off
   * awards (does not re-run scoring, cut scores, or the safeguard).
   */
  getOverallGrades(yearId: string): OverallGradesModel | null;
  /** Certificates & reports built from the Overall result (not a single sitting). */
  getOverallDocuments(yearId: string): DocumentsModel | null;
  /** Per-student performance + per-element levels for the performance-report export. */
  getPerformanceReport(cycleId: string): PerformanceReportModel | null;
  /**
   * Engine primitives for the overall-score-analysis export (assembled into the
   * MCQ_Overall_Score_Analysis workbook in the page). `preExclusion` keeps every
   * item (naive scores, before item review); otherwise the reviewed exclusions
   * are dropped. Export-only — no engine/scoring change.
   */
  getScoreAnalysisData(cycleId: string, preExclusion?: boolean): AssembleScoreAnalysisArgs | null;
  /** Engine primitives for the item-analysis export (README + per-subject sheets). */
  getItemAnalysisData(cycleId: string): AssembleItemAnalysisArgs | null;
  getGradingDefaults(): GradingDefaultsModel;
  /** Per-student technical exclusions (optional Student-review step). */
  getStudentReview(cycleId: string): StudentReviewModel | null;
  /** Distinction safeguard for one assessment scope (grading stage). */
  getDistinctionSafeguard(cycleId: string, scope?: string): DistinctionSafeguardModel | null;
  /** Student Summary for document generation (only populated once locked). */
  getDocuments(cycleId: string): DocumentsModel | null;

  // settings: users. The three FIXED canonical tiers are the only assignable
  // roles (see getMembers().roles); which permissions each tier holds is managed
  // via the configurable-permissions API below, not a custom-role editor.
  getMembers(): MembersModel;

  // settings: dynamic roles × granular actions (migration 0040). Enforcement
  // resolves membership role_id → the role's granted actions → the gated action.
  // `getActionCatalogue` is the fixed code catalogue; `getRoles` are the
  // add/deletable role rows; `getRoleActions` is role_id → granted action keys.
  // The setters are admin-only (general.manage_roles) and mirror the RPC lockout
  // guards (Admin undeletable; its manage_roles/manage_users cells locked on;
  // never orphan manage_roles; can't delete a role that still has members).
  getActionCatalogue(): ActionDef[];
  getRoles(): Role[];
  getRoleActions(): Record<string, ActionKey[]>;
  createRole(name: string): void;
  renameRole(id: string, name: string): void;
  deleteRole(id: string): void;
  setRoleAction(roleId: string, action: ActionKey, granted: boolean): void;

  // settings: test centres (top-level scoping dimension — migration 0010)
  /** Every test centre (active + inactive), for the management list. */
  listTestCentres(): TestCentreSummary[];
  /** Create a centre. Lead/Admin only (TODO P3: admin-only). */
  createTestCentre(input: { name: string; code: string }): void;
  /** Edit a centre's name / code / active flag. */
  updateTestCentre(id: string, patch: { name?: string; code?: string; active?: boolean }): void;
  /** Activate / deactivate a centre (hide from new work without deleting history). */
  setTestCentreActive(id: string, active: boolean): void;
  /**
   * 0013 — reassign an exam year to a different centre. `yearId` is the derived
   * id from `listYears()`. Admin-only (enforced server-side via
   * move_exam_year_to_centre); rejects on a (name, region, centre) conflict with a
   * friendly message. Pure labelling — never recomputes the engine or touches
   * grades. Rejects the returned promise on error so the UI can surface it.
   */
  moveExamYearToCentre(yearId: string, testCentreId: string): Promise<void>;

  // settings: configuration
  getConfig(): ConfigModel;
  /**
   * The full scoring configuration the engine reads — item-quality thresholds
   * plus the performance/award level definitions and default cut-points. This is
   * the single object the Settings editor (next prompt) will mutate.
   */
  getScoringConfig(): ScoringConfig;

  // audit & analytics
  getAuditLog(cycleId: string | null, filter: AuditFilter, search: string): AuditModel;
  /**
   * The admin "Audit & overrides" surface for a cycle: the CURRENT effective
   * grade-bearing decisions (excluded items, manual mark adjustments) with their
   * provenance, flagging any that are the result of an override (and by whom).
   */
  getOverrideView(cycleId: string): OverrideViewModel;
  getAnalyticsTrends(): AnalyticsTrends;
  /**
   * The "Overall" analytics read-model: a bird's-eye view of programme
   * performance over time across partner centres, grouped by centre × year ×
   * sitting × subject. Every figure is a roll-up of already-signed-off per-sitting
   * outputs (best-of-two via `rollupOverall`; no scoring re-run). `hasComparison`
   * is true only when ≥ 2 real years exist.
   *
   * `filter.centres` re-pools every figure (participation / perf / awardDist /
   * spreads) from just those centres — the cells are filtered by centre name and
   * `computeOverallAnalytics` re-run — so a centre subset re-slices the headline
   * numbers, not only the per-centre columns. Omit it for the full programme view.
   */
  getOverallAnalytics(filter?: OverallAnalyticsFilter): OverallAnalytics;

  // new cycle
  getNewCycle(): NewCycleModel;

  // writes
  setItemExcluded(
    cycleId: string,
    assessmentId: string,
    itemId: string,
    excluded: boolean,
    reason?: string | null,
  ): void;
  /**
   * Ingest a combined raw export for a cycle: persist the split assessments,
   * items, participants and the response matrix the engine consumes, then make
   * the pipeline read that stored data. The browser parses + cleans + validates
   * the file (reusing lib/ingest) and hands the cleaned responses + report here.
   * Resolves once the data is persisted (Supabase) or rebuilt (in-memory).
   */
  ingestRawExport(
    cycleId: string,
    file: { name: string; sizeMB: number },
    clean: CleanResponse[],
    report: ValidationReport,
    /**
     * The faithful 3-CSV canonical model + source filenames. Optional so the
     * legacy single-file path still type-checks; the live (Supabase) provider
     * forwards it to the ingest route, which persists the richer intake
     * (migration 0006). The in-memory provider ignores it (it has no DB), but
     * records the sitting tag.
     */
    extra?: { canonical?: CanonicalModel; files?: { items?: string; assessments?: string; topics?: string } },
  ): Promise<void>;
  /**
   * Empty a sitting's ingested data while KEEPING the sitting shell, returning
   * it to the empty Upload state so a fresh upload can run ("start from clean").
   * Cycle-scoped, audited, lead/admin only. Resolves once the DB clear completes
   * (live) or the in-memory state is reset (demo).
   */
  clearSittingData(cycleId: string): Promise<void>;
  /**
   * Delete a sitting AND all its ingested data (every related table, scoped by
   * cycle_id). Irreversible — the UI gates it behind an explicit confirm step.
   * Cycle-scoped, audited, lead/admin only.
   */
  deleteSitting(cycleId: string): Promise<void>;
  /**
   * Delete a whole cycle AND every row keyed to that cycle_id across all tables
   * (the full cascade), from the cycle's Settings danger surface. Same guarantees
   * as deleteSitting (admin-only, audited, resolves only once the DB removed rows).
   * No last-cycle restriction: an admin may delete every cycle, leaving an empty
   * workspace (zero cycles is a valid state). Returns to Years on success.
   */
  deleteCycle(cycleId: string): Promise<void>;
  /**
   * Probe the live DB for schema drift — the columns/functions the code needs
   * versus what's installed. Lets the app flag "the DB is behind — run migration
   * NNNN" proactively instead of failing at ingest. The demo has no DB (always ok).
   */
  getSchemaHealth(): Promise<SchemaHealth>;
  /**
   * Clean-stage, non-destructive removal of rows (participant ids) and/or columns
   * (item ids) from the working (cleaned) set for one subject. The raw data is
   * never touched — this is a recorded decision (like an item exclusion) that the
   * cleaned view and every downstream read (raw scores, scoring) honour. Pass
   * `removed=false` to restore the listed targets. Persisted by the Supabase
   * provider so it survives a reload; in-memory in the demo.
   */
  setCleanRemoval(
    cycleId: string,
    assessmentId: string,
    target: { rows?: string[]; cols?: string[] },
    removed: boolean,
  ): void;
  /** Restore every clean-stage removal for one subject ("Revert all"). */
  clearCleanRemovals(cycleId: string, assessmentId: string): void;
  /**
   * Flag (or un-flag) a participant as a staff / test account excluded from the
   * ENTIRE cohort — one authoritative action, not a per-subject removal. An
   * excluded participant drops from every downstream stage (raw scores, score, cut
   * scores, grades, analytics) and the headline counts. `excluded=false` restores
   * them. Persisted by the Supabase provider; in-memory in the demo. The caller
   * supplies the participant id (never a hardcoded email).
   */
  excludeParticipantFromCohort(
    cycleId: string,
    participantId: string,
    excluded: boolean,
    reason?: string | null,
  ): void;
  setBoundary(cycleId: string, scope: string, input: SetBoundaryInput): void;
  setGradingDefaults(patch: Partial<GradingConfig>): void;
  /** Edit the engine's item-quality Good/Review/Flag thresholds (Lead/Admin only). */
  setQualityThresholds(patch: Partial<QualityThresholds>): void;
  setDocumentSettings(cycleId: string, patch: Partial<DocSettings>): void;
  resolveDuplicates(cycleId: string, strategy: DuplicateStrategy): void;
  lockCycle(cycleId: string): void;
  unlockCycle(cycleId: string): void;

  // members & roles mutations
  inviteMember(email: string, roleId: string): void;
  setMemberRole(memberId: string, roleId: string): void;
  removeMember(memberId: string): void;
  resendInvite(memberId: string): void;

  // per-student technical exclusions (Student review)
  uploadTechnicalErrors(cycleId: string, fileName: string, rows: TechnicalErrorRow[]): void;
  clearTechnicalErrors(cycleId: string): void;
  setIncidentDecision(cycleId: string, incidentId: string, decision: IncidentDecision, reason?: string | null): void;

  // essay marks (English/Arabic only — optional, non-blocking upload at Ingest)
  getEssayMarks(cycleId: string): EssayMarksModel | null;
  /**
   * Read-only context for the essay-marks template + pre-write validation: the
   * essay subjects, their current rosters (with Clean-tab exclusion flags), and
   * the per-cell max mark. Never writes; null when the cycle carries no data.
   */
  getEssayContext(cycleId: string): EssayUploadContext | null;
  uploadEssayMarks(cycleId: string, fileName: string, rows: EssayUploadRow[]): void;
  clearEssayMarks(cycleId: string): void;

  // incident log → alterations triage (Adjustments step)
  getAdjustments(cycleId: string): AdjustmentsModel | null;
  uploadIncidentLog(cycleId: string, fileName: string, rows: IncidentInput[]): void;
  clearIncidentLog(cycleId: string): void;
  /** Record (or clear) the human triage decision + alteration for one incident. */
  decideIncident(cycleId: string, incidentId: string, decision: IncidentDecisionInput): void;
  /** Transparent per-student per-subject composition: MCQ + Essay + Alterations = total. */
  getComposition(cycleId: string): CompositionModel | null;

  // CGJ (Centre Grade Judgement) — centre-expected vs actual, after Cut scores ─
  /**
   * The CGJ comparison for a sitting: each student's centre-EXPECTED level per
   * subject lined up against the ACTUAL level the pipeline produced (read from
   * `getGrades` — no recompute). Includes the assumed PLD→award mapping as a
   * labelled, unconfirmed assumption (O2). Null for a non-live cycle.
   */
  getCgj(cycleId: string): CgjModel | null;
  /** Upload a centre expectations file (parsed client-side into rows). Audited. */
  uploadCgjFile(cycleId: string, fileName: string, rows: CgjUploadRow[]): void;
  /** Remove the uploaded centre expectations file. */
  clearCgj(cycleId: string): void;
  /** Speededness & timing diagnostics (informational; not part of grading). */
  getDiagnostics(cycleId: string): DiagnosticsModel | null;
  /** Cronbach's-α reliability at every construct grouping (read-only, additive). */
  getReliability(cycleId: string): ReliabilityModel | null;
  /**
   * Raw per-item source (items + responses + participant drop-set per assessment)
   * for the Per-Item Speededness / Omission / Completion export. Read-only and
   * additive — see lib/data/per-item-source.ts. Null for a non-live cycle.
   */
  getPerItemSource(cycleId: string): PerItemSource | null;

  // distinction safeguard (grading stage)
  confirmDistinctionCaps(cycleId: string): void;
  overrideDistinctionCap(cycleId: string, studentId: string, reason: string): void;
  undoDistinctionOverride(cycleId: string, studentId: string): void;

  // manual mark adjustment (Grades stage — audited, reversible; rides Alterations)
  /** Adjust a student's subject MARK to `newMark` with a required `reason`; the
   *  delta flows through the engine's existing alterations input and recomputes
   *  the grade (incl. the D3 safeguard). Audited. */
  adjustStudentMark(cycleId: string, participantId: string, assessmentId: string, newMark: number, reason: string): void;
  /** Remove a manual mark adjustment by id — reverts the grade; audited. */
  removeStudentMarkAdjustment(cycleId: string, adjustmentId: string): void;

  // overrides (authorised user reverses another user's grade-bearing action) ──
  /**
   * Override another user's item exclusion/inclusion decision (e.g. re-include an
   * item a reviewer excluded). Authorised users only (lead_admin); a `reason` is
   * required. Re-applies the SAME effective state the original action used, so
   * scoring recomputes through the full engine (incl. the D3 safeguard), and
   * writes an override audit entry naming the prior decider.
   */
  overrideItemExclusion(
    cycleId: string,
    assessmentId: string,
    itemId: string,
    exclude: boolean,
    reason: string,
  ): void;
  /**
   * Override another user's manual mark adjustment: set the cell's mark to
   * `newMark`, or revert it (`newMark === null`). lead_admin only; `reason`
   * required. Rides the existing alterations engine input (full recompute incl.
   * D3) and writes an override audit entry naming the prior adjuster.
   */
  overrideMarkAdjustment(
    cycleId: string,
    participantId: string,
    assessmentId: string,
    newMark: number | null,
    reason: string,
  ): void;

  // configuration mutations
  setSafeguardConfig(patch: { topDifficultyDemand?: string }): void;
  /** Set the borderline (marginal) flagging band (percentage points). Grade-bearing:
   *  re-flags through the full grade recompute (incl. the D3 safeguard). */
  setBorderlineConfig(patch: Partial<BorderlineConfig>): void;
  /** Per-subject A–E element labels (configurable in Settings). */
  getElementLabels(): ElementLabelsConfig;
  /** Replace the per-subject element-label config (lead/admin only, validated). */
  setElementLabels(config: ElementLabelsConfig): void;

  // Incident Adjustments configuration registry (admin-only writes; read-only for
  // lower roles). Codes/formulae/caps + the reconfigurable import column mapping.
  getIncidentConfig(): IncidentConfigModel;
  /** Insert (no id) or update one incident code. Admin only; add-only validated. */
  upsertIncidentCode(input: IncidentCodeInput): void;
  deleteIncidentCode(id: string): void;
  /** Per-student global cap on total incident marks (null = no cap). Admin only. */
  setIncidentPerStudentCap(cap: number | null): void;
  /** Reconfigurable import column mapping. Admin only. */
  setIncidentMapping(mapping: IncidentColumnMapping): void;

  // Incident Adjustments — apply engine + per-student review surface (02b).
  /** The cohort roster the incident importer resolves rows against — each cohort
   *  participant's P-A stable internal id + display name. Empty when unknown. */
  getIncidentRoster(cycleId: string): RosterParticipant[];
  /** Replace a cycle's parsed+resolved incident rows (cycle-role import action).
   *  `source` records what was loaded (real file vs the labelled sample), so the
   *  review surface can show it and explain how to replace the sample. */
  importIncidentRows(
    cycleId: string,
    rows: readonly ResolvedIncidentRow[],
    source?: { fileName: string; sample: boolean },
  ): void;
  /** Clear a cycle's imported incident rows (and any prior commit). Cycle role. */
  clearIncidentRows(cycleId: string): void;
  /** The per-student review surface: base + capped adjustment + breakdown. All
   *  roles may VIEW; `canApply` is admin-only. Null when the cycle is unknown. */
  getIncidentReview(cycleId: string): IncidentReviewModel | null;
  /** Commit the (capped) incident adjustments to scores. Admin only; explicit. */
  applyIncidentAdjustments(cycleId: string): void;
  /** Un-apply (revert) a prior commit, so base scores stand alone. Admin only. */
  unapplyIncidentAdjustments(cycleId: string): void;

  // Technical Incident Upload — ingest the real 20-column export, match by email
  // within the active cycle, stage into `exam_incidents` (0044). STAGING ONLY: no
  // marks are adjusted (§3 gate). Mirrors the essay masterfile upload trio.
  /** Read-only context the pure matcher (`matchExamIncidents`) resolves rows
   *  against: the active cycle name, its subjects, every sitting (email→
   *  qm_result_id per subject), the staff/non-cohort emails, and the references
   *  already staged (for the `duplicate` observation). Null when unknown. */
  getExamIncidentMatchContext(cycleId: string): ExamIncidentMatchContext | null;
  /** Upsert a batch of staged incident records by `reference` (cycle role). A
   *  re-uploaded corrected file UPDATES rows, never duplicates. Never writes an
   *  adjustment. */
  upsertExamIncidents(cycleId: string, batchId: string, fileName: string, records: readonly ExamIncidentRecord[]): void;
  /** All staged incident records for a cycle (most-recent batch last). */
  getExamIncidentsForCycle(cycleId: string): ExamIncidentRecord[];
  /** The reconciliation report for one import batch, rebuilt from staged rows. */
  getExamIncidentReconciliation(cycleId: string, batchId: string): ExamIncidentReconciliation | null;
  /** Clear a cycle's staged incidents (the "Remove" control). Cycle role. */
  clearExamIncidents(cycleId: string): void;

  // audit-writing actions (UI-driven export / document generation)
  recordExport(cycleId: string, detail: string): void;
  recordDocuments(cycleId: string, detail: string): void;

  // new-cycle action — persists to the database (Supabase provider) and returns
  // the real new cycle id; the in-memory provider resolves to its demo cycle.
  createCycle(input: CreateCycleInput): Promise<string>;

  // reactivity (for useSyncExternalStore)
  subscribe(listener: () => void): () => void;
  getVersion(): number;
}
