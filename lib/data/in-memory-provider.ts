/**
 * In-memory DataProvider. Seeds from genuine engine output (seed.generated.json)
 * and recomputes scores/distributions/grades through the real engine on every
 * change. Decisions (exclusions, boundaries, locks) live in memory and reset on
 * reload — there is no database in this build.
 */

import {
  getEngine,
  defaultScoringConfig,
  deriveAward,
  qualifiesForDistinctionByLevels,
  d3MajorityThreshold,
  passesD3Majority,
  LOW_ITEMS_THRESHOLD,
  SMALL_SAMPLE_THRESHOLD,
} from "@/lib/engine";
import type {
  Alteration,
  EssayMark,
  ItemMeta,
  ItemStat,
  ParticipantScore,
  QualityRating,
  QualityThresholds,
  ResponseRecord,
  ScoringConfig,
} from "@/lib/engine";
import {
  backsolveCuts,
  checkOutstandingHalfD3,
  POLICY_GUARDRAILS,
} from "@/lib/engine/cut-scores";
import seedJson from "./seed.generated.json";
import { roleTierLabel } from "@/lib/auth/roles";
import {
  can,
  ACTIONS,
  ACTION_KEYS,
  defaultRoles,
  defaultRoleActions,
  resolveRoleActions,
  MANAGE_ROLES_ACTION,
  MANAGE_USERS_ACTION,
  type ActionDef,
  type ActionKey,
  type ResolvedRoleActions,
  type Role as RoleModel,
} from "@/lib/auth/actions";
import { rollupOverall, overallAwardsReconcile } from "./overall";
import {
  computeOverallAnalytics,
  overallAwardBands,
  overallPLevels,
  subjectKeyOf,
  type OACell,
  type OASitting,
  type OASittingStudent,
} from "./overall-analytics";
import { buildLiveCycleData } from "./build-live-cycle";
import {
  buildAssessmentDiagnostics,
  cleanDiagResponses,
  type DiagResponse,
  // TEMP-DEBUG (maxScore-leak investigation — REMOVE AFTER)
  __setTempDebugTimingLabel,
} from "@/lib/diagnostics";
// TEMP-DEBUG (maxScore-leak investigation — REMOVE AFTER): the target assessment
// confirmed in the production DB. Matched by id OR name so this also fires
// against local/demo data during testing.
const __TEMP_DEBUG_TARGET_ASSESSMENT_ID = "56629397-a027-4159-97f9-2bcf2cd38890";
function __tempDebugIsTargetAssessment(a: { id: string; name: string }): boolean {
  return a.id === __TEMP_DEBUG_TARGET_ASSESSMENT_ID || a.name.includes("Applicable Math");
}
import { doNextForStage } from "./pipeline-route";
import type { CleanResponse } from "@/lib/ingest/types";
import type { ValidationReport } from "@/lib/ingest/types";
import type { CanonicalModel } from "@/lib/ingest/qm";
import { SUBJECT_CATALOG, isSurveyAssessment } from "./subject-catalog";
import { isTechnicalIncidentStatus } from "./result-status";
import { isEssaySubject, reservedEssayMax, ESSAY_ITEM_MAX } from "./essays";
import type {
  AssembleScoreAnalysisArgs,
  AssembleItemAnalysisArgs,
  ItemResponseFact,
  ItemReviewDecision,
} from "@/lib/export/types";
import type { Seed, SeedAssessment, SeedItem } from "./seed-types";
import type {
  DataProvider,
  SetBoundaryInput,
  TechnicalErrorRow,
  EssayUploadRow,
  CgjUploadRow,
  IncidentInput,
  IncidentDecisionInput,
  SchemaHealth,
  SittingRoster,
} from "./provider";
import {
  assumedPldAwardMap,
  compareLevels,
  normalizePerformanceLevel,
} from "./cgj";
import {
  PIPELINE,
  type AnalyticsTrends,
  type OverallAnalytics,
  type OverallAnalyticsFilter,
  type TrendKpi,
  type AssessmentRef,
  type AuditEntry,
  type AuditFilter,
  type AuditModel,
  type AuditType,
  type OverrideViewModel,
  type EffectiveDecision,
  type BoundaryMode,
  type BoundaryModel,
  type D3HalfWarning,
  type BorderlineConfig,
  type ConfigModel,
  type CreateCycleInput,
  type CurrentUser,
  type Role,
  type CycleDetail,
  type CycleSummary,
  type TestCentreSummary,
  type YearSummary,
  type YearDetail,
  type SittingRef,
  type SittingKey,
  type DocSettings,
  type DocumentsModel,
  type IssuanceSignOff,
  type IssuanceReadiness,
  type DuplicateStrategy,
  type GradeBandRow,
  type GradeCell,
  type GradeMatrixRow,
  type GradesModel,
  type CgjModel,
  type CgjStudentRow,
  type CgjSubjectCompare,
  type ManualMarkAdjustment,
  type OverallGradesModel,
  type GradingDefaultsModel,
  type IngestModel,
  type ItemDetailModel,
  type ItemRow,
  type Member,
  type MembersModel,
  type NewCycleModel,
  type PerformanceReportModel,
  type PerfReportStudent,
  type PerfReportSubject,
  type PerfElementResult,
  type PerfReportSummarySubject,
  type QualityThresholdRow,
  type ReviewModel,
  type CombinedSplitModel,
  type DetectedSubject,
  type RawDataModel,
  type RawColumnMeta,
  type RawDataRow,
  type RawElementBreak,
  type DataCleaningModel,
  type CleanedDataModel,
  type CleaningImpactModel,
  type CleaningImpactSubject,
  type CleaningImpactElement,
  type CleaningSummaryModel,
  type CleaningSummaryDist,
  type CleaningSummarySubject,
  type CleaningSummaryStatusRow,
  type CleanedMasterDataset,
  type CleaningCheck,
  type NaiveScoresModel,
  type NaiveElementCol,
  type NaiveStudentRow,
  type StudentSummary,
  type UnofficialSubject,
  type UnofficialElement,
  type DistinctionCandidate,
  type DistinctionSafeguardModel,
  type EssayMarksModel,
  type EssayStudentMark,
  type EssaySubjectRef,
  type EssayUploadContext,
  type EssaySubjectContext,
  type EssayRosterEntry,
  type AdjustmentsModel,
  type AdjustmentIncident,
  type DiagnosticsModel,
  type ReliabilityModel,
  type ReliabilityRow,
  type CompositionModel,
  type StudentComposition,
  type SubjectComposition,
  type DemandScore,
  type IncidentDecision,
  type SafeguardConfig,
  type SafeguardResult,
  type StudentReviewModel,
  type TechnicalErrorsUpload,
  type TechnicalIncident,
  type IncidentConfigModel,
  type IncidentReviewModel,
  type IncidentReviewStudent,
} from "./types";
import {
  defaultIncidentConfig,
  validateIncidentCode,
  validatePerStudentCap,
  normalizeIncidentCode,
  classifyIncidentType,
} from "@/lib/incidents/config";
import { describeFormula } from "@/lib/incidents/formula";
import type {
  IncidentAdjustmentConfig,
  IncidentCodeInput,
  IncidentColumnMapping,
} from "@/lib/incidents/types";
import type { ResolvedIncidentRow, RosterParticipant } from "@/lib/incidents/import";
import { computeStudentAdjustments } from "@/lib/incidents/apply";
import {
  classifySubjectName,
  reconciliationFromRecords,
  type ExamIncidentMatchContext,
  type ExamIncidentRecord,
  type ExamIncidentReconciliation,
  type IncidentSittingEntry,
} from "@/lib/incidents/exam-incident-match";
import {
  CLEANED_DATA_COLUMNS,
  CLEANED_DATA_UNAVAILABLE,
  type CleanedDataColumn,
} from "./cleaned-schema";
import {
  DEFAULT_ELEMENT_LABELS,
  validateElementLabels,
  labelMapForSubject,
  resolveEssayWritingLabel,
  type ElementLabelsConfig,
  type ResolvedElementLabel,
} from "./element-labels";
import {
  classify,
  defaultGradingConfig,
  starsFor,
  type GradingConfig,
  DEFAULT_PERFORMANCE_TARGETS,
  DEFAULT_AWARD_TARGETS,
  DEFAULT_BORDERLINE_BAND_PCT,
  clampBorderlineBand,
} from "./grading";
import {
  ANALYTICS_CYCLE_LABELS,
  ANALYTICS_CYCLE_NAMES,
  defaultMembers,
  mockPriors,
  seedAuditEntries,
} from "./mock-admin";

/** Default seed (the bundled demo cycle). A different seed can be injected via
 *  the constructor — e.g. the SupabaseDataProvider hydrates one from the database
 *  and the seed:supabase script reuses this provider over freshly-ingested data. */
const DEFAULT_SEED = seedJson as unknown as Seed;
const engine = getEngine();

/** Synthetic `perElement` / element-column key for the display-only essay
 *  ("Writing") column on the Raw Scores view. Namespaced so it can never collide
 *  with a real QuestionMajorElement value from the data. */
const ESSAY_ELEMENT_MAJOR = "__essay_writing__";

interface BoundaryState {
  mode: BoundaryMode;
  cuts: number[];
  targets: number[];
  /** Committed backsolve snapshot — the suggested starting point, per cut. */
  suggested?: number[];
  /** Per-cut deliberate guard-rail waiver (value knowingly outside policy bounds). */
  waived?: boolean[];
}

/** One exam's D3-majority working for a student (Layer 1b). */
interface D3ExamStatus {
  assessmentId: string;
  name: string;
  shortName: string;
  /** D3 items the student answered correctly (score > 0). */
  correct: number;
  /** D3 items available on the exam (after cohort item exclusions). */
  available: number;
  /** Strictly-more-than-half threshold for `available`. */
  majority: number;
  pass: boolean;
}
/** A student's overall D3 cap result across every exam carrying D3 items. */
interface D3CapStatus {
  pass: boolean;
  exams: D3ExamStatus[];
  /** The first exam that failed the majority (drives the visible "why"). */
  failing: D3ExamStatus | null;
}

// --- small numeric helpers ---------------------------------------------------
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mu = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - mu) ** 2)));
}
function round(x: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

/** Deterministic 32-bit FNV-1a hash of a string (no deps) — used only for the
 *  demo February baseline, never for real scoring. */
function hash32(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Render the numeric item-quality thresholds into the Configuration screen's
 * display rows, so the screen always mirrors whatever bands the engine is using
 * rather than a hand-typed copy.
 */
function qualityThresholdRows(q: QualityThresholds): QualityThresholdRow[] {
  const f = (n: number) => n.toFixed(2);
  const p = q.pValue;
  const corr = (t: QualityThresholds["itemTotal"], includeUndefined: boolean) => ({
    good: `≥ ${f(t.reviewBelow)}`,
    review: `${f(t.flagBelow)} – ${f(t.reviewBelow)}`,
    flag: includeUndefined ? `< ${f(t.flagBelow)} / undefined` : `< ${f(t.flagBelow)}`,
  });
  return [
    {
      metric: "p-value (difficulty)",
      good: `${f(p.reviewBelow)} – ${f(p.goodUpTo)}`,
      review: `${f(p.flagBelow)}–${f(p.reviewBelow)} / ${f(p.goodUpTo)}–${f(p.reviewUpTo)}`,
      flag: `< ${f(p.flagBelow)} / > ${f(p.reviewUpTo)}`,
    },
    { metric: "Item-total correlation", ...corr(q.itemTotal, true) },
    { metric: "Point-biserial", ...corr(q.pointBiserial, true) },
    { metric: "Discrimination", ...corr(q.discrimination, false) },
  ];
}

export class InMemoryDataProvider implements DataProvider {
  private version = 0;
  private listeners = new Set<() => void>();
  /** The cycle data this provider serves. Defaults to the bundled demo seed;
   *  the SupabaseDataProvider injects one hydrated from the database, and the
   *  seed:supabase script runs it over freshly-ingested data. */
  // Not `readonly`: a clear/delete replaces `liveCycle` with an emptied clone
  // (resetCycleToEmpty). The default is the SHARED module-level DEFAULT_SEED, so we
  // must never mutate it in place — reassign a fresh seed object instead.
  private seed: Seed = DEFAULT_SEED;

  // mutable decision state
  private exclusions = new Map<string, Set<string>>(); // cycle:assessment -> itemIds
  private reasons = new Map<string, string>(); // cycle:assessment:item -> reason
  // Clean-stage, non-destructive removals (distinct from item-review exclusions):
  // rows = participant ids dropped from the cohort, cols = item ids dropped from
  // the analysis. Keyed cycle:assessment. The raw data is never mutated — these
  // sets filter the cleaned view and fold into the engine-facing reads.
  private cleanRows = new Map<string, Set<string>>(); // cycle:assessment -> participantIds
  private cleanCols = new Map<string, Set<string>>(); // cycle:assessment -> itemIds
  // Authoritative cohort-wide participant exclusions (staff / test accounts).
  // Keyed cycle -> participantId -> reason. Distinct from per-subject clean rows:
  // ONE action drops the participant from every subject + every cohort view. This
  // is the single cleaned source the downstream stages read for "is this a real
  // student?" (root causes B + C).
  private participantExclusions = new Map<string, Map<string, string>>(); // cycle -> pid -> reason
  private boundaries = new Map<string, BoundaryState>(); // cycle:scope -> state
  private locked = new Set<string>();
  private grading: GradingConfig = defaultGradingConfig();
  // Item-quality Good/Review/Flag thresholds — the configurable half of the
  // engine's ScoringConfig (the level/award vocabulary is `this.grading`). The
  // Settings editor that mutates these arrives in the next prompt; for now the
  // default reproduces the engine's published ratings exactly.
  private quality: QualityThresholds = defaultScoringConfig().quality;
  private docSettingsByCycle = new Map<string, DocSettings>();

  // Dynamic roles × granular actions (migration 0040): the add/deletable role rows
  // + each role's granted actions, seeded from the defaults. The
  // SupabaseDataProvider overwrites both from the DB on hydrate. `resolvedActions`
  // is the derived (role_id → granted action set) view every gate reads via
  // `can()`; it is recomputed whenever `roles`/`roleActions` change.
  private roles: RoleModel[] = defaultRoles();
  private roleActions: Record<string, ActionKey[]> = defaultRoleActions();
  private resolvedActions: ResolvedRoleActions = resolveRoleActions(this.roles, this.roleActions);

  // incident log (Adjustments) + distinction safeguard
  private technicalErrors = new Map<string, { uploaded: boolean; sample: boolean; fileName: string | null; incidents: TechnicalIncident[] }>();
  private incidentSeq = 0;
  // three-component scoring inputs (Parts 2 & 3) — empty defaults to MCQ-only.
  // essay marks (Part 2): the scoring-facing marks plus upload metadata.
  private essayMarksByCycle = new Map<
    string,
    {
      uploaded: boolean;
      sample: boolean;
      fileName: string | null;
      marks: EssayMark[];
      /** `${participantId}|${assessmentId}` → number of essays averaged. */
      essayCounts: Map<string, number>;
      /** File ParticipantIDs that matched no roster student. */
      unmatchedIds: string[];
    }
  >();
  // alterations: cycle -> human-decided +/- raw marks per student per subject.
  // Derived from decided incidents (rebuildAlterations); read by the engine.
  private alterationsByCycle = new Map<string, Alteration[]>();
  // Manual mark adjustments (Grades-stage overrides): cycle -> records. These ride
  // the SAME alterations input the engine consumes (merged in `alterationsFor`),
  // so a manual delta recomputes the grade through the full path (incl. the D3
  // safeguard) without ever touching item-stats or engine logic. Audited + reversible.
  private manualAdjustmentsByCycle = new Map<string, ManualMarkAdjustment[]>();
  private manualAdjSeq = 0;
  // incident log (Part 3): the triage queue behind the Adjustments step.
  private incidentLogByCycle = new Map<
    string,
    { uploaded: boolean; sample: boolean; fileName: string | null; incidents: AdjustmentIncident[] }
  >();
  private adjIncidentSeq = 0;
  // Technical Incident Upload (0044): staged incident export records, cycle -> the
  // upserted records keyed on `reference`. STAGING ONLY — no marks are adjusted.
  // Batch provenance (id → file name) is kept alongside for the reconciliation.
  private examIncidentsByCycle = new Map<string, Map<string, ExamIncidentRecord>>();
  private examIncidentBatches = new Map<string, { cycleId: string; fileName: string }>();
  // CGJ (Centre Grade Judgement): the centre's EXPECTED level per student per
  // subject, keyed by cycle. Pure comparison input — never feeds scoring.
  // `expected` maps assessmentId → expected performance level (raw rows are
  // resolved to assessments + normalised at upload time).
  private cgjByCycle = new Map<
    string,
    {
      uploaded: boolean;
      sample: boolean;
      fileName: string | null;
      /** studentName (as supplied) → { assessmentId → expected level }. */
      students: { name: string; expected: Record<string, string> }[];
    }
  >();
  private distinctionOverrides = new Map<string, Map<string, { reason: string; by: string }>>();
  private distinctionConfirmed = new Set<string>();
  // safeguard config; empty topDifficultyDemand → resolve to the highest demand present.
  private safeguard: { topDifficultyDemand: string } = {
    topDifficultyDemand: "",
  };
  // Borderline (marginal) flagging band, in percentage points. Grade-bearing
  // input the grade recompute reads (see marginalInfo); editable via Settings.
  // Default is the ±2% placeholder pending G12's policy value.
  private borderline: BorderlineConfig = { bandPct: DEFAULT_BORDERLINE_BAND_PCT };

  // Incident Adjustments configuration registry (codes/formulae/caps + import
  // column mapping). Admin-owned; lower roles read-only. Mirrors migration 0016.
  private incidentConfig: IncidentAdjustmentConfig = defaultIncidentConfig();

  // Incident Adjustments — apply/review state (02b). Parsed+resolved incident
  // rows per cycle (mirrors `incident_rows`), and the admin commit flag per cycle
  // (mirrors `incident_applications`, migration 0017). The capped per-student
  // ledger is DERIVED from these + the config by the apply engine — never stored
  // as a merged number — so base scores are never touched (they reconcile 1:1).
  private incidentRows = new Map<string, ResolvedIncidentRow[]>();
  private incidentSource = new Map<string, { fileName: string; sample: boolean }>();
  private incidentApplied = new Map<string, { by: string; at: string }>();

  // Per-subject A–E element labels (configurable in Settings). Seeded from the
  // confirmed G12++ defaults; the Supabase provider replays the persisted set.
  private elementLabels: ElementLabelsConfig = JSON.parse(JSON.stringify(DEFAULT_ELEMENT_LABELS));

  // admin / audit / config state (all MOCK — see lib/data/mock-admin.ts)
  private members: Member[] = defaultMembers();
  private auditEntries: AuditEntry[] = seedAuditEntries("may-2026");
  private auditSeq = 0;

  // 0010 — test centres (top-level scoping dimension). The demo seeds a single
  // active centre that every derived year belongs to (the live Supabase provider
  // hydrates the real list from the test_centres table via the seed). Populated
  // in the constructor (after `seed` is bound) and managed by the CRUD methods
  // below, which mirror the SECURITY DEFINER RPCs in migration 0010.
  private testCentres: TestCentreSummary[] = [];
  private seq = 0;
  // 0013 — year reassignments: cycleId → overridden centre id. Held as mutable
  // decision state (like exclusions/locks) rather than written back onto `seed`,
  // so the SHARED demo seed module is never mutated (keeps test isolation) and a
  // reassignment is pure labelling — no result/grade/seed data is rewritten.
  private cycleCentreOverride = new Map<string, string>();

  private user: CurrentUser = {
    id: "demo-admin",
    // Neutral demo user (an admin) for the in-memory demo so role-gated controls
    // (Lock, admin) are exercised. The SupabaseDataProvider injects the real
    // session-derived user via the constructor — this is never the live identity.
    name: "Workspace Admin",
    initials: "WA",
    role: "lead_admin",
  };

  // Who set the current effective state of each grade-bearing decision, so an
  // override can name the prior actor AND gate on the strictly-higher `canOverride`
  // rule against the role that took it. Keyed like the audit detail.
  //   exclusionBy: `${cycleId}:${assessmentId}:${itemId}` → actor (incl. their role)
  private exclusionBy = new Map<string, { id: string; name: string; role: Role; at: string }>();
  //   overrideMeta (item exclusions): same key → override provenance
  private exclusionOverride = new Map<string, { by: string; priorActor: string | null; reason: string; ts: string }>();
  //   overrideMeta (mark adjustments): `${cycleId}:${participantId}:${assessmentId}`
  private adjustmentOverride = new Map<string, { by: string; priorActor: string | null; reason: string; ts: string }>();

  /**
   * @param seed Optional cycle data to serve (defaults to the bundled demo seed).
   * @param user Optional signed-in user (defaults to the MOCK Lead).
   */
  // `hydrated` marks a provider built from the live database (SupabaseDataProvider).
  // It only affects year IDENTITY: live years always route on a real id (the year's
  // UUID, or — when a legacy cycle has no year row — the sitting's own cycle id), so
  // a route param can never be a name label like `year-Unknown`. The demo (no DB)
  // keeps its stable `year-<year>` fixture key.
  private readonly hydrated: boolean;

  constructor(seed?: Seed, user?: CurrentUser, hydrated = false) {
    if (seed) this.seed = seed;
    if (user) this.user = user;
    this.hydrated = hydrated;
    // 0010 — bind the test-centre list now that `seed` is final. Live runs carry
    // the hydrated centres; the demo falls back to a single active centre so the
    // home/year screens always have a centre to label and the picker is non-empty.
    // A DEFINED `testCentres` (even an empty array) is live/hydrated data — use it
    // verbatim so the picker only ever offers real centre UUIDs, and an empty live
    // workspace correctly shows "create a centre first" rather than a mock. Only the
    // demo seed (field absent → undefined) falls back to a single labelling centre so
    // the home/year screens always have a centre to display.
    this.testCentres =
      this.seed.testCentres !== undefined
        ? this.seed.testCentres.map((c) => ({ ...c }))
        : [{ id: "tc-shatila-1", name: "Shatila 1", code: "SHA1", slug: "shatila-1", active: true }];
  }

  /** The centre new work defaults to: the first ACTIVE centre, else the first. */
  private primaryTestCentre(): TestCentreSummary {
    return this.testCentres.find((c) => c.active) ?? this.testCentres[0]!;
  }

  /** Resolve a cycle's centre by id, falling back to the primary centre. */
  private centreFor(testCentreId?: string): TestCentreSummary {
    return (testCentreId && this.testCentres.find((c) => c.id === testCentreId)) || this.primaryTestCentre();
  }

  /** A cycle's EFFECTIVE centre id: a 0013 reassignment override if one exists,
   *  else the centre stored on the seed cycle. */
  private effectiveCentreId(cycleId: string, seedCentreId?: string): string | undefined {
    return this.cycleCentreOverride.get(cycleId) ?? seedCentreId;
  }

  // ── subscription ──────────────────────────────────────────────────────────
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getVersion(): number {
    return this.version;
  }
  private bump(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  getCurrentUser(): CurrentUser {
    return this.user;
  }

  /**
   * Switch the acting user. The SupabaseDataProvider injects the real session
   * user via the constructor; this lets the in-memory demo (and tests) model a
   * second authorised person performing an override of someone else's action.
   */
  setCurrentUser(user: CurrentUser): void {
    this.user = user;
    this.bump();
  }

  /** Append an audit entry attributed to the current user (newest first). */
  private audit(
    type: AuditType,
    action: string,
    detail: string,
    cycleId: string | null,
    extra?: { isOverride?: boolean; priorActor?: string | null; reason?: string | null },
  ): void {
    const me = this.members.find((m) => m.id === this.user.id);
    this.auditSeq += 1;
    this.auditEntries.unshift({
      id: `live-${this.auditSeq}`,
      ts: new Date().toISOString(),
      actorId: this.user.id,
      actorName: this.user.name,
      actorRole: me?.roleName ?? "G12 Lead",
      type,
      action,
      detail,
      cycleId,
      seeded: false,
      isOverride: extra?.isOverride ?? false,
      priorActor: extra?.priorActor ?? null,
      reason: extra?.reason ?? null,
    } satisfies AuditEntry);
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private assessment(assessmentId: string): SeedAssessment | undefined {
    return this.seed.liveCycle.assessments.find((a) => a.id === assessmentId);
  }
  private excludedSet(cycleId: string, assessmentId: string): Set<string> {
    const itemEx = this.exclusions.get(`${cycleId}:${assessmentId}`);
    // Columns removed at the Clean stage are not scored either — fold them into
    // the same set the engine reads, so a removed column propagates downstream
    // through the existing exclusion path (no engine change). With no clean
    // removals (the default) this is byte-identical to the item-review set.
    const cleanCols = this.cleanCols.get(`${cycleId}:${assessmentId}`);
    if (!cleanCols || cleanCols.size === 0) return itemEx ?? new Set();
    return new Set([...(itemEx ?? []), ...cleanCols]);
  }
  /** Participant ids removed at the Clean stage for one subject (live cycle). */
  private cleanRowSet(assessmentId: string): Set<string> | undefined {
    return this.cleanRows.get(`${this.seed.liveCycle.id}:${assessmentId}`);
  }
  /**
   * Participant ids excluded cohort-wide for the live cycle — staff/test accounts
   * and anyone the reviewer removed from every subject. This is ALL data now: every
   * id comes from `excludeParticipantFromCohort` (recorded ad hoc in the Clean UI, or
   * seeded per cohort from the `cohort_exclusions` table on hydrate). No participant
   * is excluded by an email/name/id hard-coded in the source — the staff/test set is
   * an editable, per-cohort list, not a constant.
   */
  private cohortExcludedSet(): Set<string> {
    return new Set<string>(this.participantExclusions.get(this.seed.liveCycle.id)?.keys() ?? []);
  }
  /**
   * Participants removed from the COHORT entirely — those cleaned out (Clean-stage
   * row removal) of EVERY subject in which they have responses. The test/staff
   * account, deleted on every subject tab, lands here and so drops out of the
   * cohort-wide views (grades, overall award, the reliability participant count)
   * and the headline participant counts — not just the per-subject scores. A
   * participant still present in even one subject is NOT cohort-removed: they keep
   * their cohort row and simply carry a blank cell for the subject(s) they left.
   */
  private cohortRemovedParticipants(): Set<string> {
    // Authoritative cohort exclusions (staff/test) drop out unconditionally; the
    // per-subject "removed from every subject" rule below is the legacy path.
    const out = new Set<string>(this.cohortExcludedSet());
    const assessments = this.seed.liveCycle.assessments;
    const presence = assessments.map((a) => this.participantsIn(a));
    for (const p of this.seed.liveCycle.participants) {
      let appears = false;
      let allRemoved = true;
      for (let i = 0; i < assessments.length; i++) {
        if (!presence[i]!.has(p.id)) continue;
        appears = true;
        if (!this.cleanRowSet(assessments[i]!.id)?.has(p.id)) {
          allRemoved = false;
          break;
        }
      }
      if (appears && allRemoved) out.add(p.id);
    }
    return out;
  }
  /** Live participant headcount after cohort-wide Clean removals. */
  private cohortParticipantCount(): number {
    return this.seed.liveCycle.participants.length - this.cohortRemovedParticipants().size;
  }
  private responsesOf(a: SeedAssessment): ResponseRecord[] {
    // Drop the responses of any participant removed at the Clean stage, so the
    // cohort the engine scores already reflects the cleaned set. Only the single
    // live cycle has real data, so keying by liveCycle.id is sufficient.
    const removed = this.cleanRowSet(a.id);
    const cohortExcluded = this.cohortExcludedSet();
    const drop = removed && removed.size ? new Set([...removed, ...cohortExcluded]) : cohortExcluded;
    const src = drop.size ? a.responses.filter((r) => !drop.has(r.p)) : a.responses;
    return src.map((r) => ({
      participantId: r.p,
      itemId: r.i,
      assessmentId: a.id,
      score: r.s,
    }));
  }
  /**
   * Raw diagnostics records for one assessment's CURRENT `items`/`responses` —
   * unfiltered by participant (the drop-set is applied by the caller via
   * `cleanDiagResponses`, matching the ingest-time build in `buildLiveCycleData`/
   * `hydrate`). Only items with `maxScore >= 1` are included — the same filter
   * those two build paths apply (unscored stimulus/instruction items must not
   * inflate omission/completion/correlation inputs; see
   * tests/diagnostics-maxscore-zero.test.ts). Presentation order uses QM's real
   * per-sitting `questionPresentedNumber` carried on each response — confirmed
   * against the 700435 fixture to VARY per participant even for the same item, so
   * it is read per response, never shared globally by item. Falls back to the
   * item's position in the already-ordered `a.items` array (ingest-time first-
   * appearance order) ONLY when `questionPresentedNumber` is null/missing for a
   * given response (defensive; should not fire on real data — logged below so a
   * fallback firing stays visible). "answered" reads the same `r.a !== false`
   * signal the rest of the provider uses (itself keyed off AnswerGivenChoiceNumber
   * upstream).
   */
  private diagResponsesFor(a: SeedAssessment): DiagResponse[] {
    // TEMP-DEBUG (maxScore-leak investigation — REMOVE AFTER)
    const __tempDebug = __tempDebugIsTargetAssessment(a);
    if (__tempDebug) {
      console.log(`[TEMP-DEBUG] diagResponsesFor(${a.name}): a.items.length=${a.items.length}`);
      console.log(`[TEMP-DEBUG] diagResponsesFor(${a.name}): a.responses.length=${a.responses.length}`);
    }
    const itemMeta = new Map<string, { demand: string | null; itemSet: string | null; fallbackOrder: number }>();
    let fallbackOrder = 0;
    const __tempDebugExcludedItemIds: string[] = []; // TEMP-DEBUG
    for (const it of a.items) {
      if ((it.maxScore ?? 1) < 1) {
        if (__tempDebug) __tempDebugExcludedItemIds.push(it.id); // TEMP-DEBUG
        continue;
      }
      itemMeta.set(it.id, { demand: it.demand, itemSet: it.itemSet ?? null, fallbackOrder: fallbackOrder++ });
    }
    if (__tempDebug) {
      console.log(
        `[TEMP-DEBUG] diagResponsesFor(${a.name}): excluded ${__tempDebugExcludedItemIds.length} item(s) ` +
          `by (maxScore ?? 1) < 1: [${__tempDebugExcludedItemIds.join(", ")}]`,
      );
    }
    const out: DiagResponse[] = [];
    let fallbackOrderCount = 0;
    for (const r of a.responses) {
      const meta = itemMeta.get(r.i);
      if (!meta) continue;
      let order = r.questionPresentedNumber ?? null;
      if (order == null) {
        order = meta.fallbackOrder;
        fallbackOrderCount += 1;
      }
      out.push({
        participantId: r.p,
        itemId: r.i,
        demandLevel: meta.demand,
        itemSet: meta.itemSet,
        order,
        answered: r.a !== false,
        correct: r.s === 1,
        responseTime: r.responseTime ?? null,
      });
    }
    if (fallbackOrderCount > 0) {
      console.warn(
        `diagResponsesFor: ${a.name} — ${fallbackOrderCount} response(s) had no questionPresentedNumber; ` +
          `fell back to item-array-position proxy for presentation order.`,
      );
    }
    // TEMP-DEBUG (maxScore-leak investigation — REMOVE AFTER)
    if (__tempDebug) {
      console.log(`[TEMP-DEBUG] diagResponsesFor(${a.name}): returned DiagResponse[].length=${out.length}`);
    }
    return out;
  }
  /**
   * participantId -> full subject score for one assessment, composed from the
   * three components (retained MCQ + essay + alterations). The map values are the
   * engine's ParticipantScore, so callers can read the total (`raw`), `max`,
   * `pct`, and the per-component breakdown (`mcq` / `essay` / `alterations`).
   */
  private pctByParticipant(cycleId: string, a: SeedAssessment): Map<string, ParticipantScore> {
    const excluded = [...this.excludedSet(cycleId, a.id)];
    const scores = engine.computeScores(this.responsesOf(a), excluded, {
      essayMarks: this.essayMarksFor(cycleId, a.id),
      alterations: this.alterationsFor(cycleId, a.id),
      essayAssessmentIds: this.essaySubjectIds(),
      // Half-weighted essay max, derived from the subject's essay block (never the
      // hard-coded 20). 0 for non-essay subjects, so nothing is reserved there.
      essayMax: reservedEssayMax(a),
      items: this.itemMetasFor(a),
    });
    return new Map(scores.map((s) => [s.participantId, s]));
  }

  /**
   * Pre-item-review-deletion subject scores for the Raw Scores view.
   *
   * The SAME engine score path as the final Score (`pctByParticipant`) — cleaned
   * cohort, Clean-stage column removals, and the half-weighted essay component —
   * but WITHOUT the item-review deletions (`excludedItemIds` here is Clean columns
   * only, never the reviewed-item exclusions). So Raw = Score − the deletion step;
   * on a cohort with no item-review deletions the two are identical. Alterations
   * are deliberately NOT applied here: Raw stays the as-submitted (cleaned MCQ +
   * essay) view, and manual mark adjustments belong to the downstream Score.
   */
  private rawSubjectScores(cycleId: string, a: SeedAssessment): Map<string, ParticipantScore> {
    const cleanCols = this.cleanCols.get(`${cycleId}:${a.id}`);
    const excluded = cleanCols && cleanCols.size ? [...cleanCols] : [];
    const scores = engine.computeScores(this.responsesOf(a), excluded, {
      essayMarks: this.essayMarksFor(cycleId, a.id),
      essayAssessmentIds: this.essaySubjectIds(),
      // Half-weighted essay max, derived from the subject's essay block (0 for a
      // non-essay subject) — the SAME derivation the final Score uses.
      essayMax: reservedEssayMax(a),
      items: this.itemMetasFor(a),
    });
    return new Map(scores.map((s) => [s.participantId, s]));
  }
  /**
   * Assessment ids that carry an essay component (English + Arabic). Uses the one
   * shared, script-aware detector (lib/data/essays) so the Arabic-script subject
   * is recognised from its item data / name — not the old Latin-only regex.
   */
  private essaySubjectIds(): string[] {
    return this.seed.liveCycle.assessments.filter((a) => isEssaySubject(a)).map((a) => a.id);
  }
  private itemMetasFor(a: SeedAssessment): ItemMeta[] {
    return a.items.map((it) => ({
      itemId: it.id,
      assessmentId: a.id,
      majorElement: it.major,
      subElement: it.sub,
      demandLevel: it.demand,
      maxScore: it.maxScore,
    }));
  }
  private essayMarksFor(cycleId: string, assessmentId?: string): EssayMark[] {
    const all = this.essayMarksByCycle.get(cycleId)?.marks ?? [];
    return assessmentId ? all.filter((e) => e.assessmentId === assessmentId) : all;
  }
  /**
   * The Arabic/English assessment for an essay subject code (AFL/ESL). Resolves
   * the Arabic subject as the essay subject that is not English, so it matches
   * whether the subject name is Latin ("Arabic…") or Arabic script.
   */
  private essayAssessmentForCode(code: string): SeedAssessment | undefined {
    const A = this.seed.liveCycle.assessments;
    if (/esl|english/i.test(code)) return A.find((a) => /english/i.test(a.name));
    if (/afl|arabic/i.test(code)) return A.find((a) => isEssaySubject(a) && !/english/i.test(a.name));
    return undefined;
  }
  private alterationsFor(cycleId: string, assessmentId?: string): Alteration[] {
    // Incident-derived alterations + manual mark adjustments, fed to the engine as
    // the single `alterations` input. The manual delta is therefore applied as
    // engine INPUT (never by altering item-stats/engine logic), so the grade
    // recomputes through the full existing path — keeping engine parity intact.
    const incident = this.alterationsByCycle.get(cycleId) ?? [];
    const manual = (this.manualAdjustmentsByCycle.get(cycleId) ?? []).map((m) => ({
      participantId: m.participantId,
      assessmentId: m.assessmentId,
      marks: m.delta,
    }));
    const all = [...incident, ...manual];
    return assessmentId ? all.filter((e) => e.assessmentId === assessmentId) : all;
  }

  /** The active manual mark adjustment on one student's subject, if any. */
  private manualAdjustmentFor(cycleId: string, participantId: string, assessmentId: string): ManualMarkAdjustment | undefined {
    return (this.manualAdjustmentsByCycle.get(cycleId) ?? []).find(
      (m) => m.participantId === participantId && m.assessmentId === assessmentId,
    );
  }

  /** Public lookup of a manual adjustment by id (used by the Supabase wrapper). */
  findManualAdjustment(cycleId: string, adjustmentId: string): ManualMarkAdjustment | undefined {
    return (this.manualAdjustmentsByCycle.get(cycleId) ?? []).find((m) => m.id === adjustmentId);
  }

  /**
   * Borderline detection for one subject score: is the student within the
   * configurable borderline band (`this.borderline.bandPct`, in PERCENTAGE
   * POINTS) below the cut for the NEXT grade up? Returns the gap to that cut in
   * both percentage points (`pctToNext`, the flagging unit) and raw marks
   * (`marksToNext`, kept so the adjustment dialog can pre-fill the upward bump) —
   * or null when the student is farther than the band below every boundary, or is
   * already at the top band.
   *
   * Percentage flagging is fairer than the old raw-item-count rule: a fixed mark
   * count meant wildly different leniencies across subjects with different item
   * totals; a % band is consistent and is measured in the same % space the cuts
   * (and `classify`) live in. The band is symmetric about the threshold; we flag
   * the just-below side, which is what feeds the "nudge them over" workflow.
   */
  private marginalInfo(
    score: ParticipantScore,
    cuts: number[],
    levels: string[],
  ): { marksToNext: number; pctToNext: number; nextLevel: string } | null {
    const { raw, max, pct } = score;
    if (max <= 0) return null;
    const band = this.borderline.bandPct;
    if (!(band > 0)) return null; // a band of 0 disables borderline flagging
    // cuts are descending percentages (best → lowest); the next grade up is the
    // CLOSEST cut strictly above the student's % — the lowest boundary they have
    // not yet cleared. Iterating from the lowest cut upward, the first cut above
    // them is that closest boundary. Measuring in % keeps this consistent with
    // `classify`, which bands on the same `pct`.
    for (let i = cuts.length - 1; i >= 0; i--) {
      const cutPct = cuts[i]!;
      if (cutPct > pct) {
        const pctBelow = cutPct - pct;
        if (pctBelow > 0 && pctBelow <= band) {
          const cutRaw = (cutPct / 100) * max;
          return { marksToNext: round(cutRaw - raw, 2), pctToNext: round(pctBelow, 2), nextLevel: levels[i] ?? "" };
        }
        return null; // closest boundary above is farther than the band
      }
    }
    return null; // already at/above the top cut — no grade up to miss
  }
  /**
   * The live ScoringConfig the engine reads — the item-quality thresholds
   * (`this.quality`) plus the level/award vocabulary and default cut-points
   * (`this.grading`). This is the single config object the settings read-model
   * exposes (`getScoringConfig`) and that threads into every engine call, so
   * editing it actually changes scoring.
   */
  private scoringConfig(): ScoringConfig {
    return {
      quality: this.quality,
      performanceLevels: this.grading.performanceLevels.map((label) => ({
        label,
        stars: this.grading.starMap[label] ?? "",
      })),
      awardLevels: this.grading.awardLevels.map((label) => ({ label })),
      performanceCuts: [...this.grading.performanceCuts],
      awardCuts: [...this.grading.awardCuts],
    };
  }

  /** Levels + default cuts/targets for a scope (assessment → performance, overall → award). */
  private schemeFor(scope: string): { levels: string[]; cuts: number[]; targets: number[]; isAward: boolean } {
    if (scope === "overall") {
      return {
        levels: this.grading.awardLevels,
        cuts: this.grading.awardCuts,
        targets: DEFAULT_AWARD_TARGETS,
        isAward: true,
      };
    }
    return {
      levels: this.grading.performanceLevels,
      cuts: this.grading.performanceCuts,
      targets: DEFAULT_PERFORMANCE_TARGETS,
      isAward: false,
    };
  }
  private boundaryState(cycleId: string, scope: string): BoundaryState {
    const existing = this.boundaries.get(`${cycleId}:${scope}`);
    if (existing) return existing;
    const s = this.schemeFor(scope);
    return { mode: "cuts", cuts: [...s.cuts], targets: [...s.targets] };
  }

  private assessmentRefs(cycleId: string): AssessmentRef[] {
    return this.seed.liveCycle.assessments.map((a) => ({
      id: a.id,
      name: a.name,
      shortName: a.shortName,
      rtl: a.rtl,
      itemCount: a.items.length,
      excludedCount: this.excludedSet(cycleId, a.id).size,
      stageIndex: a.stageIndex,
    }));
  }

  // ── cycles ────────────────────────────────────────────────────────────────
  listCycles(): CycleSummary[] {
    const live = this.seed.liveCycle;
    const liveCentre = this.centreFor(this.effectiveCentreId(live.id, live.testCentreId));
    const liveSummary: CycleSummary = {
      id: live.id,
      name: live.name,
      stageIndex: live.stageIndex,
      stageLabel: this.locked.has(live.id) ? "Locked & exported" : PIPELINE[live.stageIndex] ?? "Draft",
      stepsDone: this.locked.has(live.id) ? PIPELINE.length : live.stageIndex,
      participants: this.cohortParticipantCount(),
      assessments: live.assessments.length,
      lastActivity: live.lastActivity,
      locked: this.locked.has(live.id),
      live: true,
      mock: false,
      testCentreId: liveCentre.id,
      testCentreName: liveCentre.name,
      examYearId: live.yearId,
    };
    const priors: CycleSummary[] = this.seed.priorCycles.map((p) => {
      const centre = this.centreFor(this.effectiveCentreId(p.id, p.testCentreId));
      return {
        id: p.id,
        name: p.name,
        stageIndex: p.stageIndex,
        stageLabel: "Locked & exported",
        stepsDone: p.stepsDone,
        participants: p.participants,
        assessments: p.assessments,
        lastActivity: p.lastActivity,
        locked: p.locked,
        live: false,
        mock: true,
        testCentreId: centre.id,
        testCentreName: centre.name,
        examYearId: p.yearId,
      };
    });
    return [liveSummary, ...priors];
  }

  getCycle(cycleId: string): CycleDetail | null {
    const live = this.seed.liveCycle;
    if (cycleId === live.id) {
      const refs = this.assessmentRefs(cycleId);
      return {
        id: live.id,
        name: live.name,
        participants: this.cohortParticipantCount(),
        assessmentCount: refs.length,
        startedAt: live.startedAt,
        stageIndex: this.locked.has(live.id) ? PIPELINE.length - 1 : live.stageIndex,
        locked: this.locked.has(live.id),
        mock: false,
        testCentreName: this.centreFor(this.effectiveCentreId(live.id, live.testCentreId)).name,
        // Land on the cycle's FIRST INCOMPLETE step — never skip ahead to a
        // screen (Review/Boundaries/…) whose data doesn't exist yet. A locked
        // cycle's work is done, so its next action is document generation; an
        // empty/draft cycle resolves to Upload (stageIndex 0). The previous code
        // hard-coded "Review item quality" regardless of progress, which threw a
        // brand-new cycle straight onto the Cronbach/Review screen.
        doNext: doNextForStage(live.id, this.locked.has(live.id) ? PIPELINE.length - 1 : live.stageIndex),
        assessments: refs,
      };
    }
    const prior = this.seed.priorCycles.find((p) => p.id === cycleId);
    if (prior) {
      return {
        id: prior.id,
        name: prior.name,
        participants: prior.participants,
        assessmentCount: prior.assessments,
        startedAt: prior.lastActivity,
        stageIndex: prior.stageIndex,
        locked: true,
        mock: true,
        testCentreName: this.centreFor(this.effectiveCentreId(prior.id, prior.testCentreId)).name,
        doNext: { title: "Locked cycle", body: "This is a mock prior cycle with no detailed data in this build.", href: "/", cta: "Back to cycles" },
        assessments: [],
      };
    }
    return null;
  }

  // ── years (groups of sittings) ────────────────────────────────────────────
  // A year is a grouping over the per-sitting cycles. We derive the year label
  // and sitting (February / May) from each cycle's name — the same mapping the
  // SQL migration applies to the stored rows (see 0005). No engine/scoring code
  // is involved: this is pure presentation grouping.

  /** Stable, route-safe year id from a year label, e.g. "2026" → "year-2026". */
  private yearId(year: string): string {
    return `year-${year}`;
  }

  /** Pull a 4-digit year out of a cycle name (fallback: "Unknown"). */
  private yearOf(name: string): string {
    const m = name.match(/(19|20)\d{2}/);
    return m ? m[0] : "Unknown";
  }

  /** Map a cycle name to its sitting: Jan–Apr → February, otherwise May. */
  private sittingOf(name: string): SittingKey {
    return /\b(jan|feb|mar|apr)/i.test(name) ? "february" : "may";
  }

  private sittingRefFrom(c: CycleSummary, sitting: SittingKey): SittingRef {
    return {
      sitting,
      label: sitting === "february" ? "February" : "May",
      testCentreName: c.testCentreName,
      cycleId: c.id,
      cycleName: c.name,
      started: true,
      locked: c.locked,
      stageLabel: c.stageLabel,
      stepsDone: c.stepsDone,
      participants: c.participants,
      assessments: c.assessments,
      lastActivity: c.lastActivity,
      live: c.live,
      mock: c.mock,
    };
  }

  private emptySitting(sitting: SittingKey, testCentreName: string): SittingRef {
    return {
      sitting,
      label: sitting === "february" ? "February" : "May",
      testCentreName,
      cycleId: null,
      cycleName: null,
      started: false,
      locked: false,
      stageLabel: "Not started",
      stepsDone: 0,
      participants: 0,
      assessments: 0,
      lastActivity: "—",
      live: false,
      mock: false,
    };
  }

  /**
   * Group every cycle into its (centre, year) + sitting slot (newest first). A
   * year now belongs to a TEST CENTRE (migration 0010), so the grouping key is
   * (centreId, year): "Shatila 1 / 2026" and "Shatila 2 / 2026" are two distinct
   * year rows that share the comparable period "2026". The primary centre keeps
   * the clean `year-${year}` id (route + test stability); additional centres are
   * qualified by their slug so their ids stay unique.
   */
  private buildYears(): {
    id: string;
    name: string;
    testCentreId: string;
    testCentreName: string;
    examYearId?: string;
    february: SittingRef;
    may: SittingRef;
  }[] {
    const order: string[] = [];
    const byKey = new Map<
      string,
      { year: string; centre: TestCentreSummary; examYearId?: string; anchorCycleId?: string; february?: SittingRef; may?: SittingRef }
    >();
    const primaryId = this.primaryTestCentre().id;
    for (const c of this.listCycles()) {
      const year = this.yearOf(c.name);
      const sitting = this.sittingOf(c.name);
      const centre = this.centreFor(c.testCentreId);
      // GROUPING KEY — always id-anchored for live data so a route param is never a
      // name label:
      //  * a real exam_years row groups all its sittings together (by year_id);
      //  * a live cycle with NO year row is its own year (keyed on its cycle id) — it
      //    isn't linked to any other sitting in the DB, so it must never merge by a
      //    parsed/blank name into a shared "Unknown" bucket;
      //  * the demo (no DB) groups February + May of a parsed year under one card.
      const key = c.examYearId
        ? `y:${c.examYearId}`
        : this.hydrated && c.id
          ? `c:${c.id}`
          : `${centre.id}|${year}`;
      if (!byKey.has(key)) {
        byKey.set(key, { year, centre, anchorCycleId: c.id || undefined });
        order.push(key);
      }
      const slot = byKey.get(key)!;
      // The real exam_years.id (live data) — first cycle in the slot to carry one
      // wins; all sittings of a (centre, year) share the same year row.
      if (!slot.examYearId && c.examYearId) slot.examYearId = c.examYearId;
      if (!slot.anchorCycleId && c.id) slot.anchorCycleId = c.id;
      const ref = this.sittingRefFrom(c, sitting);
      // First write wins per slot; listCycles is newest-first and the live run is
      // first, so the most relevant cycle keeps the slot if names ever collide.
      if (!slot[sitting]) slot[sitting] = ref;
    }
    return order.map((key) => {
      const slot = byKey.get(key)!;
      // ROUTE ID — ALWAYS a real id, NEVER a name label:
      //  * a real exam_years row → its UUID (canonical year id, carried unchanged);
      //  * a live cycle with no year row → the sitting's own (real) cycle id, so the
      //    route param can never be the `year-Unknown` label and the year still opens;
      //  * the demo (no DB) → its stable `year-<year>` fixture key (no DB id exists,
      //    and demo names always carry a year, so "Unknown" is never constructed).
      // The NAME is display-only and falls back to "Unknown"; it is not the key.
      const derivedLabel =
        slot.centre.id === primaryId ? this.yearId(slot.year) : `${this.yearId(slot.year)}--${slot.centre.slug}`;
      const id =
        slot.examYearId ?? (this.hydrated ? (slot.anchorCycleId ?? derivedLabel) : derivedLabel);
      return {
        id,
        name: slot.year,
        testCentreId: slot.centre.id,
        testCentreName: slot.centre.name,
        examYearId: slot.examYearId,
        february: slot.february ?? this.emptySitting("february", slot.centre.name),
        may: slot.may ?? this.emptySitting("may", slot.centre.name),
      };
    });
  }

  listYears(): YearSummary[] {
    return this.buildYears().map((y) => {
      const live = y.february.live || y.may.live;
      const mock =
        (!y.february.started || y.february.mock) &&
        (!y.may.started || y.may.mock) &&
        !live;
      const lastActivity =
        (y.may.live && y.may.lastActivity) ||
        (y.february.live && y.february.lastActivity) ||
        (y.may.started && y.may.lastActivity) ||
        (y.february.started && y.february.lastActivity) ||
        "—";
      return {
        id: y.id,
        name: y.name,
        testCentreId: y.testCentreId,
        testCentreName: y.testCentreName,
        examYearId: y.examYearId,
        february: y.february,
        may: y.may,
        participants: Math.max(y.february.participants, y.may.participants),
        lastActivity,
        live,
        mock,
      };
    });
  }

  getYear(yearId: string): YearDetail | null {
    // Resolve on the canonical id (the real exam_years.id for live data), also
    // accepting the legacy derived label-key so any older link still opens.
    const y = this.buildYears().find((yr) => yr.id === yearId || yr.examYearId === yearId);
    if (!y) return null;
    // Overall is the best-of-two-by-award-level rollup — implemented next prompt.
    const ready = y.february.started && y.february.locked && y.may.started && y.may.locked;
    return {
      id: y.id,
      name: y.name,
      testCentreId: y.testCentreId,
      testCentreName: y.testCentreName,
      examYearId: y.examYearId,
      february: y.february,
      may: y.may,
      overall: {
        ready,
        note: ready
          ? "Both sittings are locked — the Overall best-of-two rollup runs here."
          : "Overall becomes available once both the February and May sittings are locked.",
      },
    };
  }

  // ── ingest & validate ─────────────────────────────────────────────────────
  getIngest(cycleId: string): IngestModel | null {
    const live = this.seed.liveCycle;
    if (cycleId !== live.id) return null;
    // A raw export has actually been ingested only once some subject has
    // responses. A freshly-created (empty) cycle has none — the Import screen
    // shows its upload prompt instead of an all-zero "validation report".
    const uploaded = live.assessments.some((a) => a.responses.length > 0);
    return {
      cycleId,
      uploaded,
      fileName: live.fileName,
      fileSizeMB: live.fileSizeMB,
      uploadedAgo: live.uploadedAgo,
      files: live.files ?? { items: null, assessments: null, topics: null },
      report: live.validation,
      preview: live.preview,
      duplicates: live.duplicates,
      canContinue: uploaded && live.validation.passed,
      technicalErrors: this.technicalErrorsUpload(cycleId),
    };
  }

  // ── front of pipeline: combined upload · raw data · cleaning · naive scores ──
  /** Distinct participant ids that have at least one response in an assessment. */
  private participantsIn(a: SeedAssessment): Set<string> {
    const set = new Set<string>();
    for (const r of a.responses) set.add(r.p);
    return set;
  }

  /**
   * The authoritative ingest roster (migration 0026 `sittings`): which participants
   * sat each subject, STAFF INCLUDED, read from the sitting spine carried in the
   * seed — not the MCQ response matrix. Falls back to the response matrix for legacy
   * seeds that predate the carried sittings (the two agree on correct data). Every
   * ingest-stage per-subject / cycle participant count reads from this.
   */
  getSittingRoster(cycleId: string): SittingRoster | null {
    const live = this.seed.liveCycle;
    if (cycleId !== live.id) return null;
    const emailOf = new Map(live.participants.map((p) => [p.id, p.studentId ?? p.id]));
    const byAssessment = new Map<string, Map<string, string>>();

    if (live.sittings && live.sittings.length > 0) {
      for (const s of live.sittings) {
        const roster = byAssessment.get(s.assessmentId) ?? new Map<string, string>();
        roster.set(s.participantId, s.participantEmail || emailOf.get(s.participantId) || s.participantId);
        byAssessment.set(s.assessmentId, roster);
      }
    } else {
      // Legacy fallback: derive the roster from the response matrix (== sittings on
      // correctly-ingested data), so a seed without the sitting spine still reads a
      // per-subject roster rather than nothing.
      for (const a of live.assessments) {
        const roster = new Map<string, string>();
        for (const id of this.participantsIn(a)) roster.set(id, emailOf.get(id) ?? id);
        byAssessment.set(a.id, roster);
      }
    }

    const distinctEmails = new Set<string>();
    for (const roster of byAssessment.values()) for (const email of roster.values()) distinctEmails.add(email.toLowerCase());
    return { byAssessment, totalParticipants: distinctEmails.size };
  }
  /** Distinct major elements in an assessment, in first-appearance order. */
  private majorsOf(a: SeedAssessment): string[] {
    return this.majorsOfItems(a.items);
  }
  /** Distinct major elements across a set of items, in first-appearance order. */
  private majorsOfItems(items: SeedAssessment["items"]): string[] {
    const seen: string[] = [];
    for (const it of items) if (it.major && !seen.includes(it.major)) seen.push(it.major);
    return seen;
  }
  private demandCounts(a: SeedAssessment): { D1: number; D2: number; D3: number } {
    const d = { D1: 0, D2: 0, D3: 0 };
    for (const it of a.items) if (it.demand === "D1" || it.demand === "D2" || it.demand === "D3") d[it.demand] += 1;
    return d;
  }
  /** Resolved A–E letter + display label for each major element of a subject,
   *  driven by the configurable per-subject element labels (Settings). */
  private elementLabelMap(a: SeedAssessment): Map<string, ResolvedElementLabel> {
    return labelMapForSubject(this.elementLabels, a.name, this.majorsOfItems(a.items));
  }

  /** Build the raw response matrix (participants × items) for a subject. */
  private rawMatrix(a: SeedAssessment): { columns: RawColumnMeta[]; rows: RawDataRow[] } {
    const labels = this.elementLabelMap(a);
    const columns: RawColumnMeta[] = a.items.map((it, i) => {
      const resolved = it.major ? labels.get(it.major) : undefined;
      return {
        id: it.id,
        qLabel: `Q${i + 1}`,
        major: it.major,
        sub: it.sub,
        demand: it.demand,
        maxScore: it.maxScore ?? 1,
        elLetter: resolved?.letter ?? null,
        elLabel: resolved?.label ?? null,
      };
    });
    const score = new Map<string, number>();
    for (const r of a.responses) score.set(`${r.p} ${r.i}`, r.s);
    const present = this.participantsIn(a);
    const rows: RawDataRow[] = this.seed.liveCycle.participants
      .filter((p) => present.has(p.id))
      .map((p) => ({
        id: p.id,
        studentId: p.studentId ?? p.id,
        name: p.label,
        cells: a.items.map((it) => {
          const v = score.get(`${p.id} ${it.id}`);
          return v === undefined ? null : v;
        }),
      }));
    return { columns, rows };
  }

  getCombinedSplit(cycleId: string): CombinedSplitModel | null {
    const live = this.seed.liveCycle;
    if (cycleId !== live.id) return null;
    // The split panel summarises a raw export AFTER it's been ingested. With no
    // upload yet (empty cycle) there is nothing to split — return null so the
    // Import screen shows its upload prompt, not "Detected 0-item subjects".
    if (!live.assessments.some((a) => a.responses.length > 0)) return null;
    // Per-subject participants = the authoritative ingest roster (sittings,
    // count(distinct participant_email), staff INCLUDED) — not the MCQ matrix.
    const roster = this.getSittingRoster(cycleId);
    const rosterSize = (a: SeedAssessment) => roster?.byAssessment.get(a.id)?.size ?? this.participantsIn(a).size;
    const counts = live.assessments.map((a) => rosterSize(a));
    const maxParts = Math.max(...counts, 0);
    const essayIds = new Set(this.essaySubjectIds());
    const subjects: DetectedSubject[] = live.assessments.map((a) => {
      const participants = rosterSize(a);
      const warn = participants < maxParts;
      return {
        id: a.id,
        name: a.name,
        shortName: a.shortName,
        items: a.items.length,
        participants,
        elements: this.majorsOf(a),
        rtl: a.rtl,
        hasEssay: essayIds.has(a.id),
        status: warn ? "warn" : "ok",
        note: warn ? `${maxParts - participants} fewer participant${maxParts - participants > 1 ? "s" : ""} than the largest subject` : null,
      };
    });
    return {
      cycleId,
      fileName: live.fileName,
      fileSizeMB: live.fileSizeMB,
      uploadedAgo: live.uploadedAgo,
      totalItems: live.assessments.reduce((n, a) => n + a.items.length, 0),
      // Distinct participants across the cycle from the sitting roster (staff incl).
      totalParticipants: roster?.totalParticipants ?? live.participants.length,
      subjects,
    };
  }

  getRawData(cycleId: string, assessmentId: string): RawDataModel | null {
    const a = this.assessment(assessmentId);
    if (cycleId !== this.seed.liveCycle.id || !a) return null;
    const refs = this.assessmentRefs(cycleId);
    const labels = this.elementLabelMap(a);
    const byElement: RawElementBreak[] = this.majorsOf(a).map((major) => {
      const items = a.items.filter((it) => it.major === major);
      const subs: string[] = [];
      for (const it of items) if (it.sub && !subs.includes(it.sub)) subs.push(it.sub);
      const resolved = labels.get(major);
      return { major, subs, items: items.length, letter: resolved?.letter, label: resolved?.label };
    });
    const subElementsCount = byElement.reduce((n, e) => n + e.subs.length, 0);
    const { columns, rows } = this.rawMatrix(a);
    return {
      assessment: refs.find((r) => r.id === assessmentId)!,
      assessments: refs,
      participants: this.participantsIn(a).size,
      items: a.items.length,
      scoredItems: a.items.filter((it) => (it.maxScore ?? 1) >= 1).length,
      elementsCount: byElement.length,
      subElementsCount,
      demand: this.demandCounts(a),
      byElement,
      columns,
      rows,
    };
  }

  getDataCleaning(cycleId: string, assessmentId: string): DataCleaningModel | null {
    const a = this.assessment(assessmentId);
    if (cycleId !== this.seed.liveCycle.id || !a) return null;
    const refs = this.assessmentRefs(cycleId);
    // Surface the REAL validation report as cleaning checks; warnings vs must-fix
    // are distinguished by status. The sample data is clean, so blockers only
    // appear if a real upload fails validation.
    const checks: CleaningCheck[] = this.seed.liveCycle.validation.checks.map((c) => ({
      id: c.id,
      status: c.status,
      title: c.label,
      detail: c.detail || null,
      count: c.count != null ? String(c.count) : null,
      action: c.status === "fail" ? "Resolve" : c.status === "warn" ? "Review" : null,
    }));
    const counts = {
      pass: checks.filter((c) => c.status === "pass").length,
      warn: checks.filter((c) => c.status === "warn").length,
      fail: checks.filter((c) => c.status === "fail").length,
    };
    const { columns, rows } = this.rawMatrix(a);
    // Apply the non-destructive clean-stage removals. Removed COLUMNS and ROWS both
    // stay VISIBLE and are struck through instead of vanishing, so a removal reads
    // as "still here, just excluded" and can be reversed in place. `rawMatrix`
    // itself is untouched, so getRawData still shows the full raw file. The
    // exclusion (of either kind) reaches scoring through `excludedSet`, not through
    // this view — so keeping columns visible here is presentational only.
    const remRows = this.cleanRows.get(`${cycleId}:${assessmentId}`);
    const remCols = this.cleanCols.get(`${cycleId}:${assessmentId}`);
    const cleanedColumns = columns;
    const cleanedRows = rows;
    const excludedCols = columns.filter((c) => remCols?.has(c.id)).map((c) => c.id);
    // Struck rows have two scopes, both kept visible: PER-SUBJECT removals (this
    // sitting only — `setCleanRemoval`) and COHORT-WIDE exclusions (every subject —
    // `excludeParticipantFromCohort`, incl. seeded staff/test accounts). The union
    // is what the table strikes through; the split drives the scope-aware UI.
    const cohortExcluded = this.cohortExcludedSet();
    const cohortExcludedRows = cleanedRows.filter((r) => cohortExcluded.has(r.id)).map((r) => r.id);
    const subjectExcludedRows = cleanedRows.filter((r) => remRows?.has(r.id) && !cohortExcluded.has(r.id)).map((r) => r.id);
    const excludedRows = cleanedRows.filter((r) => cohortExcluded.has(r.id) || remRows?.has(r.id)).map((r) => r.id);
    return {
      assessment: refs.find((r) => r.id === assessmentId)!,
      assessments: refs,
      checks,
      counts,
      rowsBefore: rows.length,
      rowsAfter: cleanedRows.length - excludedRows.length,
      canProceed: counts.fail === 0,
      columns: cleanedColumns,
      rows: cleanedRows,
      excludedRows,
      subjectExcludedRows,
      cohortExcludedRows,
      excludedCols,
    };
  }

  /**
   * Read-only view of the cleaned set in the Questionmark cleaned-export column
   * layout (lib/data/cleaned-schema.ts) — one row per retained (participant, item)
   * response, so the Clean step mirrors the team's Excel spreadsheet. Honours the
   * Clean-stage removals (the raw matrix is untouched). De-identified: PII and the
   * QM-only per-response metadata columns are present in position but blank — never
   * fabricated, never exported.
   */
  getCleanedData(cycleId: string, assessmentId: string): CleanedDataModel | null {
    const a = this.assessment(assessmentId);
    if (cycleId !== this.seed.liveCycle.id || !a) return null;
    const refs = this.assessmentRefs(cycleId);
    const remRows = this.cleanRows.get(`${cycleId}:${assessmentId}`);
    const remCols = this.cleanCols.get(`${cycleId}:${assessmentId}`);
    const items = remCols && remCols.size ? a.items.filter((it) => !remCols.has(it.id)) : a.items;
    const present = this.participantsIn(a);
    // Post-clean state: drop both per-subject removed rows AND cohort-excluded
    // (soft-deleted / staff-test) participants, so this mirror — and the Excel
    // export built from it — reflects exactly what survives cleaning.
    const cohortExcluded = this.cohortExcludedSet();
    const parts = this.seed.liveCycle.participants.filter(
      (p) => present.has(p.id) && !remRows?.has(p.id) && !cohortExcluded.has(p.id),
    );

    const scoreByKey = new Map<string, number>();
    for (const r of a.responses) scoreByKey.set(`${r.p} ${r.i}`, r.s);
    const choiceNumberByKey = new Map<string, string | null>();
    for (const r of a.responses) choiceNumberByKey.set(`${r.p} ${r.i}`, r.answerGivenChoiceNumber ?? null);
    const presentedNumberByKey = new Map<string, number | null>();
    for (const r of a.responses) presentedNumberByKey.set(`${r.p} ${r.i}`, r.questionPresentedNumber ?? null);
    const answerGivenByKey = new Map<string, string>();
    const responseTimeByKey = new Map<string, number>();
    for (const r of a.responses) {
      if (r.answerGiven != null) answerGivenByKey.set(`${r.p} ${r.i}`, r.answerGiven);
      if (r.responseTime != null) responseTimeByKey.set(`${r.p} ${r.i}`, r.responseTime);
    }
    const incident = new Map<string, string>();
    for (const ti of a.technicalIncidents ?? []) incident.set(ti.p, ti.status);
    // Max-0 items (instruction/stimulus pages) are never real responses — excluded
    // from both the score totals and the exported rows below, so a passage intro
    // doesn't show up as a full row in the Clean step's export.
    const scored = items.filter((it) => (it.maxScore ?? 1) >= 1);
    const maxTotal = scored.reduce((n, it) => n + (it.maxScore ?? 1), 0);

    const rows: string[][] = [];
    for (const p of parts) {
      // Per-participant totals over retained, scored items (the cleaned set).
      let total = 0;
      for (const it of scored) total += scoreByKey.get(`${p.id} ${it.id}`) ?? 0;
      const pct = maxTotal ? Math.round((total / maxTotal) * 1000) / 10 : 0;
      const resultStatus = incident.get(p.id) ?? "Finished OK";
      for (const it of scored) {
        const score = scoreByKey.get(`${p.id} ${it.id}`);
        if (score === undefined) continue; // a row per presented (answered) question
        const rec: Partial<Record<CleanedDataColumn, string>> = {
          // ResultId is the SITTING key (QM ResultId) — one per participant ×
          // subject — NOT the participant id, so a participant's separate subjects
          // stay distinct sitting-records. Falls back to the participant id only for
          // legacy seeds that predate the per-sitting map.
          ResultId: a.resultIdByParticipant?.[p.id] ?? p.id,
          QuestionId: it.id,
          QuestionDescription: it.wording ?? "",
          QuestionType: "Multiple Choice",
          QuestionSubElement: it.sub ?? "",
          QuestionPresentedNumber: presentedNumberByKey.get(`${p.id} ${it.id}`) != null ? String(presentedNumberByKey.get(`${p.id} ${it.id}`)) : "",
          QuestionWording: it.wording ?? "",
          QuestionMinimumScore: "0",
          QuestionMaximumScore: String(it.maxScore ?? 1),
          QuestionStatus: "Normal",
          AnswerGiven: answerGivenByKey.get(`${p.id} ${it.id}`) ?? "",
          AnswerScore: String(score),
          AnswerGivenChoiceNumber: choiceNumberByKey.get(`${p.id} ${it.id}`) ?? "",
          AnswerResponseTimeSeconds:
            responseTimeByKey.get(`${p.id} ${it.id}`) !== undefined
              ? String(responseTimeByKey.get(`${p.id} ${it.id}`))
              : "",
          AssessmentId: a.id,
          AssessmentName: a.name,
          // Participant identity, carried as its OWN column (the email = the
          // qm_participant_id), distinct from the ResultId/sitting key — the field
          // used to group a participant's sittings across subjects.
          ParticipantEmail: p.studentId ?? "",
          ResultStatus: resultStatus,
          ResultTotalScore: String(total),
          ResultPercentageScore: String(pct),
          ResultMaximumScore: String(maxTotal),
          ParticipantFullName: p.label,
          ParticipantID: p.studentId ?? p.id,
          QuestionMajorElement: it.major ?? "",
        };
        rows.push(CLEANED_DATA_COLUMNS.map((c) => rec[c] ?? ""));
      }
    }

    return {
      assessment: refs.find((r) => r.id === assessmentId)!,
      assessments: refs,
      headers: [...CLEANED_DATA_COLUMNS],
      blankColumns: [...CLEANED_DATA_UNAVAILABLE],
      rows,
      retained: { participants: parts.length, items: items.length, responses: rows.length },
    };
  }

  /** The scored-exam assessments for the live cycle (surveys excluded). */
  private examAssessments(): SeedAssessment[] {
    return this.seed.liveCycle.assessments.filter((a) => !isSurveyAssessment(a.name));
  }

  getCleaningImpact(cycleId: string): CleaningImpactModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const refs = this.assessmentRefs(cycleId);
    const exams = this.examAssessments();
    const cohortRemoved = this.cohortRemovedParticipants();
    const cohortExcluded = this.cohortExcludedSet();

    // Cohort-wide distinct participants across the scored exams.
    const beforeParts = new Set<string>();
    for (const a of exams) for (const id of this.participantsIn(a)) beforeParts.add(id);
    const afterParts = new Set([...beforeParts].filter((id) => !cohortRemoved.has(id)));

    // Element labels + record tallies, grouped by QuestionMajorElement.
    const elBefore = new Map<string, number>();
    const elAfter = new Map<string, number>();
    const elLabel = new Map<string, string>();

    const bySubject: CleaningImpactSubject[] = [];
    let recBefore = 0;
    let recAfter = 0;
    for (const a of exams) {
      const dropRows = new Set([...cohortExcluded, ...(this.cleanRows.get(`${cycleId}:${a.id}`) ?? [])]);
      const dropCols = this.cleanCols.get(`${cycleId}:${a.id}`) ?? new Set<string>();
      const labels = this.elementLabelMap(a);
      const itemMajor = new Map(a.items.map((it) => [it.id, it.major]));
      let sBefore = 0;
      let sAfter = 0;
      const sParts = new Set<string>();
      const sPartsAfter = new Set<string>();
      // Per-subject element tallies (parallel to the cohort-wide el* maps).
      const sElBefore = new Map<string, number>();
      const sElAfter = new Map<string, number>();
      const sElLabel = new Map<string, string>();
      for (const r of a.responses) {
        const major = itemMajor.get(r.i) ?? null;
        sBefore += 1;
        sParts.add(r.p);
        if (major) {
          elBefore.set(major, (elBefore.get(major) ?? 0) + 1);
          if (!elLabel.has(major)) elLabel.set(major, labels.get(major)?.label ?? major);
          sElBefore.set(major, (sElBefore.get(major) ?? 0) + 1);
          if (!sElLabel.has(major)) sElLabel.set(major, labels.get(major)?.label ?? major);
        }
        if (dropRows.has(r.p) || dropCols.has(r.i)) continue;
        sAfter += 1;
        sPartsAfter.add(r.p);
        if (major) {
          elAfter.set(major, (elAfter.get(major) ?? 0) + 1);
          sElAfter.set(major, (sElAfter.get(major) ?? 0) + 1);
        }
      }
      recBefore += sBefore;
      recAfter += sAfter;
      const ref = refs.find((x) => x.id === a.id)!;
      const subjectByElement: CleaningImpactElement[] = [...sElBefore.keys()].map((major) => ({
        major,
        label: sElLabel.get(major) ?? major,
        records: { before: sElBefore.get(major) ?? 0, after: sElAfter.get(major) ?? 0 },
      }));
      bySubject.push({
        assessmentId: a.id,
        shortName: ref.shortName,
        name: a.name,
        records: { before: sBefore, after: sAfter },
        participants: { before: sParts.size, after: sPartsAfter.size },
        byElement: subjectByElement,
      });
    }

    const byElement: CleaningImpactElement[] = [...elBefore.keys()].map((major) => ({
      major,
      label: elLabel.get(major) ?? major,
      records: { before: elBefore.get(major) ?? 0, after: elAfter.get(major) ?? 0 },
    }));

    return {
      cycleId,
      participants: { before: beforeParts.size, after: afterParts.size },
      records: { before: recBefore, after: recAfter },
      bySubject,
      byElement,
      excludedRecords: recBefore - recAfter,
      excludedParticipants: beforeParts.size - afterParts.size,
    };
  }

  getCleaningSummary(cycleId: string): CleaningSummaryModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const refs = this.assessmentRefs(cycleId);
    const exams = this.examAssessments();
    const cohortExcluded = this.cohortExcludedSet();

    // Per-subject score distribution — reuse the engine's `computeScores` so the
    // scored denominator is exactly the one used downstream (max-0 stimulus items
    // contribute 0 to the max and never inflate/deflate the average). `drop` is the
    // rows removed at Clean; `excludedItems` the columns removed at Clean. Cleaning
    // is isolated from the later item-review exclusions (not applied here).
    const distOf = (a: SeedAssessment, drop: Set<string>, excludedItems: string[]): CleaningSummaryDist => {
      const responses = a.responses
        .filter((r) => !drop.has(r.p))
        .map((r) => ({ participantId: r.p, itemId: r.i, assessmentId: a.id, score: r.s }));
      const scores = engine.computeScores(responses, excludedItems, {
        essayMarks: this.essayMarksFor(cycleId, a.id),
        alterations: this.alterationsFor(cycleId, a.id),
        essayAssessmentIds: this.essaySubjectIds(),
        essayMax: reservedEssayMax(a),
        items: this.itemMetasFor(a),
      });
      const pcts = scores.map((s) => s.pct);
      return {
        n: pcts.length,
        mean: round(mean(pcts), 1),
        median: round(median(pcts), 0),
        sd: round(stddev(pcts), 1),
      };
    };

    // Order: "Finished OK" first, then technical statuses alphabetically.
    const orderStatus = (keys: string[]) =>
      keys.sort((x, y) => {
        const nx = isTechnicalIncidentStatus(x) ? 1 : 0;
        const ny = isTechnicalIncidentStatus(y) ? 1 : 0;
        return nx - ny || x.localeCompare(y);
      });

    // Cohort-wide completion counts by ResultStatus, accumulated as we walk each
    // subject so the Overall (global) and per-subject views stay in lock-step.
    const before = new Map<string, number>();
    const after = new Map<string, number>();

    const subjects: CleaningSummarySubject[] = exams.map((a) => {
      const cleanRowSet = this.cleanRows.get(`${cycleId}:${a.id}`) ?? new Set<string>();
      const cleanColSet = [...(this.cleanCols.get(`${cycleId}:${a.id}`) ?? [])];
      const afterDrop = new Set([...cohortExcluded, ...cleanRowSet]);
      const ref = refs.find((x) => x.id === a.id)!;

      // This subject's completion counts by ResultStatus (before → after).
      const status = new Map<string, string>();
      for (const ti of a.technicalIncidents ?? []) status.set(ti.p, ti.status);
      const sBefore = new Map<string, number>();
      const sAfter = new Map<string, number>();
      for (const p of this.participantsIn(a)) {
        const s = status.get(p) ?? "Finished OK";
        sBefore.set(s, (sBefore.get(s) ?? 0) + 1);
        before.set(s, (before.get(s) ?? 0) + 1);
        if (!afterDrop.has(p)) {
          sAfter.set(s, (sAfter.get(s) ?? 0) + 1);
          after.set(s, (after.get(s) ?? 0) + 1);
        }
      }
      const subjectStatusCounts: CleaningSummaryStatusRow[] = orderStatus([
        ...new Set([...sBefore.keys(), ...sAfter.keys()]),
      ]).map((s) => ({ status: s, before: sBefore.get(s) ?? 0, after: sAfter.get(s) ?? 0 }));

      return {
        assessmentId: a.id,
        shortName: ref.shortName,
        name: a.name,
        before: distOf(a, new Set(), []),
        after: distOf(a, afterDrop, cleanColSet),
        statusCounts: subjectStatusCounts,
      };
    });

    const statusCounts: CleaningSummaryStatusRow[] = orderStatus([
      ...new Set([...before.keys(), ...after.keys()]),
    ]).map((status) => ({
      status,
      before: before.get(status) ?? 0,
      after: after.get(status) ?? 0,
    }));

    return {
      cycleId,
      subjects,
      statusCounts,
      note:
        "Summary statistics for the five scored exams only (survey instruments are excluded so they can’t skew cohort averages). Percentages use the scoring engine’s scored denominator (max-0 stimulus items excluded), shown before vs after the current cleaning.",
    };
  }

  getCleanedMasterDataset(cycleId: string): CleanedMasterDataset | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const exams = this.examAssessments();
    const rows: string[][] = [];
    const idIdx = CLEANED_DATA_COLUMNS.indexOf("ParticipantID" as CleanedDataColumn);
    const participants = new Set<string>();
    let subjects = 0;
    for (const a of exams) {
      const model = this.getCleanedData(cycleId, a.id);
      if (!model) continue;
      subjects += 1;
      for (const row of model.rows) {
        rows.push(row);
        if (idIdx >= 0 && row[idIdx]) participants.add(row[idIdx]!);
      }
    }
    return {
      headers: [...CLEANED_DATA_COLUMNS],
      rows,
      retained: { participants: participants.size, responses: rows.length, subjects },
    };
  }

  getNaiveScores(cycleId: string, assessmentId: string): NaiveScoresModel | null {
    const a = this.assessment(assessmentId);
    if (cycleId !== this.seed.liveCycle.id || !a) return null;
    const refs = this.assessmentRefs(cycleId);
    // Honour the Clean stage: columns/rows removed there are CLEANED OUT of the
    // data (distinct from item-review exclusions, which are applied later). The
    // raw-scores view therefore works over the cleaned item/participant set.
    const remCols = this.cleanCols.get(`${cycleId}:${assessmentId}`);
    const remRows = this.cleanRows.get(`${cycleId}:${assessmentId}`);
    const cleanItems = remCols && remCols.size ? a.items.filter((it) => !remCols.has(it.id)) : a.items;
    const majors = this.majorsOfItems(cleanItems);
    const naiveLabels = labelMapForSubject(this.elementLabels, a.name, majors);
    const elements: NaiveElementCol[] = majors.map((major, i) => {
      const resolved = naiveLabels.get(major);
      return {
        major,
        shortId: resolved?.letter ?? String.fromCharCode(65 + i), // configured A–E (else appearance order)
        items: cleanItems.filter((it) => it.major === major).length,
        label: resolved?.label ?? major,
      };
    });
    // Pre-exclusion raw score = sum of scores over scored (maxScore≥1) items.
    // NO item-review exclusions applied — this is the as-submitted view, distinct
    // from the post-exclusion scoring used downstream (parity untouched).
    const scoredItems = cleanItems.filter((it) => (it.maxScore ?? 1) >= 1);
    const mcqMax = scoredItems.length;
    const itemsByMajor = new Map<string, Set<string>>();
    for (const major of majors) itemsByMajor.set(major, new Set(cleanItems.filter((it) => it.major === major).map((it) => it.id)));

    const present = this.participantsIn(a);
    const cohortExcluded = this.cohortExcludedSet();
    // Subject totals from the engine score path (retained MCQ + half-weighted
    // essay), minus the item-review deletion step — so Raw carries the essay and
    // equals the final Score on a cohort with no deletions. The per-element cells
    // below stay the naive MCQ correct-counts (the topic breakdown), which need
    // not sum to `raw` once the essay is folded into the total.
    const hasEssay = new Set(this.essaySubjectIds()).has(a.id);
    const subjectScores = this.rawSubjectScores(cycleId, a);
    const subjectMax = subjectScores.size
      ? [...subjectScores.values()][0]!.max
      : mcqMax + (hasEssay ? reservedEssayMax(a) : 0);

    // Essay subjects (English/Arabic) surface the offline essay mark as a DISPLAY-ONLY
    // "Writing" column (its /20 is already folded into `raw` by the engine — this adds
    // no scoring). The per-participant mark drives the cell; a missing mark renders 0
    // via the same `?? 0` the MCQ element cells use. Never added for non-essay subjects.
    const essayMax = hasEssay ? reservedEssayMax(a) : 0;
    const essayMarkByPid = new Map<string, number>();
    if (hasEssay && essayMax > 0) {
      for (const m of this.essayMarksFor(cycleId, a.id)) essayMarkByPid.set(m.participantId, m.mark);
      const writing = resolveEssayWritingLabel(this.elementLabels, a.name);
      elements.push({ major: ESSAY_ELEMENT_MAJOR, shortId: writing.letter, items: 0, label: writing.label, essayMax });
    }
    const students: NaiveStudentRow[] = this.seed.liveCycle.participants
      .filter((p) => present.has(p.id) && !remRows?.has(p.id) && !cohortExcluded.has(p.id))
      .map((p) => {
        const myScores = a.responses.filter((r) => r.p === p.id);
        const byId = new Map(myScores.map((r) => [r.i, r.s]));
        const perElement: Record<string, number> = {};
        for (const major of majors) {
          let got = 0;
          for (const id of itemsByMajor.get(major)!) got += byId.get(id) ?? 0;
          perElement[major] = got;
        }
        // Display-only essay ("Writing") cell — the /20 mark already inside `raw`.
        // Left unset when the participant has no mark, so the table's `?? 0` renders
        // it exactly like a missing MCQ element.
        if (essayMarkByPid.has(p.id)) perElement[ESSAY_ELEMENT_MAJOR] = essayMarkByPid.get(p.id)!;
        const sc = subjectScores.get(p.id);
        return {
          id: p.id,
          studentId: p.studentId ?? p.id,
          name: p.label,
          perElement,
          raw: sc ? sc.raw : 0,
          pct: sc ? sc.pct : 0,
          max: sc ? sc.max : subjectMax,
        };
      })
      .sort((x, y) => y.pct - x.pct);

    const cohortAvgPct = students.length ? Math.round((students.reduce((n, s) => n + s.pct, 0) / students.length) * 10) / 10 : 0;
    return {
      assessment: refs.find((r) => r.id === assessmentId)!,
      assessments: refs,
      hasEssay,
      mcqItems: mcqMax,
      subjectMax,
      totalItems: a.items.length,
      cohortAvgPct,
      elements,
      students,
    };
  }

  // ── item review & scoring ───────────────────────────────────────────────--
  getReview(cycleId: string, assessmentId: string): ReviewModel | null {
    const a = this.assessment(assessmentId);
    if (cycleId !== this.seed.liveCycle.id || !a) return null;
    const excluded = this.excludedSet(cycleId, assessmentId);
    const refs = this.assessmentRefs(cycleId);
    const ref = refs.find((r) => r.id === assessmentId)!;

    // Recompute item statistics live so per-student exclusions drop a glitched
    // response from that item's cohort psychometrics. With no per-student
    // exclusions this is byte-identical to the seed (parity-verified).
    const live = this.liveItemStats(cycleId, a);
    const scoredItems = a.items.filter((it) => (it.maxScore ?? 1) >= 1);
    const items: ItemRow[] = scoredItems.map((it) => {
      const s = live.get(it.id);
      return {
        id: it.id,
        wording: it.wording,
        major: it.major,
        sub: it.sub,
        demand: it.demand,
        pValue: s?.pValue ?? it.pValue,
        itemTotal: s ? s.itemTotal : it.itemTotal,
        pointBiserial: s ? s.pointBiserial : it.pointBiserial,
        discrimination: s?.discrimination ?? it.discrimination,
        overallReview: s?.overallReview ?? it.overallReview,
        qualityIndex: s?.qualityIndex ?? it.qualityIndex,
        excluded: excluded.has(it.id),
        reason: this.reasons.get(`${cycleId}:${assessmentId}:${it.id}`) ?? null,
        options: it.options ?? null,
      };
    });

    const pcts = [...this.pctByParticipant(cycleId, a).values()].map((v) => v.pct);
    const cohortMean = round(mean(pcts), 1);
    const cohortSd = round(stddev(pcts), 1);

    // distribution histogram (16 bins over 0..100)
    const bins = 16;
    const distribution = new Array(bins).fill(0) as number[];
    for (const p of pcts) {
      const idx = Math.min(bins - 1, Math.floor((p / 100) * bins));
      distribution[idx] = (distribution[idx] ?? 0) + 1;
    }

    const retained = items.filter((it) => !it.excluded);
    const medianDifficulty = round(median(retained.map((it) => it.pValue)), 2);

    // counts of retained items per element / demand
    const elementCounts = new Map<string, number>();
    const demandCounts = new Map<string, number>();
    for (const it of retained) {
      if (it.major) elementCounts.set(it.major, (elementCounts.get(it.major) ?? 0) + 1);
      if (it.demand) demandCounts.set(it.demand, (demandCounts.get(it.demand) ?? 0) + 1);
    }
    const byElement = [...elementCounts.entries()]
      .map(([k, v]) => ({ k, v }))
      .sort((x, y) => y.v - x.v)
      .slice(0, 6);
    const byDemand = ["D1", "D2", "D3"]
      .filter((d) => demandCounts.has(d))
      .map((d) => ({ k: d, v: demandCounts.get(d) ?? 0 }));

    return {
      assessment: ref,
      assessments: refs,
      kpis: {
        items: scoredItems.length,
        excluded: excluded.size,
        medianDifficulty,
        cohortMean,
      },
      items,
      distribution,
      cohortMean,
      cohortSd,
      byElement,
      byDemand,
    };
  }

  getItemDetail(cycleId: string, assessmentId: string, itemId: string): ItemDetailModel | null {
    // Note: unlike getReview(), this still looks up by itemId across all of a.items,
    // so a Max Score = 0 item is still reachable here even though it no longer
    // appears as a row in the Review table. Possible follow-up, not fixed here.
    const a = this.assessment(assessmentId);
    if (cycleId !== this.seed.liveCycle.id || !a) return null;
    const index = a.items.findIndex((it) => it.id === itemId);
    if (index < 0) return null;
    const item = a.items[index]!;

    // Full live ItemStat (same engine call as the table) so the per-statistic
    // ratings reflect any per-student exclusions and the configured thresholds.
    const stats = engine.computeItemStats({
      responses: this.responsesOf(a),
      scoringConfig: this.scoringConfig(),
    });
    const s = stats.find((x) => x.itemId === itemId);

    // Live response rows for this item (per-student-excluded responses dropped),
    // for the outcome split and the discrimination upper/lower groups.
    const recs = this.responsesOf(a);
    const totalByP = new Map<string, number>();
    for (const r of recs) totalByP.set(r.participantId, (totalByP.get(r.participantId) ?? 0) + r.score);
    const rows = recs
      .filter((r) => r.itemId === itemId)
      .map((r) => ({ score: r.score, total: totalByP.get(r.participantId) ?? r.score }));
    const answered = rows.length;
    const correct = rows.reduce((acc, r) => acc + (r.score > 0 ? 1 : 0), 0);
    const incorrect = answered - correct;
    const presented = item.participantsPresented;
    const notAnswered = Math.max(0, presented - answered);

    // upper/lower group means (top/bottom g≈n/3 by rest-total desc, tie by total)
    const g = Math.max(1, Math.round(answered / 3));
    const ranked = rows
      .map((r) => ({ score: r.score, rest: r.total - r.score, total: r.total }))
      .sort((x, y) => y.rest - x.rest || y.total - x.total);
    const gmean = (grp: { score: number }[]) => (grp.length ? grp.reduce((acc, r) => acc + r.score, 0) / grp.length : 0);
    const upperMean = round(gmean(ranked.slice(0, g)), 2);
    const lowerMean = round(gmean(ranked.slice(answered - g)), 2);

    const pValue = s?.pValue ?? item.pValue;
    const itemTotal = s ? s.itemTotal : item.itemTotal;
    const pointBiserial = s ? s.pointBiserial : item.pointBiserial;
    const discrimination = s?.discrimination ?? item.discrimination;
    const pRating = s?.pRating ?? item.pRating;
    const itRating = s?.itRating ?? item.itRating;
    const pbRating = s?.pbRating ?? item.pbRating;
    const discRating = s?.discRating ?? item.discRating;
    const overallReview = s?.overallReview ?? item.overallReview;

    return {
      id: itemId,
      qLabel: `Q${String(index + 1).padStart(2, "0")}`,
      wording: item.wording,
      description: item.description ?? null,
      parentWording: item.parentWording ?? null,
      major: item.major,
      sub: item.sub,
      demand: item.demand,
      maxScore: item.maxScore ?? 1,
      excluded: this.excludedSet(cycleId, assessmentId).has(itemId),
      reason: this.reasons.get(`${cycleId}:${assessmentId}:${itemId}`) ?? null,
      options: item.options ?? null,
      answered,
      presented,
      notAnswered,
      pValue,
      pRating,
      itemTotal,
      itRating,
      pointBiserial,
      pbRating,
      discrimination,
      discRating,
      overallReview,
      qualityIndex: s ? this.qualityIndexOf(s) : item.qualityIndex,
      groups: { size: g, upperMean, lowerMean },
      outcome: { correct, incorrect, notAnswered },
      reasons: {
        p: this.reasonForP(pValue, pRating),
        it: this.reasonForCorr("item-total correlation", itemTotal, itRating),
        pb: this.reasonForCorr("point-biserial", pointBiserial, pbRating),
        disc: this.reasonForCorr("discrimination", discrimination, discRating),
        overall: `Overall review is ${overallReview} — the worst of the four statistic ratings.`,
      },
    };
  }

  /** Plain-language reason for a p-value rating, using the live thresholds. */
  private reasonForP(p: number, rating: QualityRating): string {
    const t = this.quality.pValue;
    const v = p.toFixed(2);
    if (rating === "Good") return `p-value ${v} sits in the healthy ${t.reviewBelow.toFixed(2)}–${t.goodUpTo.toFixed(2)} band — a sensible difficulty.`;
    if (p < t.reviewBelow) return `p-value ${v} is below ${t.reviewBelow.toFixed(2)} — hard; few students answered correctly.`;
    if (p > t.goodUpTo) return `p-value ${v} is above ${t.goodUpTo.toFixed(2)} — easy; most students answered correctly.`;
    return `p-value ${v} is just outside the Good band.`;
  }

  /** Plain-language reason for a correlation-type rating, using the live thresholds. */
  private reasonForCorr(name: string, value: number | null, rating: QualityRating): string {
    const t = this.quality.itemTotal; // correlation metrics share the band shape
    if (value === null || Number.isNaN(value)) return `${name} is undefined (zero variance) — treated as Flag.`;
    const v = value.toFixed(2);
    if (rating === "Good") return `${name} ${v} is at or above ${t.reviewBelow.toFixed(2)} — discriminates well between stronger and weaker students.`;
    if (value < t.flagBelow) return `${name} ${v} is below ${t.flagBelow.toFixed(2)} — little or negative discrimination.`;
    return `${name} ${v} is between ${t.flagBelow.toFixed(2)} and ${t.reviewBelow.toFixed(2)} — weak discrimination, worth a look.`;
  }

  // ── scoring & grade boundaries ──────────────────────────────────────────---
  private scopePcts(cycleId: string, scope: string): number[] {
    if (scope === "overall") {
      const totals = new Map<string, { raw: number; max: number }>();
      for (const a of this.seed.liveCycle.assessments) {
        for (const [pid, v] of this.pctByParticipant(cycleId, a)) {
          const t = totals.get(pid) ?? { raw: 0, max: 0 };
          t.raw += v.raw;
          t.max += v.max;
          totals.set(pid, t);
        }
      }
      return [...totals.values()].filter((t) => t.max > 0).map((t) => (t.raw / t.max) * 100);
    }
    const a = this.assessment(scope);
    if (!a) return [];
    return [...this.pctByParticipant(cycleId, a).values()].map((v) => v.pct);
  }

  /** Subject total max (raw marks) for a scope, so the UI can show raw alongside %. */
  private scopeMaxRaw(cycleId: string, scope: string): number {
    if (scope === "overall") {
      let max = 0;
      for (const a of this.seed.liveCycle.assessments) {
        const vals = [...this.pctByParticipant(cycleId, a).values()].map((v) => v.max);
        max += vals.length ? Math.max(...vals) : 0;
      }
      return max;
    }
    const a = this.assessment(scope);
    if (!a) return 0;
    const vals = [...this.pctByParticipant(cycleId, a).values()].map((v) => v.max);
    return vals.length ? Math.max(...vals) : 0;
  }

  /**
   * studentId → number of D3 (top-difficulty) items answered CORRECTLY, for a
   * scope. Read-only; the cut-score lane uses this for the cohort-level ½-D3
   * sanity check on the Outstanding cut.
   *
   * LANE NOTE (Wave 3b): Wave 3a may add related per-student D3 logic (its
   * per-student Distinction cap). This helper is deliberately small and isolated
   * so the two can be reconciled / de-duplicated trivially at merge — do not
   * fold award or per-student-cap logic in here.
   *
   * CONFIRM — "correct" is interpreted as FULL MARKS on the item
   * (score ≥ item maxScore). The existing safeguard counts "attempted" (any
   * non-blank response); this helper counts correct on purpose. Flip the
   * predicate if the methodology says otherwise.
   */
  private computeD3CorrectByStudent(cycleId: string, scope: string): Map<string, number> {
    void cycleId;
    const demand = this.resolveTopDifficulty();
    const out = new Map<string, number>();
    const asms =
      scope === "overall"
        ? this.seed.liveCycle.assessments
        : this.seed.liveCycle.assessments.filter((a) => a.id === scope);
    for (const a of asms) {
      const pool = new Map(a.items.filter((it) => it.demand === demand).map((it) => [it.id, it.maxScore]));
      for (const r of a.responses) {
        if (!pool.has(r.i)) continue;
        const maxScore = pool.get(r.i)!;
        const correct = maxScore > 0 ? r.s >= maxScore : r.s > 0;
        if (correct) out.set(r.p, (out.get(r.p) ?? 0) + 1);
        else if (!out.has(r.p)) out.set(r.p, out.get(r.p) ?? 0);
      }
    }
    return out;
  }

  /** Count of D3 (top-difficulty) items in a scope. */
  private scopeD3Total(scope: string): number {
    const demand = this.resolveTopDifficulty();
    const asms =
      scope === "overall"
        ? this.seed.liveCycle.assessments
        : this.seed.liveCycle.assessments.filter((a) => a.id === scope);
    let total = 0;
    for (const a of asms) total += a.items.filter((it) => it.demand === demand).length;
    return total;
  }

  /**
   * ½-D3 cohort sanity check for an Outstanding cut (percent). Looks at the
   * students who clear the cut and asks whether they all reached ≥ ½ of D3 items
   * correct. Warning only — never a clamp. See cut-scores.ts for the flagged
   * interpretation.
   */
  private d3WarningForCut(cycleId: string, scope: string, outstandingCutPct: number): D3HalfWarning {
    const d3Total = this.scopeD3Total(scope);
    const d3Correct = this.computeD3CorrectByStudent(cycleId, scope);
    const max = this.scopeMaxRaw(cycleId, scope);
    // Students at/above the Outstanding cut, by percent of subject max.
    const pctMap = this.scopePctByStudent(cycleId, scope);
    const cleared: number[] = [];
    for (const [pid, pct] of pctMap) {
      if (pct >= outstandingCutPct) cleared.push(d3Correct.get(pid) ?? 0);
    }
    void max;
    const r = checkOutstandingHalfD3(cleared, d3Total);
    return {
      applicable: d3Total > 0 && r.outstandingCount > 0,
      consistent: r.consistent,
      d3Total: r.d3Total,
      halfThreshold: r.halfThreshold,
      outstandingCount: r.outstandingCount,
      belowHalf: r.belowHalf,
      note: r.note,
    };
  }

  /** studentId → percent of subject max for a scope (mirrors scopePcts, keyed). */
  private scopePctByStudent(cycleId: string, scope: string): Map<string, number> {
    if (scope === "overall") {
      const totals = new Map<string, { raw: number; max: number }>();
      for (const a of this.seed.liveCycle.assessments) {
        for (const [pid, v] of this.pctByParticipant(cycleId, a)) {
          const t = totals.get(pid) ?? { raw: 0, max: 0 };
          t.raw += v.raw;
          t.max += v.max;
          totals.set(pid, t);
        }
      }
      const out = new Map<string, number>();
      for (const [pid, t] of totals) if (t.max > 0) out.set(pid, (t.raw / t.max) * 100);
      return out;
    }
    const a = this.assessment(scope);
    const out = new Map<string, number>();
    if (!a) return out;
    for (const [pid, v] of this.pctByParticipant(cycleId, a)) out.set(pid, v.pct);
    return out;
  }

  getBoundaries(cycleId: string, scope: string): BoundaryModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const scopes = [
      ...this.seed.liveCycle.assessments.map((a) => ({ id: a.id, label: a.shortName })),
      { id: "overall", label: "Overall award" },
    ];
    const scopeLabel = scopes.find((s) => s.id === scope)?.label ?? "Overall award";

    const scheme = this.schemeFor(scope);
    const levels = scheme.levels;
    const st = this.boundaryState(cycleId, scope);

    const pcts = this.scopePcts(cycleId, scope);
    const n = pcts.length;

    // integer-resolution counts (0..100) for band maths
    const counts = new Array(101).fill(0) as number[];
    for (const p of pcts) {
      const ci = Math.max(0, Math.min(100, Math.round(p)));
      counts[ci] = (counts[ci] ?? 0) + 1;
    }
    const atAbove = new Array(102).fill(0) as number[];
    for (let s = 100; s >= 0; s--) atAbove[s] = atAbove[s + 1]! + counts[s]!;
    const atOrAbove = (cut: number) => atAbove[Math.max(0, Math.min(100, Math.round(cut)))]!;

    // Backsolve the suggestion from the current targets via the cut-score engine
    // (Wave 3b): nearest-achievable snapping + the 25%/90% guard-rails. The award
    // scope keeps its own cumulative banding; the guard-rails are a per-subject
    // performance-cut policy, so we only apply them to non-award scopes.
    const backsolve = scheme.isAward
      ? backsolveCuts(pcts, st.targets, { floorPct: 0, ceilingPct: 100 })
      : backsolveCuts(pcts, st.targets, POLICY_GUARDRAILS);

    // In "pct" mode the effective cuts ARE the backsolved suggestion; in "cuts"
    // mode the user's committed cuts win.
    const effCuts = st.mode === "cuts" ? st.cuts : backsolve.cuts;
    const last = levels.length - 1;
    // Students per band, top → bottom; the lowest band is the remainder.
    const bands: GradeBandRow[] = levels.map((level, i) => {
      let students: number;
      if (i === 0) students = atOrAbove(effCuts[0] ?? 0);
      else if (i === last) students = n - atOrAbove(effCuts[i - 1] ?? 0);
      else students = atOrAbove(effCuts[i] ?? 0) - atOrAbove(effCuts[i - 1] ?? 0);
      return {
        level,
        stars: scheme.isAward ? null : starsFor(level, this.grading.starMap),
        cut: i === last ? null : effCuts[i] ?? null,
        students,
        pct: n ? round((students / n) * 100, 1) : 0,
      };
    });

    // 51 two-point bins for the chart
    const histogram = new Array(51).fill(0) as number[];
    for (let s = 0; s <= 100; s++) {
      const hi = Math.min(50, Math.floor(s / 2));
      histogram[hi] = (histogram[hi] ?? 0) + (counts[s] ?? 0);
    }

    // items scored / excluded for this scope
    let itemsScored = 0;
    let excludedCount = 0;
    if (scope === "overall") {
      for (const a of this.seed.liveCycle.assessments) {
        const ex = this.excludedSet(cycleId, a.id);
        itemsScored += a.items.length - ex.size;
        excludedCount += ex.size;
      }
    } else {
      const a = this.assessment(scope);
      const ex = this.excludedSet(cycleId, scope);
      itemsScored = (a?.items.length ?? 0) - ex.size;
      excludedCount = ex.size;
    }

    const maxRaw = this.scopeMaxRaw(cycleId, scope);
    const notApplicableD3: D3HalfWarning = {
      applicable: false,
      consistent: true,
      d3Total: this.scopeD3Total(scope),
      halfThreshold: Math.ceil(this.scopeD3Total(scope) / 2),
      outstandingCount: 0,
      belowHalf: 0,
      note: scheme.isAward
        ? "The ½-D3 check applies to the per-subject Outstanding cut, not the overall award."
        : "No Outstanding-band students — ½-D3 check not applicable.",
    };
    // ½-D3 warnings: the suggestion's against its own Outstanding cut; the live
    // one against the EFFECTIVE Outstanding cut (so an edit re-evaluates it).
    const suggestionD3 = scheme.isAward
      ? notApplicableD3
      : this.d3WarningForCut(cycleId, scope, backsolve.cuts[0] ?? 100);
    const d3Warning = scheme.isAward
      ? notApplicableD3
      : this.d3WarningForCut(cycleId, scope, effCuts[0] ?? 100);

    return {
      cycleId,
      scope,
      scopeLabel,
      scopes,
      mode: st.mode,
      isAward: scheme.isAward,
      histogram,
      levels,
      cuts: effCuts,
      targets: st.targets,
      bands,
      stats: {
        mean: round(mean(pcts), 1),
        median: round(median(pcts), 0),
        sd: round(stddev(pcts), 1),
        itemsScored,
        excluded: excludedCount,
      },
      n,
      locked: this.locked.has(cycleId),
      guardrails: scheme.isAward
        ? { floorPct: 0, ceilingPct: 100 }
        : { floorPct: POLICY_GUARDRAILS.floorPct, ceilingPct: POLICY_GUARDRAILS.ceilingPct },
      maxRaw,
      suggestion: {
        cuts: backsolve.cuts,
        perCut: backsolve.perCut,
        targets: [...st.targets],
        d3: suggestionD3,
      },
      suggestedCuts: st.suggested ? [...st.suggested] : null,
      d3Warning,
    };
  }

  // ── grades & sign-off ───────────────────────────────────────────────────--
  /** Per-participant overall raw / max / pct across all assessments. */
  private overallScoreByParticipant(cycleId: string): Map<string, { raw: number; max: number; pct: number }> {
    const totals = new Map<string, { raw: number; max: number }>();
    for (const a of this.seed.liveCycle.assessments) {
      for (const [pid, v] of this.pctByParticipant(cycleId, a)) {
        const t = totals.get(pid) ?? { raw: 0, max: 0 };
        t.raw += v.raw;
        t.max += v.max;
        totals.set(pid, t);
      }
    }
    const out = new Map<string, { raw: number; max: number; pct: number }>();
    for (const [pid, t] of totals) out.set(pid, { raw: t.raw, max: t.max, pct: t.max ? (t.raw / t.max) * 100 : 0 });
    return out;
  }
  /** Per-participant overall percentage = total raw / total max across assessments. */
  private overallPctByParticipant(cycleId: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const [pid, s] of this.overallScoreByParticipant(cycleId)) out.set(pid, s.pct);
    return out;
  }

  getGrades(cycleId: string): GradesModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const refs = this.assessmentRefs(cycleId);
    const perfLevels = this.grading.performanceLevels;
    const awardLevels = this.grading.awardLevels;

    // per-assessment score maps (full ParticipantScore, so we can flag marginal
    // cells in raw marks) + effective cut-points
    const scoreMaps = new Map<string, Map<string, ParticipantScore>>();
    const cutsByScope = new Map<string, number[]>();
    for (const a of this.seed.liveCycle.assessments) {
      scoreMaps.set(a.id, this.pctByParticipant(cycleId, a));
      cutsByScope.set(a.id, this.boundaryState(cycleId, a.id).cuts);
    }
    const overallScores = this.overallScoreByParticipant(cycleId);
    // Layer 2: the award is the deterministic lookup from the five subject
    // performance levels (NOT a cut on an overall score), with the per-student D3
    // cap (Layer 1b) applied to Distinction eligibility.
    const d3Cap = this.d3CapByParticipant(cycleId);
    const overrides = this.distinctionOverrides.get(cycleId);

    // A participant cleaned out of every subject (e.g. the test/staff account
    // removed on each subject tab) leaves the cohort — they get no grades row at
    // all, rather than a blank one. Their per-subject scores already vanished via
    // responsesOf; this drops the empty shell so counts reflect the cleaned set.
    const cohortRemoved = this.cohortRemovedParticipants();
    const rows = this.seed.liveCycle.participants.filter((p) => !cohortRemoved.has(p.id)).map((p) => {
      const grades: Record<string, GradeCell> = {};
      const subjectLevels: string[] = [];
      for (const a of this.seed.liveCycle.assessments) {
        const sc = scoreMaps.get(a.id)?.get(p.id);
        const cuts = cutsByScope.get(a.id)!;
        const level = sc === undefined ? "" : classify(sc.pct, perfLevels, cuts);
        const cell: GradeCell = { level, stars: starsFor(level, this.grading.starMap) };
        if (sc) {
          // Flag students within the configurable borderline band (percentage
          // points) below the next grade-up cut — the small-adjustment-would-
          // change-the-grade cases. Runs in the SAME getGrades pass as deriveAward
          // + the D3 cap, so re-flagging recomputes through the full engine path.
          const marg = this.marginalInfo(sc, cuts, perfLevels);
          if (marg) {
            cell.marginal = true;
            cell.marksToNext = marg.marksToNext;
            cell.pctToNext = marg.pctToNext;
            cell.nextLevel = marg.nextLevel;
          }
          const adj = this.manualAdjustmentFor(cycleId, p.id, a.id);
          if (adj) cell.adjustment = adj;
        }
        grades[a.id] = cell;
        subjectLevels.push(level);
      }
      const score = overallScores.get(p.id);
      const d3 = d3Cap.get(p.id);
      const overridden = overrides?.has(p.id) ?? false;
      const outcome = deriveAward(
        { subjectLevels, d3Pass: (d3?.pass ?? true) || overridden },
        { performanceLevels: perfLevels, awardLevels },
      );
      // Surface the working only where the D3 cap actually denied a Distinction.
      const distinctionCap =
        outcome.d3Capped && !overridden && d3?.failing
          ? {
              subject: d3.failing.shortName,
              correct: d3.failing.correct,
              available: d3.failing.available,
              majority: d3.failing.majority,
            }
          : null;
      return {
        id: p.id,
        studentId: p.studentId ?? p.id,
        label: p.label,
        grades,
        award: outcome.award,
        distinctionCap,
        overallRaw: round(score?.raw ?? 0, 1),
        overallMax: round(score?.max ?? 0, 1),
        overallPct: round(score?.pct ?? 0, 1),
      };
    });

    // INVARIANT (identity, root cause D) — grades boundary: every distinct cohort
    // participant (by internal id) must surface as exactly one grade row. A silent
    // drop or a collapsed identity would leave fewer award rows than the cohort;
    // fail loudly here, at the final grade-bearing stage, rather than mis-issue.
    const gradesCohortIds = new Set(
      this.seed.liveCycle.participants.filter((p) => !cohortRemoved.has(p.id)).map((p) => p.id),
    );
    const gradeRowIds = new Set(rows.map((r) => r.id));
    if (gradeRowIds.size !== gradesCohortIds.size) {
      throw new Error(
        `getGrades: ${gradesCohortIds.size} cohort participant(s) produced ${gradeRowIds.size} distinct grade row(s) — participant collapse at grades.`,
      );
    }

    const distCounts = new Map<string, number>();
    for (const r of rows) distCounts.set(r.award, (distCounts.get(r.award) ?? 0) + 1);
    const distribution = awardLevels.map((level) => ({ level, count: distCounts.get(level) ?? 0 }));

    return {
      cycleId,
      assessments: refs,
      rows,
      distribution,
      awardLevels,
      starMap: this.grading.starMap,
      performanceLevels: perfLevels,
      locked: this.locked.has(cycleId),
      canLock: can(this.user, "general.signoff", this.resolvedActions) && !this.locked.has(cycleId),
    };
  }

  // ── Overall (best-of-two across the year's two sittings) ──────────────────
  /**
   * The year's Overall view: per student, per subject, the HIGHER award of the
   * two sittings (by level rank), plus the derived overall award. Pure
   * aggregation over each sitting's signed-off `GradesModel` (see
   * `lib/data/overall.ts`) — no scoring, cut-score, or safeguard work runs here.
   *
   * In this build only the live (May) sitting carries real grades, and live
   * Supabase is unreachable, so the February baseline is synthesized from the May
   * cohort (clearly flagged `demo: true`) to give the rollup two sittings to
   * compare. With real two-sitting data, both sittings' `getGrades` feed the same
   * `rollupOverall` unchanged.
   */
  getOverallGrades(yearId: string): OverallGradesModel | null {
    const year = this.buildYears().find((y) => y.id === yearId);
    if (!year) return null;

    const mayGrades = year.may.cycleId ? this.getGrades(year.may.cycleId) : null;
    const realFeb = year.february.cycleId ? this.getGrades(year.february.cycleId) : null;
    // Demo February baseline (only when there's a real May sitting but no real
    // February grades to compare against).
    const febGrades = realFeb ?? (mayGrades ? this.demoFebruaryGrades(mayGrades) : null);
    const demo = realFeb === null && febGrades !== null;

    if (!mayGrades && !febGrades) return null;

    const perfLevels = this.grading.performanceLevels;
    const awardLevels = this.grading.awardLevels;
    const starMap = this.grading.starMap;
    const assessments = (mayGrades ?? febGrades)!.assessments;

    const rows = rollupOverall({
      february: febGrades,
      may: mayGrades,
      assessments,
      performanceLevels: perfLevels,
      awardLevels,
      starMap,
    });

    const distCounts = new Map<string, number>();
    for (const r of rows) distCounts.set(r.award, (distCounts.get(r.award) ?? 0) + 1);
    const distribution = awardLevels.map((level) => ({ level, count: distCounts.get(level) ?? 0 }));

    const ready = year.february.started && year.february.locked && year.may.started && year.may.locked;
    const note = ready
      ? "Both sittings are signed off — this Overall is final and certificates issue from it."
      : "Overall is provisional until both the February and May sittings are locked; figures shown are the current best-of-two.";

    return {
      yearId: year.id,
      yearName: year.name,
      assessments,
      rows,
      distribution,
      awardLevels,
      starMap,
      performanceLevels: perfLevels,
      february: { cycleId: year.february.cycleId, cycleName: year.february.cycleName },
      may: { cycleId: year.may.cycleId, cycleName: year.may.cycleName },
      ready,
      locked: ready,
      demo,
      note,
    };
  }

  /**
   * Synthesize a DEMO February sitting from the May cohort so the best-of-two
   * rollup has two sittings to compare in this fixtures-only build. Deterministic
   * per (studentId, subject): most subjects sit one level BELOW May (a student who
   * improved by May → May wins), some equal, some ABOVE May (February stands), and
   * a few absent (not sat in February → only May). The February award is derived
   * with the same award rule, so it is a faithful "signed-off" second sitting.
   *
   * NOT real data — `getOverallGrades` flags this with `demo: true`. With real
   * two-sitting data, `getGrades` returns the actual February grades and this is
   * never called.
   */
  private demoFebruaryGrades(may: GradesModel): GradesModel {
    const levels = this.grading.performanceLevels; // best → lowest
    const L = levels.length;
    const awardLevels = this.grading.awardLevels;
    const starMap = this.grading.starMap;

    const rows: GradeMatrixRow[] = may.rows.map((r) => {
      const grades: Record<string, GradeCell> = {};
      for (const a of may.assessments) {
        const mayLevel = r.grades[a.id]?.level ?? "";
        const mr = mayLevel ? levels.indexOf(mayLevel) : L - 1;
        const baseRank = mr < 0 ? L - 1 : mr;
        const b = hash32(`${r.studentId}|${a.id}`) % 10;
        let level: string;
        if (b < 1) level = ""; // ~10%: not sat in February → only May has a result
        else if (b < 6) level = levels[Math.min(L - 1, baseRank + 1)] ?? ""; // ~50%: one below → May wins
        else if (b < 8) level = levels[baseRank] ?? ""; // ~20%: equal
        else level = levels[Math.max(0, baseRank - 1)] ?? ""; // ~20%: one above → February stands
        grades[a.id] = { level, stars: level ? starsFor(level, starMap) : "" };
      }
      const subjectLevels = may.assessments.map((a) => grades[a.id]?.level ?? "");
      const outcome = deriveAward(
        { subjectLevels, d3Pass: true },
        { performanceLevels: levels, awardLevels },
      );
      return {
        id: r.id,
        studentId: r.studentId,
        label: r.label,
        grades,
        award: outcome.award,
        distinctionCap: null,
        overallRaw: r.overallRaw,
        overallMax: r.overallMax,
        overallPct: r.overallPct,
      };
    });

    const distCounts = new Map<string, number>();
    for (const r of rows) distCounts.set(r.award, (distCounts.get(r.award) ?? 0) + 1);
    const distribution = awardLevels.map((level) => ({ level, count: distCounts.get(level) ?? 0 }));

    return { ...may, cycleId: "demo-february", rows, distribution };
  }

  /**
   * Certificates & reports for the Overall (best-of-two) result. Certificates
   * issue from Overall — NOT a single sitting — so this points the document
   * generator at the rolled-up best-of-two awards. Only available once the Overall
   * is signed off (both sittings locked), mirroring the per-sitting lock gate.
   */
  /**
   * Pre-issue methodology sign-off (O1/O2). These are open decisions G12 owns;
   * until each is signed off, only DRAFT certificates may be exported. They stay
   * unconfirmed in this build by design — real issuance is intentionally not
   * silently enabled. When G12 signs off, flip the `confirmed` flags here (or
   * back them with a settings flag) and the official-issue path unlocks.
   */
  private issuanceSignOff(): IssuanceSignOff {
    const decisions = [
      {
        id: "O1",
        title: "D3 cap — per-exam vs aggregate",
        detail:
          "Confirm whether the D3-majority safeguard caps on a per-exam basis or on the aggregate across exams. This changes which Distinction-pattern students pass the cap.",
        confirmed: false,
      },
      {
        id: "O2",
        title: "CGJ PLD → award mapping",
        detail:
          "Confirm the CGJ performance-level-descriptor (PLD) → award mapping used to derive the overall award from the per-subject levels.",
        confirmed: false,
      },
    ];
    return { decisions, cleared: decisions.every((d) => d.confirmed) };
  }

  /**
   * Hard issuance gates for Overall certificates/reports (P5). Official issuance
   * requires EVERY gate met; draft/preview is always available. Gates:
   *  - scores:  the export data reconciles to truth (each student's overall award
   *             matches their best-of-two subject levels — guards against issuing
   *             certificates off corrupted overall scores; P1-followup must land).
   *  - locked:  every contributing sitting is locked / signed off (not provisional).
   *  - signoff: the O1/O2 methodology decisions are signed off.
   *  - live:    the Overall is built from REAL signed-off sittings, not synthetic /
   *             demo data (e.g. a February baseline generated because live Supabase
   *             is unreachable) — synthetic data is draft/preview only.
   */
  private issuanceReadiness(overall: OverallGradesModel, signOff: IssuanceSignOff): IssuanceReadiness {
    const reconciled = overallAwardsReconcile(overall.rows, {
      assessments: overall.assessments,
      performanceLevels: overall.performanceLevels,
      awardLevels: overall.awardLevels,
    });
    const gates = [
      {
        id: "scores" as const,
        label: "Upstream scores verified",
        met: reconciled,
        detail: reconciled
          ? "Each student's overall award reconciles with their best-of-two subject levels."
          : "Exports do not reconcile to truth — an overall award disagrees with its subject levels. Land the per-student score-integrity fix (P1-followup) first.",
      },
      {
        id: "locked" as const,
        label: "All sittings locked",
        met: overall.ready,
        detail: overall.ready
          ? "Both contributing sittings are locked / signed off."
          : "A contributing sitting is still provisional — lock both sittings' grades first.",
      },
      {
        id: "signoff" as const,
        label: "O1 & O2 signed off",
        met: signOff.cleared,
        detail: signOff.cleared
          ? "Both open methodology decisions are signed off."
          : "D3 cap (O1) and CGJ PLD→award mapping (O2) must be signed off by G12.",
      },
      {
        id: "live" as const,
        label: "Real (non-synthetic) data",
        met: !overall.demo,
        detail: overall.demo
          ? "The February baseline is generated from the May cohort because live Supabase is unreachable — draft/preview only until real two-sitting data is available."
          : "Built from real signed-off sittings.",
      },
    ];
    const firstUnmet = gates.find((g) => !g.met) ?? null;
    return {
      gates,
      officialAllowed: gates.every((g) => g.met),
      blockedReason: firstUnmet ? `${firstUnmet.label}: ${firstUnmet.detail}` : null,
    };
  }

  getOverallDocuments(yearId: string): DocumentsModel | null {
    const overall = this.getOverallGrades(yearId);
    if (!overall) return null;
    const locked = overall.locked;
    const signOff = this.issuanceSignOff();
    const readiness = this.issuanceReadiness(overall, signOff);

    const refs = overall.assessments;
    const resolve = (re: RegExp) => refs.find((a) => re.test(a.id) || re.test(a.name));
    const slotDefs: { slot: string; re: RegExp }[] = [
      { slot: "S1", re: /applicable math/i },
      { slot: "S2", re: /scientific/i },
      { slot: "S3", re: /arabic/i },
      { slot: "S4", re: /english/i },
      { slot: "S5", re: /life/i },
    ];
    const subjectOrder = slotDefs.map((d) => ({ slot: d.slot, assessment: resolve(d.re)?.name ?? d.slot }));

    const base = this.docSettings(overall.may?.cycleId ?? yearId);
    const settings: DocSettings = { ...base, cycleName: `${overall.yearName} · Overall` };

    // Students are populated whether or not the Overall is locked, so draft proofs
    // and the preview always work (P5). Each subject carries its Feb/May provenance
    // so performance reports reflect the same best-of-two breakdown as the table.
    // OFFICIAL issuance is gated on `readiness`, not on whether students exist.
    const students: StudentSummary[] = overall.rows.map((r) => ({
      participantId: r.id,
      name: r.label,
      award: r.award,
      subjects: slotDefs.map((d) => {
        const ref = resolve(d.re);
        const cell = ref ? r.grades[ref.id] : undefined;
        return {
          slot: d.slot,
          assessment: ref?.name ?? d.slot,
          level: cell?.level ?? "",
          stars: cell?.stars ?? "",
          source: cell?.source,
        };
      }),
    }));

    return { cycleId: yearId, locked, students, settings, subjectOrder, signOff, readiness };
  }

  /**
   * Per-student, per-assessment, per-major-element performance levels for the
   * Students_Performance_Report export. Element levels are computed from the
   * student's retained responses on that element's items, classified with the
   * same per-assessment cut-points the overall subject level uses. All real
   * computed data — nothing fabricated.
   */
  getPerformanceReport(cycleId: string): PerformanceReportModel | null {
    const grades = this.getGrades(cycleId);
    if (!grades) return null;
    const perfLevels = this.grading.performanceLevels;

    // subjects with ordered major elements + sub-elements, and per-participant
    // levels at both major-element and sub-element granularity. The construct
    // structure (3–5 major elements per subject, each with sub-elements) is read
    // from the data, never hardcoded.
    const subjects: PerfReportSubject[] = [];
    const elementLevelByP = new Map<string, Map<string, Map<string, string>>>(); // assessmentId -> pid -> major -> level
    // assessmentId -> pid -> major -> sub -> level
    const subLevelByP = new Map<string, Map<string, Map<string, Map<string, string>>>>();
    for (const a of this.seed.liveCycle.assessments) {
      const cuts = this.boundaryState(cycleId, a.id).cuts;
      const itemMajor = new Map<string, string | null>();
      const itemSub = new Map<string, string | null>();
      const majorOrder: string[] = [];
      const subOrder: Record<string, string[]> = {};
      for (const it of a.items) {
        itemMajor.set(it.id, it.major);
        itemSub.set(it.id, it.sub);
        if (it.major && !majorOrder.includes(it.major)) majorOrder.push(it.major);
        if (it.major && it.sub) {
          (subOrder[it.major] ??= []);
          if (!subOrder[it.major]!.includes(it.sub)) subOrder[it.major]!.push(it.sub);
        }
      }
      subjects.push({ assessmentId: a.id, name: a.name, majorElements: majorOrder, subElements: subOrder });

      const excluded = this.excludedSet(cycleId, a.id);
      // accumulate raw/n per (participant, major) and per (participant, major, sub)
      const acc = new Map<string, Map<string, { raw: number; n: number }>>();
      const subAcc = new Map<string, Map<string, Map<string, { raw: number; n: number }>>>();
      for (const r of this.responsesOf(a)) {
        if (excluded.has(r.itemId)) continue;
        const el = itemMajor.get(r.itemId);
        if (!el) continue;
        let byEl = acc.get(r.participantId);
        if (!byEl) acc.set(r.participantId, (byEl = new Map()));
        const cell = byEl.get(el) ?? { raw: 0, n: 0 };
        cell.raw += r.score;
        cell.n += 1;
        byEl.set(el, cell);

        const sub = itemSub.get(r.itemId);
        if (sub) {
          let byMajor = subAcc.get(r.participantId);
          if (!byMajor) subAcc.set(r.participantId, (byMajor = new Map()));
          let bySub = byMajor.get(el);
          if (!bySub) byMajor.set(el, (bySub = new Map()));
          const sc = bySub.get(sub) ?? { raw: 0, n: 0 };
          sc.raw += r.score;
          sc.n += 1;
          bySub.set(sub, sc);
        }
      }
      const pMap = new Map<string, Map<string, string>>();
      for (const [pid, byEl] of acc) {
        const lvls = new Map<string, string>();
        for (const [el, cell] of byEl) {
          const pct = cell.n ? (cell.raw / cell.n) * 100 : 0;
          lvls.set(el, classify(pct, perfLevels, cuts));
        }
        pMap.set(pid, lvls);
      }
      elementLevelByP.set(a.id, pMap);

      const pSubMap = new Map<string, Map<string, Map<string, string>>>();
      for (const [pid, byMajor] of subAcc) {
        const majorMap = new Map<string, Map<string, string>>();
        for (const [el, bySub] of byMajor) {
          const subLvls = new Map<string, string>();
          for (const [sub, cell] of bySub) {
            const pct = cell.n ? (cell.raw / cell.n) * 100 : 0;
            subLvls.set(sub, classify(pct, perfLevels, cuts));
          }
          majorMap.set(el, subLvls);
        }
        pSubMap.set(pid, majorMap);
      }
      subLevelByP.set(a.id, pSubMap);
    }

    const students: PerfReportStudent[] = grades.rows.map((row) => {
      const sub: Record<string, PerfElementResult> = {};
      for (const a of this.seed.liveCycle.assessments) {
        const level = row.grades[a.id]?.level ?? "";
        const elements: Record<string, string> = {};
        const lvls = elementLevelByP.get(a.id)?.get(row.id);
        if (lvls) for (const [el, lv] of lvls) elements[el] = lv;
        const subElements: Record<string, Record<string, string>> = {};
        const subLvls = subLevelByP.get(a.id)?.get(row.id);
        if (subLvls) for (const [el, bySub] of subLvls) {
          subElements[el] = {};
          for (const [s, lv] of bySub) subElements[el]![s] = lv;
        }
        sub[a.id] = { level, elements, subElements };
      }
      return { participantId: row.id, name: row.label, award: row.award, subjects: sub };
    });

    // canonical Student-Summary columns mapped by subject alias (keyword)
    const refs = grades.assessments;
    const aliasFor = (re: RegExp) => refs.find((r) => re.test(r.id) || re.test(r.name))?.id ?? null;
    const summarySubjects: PerfReportSummarySubject[] = [
      { label: "Applicable Maths", assessmentId: aliasFor(/applicable math/i) },
      { label: "Scientific Thinking", assessmentId: aliasFor(/scientific/i) },
      { label: "Arabic 1st Language", assessmentId: aliasFor(/arabic/i) },
      { label: "English 2nd Language", assessmentId: aliasFor(/english/i) },
      { label: "Life Success Skills", assessmentId: aliasFor(/life/i) },
    ];

    const n = grades.rows.length;
    const awardDistribution = grades.distribution.map((d) => ({
      level: d.level,
      count: d.count,
      pct: n ? round((d.count / n) * 100, 1) : 0,
    }));

    return {
      cycleName: this.seed.liveCycle.name,
      performanceLevels: perfLevels,
      awardLevels: this.grading.awardLevels,
      subjects,
      summarySubjects,
      students,
      awardDistribution,
    };
  }

  // ── live item statistics (per-student exclusions nudge cohort psychometrics)
  /** Transparent 0–100 quality index — mirrors scripts/build-seed.mts exactly. */
  private qualityIndexOf(s: ItemStat): number {
    const score: Record<QualityRating, number> = { Good: 1, Review: 0.55, Flag: 0.12 };
    const avg = (score[s.pRating] + score[s.itRating] + score[s.pbRating] + score[s.discRating]) / 4;
    return Math.round(avg * 100);
  }
  /**
   * Recompute one assessment's item statistics through the engine, dropping any
   * per-student-excluded responses. With no per-student exclusions this is
   * byte-identical to the seed (parity-verified), so the Review screen is
   * unchanged until a technical fault is excluded.
   */
  private liveItemStats(
    cycleId: string,
    a: SeedAssessment,
  ): Map<string, { pValue: number; itemTotal: number | null; pointBiserial: number | null; discrimination: number; overallReview: QualityRating; qualityIndex: number }> {
    const stats = engine.computeItemStats({
      responses: this.responsesOf(a),
      scoringConfig: this.scoringConfig(),
    });
    const out = new Map<
      string,
      { pValue: number; itemTotal: number | null; pointBiserial: number | null; discrimination: number; overallReview: QualityRating; qualityIndex: number }
    >();
    for (const s of stats) {
      out.set(s.itemId, {
        pValue: s.pValue,
        itemTotal: s.itemTotal,
        pointBiserial: s.pointBiserial,
        discrimination: s.discrimination,
        overallReview: s.overallReview,
        qualityIndex: this.qualityIndexOf(s),
      });
    }
    return out;
  }

  // ── per-student technical exclusions (Student review step) ────────────────
  /** All demand levels present across the cycle, ascending (e.g. D1 < D2 < D3). */
  private allDemandLevels(): string[] {
    const set = new Set<string>();
    for (const a of this.seed.liveCycle.assessments) for (const it of a.items) if (it.demand) set.add(it.demand);
    return [...set].sort();
  }
  /** The "top-difficulty" demand: configured value, else the highest present. */
  private resolveTopDifficulty(assessmentId?: string): string {
    if (this.safeguard.topDifficultyDemand) return this.safeguard.topDifficultyDemand;
    const set = new Set<string>();
    const asms = assessmentId
      ? this.seed.liveCycle.assessments.filter((a) => a.id === assessmentId)
      : this.seed.liveCycle.assessments;
    for (const a of asms) for (const it of a.items) if (it.demand) set.add(it.demand);
    const sorted = [...set].sort();
    return sorted[sorted.length - 1] ?? "";
  }
  /** Locate an item across assessments, with a display label (Q-index in order). */
  private itemLocate(itemId: string): { a: SeedAssessment; item: SeedItem; label: string } | null {
    for (const a of this.seed.liveCycle.assessments) {
      const idx = a.items.findIndex((it) => it.id === itemId);
      if (idx >= 0) return { a, item: a.items[idx]!, label: `Q${idx + 1}` };
    }
    return null;
  }
  private buildIncident(
    studentId: string,
    studentName: string,
    itemId: string | null,
    questionRaw: string,
    error: string,
    decision: IncidentDecision = null,
    reason: string | null = null,
  ): TechnicalIncident {
    const loc = itemId ? this.itemLocate(itemId) : null;
    this.incidentSeq += 1;
    return {
      id: `inc-${this.incidentSeq}`,
      studentId,
      studentName,
      assessmentId: loc?.a.id ?? "",
      assessmentName: loc?.a.name ?? "Unmatched",
      itemId: loc ? itemId : null,
      questionLabel: loc?.label ?? questionRaw,
      demand: loc?.item.demand ?? null,
      wording: loc?.item.wording ?? null,
      rtl: loc?.a.rtl ?? false,
      error,
      decision,
      reason,
      by: decision ? this.user.name : null,
      at: decision ? new Date().toISOString() : null,
    };
  }
  /** Match an uploaded student cell to a participant (by id or friendly label). */
  private matchStudent(raw: string): { id: string; name: string } {
    const clean = raw.trim();
    const byId = this.seed.liveCycle.participants.find((p) => p.id.toLowerCase() === clean.toLowerCase());
    if (byId) return { id: byId.id, name: byId.label };
    const byLabel = this.seed.liveCycle.participants.find((p) => p.label.toLowerCase() === clean.toLowerCase());
    if (byLabel) return { id: byLabel.id, name: byLabel.label };
    return { id: clean, name: clean };
  }

  /**
   * Resolve an essay-file ParticipantID to a participant, keyed ONLY on the
   * P-A internal UNIQUE identity — the stable internal id (`p.id`) or the
   * guaranteed-unique Student ID (`p.studentId` = `qm_participant_id` on live
   * data). Deliberately NEVER falls back to the display name (`p.label`): names
   * collide (the two Fatimas), so a name key would fold distinct students'
   * essays together — the exact "non-unique derived key" collapse P-A fixed.
   * Essays therefore land on the correct, un-collapsed student. Returns
   * `matched: false` (skip + surface as unmatched) when no unique key matches.
   */
  private matchEssayStudent(raw: string): { id: string; matched: boolean } {
    const clean = raw.trim().toLowerCase();
    for (const p of this.seed.liveCycle.participants) {
      if (p.id.toLowerCase() === clean) return { id: p.id, matched: true };
    }
    for (const p of this.seed.liveCycle.participants) {
      if ((p.studentId ?? p.id).toLowerCase() === clean) return { id: p.id, matched: true };
    }
    return { id: raw.trim(), matched: false };
  }

  private technicalErrorsUpload(cycleId: string): TechnicalErrorsUpload {
    const te = this.technicalErrors.get(cycleId);
    if (!te || !te.uploaded) {
      return { uploaded: false, fileName: null, incidentCount: 0, matchedCount: 0, preview: { headers: [], rows: [] }, sample: false };
    }
    const matched = te.incidents.filter((i) => i.itemId).length;
    return {
      uploaded: true,
      fileName: te.fileName,
      incidentCount: te.incidents.length,
      matchedCount: matched,
      preview: {
        headers: ["Student", "Question", "Error"],
        rows: te.incidents.slice(0, 5).map((i) => [i.studentName, i.questionLabel, i.error]),
      },
      sample: te.sample,
    };
  }

  getStudentReview(cycleId: string): StudentReviewModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const te = this.technicalErrors.get(cycleId);
    const incidents = te?.incidents ?? [];
    const excluded = incidents.filter((i) => i.decision === "excluded").length;
    const kept = incidents.filter((i) => i.decision === "kept").length;
    const awaiting = incidents.filter((i) => i.decision == null).length;
    const students = new Set(incidents.map((i) => i.studentId)).size;
    return {
      cycleId,
      uploaded: !!te?.uploaded,
      sample: !!te?.sample,
      fileName: te?.fileName ?? null,
      incidents,
      counts: { incidents: incidents.length, excluded, kept, awaiting, students },
    };
  }

  uploadTechnicalErrors(cycleId: string, fileName: string, rows: TechnicalErrorRow[]): void {
    if (!can(this.user, "incidents.upload", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const incidents = rows
      .filter((r) => (r.student ?? "").trim() || (r.question ?? "").trim())
      .map((r) => {
        const stud = this.matchStudent(String(r.student ?? ""));
        const q = String(r.question ?? "").trim();
        const matched = this.itemLocate(q);
        return this.buildIncident(stud.id, stud.name, matched ? q : null, q, String(r.error ?? "").trim() || "Technical fault reported");
      });
    this.technicalErrors.set(cycleId, { uploaded: true, sample: false, fileName, incidents });
    const matched = incidents.filter((i) => i.itemId).length;
    this.audit("upload", "Added technical-errors file", `${fileName} — ${incidents.length} incidents (${matched} matched to items)`, cycleId);
    this.bump();
  }

  /**
   * Load the small, clearly-labelled SAMPLE faults fixture. Every incident
   * references a REAL seeded participant and item (so exclusions genuinely flow
   * into scoring); it is flagged `sample: true` everywhere it surfaces.
   */
  clearTechnicalErrors(cycleId: string): void {
    if (!can(this.user, "incidents.upload", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    if (!this.technicalErrors.has(cycleId)) return;
    this.technicalErrors.delete(cycleId);
    this.audit("upload", "Removed technical-errors file", "Per-student exclusions cleared", cycleId);
    this.bump();
  }

  // ── essay marks (Part 2) ──────────────────────────────────────────────────
  /**
   * Aggregate raw essay rows into one mark per student per essay subject.
   * CONFIRM: the per-student subject mark is the MEAN of that student's per-essay
   * `TotalScore`s (sum ÷ count). If the real file provides a single final mark,
   * that single value is used directly (count 1). Change the divisor here if the
   * marking team aggregates differently.
   */
  private buildEssayState(rows: EssayUploadRow[], sample: boolean, fileName: string | null) {
    // `count` is the number of per-essay rows summed (the averaging divisor);
    // `essays` is the number of essays represented (for the pending disclosure),
    // which the reconciling masterfile flow supplies via `row.essayCount` even
    // though it emits ONE already-reconciled row per student. They coincide for
    // the per-essay template flow (each row = one essay, essayCount omitted → 1).
    const agg = new Map<string, { participantId: string; subjectCode: string; sum: number; count: number; essays: number }>();
    for (const r of rows) {
      const k = `${r.participantId}|${r.subjectCode}`;
      const e = agg.get(k) ?? { participantId: r.participantId, subjectCode: r.subjectCode, sum: 0, count: 0, essays: 0 };
      e.sum += r.totalScore;
      e.count += 1;
      e.essays += r.essayCount ?? 1;
      agg.set(k, e);
    }
    const marks: EssayMark[] = [];
    const essayCounts = new Map<string, number>();
    const unmatched = new Set<string>();
    for (const e of agg.values()) {
      const a = this.essayAssessmentForCode(e.subjectCode);
      if (!a) continue; // only Arabic/English carry essays
      // Key on the P-A internal UNIQUE participant id (never the non-unique name),
      // so essays land on the correct, un-collapsed student.
      const stud = this.matchEssayStudent(e.participantId);
      if (!stud.matched) {
        unmatched.add(e.participantId);
        continue;
      }
      marks.push({ participantId: stud.id, assessmentId: a.id, mark: e.count ? e.sum / e.count : 0 });
      essayCounts.set(`${stud.id}|${a.id}`, e.essays);
    }
    return { uploaded: true, sample, fileName, marks, essayCounts, unmatchedIds: [...unmatched] };
  }

  /** Essay subjects (assessment ids) touched by an upload's rows, matched or not. */
  private essaySubjectsTouched(rows: EssayUploadRow[]): Set<string> {
    const touched = new Set<string>();
    for (const r of rows) {
      const a = this.essayAssessmentForCode(r.subjectCode);
      if (a) touched.add(a.id);
    }
    return touched;
  }

  /**
   * Upsert essay marks, merging PER SUBJECT so each language file can be uploaded
   * separately: the incoming file fully replaces the marks for the subject(s) it
   * covers and leaves every other subject's marks intact. Re-uploading the same
   * language file replaces that subject's marks → idempotent, never duplicated.
   */
  uploadEssayMarks(cycleId: string, fileName: string, rows: EssayUploadRow[]): void {
    if (!can(this.user, "incidents.upload", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const incoming = this.buildEssayState(rows, false, fileName);
    const touched = this.essaySubjectsTouched(rows);
    const prev = this.essayMarksByCycle.get(cycleId);
    const st = prev && prev.uploaded ? this.mergeEssayState(prev, incoming, touched) : incoming;
    this.essayMarksByCycle.set(cycleId, st);
    const students = new Set(st.marks.map((m) => m.participantId)).size;
    this.audit(
      "upload",
      "Added essay-marks file",
      `${fileName} — ${st.marks.length} subject marks across ${students} students (${incoming.unmatchedIds.length} unmatched IDs)`,
      cycleId,
    );
    this.bump();
  }

  /** Merge an incoming essay state onto the previous one, replacing only the
   *  subjects the incoming file covers (keyed on assessment id in the map keys). */
  private mergeEssayState(
    prev: ReturnType<InMemoryDataProvider["buildEssayState"]>,
    incoming: ReturnType<InMemoryDataProvider["buildEssayState"]>,
    touched: Set<string>,
  ): ReturnType<InMemoryDataProvider["buildEssayState"]> {
    const keptMarks = prev.marks.filter((m) => !touched.has(m.assessmentId));
    const marks = [...keptMarks, ...incoming.marks];
    const essayCounts = new Map<string, number>();
    for (const m of keptMarks) {
      const key = `${m.participantId}|${m.assessmentId}`;
      const v = prev.essayCounts.get(key);
      if (v != null) essayCounts.set(key, v);
    }
    for (const [k, v] of incoming.essayCounts) essayCounts.set(k, v);
    const unmatchedIds = [...new Set([...prev.unmatchedIds, ...incoming.unmatchedIds])];
    return {
      uploaded: true,
      sample: prev.sample && incoming.sample,
      fileName: incoming.fileName,
      marks,
      essayCounts,
      unmatchedIds,
    };
  }

  /**
   * The merged essay marks for persistence (Supabase RPC): one row per
   * (participant, assessment) with the stored mark and the essay count. Reads the
   * already-merged in-memory state so the full-cycle-replace RPC receives EVERY
   * language's marks (keeping separate-language uploads intact in the database).
   */
  essayMarksForPersistence(cycleId: string): { participant_id: string; assessment_id: string; mark: number; essays_counted: number }[] {
    const st = this.essayMarksByCycle.get(cycleId);
    if (!st) return [];
    return st.marks.map((m) => ({
      participant_id: m.participantId,
      assessment_id: m.assessmentId,
      mark: Math.round(m.mark * 100) / 100,
      essays_counted: st.essayCounts.get(`${m.participantId}|${m.assessmentId}`) ?? 1,
    }));
  }

  /**
   * Load a small, clearly-labelled SAMPLE essay-marks set. Every row references a
   * REAL seeded participant (so the marks genuinely flow into Arabic/English
   * subject totals); flagged `sample: true` everywhere it surfaces. Two essays
   * per student per subject exercise the averaging rule.
   */
  clearEssayMarks(cycleId: string): void {
    if (!can(this.user, "incidents.upload", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    if (!this.essayMarksByCycle.has(cycleId)) return;
    this.essayMarksByCycle.delete(cycleId);
    this.audit("upload", "Removed essay-marks file", "Essay marks cleared from subject totals", cycleId);
    this.bump();
  }

  // ── Technical Incident Upload (0044): staged export → exam_incidents ────────
  /**
   * The read-only context the pure matcher (`matchExamIncidents`) resolves rows
   * against: the active cycle name, its scored subjects, every sitting keyed by
   * (email, subjectCode) → qm_result_id, the staff/non-cohort emails (from the
   * cohort_exclusions data), and the references already staged. Nothing here
   * writes. The email is the participant's `studentId` (qm_participant_id),
   * lowercased — the ONLY valid join key.
   */
  getExamIncidentMatchContext(cycleId: string): ExamIncidentMatchContext | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const byId = new Map(this.seed.liveCycle.participants.map((p) => [p.id, p]));
    const emailOf = (id: string) => (byId.get(id)?.studentId ?? id).trim().toLowerCase();
    const nameOf = (id: string) => byId.get(id)?.label ?? id;

    const subjects: { code: string; name: string }[] = [];
    const sittings: IncidentSittingEntry[] = [];
    for (const a of this.seed.liveCycle.assessments) {
      const code = classifySubjectName(a.name);
      if (!code) continue; // Life Skills / surveys → not an incident-matchable subject
      subjects.push({ code, name: a.name });
      const seen = new Set<string>();
      for (const r of a.responses) {
        if (seen.has(r.p)) continue;
        seen.add(r.p);
        sittings.push({
          email: emailOf(r.p),
          subjectCode: code,
          // the real sitting id (qm_result_id) when carried; else the participant id
          qmResultId: a.resultIdByParticipant?.[r.p] ?? r.p,
          name: nameOf(r.p),
        });
      }
    }
    const staffEmails = [...this.cohortExcludedSet()].map(emailOf).filter(Boolean);
    const existingReferences = [...(this.examIncidentsByCycle.get(cycleId)?.keys() ?? [])];
    return { cycleId, activeCycleName: this.seed.liveCycle.name, subjects, sittings, staffEmails, existingReferences };
  }

  upsertExamIncidents(cycleId: string, batchId: string, fileName: string, records: readonly ExamIncidentRecord[]): void {
    if (!can(this.user, "incidents.upload", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const map = this.examIncidentsByCycle.get(cycleId) ?? new Map<string, ExamIncidentRecord>();
    let n = 0;
    for (const rec of records) {
      if (!rec.reference.trim()) continue; // never stage a keyless row (mirrors the RPC)
      map.set(rec.reference, { ...rec, importBatchId: batchId });
      n += 1;
    }
    this.examIncidentsByCycle.set(cycleId, map);
    this.examIncidentBatches.set(batchId, { cycleId, fileName });
    this.audit("upload", "Staged technical incidents", `${fileName} — ${n} incident(s) matched + staged`, cycleId);
    this.bump();
  }

  getExamIncidentsForCycle(cycleId: string): ExamIncidentRecord[] {
    return [...(this.examIncidentsByCycle.get(cycleId)?.values() ?? [])];
  }

  getExamIncidentReconciliation(cycleId: string, batchId: string): ExamIncidentReconciliation | null {
    const batch = this.examIncidentBatches.get(batchId);
    const records = this.getExamIncidentsForCycle(cycleId).filter((r) => r.importBatchId === batchId);
    if (!batch && records.length === 0) return null;
    return reconciliationFromRecords(records, { batchId, cycleId, fileName: batch?.fileName ?? "" });
  }

  clearExamIncidents(cycleId: string): void {
    if (!can(this.user, "incidents.upload", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    if (!this.examIncidentsByCycle.has(cycleId)) return;
    this.examIncidentsByCycle.delete(cycleId);
    this.audit("upload", "Removed staged incidents", "Technical incident staging cleared", cycleId);
    this.bump();
  }

  /** Hydration setter (Supabase replay): load persisted staged records verbatim,
   *  WITHOUT re-matching — the stored `match_status` / `matched_qm_result_id` are
   *  authoritative. Not on the public interface (mirrors `essayMarksForPersistence`). */
  hydrateExamIncidents(cycleId: string, records: readonly ExamIncidentRecord[]): void {
    if (records.length === 0) return;
    const map = new Map<string, ExamIncidentRecord>();
    for (const rec of records) {
      map.set(rec.reference, rec);
      if (rec.importBatchId && !this.examIncidentBatches.has(rec.importBatchId)) {
        this.examIncidentBatches.set(rec.importBatchId, { cycleId, fileName: "" });
      }
    }
    this.examIncidentsByCycle.set(cycleId, map);
  }

  /** Hydration setter (Supabase replay): load persisted essay marks into the read
   *  model. UNGATED — this is DB truth replayed, not an interactive upload, so it
   *  must NOT go through the `incidents.upload` guard on `uploadEssayMarks` (that
   *  guard resolves against a role grid that isn't populated until later in replay,
   *  and a read-only viewer must still see essay-inclusive scores). Produces the
   *  same `essayMarksByCycle` state a successful `uploadEssayMarks` produces. */
  hydrateEssayMarks(cycleId: string, fileName: string, rows: EssayUploadRow[]): void {
    if (rows.length === 0) return;
    const incoming = this.buildEssayState(rows, false, fileName);
    const touched = this.essaySubjectsTouched(rows);
    const prev = this.essayMarksByCycle.get(cycleId);
    const st = prev && prev.uploaded ? this.mergeEssayState(prev, incoming, touched) : incoming;
    this.essayMarksByCycle.set(cycleId, st);
  }

  /** Hydration setter (Supabase replay): load a persisted incident log. UNGATED for
   *  the same reason as `hydrateEssayMarks` — the `incidents.upload` guard on the
   *  interactive `uploadIncidentLog` would silently drop the replay before the role
   *  grid is applied. */
  hydrateIncidentLog(cycleId: string, fileName: string, rows: IncidentInput[]): void {
    if (rows.length === 0) return;
    const incidents = rows.map((r) => this.buildTriageIncident(r));
    this.incidentLogByCycle.set(cycleId, { uploaded: true, sample: false, fileName, incidents });
    this.rebuildAlterations(cycleId);
  }

  /** Hydration setter (Supabase replay): re-apply a persisted incident decision.
   *  UNGATED twin of `decideIncident` (its `incidents.triage` guard would otherwise
   *  drop the replayed decision, leaving the alteration unapplied to scores). */
  hydrateIncidentDecision(cycleId: string, incidentId: string, decision: IncidentDecisionInput): void {
    const st = this.incidentLogByCycle.get(cycleId);
    const inc = st?.incidents.find((i) => i.id === incidentId);
    if (!inc) return;
    inc.applyTo = decision.applyTo;
    inc.studentId = decision.applyTo === "student" ? decision.studentId ?? null : null;
    inc.subjectId = decision.subjectId ?? inc.subjectId;
    inc.marks = decision.applyTo === "none" ? 0 : Math.trunc(decision.marks ?? 0);
    inc.reason = decision.reason ?? null;
    inc.decidedBy = this.user.name;
    inc.decidedAt = new Date().toISOString();
    this.rebuildAlterations(cycleId);
  }

  getEssayMarks(cycleId: string): EssayMarksModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const st = this.essayMarksByCycle.get(cycleId);
    const essayIds = new Set(this.essaySubjectIds());
    const subjects: EssaySubjectRef[] = this.seed.liveCycle.assessments
      .filter((a) => essayIds.has(a.id))
      .map((a) => ({
        assessmentId: a.id,
        // Only essay subjects reach here; the non-English one is Arabic (matches
        // whether the name is Latin "Arabic…" or Arabic script).
        code: /english/i.test(a.name) ? "ESL" : "AFL",
        name: a.name,
        count: st ? new Set(st.marks.filter((m) => m.assessmentId === a.id).map((m) => m.participantId)).size : 0,
      }));

    if (!st || !st.uploaded) {
      return { cycleId, uploaded: false, sample: false, fileName: null, subjects, students: [], matchedCount: 0, unmatchedIds: [], preview: { headers: [], rows: [] } };
    }

    const labelOf = (id: string) => this.seed.liveCycle.participants.find((p) => p.id === id)?.label ?? id;
    const byStudent = new Map<string, EssayStudentMark>();
    for (const m of st.marks) {
      let s = byStudent.get(m.participantId);
      if (!s) {
        s = { participantId: m.participantId, name: labelOf(m.participantId), marks: {}, essayCounts: {} };
        byStudent.set(m.participantId, s);
      }
      s.marks[m.assessmentId] = round(m.mark, 1);
      s.essayCounts[m.assessmentId] = st.essayCounts.get(`${m.participantId}|${m.assessmentId}`) ?? 1;
    }
    const students = [...byStudent.values()].sort((a, b) => a.name.localeCompare(b.name));
    const preview = {
      headers: ["Student", ...subjects.map((s) => `${s.name} /20`)],
      rows: students.slice(0, 6).map((s) => [s.name, ...subjects.map((sr) => s.marks[sr.assessmentId] ?? "—")] as (string | number | null)[]),
    };
    return {
      cycleId,
      uploaded: true,
      sample: st.sample,
      fileName: st.fileName,
      subjects,
      students,
      matchedCount: new Set(st.marks.map((m) => m.participantId)).size,
      unmatchedIds: st.unmatchedIds,
      preview,
    };
  }

  /**
   * Read-only context that drives the essay-marks template + the pre-write
   * validation report. For each essay subject we list the participants who sat it
   * (distinct response participants), keyed on the SAME id the parser/matcher
   * consume (`matchEssayStudent`), and flag any whose sitting is already excluded
   * on the Clean tab (cohort exclusion OR per-subject row removal) so validation
   * can report "flagged, not applied" instead of silently applying a mark to a
   * removed sitting. Nothing here writes.
   */
  getEssayContext(cycleId: string): EssayUploadContext | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const essayIds = new Set(this.essaySubjectIds());
    const cohortExcluded = this.cohortExcludedSet();
    const byId = new Map(this.seed.liveCycle.participants.map((p) => [p.id, p]));
    const labelOf = (id: string) => byId.get(id)?.label ?? id;
    const studentIdOf = (id: string) => byId.get(id)?.studentId ?? id;
    const subjects: EssaySubjectContext[] = this.seed.liveCycle.assessments
      .filter((a) => essayIds.has(a.id))
      .map((a) => {
        const removed = this.cleanRowSet(a.id);
        const seen = new Set<string>();
        const participants: EssayRosterEntry[] = [];
        for (const r of a.responses) {
          if (seen.has(r.p)) continue;
          seen.add(r.p);
          participants.push({
            participantId: r.p,
            studentId: studentIdOf(r.p),
            name: labelOf(r.p),
            excluded: cohortExcluded.has(r.p) || !!removed?.has(r.p),
          });
        }
        participants.sort((x, y) => x.name.localeCompare(y.name));
        return {
          assessmentId: a.id,
          // Only essay subjects reach here; the non-English one is Arabic.
          code: /english/i.test(a.name) ? "ESL" : "AFL",
          name: a.name,
          participants,
        };
      });
    return { cycleId, essayItemMax: ESSAY_ITEM_MAX, subjects };
  }

  // ── incident log → alterations triage (Part 3) ────────────────────────────
  /** The subject (assessment) an exam code maps to. Unknown codes return undefined. */
  private subjectForExamCode(code: string | null | undefined): SeedAssessment | undefined {
    const c = (code ?? "").trim();
    if (!c) return undefined;
    const A = this.seed.liveCycle.assessments;
    const map: [RegExp, RegExp][] = [
      [/\bAM\b|applicable|math/i, /applicable math/i],
      [/\bST\b|scientific|science/i, /scientific/i],
      [/\bAFL\b|arabic/i, /arabic/i],
      [/\bESL\b|english/i, /english/i],
      [/\bLSS\b|life/i, /life/i],
    ];
    for (const [codeRe, nameRe] of map) if (codeRe.test(c)) return A.find((a) => nameRe.test(a.name));
    return undefined;
  }
  /** Non-binding roster suggestion from a free-text name (never auto-applied). */
  private suggestStudentId(name: string): string | null {
    const n = name.trim().toLowerCase();
    if (!n || /\ball\b/.test(n)) return null; // "All students" → no single suggestion
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const target = new Set(norm(n));
    let best: { id: string; score: number } | null = null;
    for (const p of this.seed.liveCycle.participants) {
      const toks = norm(p.label);
      if (toks.length === 0) continue;
      if (p.label.toLowerCase() === n || p.id.toLowerCase() === n) return p.id;
      const overlap = toks.filter((t) => target.has(t)).length;
      const score = overlap / Math.max(toks.length, target.size);
      if (score > 0.5 && (!best || score > best.score)) best = { id: p.id, score };
    }
    return best?.id ?? null;
  }

  private rebuildAlterations(cycleId: string): void {
    const st = this.incidentLogByCycle.get(cycleId);
    const out: Alteration[] = [];
    if (st) {
      for (const inc of st.incidents) {
        if (!inc.subjectId || !inc.marks) continue;
        if (inc.applyTo === "student" && inc.studentId) {
          out.push({ participantId: inc.studentId, assessmentId: inc.subjectId, marks: inc.marks });
        } else if (inc.applyTo === "subject") {
          // bulk: every roster student in that subject
          for (const p of this.seed.liveCycle.participants) {
            out.push({ participantId: p.id, assessmentId: inc.subjectId, marks: inc.marks });
          }
        }
      }
    }
    this.alterationsByCycle.set(cycleId, out);
  }

  uploadIncidentLog(cycleId: string, fileName: string, rows: IncidentInput[]): void {
    if (!can(this.user, "incidents.upload", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const incidents = rows.map((r) => this.buildTriageIncident(r));
    this.incidentLogByCycle.set(cycleId, { uploaded: true, sample: false, fileName, incidents });
    this.rebuildAlterations(cycleId);
    this.audit("upload", "Added incident log", `${fileName} — ${incidents.length} incident(s) queued for triage`, cycleId);
    this.bump();
  }

  private buildTriageIncident(r: IncidentInput): AdjustmentIncident {
    this.adjIncidentSeq += 1;
    const subj = this.subjectForExamCode(r.exam);
    return {
      id: `inc-${this.adjIncidentSeq}`,
      source: r.source,
      studentName: r.studentName ?? "",
      exam: r.exam ?? null,
      issueType: r.issueType ?? null,
      actionTaken: r.actionTaken ?? null,
      questionsAffected: r.questionsAffected ?? null,
      staff: r.staff ?? null,
      email: r.email ?? null,
      school: r.school ?? null,
      description: r.description ?? null,
      suggestedStudentId: this.suggestStudentId(r.studentName ?? ""),
      suggestedSubjectId: subj?.id ?? null,
      applyTo: null,
      studentId: null,
      subjectId: subj?.id ?? null, // default the subject; reviewer can override
      marks: 0,
      reason: null,
      decidedBy: null,
      decidedAt: null,
    };
  }

  /**
   * Load a small, clearly-labelled SAMPLE incident log. Names reference real
   * roster labels (so suggestions resolve) and one row is an "All students"
   * subject-wide case; flagged `sample: true` everywhere it surfaces. Nothing is
   * auto-applied — every row still needs a human decision.
   */
  clearIncidentLog(cycleId: string): void {
    if (!can(this.user, "incidents.upload", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    if (!this.incidentLogByCycle.has(cycleId)) return;
    this.incidentLogByCycle.delete(cycleId);
    this.rebuildAlterations(cycleId);
    this.audit("upload", "Removed incident log", "Alterations cleared from subject totals", cycleId);
    this.bump();
  }

  decideIncident(cycleId: string, incidentId: string, decision: IncidentDecisionInput): void {
    if (!can(this.user, "incidents.triage", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const st = this.incidentLogByCycle.get(cycleId);
    const inc = st?.incidents.find((i) => i.id === incidentId);
    if (!inc) return;
    inc.applyTo = decision.applyTo;
    inc.studentId = decision.applyTo === "student" ? decision.studentId ?? null : null;
    inc.subjectId = decision.subjectId ?? inc.subjectId;
    inc.marks = decision.applyTo === "none" ? 0 : Math.trunc(decision.marks ?? 0);
    inc.reason = decision.reason ?? null;
    inc.decidedBy = this.user.name;
    inc.decidedAt = new Date().toISOString();
    this.rebuildAlterations(cycleId);

    // Audit (who, when, which student/subject, marks, reason, source incident).
    const subjName = inc.subjectId ? this.assessment(inc.subjectId)?.name ?? inc.subjectId : "—";
    if (decision.applyTo === "none") {
      this.audit("student", "Incident — no action", `${inc.studentName || "incident"} (${inc.source}) marked informational`, cycleId);
    } else if (decision.applyTo === "subject") {
      const n = this.seed.liveCycle.participants.length;
      this.audit("student", "Alteration (whole subject)", `${subjName}: ${inc.marks >= 0 ? "+" : ""}${inc.marks} for all ${n} students — ${inc.reason ?? "no reason"} (source: ${inc.studentName || inc.source})`, cycleId);
    } else {
      const who = inc.studentId ? this.seed.liveCycle.participants.find((p) => p.id === inc.studentId)?.label ?? inc.studentId : inc.studentName;
      this.audit("student", "Alteration (one student)", `${who} · ${subjName}: ${inc.marks >= 0 ? "+" : ""}${inc.marks} — ${inc.reason ?? "no reason"} (source: ${inc.source})`, cycleId);
    }
    this.bump();
  }

  getAdjustments(cycleId: string): AdjustmentsModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const st = this.incidentLogByCycle.get(cycleId);
    const incidents = st?.incidents ?? [];
    const roster = this.seed.liveCycle.participants.map((p) => ({ id: p.id, name: p.label }));
    const subjects = this.seed.liveCycle.assessments.map((a) => ({
      id: a.id,
      name: a.name,
      code: /applicable math/i.test(a.name) ? "AM" : /scientific/i.test(a.name) ? "ST" : /arabic/i.test(a.name) ? "AFL" : /english/i.test(a.name) ? "ESL" : /life/i.test(a.name) ? "LSS" : null,
    }));
    const decided = incidents.filter((i) => i.applyTo != null).length;
    const alterations = this.alterationsFor(cycleId).length;
    const netBySubject: Record<string, number> = {};
    for (const alt of this.alterationsFor(cycleId)) netBySubject[alt.assessmentId] = (netBySubject[alt.assessmentId] ?? 0) + alt.marks;
    return {
      cycleId,
      uploaded: !!st?.uploaded,
      sample: !!st?.sample,
      fileName: st?.fileName ?? null,
      incidents,
      roster,
      subjects,
      counts: { incidents: incidents.length, decided, awaiting: incidents.length - decided, alterations },
      netBySubject,
    };
  }

  // ── CGJ (Centre Grade Judgement) — expected vs actual ─────────────────────
  /**
   * Resolve the raw rows of a centre expectations file into the stored shape:
   * each student's expected level keyed by the assessment id its column maps to,
   * with the level normalised into a canonical performance level. Unrecognised
   * subject columns / level strings are dropped (a blank expectation, never a
   * wrong one) — the file is operational, not authoritative.
   */
  private buildCgjStudents(rows: CgjUploadRow[]): { name: string; expected: Record<string, string> }[] {
    const levels = this.grading.performanceLevels;
    return rows
      .map((r) => {
        const expected: Record<string, string> = {};
        for (const [header, raw] of Object.entries(r.levels)) {
          const subj = this.subjectForExamCode(header);
          if (!subj) continue;
          const level = normalizePerformanceLevel(raw, levels);
          if (level) expected[subj.id] = level;
        }
        return { name: r.studentName, expected };
      })
      .filter((s) => Object.keys(s.expected).length > 0);
  }

  uploadCgjFile(cycleId: string, fileName: string, rows: CgjUploadRow[]): void {
    if (!can(this.user, "cgj.upload", this.resolvedActions)) return;
    if (cycleId !== this.seed.liveCycle.id || this.locked.has(cycleId)) return;
    const students = this.buildCgjStudents(rows);
    this.cgjByCycle.set(cycleId, { uploaded: true, sample: false, fileName, students });
    this.audit("upload", "Added centre grade judgement", `${fileName} — expected grades for ${students.length} student(s)`, cycleId);
    this.bump();
  }

  /**
   * Load a small, clearly-labelled SAMPLE centre expectations set. Names
   * reference real roster labels so the match resolves; the expected levels are
   * deliberately a mix (some match the actuals, some sit above/below) so the
   * comparison shows all four outcomes. Flagged `sample: true` everywhere.
   */
  clearCgj(cycleId: string): void {
    if (!can(this.user, "cgj.upload", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    if (!this.cgjByCycle.has(cycleId)) return;
    this.cgjByCycle.delete(cycleId);
    this.audit("upload", "Removed centre grade judgement", "Centre expectations cleared from the comparison", cycleId);
    this.bump();
  }

  getCgj(cycleId: string): CgjModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const grades = this.getGrades(cycleId);
    const refs = this.assessmentRefs(cycleId);
    const perfLevels = this.grading.performanceLevels;
    const awardLevels = this.grading.awardLevels;
    const st = this.cgjByCycle.get(cycleId);

    // Actual per-student per-subject levels from the (already-computed) grades.
    const actualByStudent = new Map<string, GradeMatrixRow>();
    for (const r of grades?.rows ?? []) actualByStudent.set(r.id, r);

    // Match each centre-file student to a roster student (by the same fuzzy name
    // resolver the incident triage uses). One expected set per matched student.
    const expectedByParticipant = new Map<string, Record<string, string>>();
    let unmatchedStudents = 0;
    for (const s of st?.students ?? []) {
      const pid = this.suggestStudentId(s.name);
      if (pid) expectedByParticipant.set(pid, s.expected);
      else unmatchedStudents += 1;
    }

    let matched = 0, above = 0, below = 0, compared = 0;
    const rows: CgjStudentRow[] = (grades?.rows ?? []).map((g) => {
      const expected = expectedByParticipant.get(g.id) ?? {};
      const inCentreFile = expectedByParticipant.has(g.id);
      const subjects: Record<string, CgjSubjectCompare> = {};
      let rMatched = 0, rAbove = 0, rBelow = 0, rCompared = 0;
      for (const a of this.seed.liveCycle.assessments) {
        const exp = expected[a.id] ?? null;
        const act = g.grades[a.id]?.level || null;
        const m = compareLevels(exp, act, perfLevels);
        subjects[a.id] = { assessmentId: a.id, expected: exp, actual: act, match: m };
        if (m !== "missing") {
          rCompared += 1; compared += 1;
          if (m === "match") { rMatched += 1; matched += 1; }
          else if (m === "above") { rAbove += 1; above += 1; }
          else { rBelow += 1; below += 1; }
        }
      }
      return {
        participantId: g.id,
        studentId: g.studentId,
        name: g.label,
        subjects,
        inCentreFile,
        summary: { matched: rMatched, above: rAbove, below: rBelow, compared: rCompared },
      };
    });

    return {
      cycleId,
      uploaded: !!st?.uploaded,
      sample: !!st?.sample,
      fileName: st?.fileName ?? null,
      assessments: refs,
      rows,
      performanceLevels: perfLevels,
      awardLevels,
      counts: {
        studentsInFile: st?.students.length ?? 0,
        unmatchedStudents,
        matched,
        above,
        below,
        compared,
      },
      pldAwardMap: assumedPldAwardMap(perfLevels, awardLevels),
      pldAwardMapAssumed: true,
    };
  }

  /**
   * Usable (post-exclusion) responses + item metadata across every subject —
   * the same item set scoring uses (cohort-excluded items dropped). Feeds the
   * additive Cronbach's-α reliability output.
   */
  private usableResponsesAndItems(cycleId: string): { responses: ResponseRecord[]; items: ItemMeta[] } {
    const responses: ResponseRecord[] = [];
    const items: ItemMeta[] = [];
    for (const a of this.seed.liveCycle.assessments) {
      const excluded = this.excludedSet(cycleId, a.id);
      // Never-scored (Max Score = 0) items — instructions/stimuli — never entered
      // scoring either (getRawData/getNaiveScores apply the same maxScore>=1 gate),
      // so they're dropped here too, before the exclusion filter below.
      const scoredItemIds = new Set(
        a.items.filter((it) => !excluded.has(it.id) && (it.maxScore ?? 1) >= 1).map((it) => it.id),
      );
      // responsesOf already drops participants removed at the Clean stage, so the
      // cohort α is computed over reflects the cleaned set — the same way scoring
      // does. (excludedSet also folds in Clean-stage column removals.) This is what
      // makes a Clean change propagate into the reliability output.
      for (const r of this.responsesOf(a)) {
        if (!scoredItemIds.has(r.itemId)) continue;
        responses.push(r);
      }
      for (const it of a.items) {
        if (!scoredItemIds.has(it.id)) continue;
        items.push({
          itemId: it.id,
          assessmentId: a.id,
          majorElement: it.major,
          subElement: it.sub,
          demandLevel: it.demand,
          maxScore: it.maxScore,
        });
      }
    }
    return { responses, items };
  }

  /** Cronbach's-α reliability for the cycle, at every construct grouping (read-only). */
  getReliability(cycleId: string): ReliabilityModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const { responses, items } = this.usableResponsesAndItems(cycleId);
    const result = engine.computeReliability({ responses, items });
    const nameById = new Map(this.seed.liveCycle.assessments.map((a) => [a.id, a.name]));

    const rows: ReliabilityRow[] = result.groups.map((g) => ({
      level: g.level,
      assessmentId: g.assessmentId,
      assessmentName: g.assessmentId ? nameById.get(g.assessmentId) ?? g.assessmentId : null,
      key: g.key,
      // the subject group's raw label is the assessment id; show the real name.
      label: g.level === "subject" && g.assessmentId ? nameById.get(g.assessmentId) ?? g.label : g.label,
      k: g.k,
      n: g.n,
      alpha: g.alpha,
      note: g.note,
      lowItems: g.lowItems,
      smallSample: g.smallSample,
    }));
    const overall = rows.find((r) => r.level === "overall")!;
    return {
      cycleId,
      engineVersion: result.engineVersion,
      participants: this.cohortParticipantCount(),
      lowItemsThreshold: LOW_ITEMS_THRESHOLD,
      smallSampleThreshold: SMALL_SAMPLE_THRESHOLD,
      overall,
      rows,
    };
  }

  /**
   * Engine primitives for the overall-score-analysis export. Reuses the same
   * responses/items/exclusions the score engine reads — assembly + workbook
   * building happen in the page (so xlsx-js-style stays out of the main bundle).
   */
  getScoreAnalysisData(cycleId: string, preExclusion = false): AssembleScoreAnalysisArgs | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const responses: ResponseRecord[] = [];
    const items: ItemMeta[] = [];
    const excludedItemIds: string[] = [];
    for (const a of this.seed.liveCycle.assessments) {
      responses.push(...this.responsesOf(a));
      items.push(...this.itemMetasFor(a));
      if (!preExclusion) {
        const excluded = this.excludedSet(cycleId, a.id);
        for (const it of a.items) if (excluded.has(it.id)) excludedItemIds.push(it.id);
      }
    }
    // A cohort-removed participant (staff/test account, re-sit-only, or anyone
    // cleaned out of every subject) leaves the cohort — they must be ABSENT from
    // the naive-overall + score-analysis exports, exactly as getGrades drops them.
    // `responsesOf` already strips their responses; without this filter the export
    // would still list them as all-zero rows (the "P0010/P0011 still present"
    // leak), so the participant roster must reflect the cleaned set too.
    const cohortRemoved = this.cohortRemovedParticipants();
    // Per-(assessment × participant) sitting key for the dataset export's ResultId
    // column (the QM ResultId — one sitting per participant × subject).
    const resultIdByParticipant: Record<string, string> = {};
    for (const a of this.seed.liveCycle.assessments) {
      for (const [pid, rid] of Object.entries(a.resultIdByParticipant ?? {})) {
        resultIdByParticipant[`${a.id}:${pid}`] = rid;
      }
    }
    return {
      assessments: this.seed.liveCycle.assessments.map((a) => ({ id: a.id, name: a.name })),
      participants: this.seed.liveCycle.participants
        .filter((p) => !cohortRemoved.has(p.id))
        .map((p) => ({ id: p.id, label: p.label })),
      responses,
      items,
      excludedItemIds,
      resultIdByParticipant,
      scoreRunNote: preExclusion
        ? "Naive (pre-exclusion) overall scores — computed before item review; no items excluded."
        : "Overall scores after item-review exclusions.",
    };
  }

  /** Engine primitives for the item-analysis export (full ItemStat per item). */
  getItemAnalysisData(cycleId: string): AssembleItemAnalysisArgs | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const stats: ItemStat[] = [];
    const facts: ItemResponseFact[] = [];
    const reviews: Record<string, ItemReviewDecision> = {};
    for (const a of this.seed.liveCycle.assessments) {
      stats.push(...engine.computeItemStats({ responses: this.responsesOf(a), scoringConfig: this.scoringConfig() }));
      const excluded = this.excludedSet(cycleId, a.id);
      for (const r of a.responses) facts.push({ assessmentId: a.id, itemId: r.i, participantId: r.p, answered: true, responseTime: null });
      for (const it of a.items) {
        if (excluded.has(it.id)) reviews[it.id] = { exclude: true, reason: this.reasons.get(`${cycleId}:${a.id}:${it.id}`) ?? null };
      }
    }
    return {
      cycleName: this.getCycle(cycleId)?.name ?? "Cycle",
      assessments: this.seed.liveCycle.assessments.map((a) => ({ id: a.id, name: a.name })),
      stats,
      facts,
      reviews,
    };
  }

  /**
   * Assessment Health diagnostics, recomputed live from each assessment's CURRENT
   * `items`/`responses` on every read — never the static ingest-time snapshot
   * (`this.seed.liveCycle.diagnostics`) — so a Clean-stage participant removal
   * (per-subject `setCleanRemoval` or cohort-wide `excludeParticipantFromCohort`)
   * is reflected immediately, the same way `getReliability`/`getNaiveScores`
   * already recompute over `responsesOf`'s corrected cohort.
   */
  getDiagnostics(cycleId: string): DiagnosticsModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const cohortExcluded = this.cohortExcludedSet();
    return {
      cycleId,
      assessments: this.seed.liveCycle.assessments.map((a) => {
        const removed = this.cleanRowSet(a.id);
        const excludedParticipantIds = removed && removed.size ? new Set([...removed, ...cohortExcluded]) : cohortExcluded;
        const cleanDiag = cleanDiagResponses(this.diagResponsesFor(a), { excludedParticipantIds });
        // TEMP-DEBUG (maxScore-leak investigation — REMOVE AFTER): gate
        // timingPerformance()'s internal [TEMP-DEBUG] logging to this one
        // assessment, then reset immediately so nothing else logs.
        const __tempDebugTarget = __tempDebugIsTargetAssessment(a);
        if (__tempDebugTarget) __setTempDebugTimingLabel(a.name);
        const d = buildAssessmentDiagnostics(cleanDiag);
        if (__tempDebugTarget) __setTempDebugTimingLabel(null);
        return {
          assessmentId: a.id,
          assessmentName: a.name,
          shortName: a.shortName,
          whole: d.whole,
          byDemand: d.byDemand,
          byItemSet: d.byItemSet,
          timingByDemand: d.timingByDemand,
          omissionByPosition: d.omissionByPosition,
        };
      }),
    };
  }

  getComposition(cycleId: string): CompositionModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const essayIds = new Set(this.essaySubjectIds());
    const subjects = this.seed.liveCycle.assessments.map((a) => ({ id: a.id, name: a.name, shortName: a.shortName, hasEssay: essayIds.has(a.id) }));
    const labelOf = (id: string) => this.seed.liveCycle.participants.find((p) => p.id === id)?.label ?? id;

    // participant -> assessment -> ParticipantScore
    const byP = new Map<string, SubjectComposition[]>();
    // Per-student top-difficulty (D3) attempt tally, accumulated across subjects:
    // of the D3 items presented to a student, how many they actually attempted.
    // Display-only; reads the answered flag carried on each response.
    const d3ByP = new Map<string, { attempted: number; available: number }>();
    // Per-student technical-incident count, from each sitting's result_status flag.
    const incidentsByP = new Map<string, number>();
    for (const a of this.seed.liveCycle.assessments) {
      for (const inc of a.technicalIncidents ?? []) {
        incidentsByP.set(inc.p, (incidentsByP.get(inc.p) ?? 0) + 1);
      }
    }
    for (const a of this.seed.liveCycle.assessments) {
      // Per-demand rollup over the SAME retained MCQ items the engine scores
      // (cohort-excluded items dropped). Fixed demand levels D1/D2/D3, only those
      // present as items. Additive reporting — no change to scoring.
      const excluded = this.excludedSet(cycleId, a.id);
      const demandLevels = ["D1", "D2", "D3"] as const;
      const demandItems = new Map<string, { ids: Set<string>; max: number }>();
      for (const it of a.items) {
        if ((it.maxScore ?? 1) < 1 || excluded.has(it.id)) continue;
        if (it.demand !== "D1" && it.demand !== "D2" && it.demand !== "D3") continue;
        let g = demandItems.get(it.demand);
        if (!g) demandItems.set(it.demand, (g = { ids: new Set(), max: 0 }));
        g.ids.add(it.id);
        g.max += it.maxScore ?? 1;
      }
      const scoreByPI = new Map<string, number>(); // `${pid}␟${itemId}` -> score
      const answeredByPI = new Map<string, boolean>(); // `${pid}␟${itemId}` -> attempted?
      for (const r of a.responses) {
        scoreByPI.set(`${r.p}␟${r.i}`, r.s);
        answeredByPI.set(`${r.p}␟${r.i}`, r.a !== false);
      }
      const d3Group = demandItems.get("D3");

      for (const [pid, s] of this.pctByParticipant(cycleId, a)) {
        // Tally this student's D3 engagement on this subject they sat: of all the
        // retained D3 items on the exam, how many they attempted (answered). Items
        // never reached (no response) or left blank count as not attempted.
        if (d3Group) {
          const tally = d3ByP.get(pid) ?? { attempted: 0, available: 0 };
          for (const id of d3Group.ids) {
            tally.available += 1;
            if (answeredByPI.get(`${pid}␟${id}`)) tally.attempted += 1;
          }
          d3ByP.set(pid, tally);
        }
        const byDemand: DemandScore[] = demandLevels
          .filter((d) => demandItems.has(d))
          .map((d) => {
            const g = demandItems.get(d)!;
            let score = 0;
            for (const id of g.ids) score += scoreByPI.get(`${pid}␟${id}`) ?? 0;
            return { demand: d, score: round(score, 2), max: g.max };
          });
        // Per-subject D3 CORRECT % (display-only, Part A). Of the retained D3 items
        // on this subject, how many this student answered correctly (score > 0)
        // out of how many were available — the same "correct, not attempted /
        // available, not attempted" definition the safeguard uses, but broken down
        // per subject for the Score table. Does NOT touch the D3 majority cap.
        let subjectD3: { correct: number; available: number; pct: number | null } | null = null;
        if (d3Group && d3Group.ids.size > 0) {
          let correct = 0;
          for (const id of d3Group.ids) if ((scoreByPI.get(`${pid}␟${id}`) ?? 0) > 0) correct += 1;
          const available = d3Group.ids.size;
          subjectD3 = { correct, available, pct: round((correct / available) * 100, 1) };
        }
        const list = byP.get(pid) ?? [];
        list.push({
          assessmentId: a.id,
          name: a.name,
          hasEssay: essayIds.has(a.id),
          mcq: s.mcq,
          essay: s.essay,
          alterations: s.alterations,
          total: s.raw,
          max: s.max,
          pct: s.pct,
          byDemand,
          d3: subjectD3,
          adjustment: this.manualAdjustmentFor(cycleId, pid, a.id) ?? null,
        });
        byP.set(pid, list);
      }
    }

    const students: StudentComposition[] = [...byP.entries()].map(([pid, subs]) => {
      const total = subs.reduce((t, s) => t + s.total, 0);
      const max = subs.reduce((t, s) => t + s.max, 0);
      const d3 = d3ByP.get(pid) ?? { attempted: 0, available: 0 };
      return {
        participantId: pid,
        name: labelOf(pid),
        subjects: subs,
        overall: { total: round(total, 2), max, pct: max ? round((total / max) * 100, 1) : 0 },
        signals: {
          d3: {
            attempted: d3.attempted,
            available: d3.available,
            pct: d3.available ? round((d3.attempted / d3.available) * 100, 1) : null,
          },
          incidents: incidentsByP.get(pid) ?? 0,
        },
      };
    });
    students.sort((a, b) => b.overall.pct - a.overall.pct);
    return { cycleId, subjects, students };
  }

  setIncidentDecision(cycleId: string, incidentId: string, decision: IncidentDecision, reason?: string | null): void {
    if (!can(this.user, "incidents.triage", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const te = this.technicalErrors.get(cycleId);
    const inc = te?.incidents.find((i) => i.id === incidentId);
    if (!te || !inc) return;
    inc.decision = decision;
    inc.reason = decision === "excluded" ? reason ?? "Confirmed technical fault" : null;
    inc.by = decision ? this.user.name : null;
    inc.at = decision ? new Date().toISOString() : null;
    if (decision === "excluded") {
      this.audit("student", "Excluded question for one student", `${inc.studentName} · ${inc.questionLabel} (${inc.assessmentName}) — ${inc.reason}`, cycleId);
    } else if (decision === "kept") {
      this.audit("student", "Kept question for one student", `${inc.studentName} · ${inc.questionLabel} (${inc.assessmentName}) — scored normally`, cycleId);
    }
    this.bump();
  }

  // ── distinction safeguard (grading stage) ─────────────────────────────────
  /**
   * D3 status for one student on one assessment: the count of **available** D3
   * items (top-difficulty, after cohort item exclusions) and how many the student
   * answered **correctly** (score > 0). This is the corrected metric — correct,
   * not attempted; available, not attempted.
   */
  private d3StatusFor(
    cycleId: string,
    a: SeedAssessment,
    studentId: string,
    demand: string,
  ): { correct: number; available: number; majority: number } {
    const excluded = this.excludedSet(cycleId, a.id);
    const pool = new Set(a.items.filter((it) => it.demand === demand && !excluded.has(it.id)).map((it) => it.id));
    let correct = 0;
    for (const r of a.responses) {
      if (r.p !== studentId || !pool.has(r.i)) continue;
      if (r.s > 0) correct += 1;
    }
    return { correct, available: pool.size, majority: d3MajorityThreshold(pool.size) };
  }

  /**
   * Per-student D3-majority cap (Layer 1b). A student passes only if they cleared
   * the majority of available D3 items on **every** exam that carries D3 items;
   * a single exam below its majority caps them below Distinction. Surfaces the
   * per-exam working and the first failing exam so the cap is explainable.
   */
  private d3CapByParticipant(cycleId: string): Map<string, D3CapStatus> {
    const demand = this.resolveTopDifficulty();
    const out = new Map<string, D3CapStatus>();
    for (const p of this.seed.liveCycle.participants) {
      const exams: D3ExamStatus[] = [];
      for (const a of this.seed.liveCycle.assessments) {
        const { correct, available, majority } = this.d3StatusFor(cycleId, a, p.id, demand);
        if (available <= 0) continue; // no D3 items on this exam — cannot deny anyone
        exams.push({
          assessmentId: a.id,
          name: a.name,
          shortName: a.shortName,
          correct,
          available,
          majority,
          pass: passesD3Majority(correct, available),
        });
      }
      const failing = exams.find((e) => !e.pass) ?? null;
      out.set(p.id, { pass: !failing, exams, failing });
    }
    return out;
  }

  /** Per-participant subject performance levels, in assessment order (Layer 1). */
  private subjectLevelsByParticipant(cycleId: string): Map<string, string[]> {
    const perfLevels = this.grading.performanceLevels;
    const ids = this.seed.liveCycle.participants.map((p) => p.id);
    const out = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const a of this.seed.liveCycle.assessments) {
      const cuts = this.boundaryState(cycleId, a.id).cuts;
      const pct = this.pctByParticipant(cycleId, a);
      for (const id of ids) {
        const v = pct.get(id);
        out.get(id)!.push(v === undefined ? "" : classify(v.pct, perfLevels, cuts));
      }
    }
    return out;
  }

  /**
   * Participants whose **level pattern** qualifies for Distinction (★★★ in ≥3 AND
   * ≥★ Meets in the rest) — i.e. "in line for Distinction", before the D3 cap.
   * The award no longer comes from a cut on an overall score (the old placeholder);
   * it is the deterministic Layer-2 lookup, so candidacy is a level-pattern test.
   */
  private provisionalDistinctionIds(cycleId: string): string[] {
    const perfLevels = this.grading.performanceLevels;
    const levelsByP = this.subjectLevelsByParticipant(cycleId);
    const ids: string[] = [];
    for (const p of this.seed.liveCycle.participants) {
      const levels = levelsByP.get(p.id) ?? [];
      if (qualifiesForDistinctionByLevels(levels, perfLevels)) ids.push(p.id);
    }
    return ids;
  }
  /** studentId → safeguard result, for the grade-matrix cap (used by getGrades). */
  private distinctionDecisions(cycleId: string): Map<string, SafeguardResult> {
    const overrides = this.distinctionOverrides.get(cycleId);
    const d3 = this.d3CapByParticipant(cycleId);
    const out = new Map<string, SafeguardResult>();
    for (const sid of this.provisionalDistinctionIds(cycleId)) {
      if (overrides?.has(sid)) {
        out.set(sid, "override");
        continue;
      }
      out.set(sid, d3.get(sid)?.pass === false ? "capped" : "pass");
    }
    return out;
  }

  getDistinctionSafeguard(cycleId: string, scope?: string): DistinctionSafeguardModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const assessments = this.seed.liveCycle.assessments;
    const scopes = assessments.map((a) => ({ id: a.id, label: a.shortName }));
    const scopeId = scope && assessments.some((a) => a.id === scope) ? scope : assessments[0]?.id ?? "";
    const a = this.assessment(scopeId);
    const demand = this.resolveTopDifficulty();
    // Pool = available D3 items on the selected exam (after item exclusions); the
    // threshold is the DYNAMIC majority of that pool (e.g. 7 → 4), not a fixed N.
    const pool = a ? a.items.filter((it) => it.demand === demand && !this.excludedSet(cycleId, a.id).has(it.id)).length : 0;
    const majority = d3MajorityThreshold(pool);
    const awardLevels = this.grading.awardLevels;
    const topAward = awardLevels[0] ?? "";
    const cappedTo = awardLevels[1] ?? topAward;

    const decisions = this.distinctionDecisions(cycleId);
    const overrides = this.distinctionOverrides.get(cycleId);
    const inLineIds = this.provisionalDistinctionIds(cycleId);
    const d3Cap = this.d3CapByParticipant(cycleId);
    const labelOf = new Map(this.seed.liveCycle.participants.map((p) => [p.id, p.label] as const));

    const candidates: DistinctionCandidate[] = inLineIds.map((sid) => {
      const scopeStatus = a ? this.d3StatusFor(cycleId, a, sid, demand) : { correct: 0, available: 0, majority: 0 };
      const result = decisions.get(sid) ?? "pass";
      const failing = d3Cap.get(sid)?.failing ?? null;
      const ov = overrides?.get(sid);
      const capReason =
        result === "capped" && failing
          ? `Capped below ${topAward} — ${failing.correct}/${failing.available} D3 items correct in ${failing.shortName}; majority is ${failing.majority}`
          : null;
      return {
        id: sid,
        name: labelOf.get(sid) ?? sid,
        topDifficultyCorrect: scopeStatus.correct,
        topDifficultyAvailable: scopeStatus.available,
        majority: scopeStatus.majority,
        meets: passesD3Majority(scopeStatus.correct, scopeStatus.available),
        provisionalAward: topAward,
        cappedAward: cappedTo,
        result,
        capReason,
        overrideReason: ov?.reason ?? null,
        overrideBy: ov?.by ?? null,
      };
    });
    // Closest to the line first: lowest margin of (correct − majority) on the scope.
    candidates.sort(
      (x, y) => (x.topDifficultyCorrect - x.majority) - (y.topDifficultyCorrect - y.majority),
    );

    const vals = [...decisions.values()];
    return {
      cycleId,
      threshold: majority,
      topDifficultyDemand: demand,
      topDifficultyPool: pool,
      scope: scopeId,
      scopes,
      topAward,
      cappedTo,
      candidates,
      counts: {
        inLine: inLineIds.length,
        meet: vals.filter((v) => v === "pass").length,
        capped: vals.filter((v) => v === "capped").length,
        overridden: vals.filter((v) => v === "override").length,
      },
      canOverride: can(this.user, "general.override_distinction", this.resolvedActions),
      attemptedNote:
        "Eligibility uses D3 items answered CORRECTLY against the MAJORITY of D3 items AVAILABLE on each exam (dynamic per exam; recomputed after exclusions) — not attempts, and not a fixed count.",
    };
  }

  confirmDistinctionCaps(cycleId: string): void {
    if (!can(this.user, "grades.confirm_distinction", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const capped = [...this.distinctionDecisions(cycleId).values()].filter((v) => v === "capped").length;
    this.distinctionConfirmed.add(cycleId);
    this.audit(
      "safeguard",
      "Confirmed Distinction safeguard",
      capped ? `${capped} award(s) capped to ${this.grading.awardLevels[1] ?? "the next award"}` : "No caps — every candidate met the rule",
      cycleId,
    );
    this.bump();
  }

  overrideDistinctionCap(cycleId: string, studentId: string, reason: string): void {
    if (!can(this.user, "general.override_distinction", this.resolvedActions) || this.locked.has(cycleId)) return;
    const clean = reason.trim();
    if (!clean) return;
    const m = this.distinctionOverrides.get(cycleId) ?? new Map<string, { reason: string; by: string }>();
    m.set(studentId, { reason: clean, by: this.user.name });
    this.distinctionOverrides.set(cycleId, m);
    const label = this.seed.liveCycle.participants.find((p) => p.id === studentId)?.label ?? studentId;
    this.audit("safeguard", "Overrode Distinction cap", `${label} kept at ${this.grading.awardLevels[0] ?? "Distinction"} — ${clean}`, cycleId);
    this.bump();
  }

  undoDistinctionOverride(cycleId: string, studentId: string): void {
    if (!can(this.user, "general.override_distinction", this.resolvedActions) || this.locked.has(cycleId)) return;
    const m = this.distinctionOverrides.get(cycleId);
    if (m?.delete(studentId)) {
      const label = this.seed.liveCycle.participants.find((p) => p.id === studentId)?.label ?? studentId;
      this.audit("safeguard", "Removed Distinction override", `${label} returned to its safeguard result`, cycleId);
      this.bump();
    }
  }

  // ── manual mark adjustment (Grades-stage, audited + reversible) ────────────
  /**
   * Manually adjust one student's subject MARK to `newMark` (not a direct grade
   * flip), with a REQUIRED reason. The delta rides the existing Alterations input
   * the engine consumes, so the grade recomputes through the full path (incl. the
   * D3 distinction safeguard). At most one active adjustment per cell — re-adjusting
   * supersedes the previous one (computed against the un-adjusted base so deltas
   * never compound). Every change is audited (actor, student, subject, old → new,
   * reason, time). Engine parity is unaffected: only the alterations INPUT changes.
   */
  adjustStudentMark(cycleId: string, participantId: string, assessmentId: string, newMark: number, reason: string): void {
    if (!can(this.user, "grades.adjust", this.resolvedActions)) return;
    if (cycleId !== this.seed.liveCycle.id || this.locked.has(cycleId)) return;
    const clean = (reason ?? "").trim();
    if (!clean) return; // reason is required
    if (!Number.isFinite(newMark)) return;
    const a = this.assessment(assessmentId);
    if (!a) return;
    const score = this.pctByParticipant(cycleId, a).get(participantId);
    if (!score) return;

    const list = this.manualAdjustmentsByCycle.get(cycleId) ?? [];
    const existing = list.find((m) => m.participantId === participantId && m.assessmentId === assessmentId);
    // `score.raw` already includes any existing manual delta for this cell, so the
    // un-adjusted base is the displayed total minus that delta.
    const displayedBefore = score.raw;
    const baseRaw = round(displayedBefore - (existing?.delta ?? 0), 4);
    const target = round(newMark, 4);
    const delta = round(target - baseRaw, 4);

    const next = list.filter((m) => !(m.participantId === participantId && m.assessmentId === assessmentId));
    if (delta !== 0) {
      this.manualAdjSeq += 1;
      next.push({
        id: `madj-${this.manualAdjSeq}`,
        participantId,
        assessmentId,
        oldMark: baseRaw,
        newMark: target,
        delta,
        reason: clean,
        by: this.user.name,
        byRole: this.user.role,
        ts: new Date().toISOString(),
      });
    }
    this.manualAdjustmentsByCycle.set(cycleId, next);

    const who = this.seed.liveCycle.participants.find((p) => p.id === participantId)?.label ?? participantId;
    this.audit(
      "student",
      "Manual mark adjustment",
      `${who} · ${a.name}: ${round(displayedBefore, 2)} → ${target} mark${target === 1 ? "" : "s"} (${delta >= 0 ? "+" : ""}${delta}) — ${clean}`,
      cycleId,
    );
    this.bump();
  }

  /**
   * Remove (undo) a manual mark adjustment by id — reverts the grade (the delta
   * leaves the alterations input, so the engine recomputes the original grade) and
   * audits the removal.
   */
  removeStudentMarkAdjustment(cycleId: string, adjustmentId: string): void {
    if (!can(this.user, "grades.adjust", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const list = this.manualAdjustmentsByCycle.get(cycleId);
    const adj = list?.find((m) => m.id === adjustmentId);
    if (!list || !adj) return;
    this.manualAdjustmentsByCycle.set(cycleId, list.filter((m) => m.id !== adjustmentId));
    const who = this.seed.liveCycle.participants.find((p) => p.id === adj.participantId)?.label ?? adj.participantId;
    const a = this.assessment(adj.assessmentId);
    this.audit(
      "student",
      "Removed mark adjustment",
      `${who} · ${a?.name ?? adj.assessmentId}: reverted ${adj.newMark} → ${adj.oldMark} (${adj.delta >= 0 ? "+" : ""}${adj.delta} undone) — was: ${adj.reason}`,
      cycleId,
    );
    this.bump();
  }

  setSafeguardConfig(patch: { topDifficultyDemand?: string }): void {
    if (!can(this.user, "general.config_methodology", this.resolvedActions)) return;
    if (patch.topDifficultyDemand != null) {
      this.safeguard.topDifficultyDemand = patch.topDifficultyDemand;
    }
    this.audit("safeguard", "Updated Distinction safeguard", `top-difficulty ${this.resolveTopDifficulty()}`, null);
    this.bump();
  }

  // ── document generation (Student Summary) ────────────────────────────────
  getDocuments(cycleId: string): DocumentsModel | null {
    if (cycleId !== this.seed.liveCycle.id) return null;
    const locked = this.locked.has(cycleId);

    // Canonical template slots S1..S5 mapped to suite assessments by alias
    // (keyword), NOT by position — the template order differs from the suite's.
    const refs = this.assessmentRefs(cycleId);
    const resolve = (re: RegExp) => refs.find((a) => re.test(a.id) || re.test(a.name));
    const slotDefs: { slot: string; re: RegExp }[] = [
      { slot: "S1", re: /applicable math/i },
      { slot: "S2", re: /scientific/i },
      { slot: "S3", re: /arabic/i },
      { slot: "S4", re: /english/i },
      { slot: "S5", re: /life/i },
    ];
    const subjectOrder = slotDefs.map((d) => ({
      slot: d.slot,
      assessment: resolve(d.re)?.name ?? d.slot,
    }));

    const settings = this.docSettings(cycleId);

    if (!locked) {
      return { cycleId, locked, students: [], settings, subjectOrder };
    }

    const grades = this.getGrades(cycleId)!;
    // Element/sub-element levels for the UNOFFICIAL diagnostic report (Part 4) —
    // a richer, internal/learner breakdown than the official certificate/report.
    const perf = this.getPerformanceReport(cycleId);
    const starOf = (lvl: string) => starsFor(lvl, this.grading.starMap);
    // DOWNSTREAM: the Student Summary carries each subject's performance `level`
    // + its report `stars`, and the overall `award`, as free strings. Stars come
    // from the configured level→stars map (ScoringConfig), so an added/removed
    // performance level needs a star mapping (already part of the config), and an
    // added/removed award needs the certificate/report template to handle that
    // award label. The next prompt (Settings CRUD + certificates) wires the
    // validation that every configured level has a star mapping and every award
    // has a template slot before generation.
    const students: StudentSummary[] = grades.rows.map((r) => {
      const perfStudent = perf?.students.find((s) => s.participantId === r.id);
      const unofficial: UnofficialSubject[] = slotDefs.map((d) => {
        const ref = resolve(d.re);
        const cell = ref ? r.grades[ref.id] : undefined;
        const subjectMeta = ref ? perf?.subjects.find((s) => s.assessmentId === ref.id) : undefined;
        const result = ref ? perfStudent?.subjects[ref.id] : undefined;
        const elements: UnofficialElement[] = (subjectMeta?.majorElements ?? []).map((major) => ({
          major,
          level: result?.elements[major] ?? "",
          stars: starOf(result?.elements[major] ?? ""),
          subs: (subjectMeta?.subElements[major] ?? []).map((sub) => ({
            sub,
            level: result?.subElements[major]?.[sub] ?? "",
            stars: starOf(result?.subElements[major]?.[sub] ?? ""),
          })),
        }));
        return {
          slot: d.slot,
          assessment: ref?.name ?? d.slot,
          level: cell?.level ?? "",
          stars: cell?.stars ?? "",
          elements,
        };
      });
      return {
        participantId: r.id,
        name: r.label,
        award: r.award,
        subjects: slotDefs.map((d) => {
          const ref = resolve(d.re);
          const cell = ref ? r.grades[ref.id] : undefined;
          return {
            slot: d.slot,
            assessment: ref?.name ?? d.slot,
            level: cell?.level ?? "",
            stars: cell?.stars ?? "",
          };
        }),
        unofficial,
      };
    });

    return { cycleId, locked, students, settings, subjectOrder };
  }

  private docSettings(cycleId: string): DocSettings {
    const existing = this.docSettingsByCycle.get(cycleId);
    if (existing) return existing;
    void cycleId;
    // Defaults: cycle name + the template's sample test centre; dates from the
    // cycle. These are per-cycle settings, editable in the UI.
    return {
      cycleName: this.seed.liveCycle.name,
      testCentre: "Alsama Shatila 1",
      examDate: "11 May 2026",
      issueDate: "10 June 2026",
    };
  }

  setDocumentSettings(cycleId: string, patch: Partial<DocSettings>): void {
    this.docSettingsByCycle.set(cycleId, { ...this.docSettings(cycleId), ...patch });
    this.bump();
  }

  getGradingDefaults(): GradingDefaultsModel {
    return {
      performanceLevels: this.grading.performanceLevels,
      starMap: this.grading.starMap,
      awardLevels: this.grading.awardLevels,
      performanceCuts: this.grading.performanceCuts,
      awardCuts: this.grading.awardCuts,
      // The award is now the confirmed Layer-2 level-combination rule + D3 cap
      // (lib/engine/award.ts), not the old overall-score-cut placeholder.
      awardRuleUnconfirmed: false,
    };
  }

  // ── writes ────────────────────────────────────────────────────────────────
  /**
   * Apply the effective exclusion state for one item. This is the SINGLE mutation
   * the engine reads (`excludedSet` → `excludedItemIds`), shared by the direct
   * item-review action and by an override, so both recompute through the exact
   * same scoring path (incl. the D3 safeguard). It records who set the state and
   * does NOT itself audit — callers attach the appropriate (direct/override)
   * audit entry.
   */
  private applyItemExclusionState(
    cycleId: string,
    assessmentId: string,
    itemId: string,
    excluded: boolean,
    reason: string | null,
  ): void {
    const key = `${cycleId}:${assessmentId}`;
    const set = this.exclusions.get(key) ?? new Set<string>();
    if (excluded) {
      set.add(itemId);
      if (reason != null) this.reasons.set(`${key}:${itemId}`, reason);
    } else {
      set.delete(itemId);
      this.reasons.delete(`${key}:${itemId}`);
    }
    this.exclusions.set(key, set);
    this.exclusionBy.set(`${key}:${itemId}`, {
      id: this.user.id,
      name: this.user.name,
      role: this.user.role,
      at: new Date().toISOString(),
    });
  }

  setItemExcluded(
    cycleId: string,
    assessmentId: string,
    itemId: string,
    excluded: boolean,
    reason?: string | null,
  ): void {
    if (!can(this.user, "review.exclude", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    this.applyItemExclusionState(cycleId, assessmentId, itemId, excluded, reason ?? null);
    // A fresh direct decision supersedes any prior override provenance.
    this.exclusionOverride.delete(`${cycleId}:${assessmentId}:${itemId}`);
    const a = this.assessment(assessmentId);
    if (excluded) {
      // Name the affected question: the human Q-number (positional in a.items)
      // plus the underlying item UUID, so the audit row says WHAT was excluded.
      const qIdx = a ? a.items.findIndex((it) => it.id === itemId) : -1;
      const what = qIdx >= 0 ? `Q${qIdx + 1} (item ${itemId})` : `item ${itemId}`;
      this.audit("exclude", "Excluded item", `${a?.name ?? assessmentId} — ${what} — reason: ${reason ?? "flagged in review"}`, cycleId);
    } else {
      this.audit("exclude", "Restored item", `${a?.name ?? assessmentId} — item returned to scoring`, cycleId);
    }
    this.bump();
  }

  // ── overrides (authorised user reverses another user's action) ─────────────
  /**
   * Override another user's item exclusion/inclusion (e.g. re-include an item a
   * reviewer excluded). Gated on the canonical strictly-higher rule: the actor's
   * role must OUTRANK the role that took the original decision (admin overrides
   * analyst & team member; analyst overrides team member; nobody overrides an
   * equal or higher role). A reason is required. Re-applies the SAME effective
   * state the direct action uses, so scoring recomputes through the full engine
   * (incl. the D3 safeguard), then writes an override audit entry naming the prior
   * decider. No-op (rejected) when the actor can't override, or the sitting locked.
   */
  overrideItemExclusion(
    cycleId: string,
    assessmentId: string,
    itemId: string,
    exclude: boolean,
    reason: string,
  ): void {
    if (!can(this.user, "general.override_marks", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const key = `${cycleId}:${assessmentId}:${itemId}`;
    // `prior` names the previous decider for the override audit trail. P2 gates
    // purely on the `override` permission above — no strictly-higher rule.
    const prior = this.exclusionBy.get(key);
    const clean = (reason ?? "").trim();
    if (!clean) return; // an override requires a reason
    const priorActor = prior && prior.id !== this.user.id ? prior.name : prior?.name ?? null;

    this.applyItemExclusionState(cycleId, assessmentId, itemId, exclude, clean);
    const ts = new Date().toISOString();
    this.exclusionOverride.set(key, { by: this.user.name, priorActor, reason: clean, ts });

    const a = this.assessment(assessmentId);
    const verb = exclude ? "re-excluded" : "re-included";
    this.audit(
      "override",
      "Override — item exclusion",
      `${a?.name ?? assessmentId} — item ${verb}${priorActor ? ` (was set by ${priorActor})` : ""} — ${clean}`,
      cycleId,
      { isOverride: true, priorActor, reason: clean },
    );
    this.bump();
  }

  /**
   * Override another user's manual mark adjustment: set the cell's mark to
   * `newMark`, or revert it (`newMark === null`). Gated on the canonical
   * strictly-higher rule: the actor must OUTRANK the role that made the
   * adjustment (admin > analyst > team member; nobody overrides an equal or higher
   * role). Reason required. Rides the existing alterations engine input exactly as
   * the direct adjustment does (full recompute incl. D3), then writes an override
   * audit entry naming the prior adjuster. No-op (rejected) when the actor can't
   * override, or the sitting is locked.
   */
  overrideMarkAdjustment(
    cycleId: string,
    participantId: string,
    assessmentId: string,
    newMark: number | null,
    reason: string,
  ): void {
    if (!can(this.user, "general.override_marks", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const list = this.manualAdjustmentsByCycle.get(cycleId) ?? [];
    const existing = list.find((m) => m.participantId === participantId && m.assessmentId === assessmentId);
    // `existing` names the previous adjuster for the override audit trail. P2 gates
    // purely on the `override` permission above — no strictly-higher rule.
    const clean = (reason ?? "").trim();
    if (!clean) return;
    const priorActor = existing && existing.by !== this.user.name ? existing.by : existing?.by ?? null;
    const a = this.assessment(assessmentId);
    const who = this.seed.liveCycle.participants.find((p) => p.id === participantId)?.label ?? participantId;
    const key = `${cycleId}:${participantId}:${assessmentId}`;
    const ts = new Date().toISOString();

    if (newMark === null) {
      // Revert: drop the manual adjustment via the SAME effective path the direct
      // remove uses (engine recomputes the base grade), then audit the override.
      if (!existing) return;
      this.manualAdjustmentsByCycle.set(
        cycleId,
        list.filter((m) => !(m.participantId === participantId && m.assessmentId === assessmentId)),
      );
      this.adjustmentOverride.set(key, { by: this.user.name, priorActor, reason: clean, ts });
      this.audit(
        "override",
        "Override — reverted mark adjustment",
        `${who} · ${a?.name ?? assessmentId} — adjustment reverted${priorActor ? ` (was set by ${priorActor})` : ""} — ${clean}`,
        cycleId,
        { isOverride: true, priorActor, reason: clean },
      );
      this.bump();
      return;
    }

    // Re-set the mark through the same alterations input the direct adjustment
    // uses, then record + audit the override.
    if (!Number.isFinite(newMark)) return;
    const score = a ? this.pctByParticipant(cycleId, a).get(participantId) : undefined;
    if (!a || !score) return;
    const displayedBefore = score.raw;
    const baseRaw = round(displayedBefore - (existing?.delta ?? 0), 4);
    const target = round(newMark, 4);
    const delta = round(target - baseRaw, 4);
    const next = list.filter((m) => !(m.participantId === participantId && m.assessmentId === assessmentId));
    if (delta !== 0) {
      this.manualAdjSeq += 1;
      next.push({
        id: `madj-${this.manualAdjSeq}`,
        participantId,
        assessmentId,
        oldMark: baseRaw,
        newMark: target,
        delta,
        reason: clean,
        by: this.user.name,
        byRole: this.user.role,
        ts,
      });
    }
    this.manualAdjustmentsByCycle.set(cycleId, next);
    this.adjustmentOverride.set(key, { by: this.user.name, priorActor, reason: clean, ts });
    this.audit(
      "override",
      "Override — mark adjustment",
      `${who} · ${a.name}: ${round(displayedBefore, 2)} → ${target} (${delta >= 0 ? "+" : ""}${delta})${priorActor ? ` (was set by ${priorActor})` : ""} — ${clean}`,
      cycleId,
      { isOverride: true, priorActor, reason: clean },
    );
    this.bump();
  }

  setCleanRemoval(
    cycleId: string,
    assessmentId: string,
    target: { rows?: string[]; cols?: string[] },
    removed: boolean,
  ): void {
    if (!can(this.user, "clean.rows", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const key = `${cycleId}:${assessmentId}`;
    const rows = this.cleanRows.get(key) ?? new Set<string>();
    const cols = this.cleanCols.get(key) ?? new Set<string>();
    for (const id of target.rows ?? []) (removed ? rows.add(id) : rows.delete(id));
    for (const id of target.cols ?? []) (removed ? cols.add(id) : cols.delete(id));
    this.cleanRows.set(key, rows);
    this.cleanCols.set(key, cols);
    const rowIds = target.rows ?? [];
    const colIds = target.cols ?? [];
    const nR = rowIds.length;
    const nC = colIds.length;
    if (nR || nC) {
      const a = this.assessment(assessmentId);
      // Identify the removed row by a PSEUDONYMOUS key — the candidate code
      // (qm_participant_id), never the student's name. The audit log is
      // exportable / GDPR-scoped, so a bare name must not land in the detail.
      const codeOf = (rowId: string) => {
        const p = this.seed.liveCycle.participants.find((x) => x.id === rowId);
        return p?.studentId ?? rowId;
      };
      const qLabelOf = (itemId: string) => {
        const idx = a ? a.items.findIndex((it) => it.id === itemId) : -1;
        return idx >= 0 ? `Q${idx + 1}` : itemId;
      };
      const list = (xs: string[], fn: (x: string) => string) => {
        const shown = xs.slice(0, 8).map(fn);
        const extra = xs.length - shown.length;
        return shown.join(", ") + (extra > 0 ? `, +${extra} more` : "");
      };
      const parts = [
        nR ? `${nR} row${nR === 1 ? "" : "s"} (candidate ${list(rowIds, codeOf)})` : null,
        nC ? `${nC} column${nC === 1 ? "" : "s"} (${list(colIds, qLabelOf)})` : null,
      ]
        .filter(Boolean)
        .join(" + ");
      this.audit(
        "exclude",
        removed ? "Removed in cleaning" : "Restored in cleaning",
        `${a?.name ?? assessmentId} — ${parts} ${removed ? "removed from" : "restored to"} the cleaned set (raw data untouched)`,
        cycleId,
      );
    }
    this.bump();
  }

  clearCleanRemovals(cycleId: string, assessmentId: string): void {
    if (!can(this.user, "clean.rows", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const key = `${cycleId}:${assessmentId}`;
    const hadR = this.cleanRows.get(key)?.size ?? 0;
    const hadC = this.cleanCols.get(key)?.size ?? 0;
    this.cleanRows.delete(key);
    this.cleanCols.delete(key);
    if (hadR || hadC) {
      const a = this.assessment(assessmentId);
      this.audit("exclude", "Reverted cleaning", `${a?.name ?? assessmentId} — all clean-stage removals reverted`, cycleId);
    }
    this.bump();
  }

  excludeParticipantFromCohort(
    cycleId: string,
    participantId: string,
    excluded: boolean,
    reason?: string | null,
  ): void {
    if (!can(this.user, "clean.cohort", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    let m = this.participantExclusions.get(cycleId);
    if (!m) this.participantExclusions.set(cycleId, (m = new Map<string, string>()));
    const was = m.has(participantId);
    if (excluded) m.set(participantId, (reason ?? "").trim() || "Staff / test account");
    else m.delete(participantId);
    if (was === excluded) return; // no-op
    // Audit by the PSEUDONYMOUS candidate code, never the student's name (the log
    // is exportable / GDPR-scoped).
    const p = this.seed.liveCycle.participants.find((x) => x.id === participantId);
    const code = p?.studentId ?? participantId;
    this.audit(
      "exclude",
      excluded ? "Excluded participant from cohort" : "Restored participant to cohort",
      excluded
        ? `Candidate ${code} excluded from the whole cohort (staff/test account) — ${m.get(participantId)}`
        : `Candidate ${code} restored to the cohort`,
      cycleId,
    );
    this.bump();
  }

  setBoundary(cycleId: string, scope: string, input: SetBoundaryInput): void {
    if (!can(this.user, "cuts.set", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    const key = `${cycleId}:${scope}`;
    const cur = this.boundaryState(cycleId, scope);
    const isAward = scope === "overall";
    const scopeName = isAward ? "Overall award" : this.assessment(scope)?.name ?? scope;

    let cuts = input.cuts ? [...input.cuts] : [...cur.cuts];
    const targets = input.targets ? [...input.targets] : [...cur.targets];
    if (input.targetIndex != null && input.targetValue != null) targets[input.targetIndex] = input.targetValue;

    // Drag a handle in "Set distribution" mode: translate the dragged score-axis
    // position into the implied target share for that band, then let the read
    // model re-solve via the existing Wave 3b backsolver so the handle settles at
    // the nearest achievable cut. The cohort share at-or-above the dragged score
    // equals the combined share of every band above this cut, so this band's
    // target is that cumulative share minus the bands above it. Same underlying
    // value as the table's % column — drag and type stay in two-way sync.
    if (input.dragTargetIndex != null && input.dragScoreValue != null) {
      const idx = input.dragTargetIndex;
      if (idx >= 0 && idx < targets.length) {
        const pcts = this.scopePcts(cycleId, scope);
        const n = pcts.length;
        if (n > 0) {
          const v = Math.max(0, Math.min(100, Math.round(input.dragScoreValue)));
          const atOrAbove = pcts.reduce((c, p) => c + (Math.round(p) >= v ? 1 : 0), 0);
          const cumPct = (atOrAbove / n) * 100;
          const precedeSum = targets.slice(0, idx).reduce((a, b) => a + (Number(b) || 0), 0);
          const otherSum = targets.reduce((a, b, j) => (j === idx ? a : a + (Number(b) || 0)), 0);
          // Clamp so the band stays non-negative and the lowest band (remainder)
          // never goes below zero.
          targets[idx] = Math.max(0, Math.min(100 - otherSum, Math.round(cumPct - precedeSum)));
        }
      }
    }

    let mode: BoundaryMode = input.mode ?? cur.mode;
    let suggested = cur.suggested ? [...cur.suggested] : undefined;
    let waived = cur.waived ? [...cur.waived] : undefined;

    // ── re-suggest: backsolve cuts from the current targets, adopt them as the
    //    editable starting point + snapshot, and switch to editable "cuts" mode.
    if (input.suggest) {
      const bounds = isAward ? { floorPct: 0, ceilingPct: 100 } : POLICY_GUARDRAILS;
      const solved = backsolveCuts(this.scopePcts(cycleId, scope), targets, bounds);
      cuts = [...solved.cuts];
      suggested = [...solved.cuts];
      waived = new Array(cuts.length).fill(false);
      mode = "cuts";
      this.audit("boundary", "Suggested boundaries", `${scopeName} — backsolved cuts from target distribution`, cycleId);
    }

    // ── reset to the stored suggestion (all cuts, or a single one).
    if (input.resetToSuggestion && suggested) {
      cuts = [...suggested];
      if (waived) waived = new Array(cuts.length).fill(false);
      this.audit("boundary", "Reset to suggestion", `${scopeName} — all cuts reset to the suggested values`, cycleId);
    }
    if (input.resetCutIndex != null && suggested && suggested[input.resetCutIndex] != null) {
      cuts[input.resetCutIndex] = suggested[input.resetCutIndex]!;
      if (waived) waived[input.resetCutIndex] = false;
    }

    // ── single-cut edit (drag / type).
    if (input.cutIndex != null && input.cutValue != null) cuts[input.cutIndex] = input.cutValue;

    // Keep cut-points strictly descending (cuts[0] highest) within [1, 99].
    // NOTE: this is the STRUCTURAL ordering guard, not the policy 25%/90%
    // guard-rail. The policy bounds are surfaced (and clampable) in the read
    // model; a user may deliberately WAIVE them (waiveGuardrail) and keep a value
    // outside [25, 90] — that is recorded, not silently re-clamped here.
    for (let i = 0; i < cuts.length; i++) {
      const v = Math.max(0, Math.min(100, Math.round(cuts[i] ?? 0)));
      const hi = i > 0 ? (cuts[i - 1] ?? 100) - 1 : 99;
      const lo = i < cuts.length - 1 ? (cuts[i + 1] ?? 0) + 1 : 1;
      cuts[i] = Math.max(lo, Math.min(hi, v));
    }

    // Record a deliberate guard-rail waiver (value knowingly outside policy bounds).
    if (input.waiveGuardrail && input.cutIndex != null) {
      waived = waived ?? new Array(cuts.length).fill(false);
      waived[input.cutIndex] = true;
      this.audit(
        "boundary",
        "Waived cut guard-rail",
        `${scopeName} — cut ${input.cutIndex + 1} kept at ${cuts[input.cutIndex]}% (outside policy bounds, waived)`,
        cycleId,
      );
    }

    // Audit only deliberate cut/target edits (not every drag tick): when a
    // single cut value is committed via the table input.
    if (input.cutIndex != null && input.cutValue != null && !input.waiveGuardrail) {
      this.audit("boundary", "Changed boundary", `${scopeName} — cut ${input.cutIndex + 1} set to ${cuts[input.cutIndex]}%`, cycleId);
    }

    this.boundaries.set(key, { mode, cuts, targets, suggested, waived });
    this.bump();
  }

  setGradingDefaults(patch: Partial<GradingConfig>): void {
    if (!can(this.user, "general.config_methodology", this.resolvedActions)) return;
    // When the level/award arrays are replaced, replace the star map wholesale
    // (rather than merging) so renamed/removed levels don't leave stale stars.
    const starMap = patch.starMap
      ? patch.performanceLevels
        ? { ...patch.starMap }
        : { ...this.grading.starMap, ...patch.starMap }
      : this.grading.starMap;
    this.grading = { ...this.grading, ...patch, starMap };
    // Drop any boundary state that no longer matches the new band count so it
    // re-derives from the updated defaults.
    const perfLen = this.grading.performanceLevels.length - 1;
    const awardLen = this.grading.awardLevels.length - 1;
    for (const [key, st] of [...this.boundaries.entries()]) {
      const isAward = key.endsWith(":overall");
      if (st.cuts.length !== (isAward ? awardLen : perfLen)) this.boundaries.delete(key);
    }
    this.audit(
      "config",
      "Updated grading defaults",
      `${this.grading.performanceLevels.length} performance levels · ${this.grading.awardLevels.length} award levels`,
      null,
    );
    this.bump();
  }

  setQualityThresholds(patch: Partial<QualityThresholds>): void {
    if (!can(this.user, "general.config_methodology", this.resolvedActions)) return;
    this.quality = {
      pValue: { ...this.quality.pValue, ...(patch.pValue ?? {}) },
      itemTotal: { ...this.quality.itemTotal, ...(patch.itemTotal ?? {}) },
      pointBiserial: { ...this.quality.pointBiserial, ...(patch.pointBiserial ?? {}) },
      discrimination: { ...this.quality.discrimination, ...(patch.discrimination ?? {}) },
    };
    this.audit("config", "Changed item-quality thresholds", "Engine Good/Review/Flag rating bands updated", null);
    this.bump();
  }

  /**
   * Ingest a combined raw export into the (single) live cycle: rebuild its
   * subjects/participants/items/responses from the cleaned responses by running
   * the real engine, exactly as the seed builder does. There is no database in
   * this build, so the rebuilt data lives in memory (and resets on reload); the
   * Supabase provider overrides this to persist + recompute server-side.
   */
  ingestRawExport(
    cycleId: string,
    file: { name: string; sizeMB: number },
    clean: CleanResponse[],
    report: ValidationReport,
    // The faithful 3-CSV canonical model is forwarded by the live provider to the
    // server persist path; the in-memory provider has no DB, so it only uses it
    // for the sitting tag in the audit line (the engine matrix is rebuilt from
    // `clean`, keeping parity untouched).
    extra?: { canonical?: CanonicalModel; files?: { items?: string; assessments?: string; topics?: string } },
  ): Promise<void> {
    if (!can(this.user, "upload.ingest", this.resolvedActions)) return Promise.resolve();
    const lc = this.seed.liveCycle;
    if (cycleId !== lc.id) return Promise.resolve();

    const built = buildLiveCycleData(clean);

    // Re-ingesting replaces the data set, so any prior per-item/per-scope
    // decisions for this cycle no longer apply — clear them so the rebuilt
    // (clean) subjects are served without stale exclusions/boundaries/locks.
    for (const key of [...this.exclusions.keys()]) if (key.startsWith(`${cycleId}:`)) this.exclusions.delete(key);
    for (const key of [...this.reasons.keys()]) if (key.startsWith(`${cycleId}:`)) this.reasons.delete(key);
    for (const key of [...this.boundaries.keys()]) if (key.startsWith(`${cycleId}:`)) this.boundaries.delete(key);
    for (const key of [...this.cleanRows.keys()]) if (key.startsWith(`${cycleId}:`)) this.cleanRows.delete(key);
    for (const key of [...this.cleanCols.keys()]) if (key.startsWith(`${cycleId}:`)) this.cleanCols.delete(key);
    this.participantExclusions.delete(cycleId);
    this.locked.delete(cycleId);

    lc.fileName = file.name;
    lc.fileSizeMB = file.sizeMB;
    lc.files = {
      items: extra?.files?.items ?? null,
      assessments: extra?.files?.assessments ?? null,
      topics: extra?.files?.topics ?? null,
    };
    lc.uploadedAgo = "just now";
    lc.lastActivity = "just now";
    lc.validation = report;
    lc.preview = built.preview;
    lc.duplicates = report.checks.find((c) => c.id === "duplicates")?.count ?? 0;
    lc.participants = built.participants;
    lc.assessments = built.assessments;
    lc.diagnostics = built.diagnostics;
    lc.sittings = built.sittings; // authoritative ingest roster (recomputed)
    lc.stageIndex = 1; // uploaded → next action is Clean

    const sittingNote = extra?.canonical?.sitting ? ` · ${extra.canonical.sitting.label} sitting` : "";
    this.audit(
      "upload",
      "Ingested raw export",
      `${built.assessments.length} subjects · ${built.participants.length} participants · ${file.name}${sittingNote}`,
      cycleId,
    );
    this.bump();
    return Promise.resolve();
  }

  // Destructive sitting controls (0007). The demo has a single seeded live cycle
  // with no database, so the real cycle-scoped delete runs in the Supabase provider
  // via the SECURITY DEFINER RPCs (which clear the fact tables and re-hydrate).
  // Here we EMPTY the seeded cycle to the Upload baseline so the cached summary the
  // Year/cycle card reads (participants / assessments, derived from the seed) also
  // resets to 0/0 — otherwise the card kept showing the stale ingested counts after
  // a clear/delete. Kept async to match the interface (and the live provider, which
  // awaits the DB). A re-ingest repopulates the seed and the counts recompute.
  clearSittingData(cycleId: string): Promise<void> {
    if (!can(this.user, "upload.manage", this.resolvedActions)) return Promise.resolve();
    this.resetCycleToEmpty(cycleId);
    this.audit("upload", "Cleared sitting data", "Emptied ingested data — sitting returned to the Upload state", cycleId);
    this.bump();
    return Promise.resolve();
  }
  deleteSitting(cycleId: string): Promise<void> {
    if (!can(this.user, "general.delete", this.resolvedActions)) return Promise.resolve();
    const name = cycleId === this.seed.liveCycle.id ? this.seed.liveCycle.name : cycleId;
    this.resetCycleToEmpty(cycleId);
    this.audit("cycle", "Deleted sitting", `Removed sitting "${name}" and all its ingested data`, null);
    this.bump();
    return Promise.resolve();
  }
  // Delete a whole cycle (Settings danger surface). Mirrors deleteSitting's full
  // removal, with no last-cycle restriction: an admin may delete cycles down to an
  // empty workspace (zero cycles is a valid state). (Demo caveat: with no DB the sole
  // seeded cycle is emptied in place rather than removed, so it still shows here
  // after delete — the live Supabase path deletes for real and reaches zero.)
  deleteCycle(cycleId: string): Promise<void> {
    if (!can(this.user, "general.delete", this.resolvedActions)) return Promise.resolve();
    const name = cycleId === this.seed.liveCycle.id ? this.seed.liveCycle.name : cycleId;
    this.resetCycleToEmpty(cycleId);
    this.audit("cycle", "Deleted cycle", `Removed cycle "${name}" and every row keyed to it`, null);
    this.bump();
    return Promise.resolve();
  }

  /**
   * Empty a sitting's ingested data + per-cycle decision state back to the fresh
   * Upload baseline. The demo holds one live cycle in memory (no DB), so a
   * clear/delete must reset the seed itself: the summary card + every derived read
   * (cohortParticipantCount / assessmentRefs / years rollup) count off
   * `seed.liveCycle`, so leaving it populated is exactly what left the card showing
   * a stale "N Participants · M Assessments" after the fact tables were emptied.
   */
  private resetCycleToEmpty(cycleId: string): void {
    if (cycleId === this.seed.liveCycle.id) {
      // Reassign a fresh seed with an emptied liveCycle CLONE — never mutate the
      // shared DEFAULT_SEED in place (that would leak the reset into every other
      // provider instance built from the same default).
      this.seed = {
        ...this.seed,
        liveCycle: {
          ...this.seed.liveCycle,
          participants: [],
          assessments: [],
          diagnostics: [],
          sittings: [], // authoritative ingest roster emptied → 0 ingested
          stageIndex: 0, // back to the Upload step
          duplicates: 0,
          preview: { headers: [], rows: [] },
          validation: {
            passed: true,
            checks: [],
            stats: { rawRows: 0, mcqRows: 0, droppedSurveyRows: 0, droppedNonMcqRows: 0, assessments: 0, participants: 0, items: 0 },
          },
        },
      };
    }
    // Drop every cycle-scoped decision so nothing dangles onto the emptied cycle.
    const forCycle = (k: string): boolean => k === cycleId || k.startsWith(`${cycleId}:`);
    const dropPrefixed = (m: Map<string, unknown>): void => {
      for (const k of [...m.keys()]) if (forCycle(k)) m.delete(k);
    };
    // cycle:assessment / cycle:scope keyed.
    dropPrefixed(this.exclusions as unknown as Map<string, unknown>);
    dropPrefixed(this.reasons as unknown as Map<string, unknown>);
    dropPrefixed(this.cleanRows as unknown as Map<string, unknown>);
    dropPrefixed(this.cleanCols as unknown as Map<string, unknown>);
    dropPrefixed(this.boundaries as unknown as Map<string, unknown>);
    // cycle keyed.
    this.participantExclusions.delete(cycleId);
    this.docSettingsByCycle.delete(cycleId);
    this.technicalErrors.delete(cycleId);
    this.essayMarksByCycle.delete(cycleId);
    this.alterationsByCycle.delete(cycleId);
    this.manualAdjustmentsByCycle.delete(cycleId);
    this.incidentLogByCycle.delete(cycleId);
    this.cgjByCycle.delete(cycleId);
    this.distinctionOverrides.delete(cycleId);
    this.incidentRows.delete(cycleId);
    this.incidentSource.delete(cycleId);
    this.incidentApplied.delete(cycleId);
    this.distinctionConfirmed.delete(cycleId);
    this.locked.delete(cycleId);
  }
  // The demo has no database, so there is never any schema drift to report.
  getSchemaHealth(): Promise<SchemaHealth> {
    return Promise.resolve({ ok: true, migration: "0022", missingColumns: [], missingFunctions: [] });
  }

  resolveDuplicates(cycleId: string, strategy: DuplicateStrategy): void {
    // MOCK: records the choice in memory only; no DB write and no row mutation.
    // The real provider will call a server action that rewrites the response set.
    void strategy;
    this.audit("upload", "Resolved duplicates", `Strategy: ${strategy.replace("_", " ")}`, cycleId);
    this.bump();
  }

  lockCycle(cycleId: string): void {
    if (!can(this.user, "general.signoff", this.resolvedActions)) return;
    this.locked.add(cycleId);
    const n = this.seed.liveCycle.participants.length;
    this.audit("lock", "Locked grades", `${n} students signed off across ${this.seed.liveCycle.assessments.length} assessments`, cycleId);
    this.bump();
  }
  unlockCycle(cycleId: string): void {
    if (!can(this.user, "general.signoff", this.resolvedActions)) return;
    this.locked.delete(cycleId);
    this.audit("reopen", "Re-opened cycle", "Cycle unlocked for further review", cycleId);
    this.bump();
  }

  // ── members & roles ───────────────────────────────────────────────────────
  getMembers(): MembersModel {
    return {
      members: this.members.map((m) => ({ ...m })),
      // Roles are the dynamic role rows (add/deletable), not a fixed tier list.
      roles: [...this.roles].sort((a, b) => a.sort - b.sort).map((r) => ({ id: r.id, name: r.name })),
    };
  }

  inviteMember(email: string, roleId: string): void {
    if (!can(this.user, MANAGE_USERS_ACTION, this.resolvedActions)) return;
    const clean = email.trim();
    if (!clean || this.members.some((m) => m.email.toLowerCase() === clean.toLowerCase())) return;
    const role = this.roles.find((r) => r.id === roleId) ?? [...this.roles].sort((a, b) => a.sort - b.sort)[0];
    if (!role) return;
    const name = clean
      .split("@")[0]!
      .split(/[._]/)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");
    this.members.push({
      id: `m-${Date.now()}`,
      name: name || clean,
      email: clean,
      roleId: role.id,
      roleName: role.name,
      status: "invited",
      lastActive: "Invite sent just now",
      isCurrent: false,
    });
    this.audit("upload", "Invited person", `${clean} as ${role.name}`, null);
    this.bump();
  }
  setMemberRole(memberId: string, roleId: string): void {
    if (!can(this.user, MANAGE_USERS_ACTION, this.resolvedActions)) return;
    const m = this.members.find((x) => x.id === memberId);
    const role = this.roles.find((r) => r.id === roleId);
    if (!m || !role) return;
    m.roleId = role.id;
    m.roleName = role.name;
    this.bump();
  }
  removeMember(memberId: string): void {
    if (!can(this.user, MANAGE_USERS_ACTION, this.resolvedActions) || memberId === this.user.id) return;
    this.members = this.members.filter((m) => m.id !== memberId);
    this.bump();
  }
  resendInvite(memberId: string): void {
    if (!can(this.user, MANAGE_USERS_ACTION, this.resolvedActions)) return;
    const m = this.members.find((x) => x.id === memberId);
    if (m && m.status === "invited") {
      m.lastActive = "Invite re-sent just now";
      this.bump();
    }
  }

  // ── dynamic roles × granular actions (migration 0040) ────────────────────────
  /** The fixed CODE catalogue of gateable actions (grouped by pipeline step). */
  getActionCatalogue(): ActionDef[] {
    return ACTIONS.map((a) => ({ ...a }));
  }
  /** The add/deletable role rows, in sort order. */
  getRoles(): RoleModel[] {
    return [...this.roles].sort((a, b) => a.sort - b.sort).map((r) => ({ ...r }));
  }
  /** role_id → the actions that role holds (the grid). */
  getRoleActions(): Record<string, ActionKey[]> {
    const out: Record<string, ActionKey[]> = {};
    for (const [id, acts] of Object.entries(this.roleActions)) out[id] = [...acts];
    return out;
  }

  /** Recompute the derived (role_id → granted action set) view every gate reads. */
  private recomputeResolvedActions(): void {
    this.resolvedActions = resolveRoleActions(this.roles, this.roleActions);
  }
  /** How many roles (optionally excluding one) still hold `general.manage_roles`. */
  private rolesHoldingManageRoles(excludeRoleId?: string): number {
    return this.roles.filter(
      (r) => r.id !== excludeRoleId && (this.roleActions[r.id] ?? []).includes(MANAGE_ROLES_ACTION),
    ).length;
  }

  createRole(name: string): void {
    if (!can(this.user, MANAGE_ROLES_ACTION, this.resolvedActions)) return;
    const clean = name.trim();
    if (!clean || this.roles.some((r) => r.name.toLowerCase() === clean.toLowerCase())) return;
    const id = `role-${this.seq++}-${clean.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const sort = this.roles.reduce((mx, r) => Math.max(mx, r.sort), -1) + 1;
    this.roles.push({ id, name: clean, isSystem: false, sort });
    this.roleActions[id] = [];
    this.recomputeResolvedActions();
    this.audit("config", "Created role", clean, null);
    this.bump();
  }

  renameRole(id: string, name: string): void {
    if (!can(this.user, MANAGE_ROLES_ACTION, this.resolvedActions)) return;
    const r = this.roles.find((x) => x.id === id);
    if (!r) return;
    const clean = name.trim();
    if (!clean || this.roles.some((x) => x.id !== id && x.name.toLowerCase() === clean.toLowerCase())) return;
    r.name = clean;
    // Keep every member's cached role label in step with the rename.
    for (const m of this.members) if (m.roleId === id) m.roleName = clean;
    this.audit("config", "Renamed role", clean, null);
    this.bump();
  }

  deleteRole(id: string): void {
    if (!can(this.user, MANAGE_ROLES_ACTION, this.resolvedActions)) return;
    const r = this.roles.find((x) => x.id === id);
    if (!r) return;
    // Lockout guard: the Admin system role is undeletable.
    if (r.isSystem) return;
    // Refuse if the role still has members (reassign in Users first).
    if (this.members.some((m) => m.roleId === id)) return;
    // Lockout guard: never delete the last role holding general.manage_roles.
    if ((this.roleActions[id] ?? []).includes(MANAGE_ROLES_ACTION) && this.rolesHoldingManageRoles(id) === 0) return;
    this.roles = this.roles.filter((x) => x.id !== id);
    delete this.roleActions[id];
    this.recomputeResolvedActions();
    this.audit("config", "Deleted role", `Removed "${r.name}"`, null);
    this.bump();
  }

  setRoleAction(roleId: string, action: ActionKey, granted: boolean): void {
    if (!can(this.user, MANAGE_ROLES_ACTION, this.resolvedActions)) return;
    const r = this.roles.find((x) => x.id === roleId);
    if (!r || !(ACTION_KEYS as string[]).includes(action)) return;
    // Lockout guard: the Admin role's manage-roles + manage-users cells are
    // permanently granted (can't be turned off).
    if (r.isSystem && !granted && (action === MANAGE_ROLES_ACTION || action === MANAGE_USERS_ACTION)) return;
    const cur = this.roleActions[roleId] ?? [];
    const has = cur.includes(action);
    // Lockout guard: never leave zero roles holding general.manage_roles.
    if (action === MANAGE_ROLES_ACTION && !granted && has && this.rolesHoldingManageRoles(roleId) === 0) return;
    if (granted && !has) this.roleActions[roleId] = [...cur, action];
    else if (!granted && has) this.roleActions[roleId] = cur.filter((a) => a !== action);
    else return;
    this.recomputeResolvedActions();
    this.bump();
  }

  /**
   * Overwrite the roles + grid from persisted DB rows (Supabase hydrate). Empty
   * input (fresh DB) leaves the seeded defaults in place so `can()` is correct
   * before the first edit.
   */
  applyRolesAndActions(
    roles: { id: string; name: string; is_system: boolean; sort: number | null }[],
    roleActions: { role_id: string; action: string }[],
  ): void {
    if (roles.length === 0) return;
    this.roles = roles
      .map((r) => ({ id: r.id, name: r.name, isSystem: r.is_system, sort: r.sort ?? 0 }))
      .sort((a, b) => a.sort - b.sort);
    const next: Record<string, ActionKey[]> = {};
    for (const r of this.roles) next[r.id] = [];
    for (const ra of roleActions) {
      const bucket = next[ra.role_id];
      if (bucket && (ACTION_KEYS as string[]).includes(ra.action)) bucket.push(ra.action as ActionKey);
    }
    this.roleActions = next;
    this.recomputeResolvedActions();
    this.bump();
  }

  // ── configuration ─────────────────────────────────────────────────────────
  getConfig(): ConfigModel {
    return {
      // Display rows derived from the *live* item-quality thresholds, so the
      // Configuration screen reflects whatever the engine is actually using.
      thresholds: qualityThresholdRows(this.quality),
      safeguard: {
        // The D3 safeguard reads this demand level (editable); the threshold is
        // the dynamic per-exam majority of available D3 items, not a fixed count.
        topDifficultyDemand: this.resolveTopDifficulty(),
        demandLevels: this.allDemandLevels(),
      },
      borderline: { ...this.borderline },
    };
  }

  getScoringConfig(): ScoringConfig {
    return this.scoringConfig();
  }

  /**
   * Set the borderline (marginal) flagging band (percentage points). Grade-bearing
   * config: invalid/out-of-range values are clamped (defence in depth — the
   * Supabase RPC also validates server-side), and a change re-flags through the
   * full grade recompute on the next read (marginalInfo runs inside getGrades).
   */
  setBorderlineConfig(patch: Partial<BorderlineConfig>): void {
    if (!can(this.user, "general.config_methodology", this.resolvedActions)) return;
    if (patch.bandPct == null || !Number.isFinite(patch.bandPct)) return;
    this.borderline = { bandPct: clampBorderlineBand(patch.bandPct) };
    this.audit("config", "Updated borderline flagging band", `±${this.borderline.bandPct}% around each grade boundary`, null);
    this.bump();
  }

  getElementLabels(): ElementLabelsConfig {
    return JSON.parse(JSON.stringify(this.elementLabels));
  }
  setElementLabels(config: ElementLabelsConfig): void {
    if (!can(this.user, "general.config_methodology", this.resolvedActions)) return;
    // Server-side parity: reject an invalid set (empty labels, duplicate letters).
    if (validateElementLabels(config)) return;
    this.elementLabels = JSON.parse(JSON.stringify(config));
    this.audit("config", "Updated element labels", "Per-subject A–E element display labels", null);
    this.bump();
  }

  // ── Incident Adjustments configuration ──────────────────────────────────────
  getIncidentConfig(): IncidentConfigModel {
    const c = this.incidentConfig;
    return {
      canEdit: can(this.user, "general.config_incidents", this.resolvedActions),
      perStudentCap: c.perStudentCap,
      mapping: { ...c.mapping },
      codes: c.codes.map((code) => ({
        ...code,
        matchTypes: [...code.matchTypes],
        formula: { ...code.formula },
      })),
    };
  }

  upsertIncidentCode(input: IncidentCodeInput): void {
    if (!can(this.user, "general.config_incidents", this.resolvedActions)) return;
    // Defence in depth (the UI validates too): reject anything not add-only / invalid.
    if (validateIncidentCode(input, this.incidentConfig.codes).length > 0) return;
    if (input.id) {
      const i = this.incidentConfig.codes.findIndex((c) => c.id === input.id);
      if (i < 0) return;
      this.incidentConfig.codes[i] = normalizeIncidentCode(input, input.id);
      this.audit("config", "Updated incident code", `${input.code} · ${describeFormula(input.formula)}`, null);
    } else {
      const id = `code-${++this.seq}-${Date.now().toString(36)}`;
      this.incidentConfig.codes.push(normalizeIncidentCode(input, id));
      this.audit("config", "Added incident code", `${input.code} · ${describeFormula(input.formula)}`, null);
    }
    this.bump();
  }

  deleteIncidentCode(id: string): void {
    if (!can(this.user, "general.config_incidents", this.resolvedActions)) return;
    const before = this.incidentConfig.codes.length;
    this.incidentConfig.codes = this.incidentConfig.codes.filter((c) => c.id !== id);
    if (this.incidentConfig.codes.length !== before) {
      this.audit("config", "Removed incident code", id, null);
      this.bump();
    }
  }

  setIncidentPerStudentCap(cap: number | null): void {
    if (!can(this.user, "general.config_incidents", this.resolvedActions)) return;
    if (validatePerStudentCap(cap).length > 0) return;
    this.incidentConfig.perStudentCap = cap;
    this.audit("config", "Updated per-student incident cap", cap === null ? "No cap" : `${cap} marks`, null);
    this.bump();
  }

  setIncidentMapping(mapping: IncidentColumnMapping): void {
    if (!can(this.user, "general.config_incidents", this.resolvedActions)) return;
    this.incidentConfig.mapping = { ...mapping };
    this.audit("config", "Updated incident import mapping", "Column mapping", null);
    this.bump();
  }

  // ── Incident Adjustments — apply engine + per-student review surface (02b) ──
  /** The cohort roster the importer resolves incident rows against — keyed on P-A's
   *  stable internal participant id (the same id the review's base scores key on). */
  getIncidentRoster(cycleId: string): RosterParticipant[] {
    const comp = this.getComposition(cycleId);
    if (!comp) return [];
    return comp.students.map((s) => ({ internalId: s.participantId, name: s.name }));
  }

  importIncidentRows(
    cycleId: string,
    rows: readonly ResolvedIncidentRow[],
    source?: { fileName: string; sample: boolean },
  ): void {
    if (!can(this.user, "incidents.upload", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    this.incidentRows.set(cycleId, rows.map((r) => ({ ...r, errors: [...r.errors] })));
    if (source) this.incidentSource.set(cycleId, { ...source });
    // A fresh import supersedes any prior commit — the team re-reviews before re-applying.
    this.incidentApplied.delete(cycleId);
    this.audit("upload", "Imported incident rows", `${rows.length} row${rows.length === 1 ? "" : "s"}`, cycleId);
    this.bump();
  }

  clearIncidentRows(cycleId: string): void {
    if (!can(this.user, "incidents.upload", this.resolvedActions)) return;
    if (this.locked.has(cycleId)) return;
    if (!this.incidentRows.has(cycleId) && !this.incidentSource.has(cycleId)) return;
    this.incidentRows.delete(cycleId);
    this.incidentSource.delete(cycleId);
    this.incidentApplied.delete(cycleId);
    this.audit("upload", "Cleared incident rows", "Incident log removed", cycleId);
    this.bump();
  }

  /**
   * Build a small labelled sample of resolved incident rows tied to real cohort
   * students, so the review surface is explorable with no upload. Deliberately
   * exercises every path: a per-duration incident that hits its per-code cap, a
   * whole-room fixed incident, an unclassified row (zero marks, surfaced), a
   * student pushed over the per-student global cap, and an unmatched row.
   */
  getIncidentReview(cycleId: string): IncidentReviewModel | null {
    const comp = this.getComposition(cycleId);
    if (!comp) return null;
    const baseById = new Map(comp.students.map((s) => [s.participantId, { name: s.name, base: s.overall.total }]));
    const rows = this.incidentRows.get(cycleId) ?? [];
    const adjustments = computeStudentAdjustments(rows, this.incidentConfig.codes, this.incidentConfig.perStudentCap);

    const matched: IncidentReviewStudent[] = [];
    const unmatched: IncidentReviewStudent[] = [];
    let ok = 0;
    let unclassified = 0;
    let error = 0;
    let perStudentCapHits = 0;
    let perCodeCapHits = 0;

    for (const a of adjustments) {
      ok += a.okCount;
      unclassified += a.unclassifiedCount;
      error += a.errorCount;
      const baseRow = a.participantId ? baseById.get(a.participantId) : undefined;
      const isUnmatched = !baseRow;
      const base = baseRow?.base ?? 0;
      const student: IncidentReviewStudent = {
        participantKey: a.participantKey,
        participantId: a.participantId,
        name: baseRow?.name ?? a.studentName ?? a.participantKey,
        base: round(base, 2),
        adjustment: a.adjustment,
        uncappedAdjustment: a.uncappedTotal,
        adjusted: round(base + a.adjustment, 2),
        perStudentCapHit: a.perStudentCapHit,
        perCodeCapHit: a.perCodeCapHit,
        unmatched: isUnmatched,
        contributions: a.contributions.map((c) => ({
          rowNumber: c.rowNumber,
          incidentType: c.incidentType,
          questionNumber: c.questionNumber,
          durationMinutes: c.durationMinutes,
          status: c.status,
          code: c.code,
          codeLabel: c.codeLabel,
          rawMarks: c.rawMarks,
          marks: c.marks,
          perCodeCap: c.perCodeCap,
          perCodeCapHit: c.perCodeCapHit,
          errors: [...c.errors],
        })),
      };
      if (a.perStudentCapHit) perStudentCapHits += 1;
      perCodeCapHits += a.contributions.filter((c) => c.perCodeCapHit).length;
      (isUnmatched ? unmatched : matched).push(student);
    }
    matched.sort((x, y) => y.adjustment - x.adjustment || x.name.localeCompare(y.name));

    const applied = this.incidentApplied.get(cycleId) ?? null;
    return {
      cycleId,
      applied: applied !== null,
      appliedBy: applied?.by ?? null,
      appliedAt: applied?.at ?? null,
      canApply: can(this.user, "incidents.apply", this.resolvedActions),
      perStudentCap: this.incidentConfig.perStudentCap,
      source: this.incidentSource.get(cycleId) ?? null,
      students: matched,
      unmatched,
      counts: {
        incidents: rows.length,
        students: matched.length,
        ok,
        unclassified,
        error,
        unmatched: unmatched.length,
        perStudentCapHits,
        perCodeCapHits,
      },
    };
  }

  applyIncidentAdjustments(cycleId: string): void {
    if (!can(this.user, "incidents.apply", this.resolvedActions)) return; // only admin may commit to scores
    if (this.locked.has(cycleId)) return;
    if ((this.incidentRows.get(cycleId) ?? []).length === 0) return;
    this.incidentApplied.set(cycleId, { by: this.user.name, at: new Date().toISOString() });
    const review = this.getIncidentReview(cycleId);
    const applied = review ? review.students.filter((s) => s.adjustment > 0).length : 0;
    this.audit("student", "Applied incident adjustments", `${applied} student${applied === 1 ? "" : "s"} adjusted (capped)`, cycleId);
    this.bump();
  }

  unapplyIncidentAdjustments(cycleId: string): void {
    if (!can(this.user, "incidents.apply", this.resolvedActions)) return;
    if (!this.incidentApplied.has(cycleId)) return;
    this.incidentApplied.delete(cycleId);
    this.audit("student", "Reverted incident adjustments", "Base scores stand alone", cycleId);
    this.bump();
  }

  // ── audit ─────────────────────────────────────────────────────────────────
  getAuditLog(cycleId: string | null, filter: AuditFilter, search: string): AuditModel {
    const filterTypes: Record<AuditFilter, AuditType[] | null> = {
      all: null,
      exclude: ["exclude"],
      boundary: ["boundary"],
      lock: ["lock", "reopen"],
      export: ["export", "document"],
    };
    const types = filterTypes[filter];
    const q = search.trim().toLowerCase();
    const entries = this.auditEntries.filter((e) => {
      if (cycleId && e.cycleId && e.cycleId !== cycleId) return false;
      if (types && !types.includes(e.type)) return false;
      if (q && !`${e.action} ${e.detail} ${e.actorName}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return { entries, total: this.auditEntries.length };
  }

  /**
   * Admin "Audit & overrides" surface: the CURRENT effective grade-bearing
   * decisions for a cycle (excluded items + manual mark adjustments) with their
   * provenance, flagging any that are the result of an override (and by whom).
   * This is the surface used during a Cambridge check-in to see — and reverse —
   * what is in effect, with nothing silently changed.
   */
  getOverrideView(cycleId: string): OverrideViewModel {
    const decisions: EffectiveDecision[] = [];
    const locked = this.locked.has(cycleId);
    // P2: a decision is overridable when the signed-in user holds the `override`
    // permission and the sitting is unlocked — the matrix, not the old
    // strictly-higher role hierarchy. `decidedByRole` is kept purely as a label.
    const mayOverride = (): boolean => !locked && can(this.user, "general.override_marks", this.resolvedActions);

    // Excluded items (the grade-bearing item-review state).
    for (const [key, set] of this.exclusions) {
      const [cid, aid] = key.split(":");
      if (cid !== cycleId || !aid) continue;
      const a = this.assessment(aid);
      for (const itemId of set) {
        const loc = this.itemLocate(itemId);
        const label = loc?.label ?? itemId;
        const who = this.exclusionBy.get(`${key}:${itemId}`);
        const subjectRole: Role = who?.role ?? "reviewer";
        const ov = this.exclusionOverride.get(`${cycleId}:${aid}:${itemId}`);
        decisions.push({
          key: `excl:${aid}:${itemId}`,
          kind: "item_exclusion",
          target: `${a?.name ?? aid} · ${label}`,
          assessmentId: aid,
          itemId,
          state: "Excluded from scoring",
          excluded: true,
          decidedBy: who?.name ?? "—",
          decidedAt: who?.at ?? "",
          decidedByRole: roleTierLabel(subjectRole),
          canOverride: mayOverride(),
          reason: this.reasons.get(`${key}:${itemId}`) ?? null,
          override: ov ? { by: ov.by, priorActor: ov.priorActor, reason: ov.reason, ts: ov.ts } : null,
        });
      }
    }

    // Manual mark adjustments (the grade-bearing alterations state).
    for (const adj of this.manualAdjustmentsByCycle.get(cycleId) ?? []) {
      const a = this.assessment(adj.assessmentId);
      const who = this.seed.liveCycle.participants.find((p) => p.id === adj.participantId)?.label ?? adj.participantId;
      const subjectRole: Role = adj.byRole ?? "reviewer";
      const ov = this.adjustmentOverride.get(`${cycleId}:${adj.participantId}:${adj.assessmentId}`);
      decisions.push({
        key: `adj:${adj.participantId}:${adj.assessmentId}`,
        kind: "mark_adjustment",
        target: `${who} · ${a?.name ?? adj.assessmentId}`,
        assessmentId: adj.assessmentId,
        participantId: adj.participantId,
        state: `${adj.oldMark} → ${adj.newMark} (${adj.delta >= 0 ? "+" : ""}${adj.delta})`,
        decidedBy: adj.by,
        decidedAt: adj.ts,
        decidedByRole: roleTierLabel(subjectRole),
        canOverride: mayOverride(),
        reason: adj.reason,
        override: ov ? { by: ov.by, priorActor: ov.priorActor, reason: ov.reason, ts: ov.ts } : null,
      });
    }

    decisions.sort((x, y) => (y.decidedAt ?? "").localeCompare(x.decidedAt ?? ""));
    return {
      cycleId,
      // Override rights AT ALL: holds the `override` permission on an unlocked
      // sitting. Each row's `canOverride` reflects the same permission (P2: the
      // matrix is the source of truth, not the old strictly-higher hierarchy).
      canOverride: can(this.user, "general.override_marks", this.resolvedActions) && !locked,
      decisions,
      counts: { decisions: decisions.length, overridden: decisions.filter((d) => d.override).length },
    };
  }

  recordExport(cycleId: string, detail: string): void {
    this.audit("export", "Exported data", detail, cycleId);
    this.bump();
  }
  recordDocuments(cycleId: string, detail: string): void {
    this.audit("document", "Generated documents", detail, cycleId);
    this.bump();
  }

  // ── analytics (real live cycle, mock priors) ──────────────────────────────
  private liveAggregates() {
    const cycleId = this.seed.liveCycle.id;
    const overallPcts = [...this.overallPctByParticipant(cycleId).values()];
    const grades = this.getGrades(cycleId);
    const awardLevels = this.grading.awardLevels;
    const awardDist: Record<string, number> = {};
    const n = grades?.rows.length ?? 0;
    for (const lvl of awardLevels) {
      const c = grades?.distribution.find((d) => d.level === lvl)?.count ?? 0;
      awardDist[lvl] = n ? round((c / n) * 100, 0) : 0;
    }
    // per-assessment cohort mean + excluded + mean quality
    const byAssessment: Record<string, number> = {};
    let totalExcluded = 0;
    let qualitySum = 0;
    let qualityCount = 0;
    for (const a of this.seed.liveCycle.assessments) {
      const pcts = [...this.pctByParticipant(cycleId, a).values()].map((v) => v.pct);
      byAssessment[a.id] = round(mean(pcts), 1);
      totalExcluded += this.excludedSet(cycleId, a.id).size;
      for (const it of a.items) {
        qualitySum += it.qualityIndex;
        qualityCount += 1;
      }
    }
    return {
      participants: this.seed.liveCycle.participants.length,
      cohortMean: round(mean(overallPcts), 1),
      median: round(median(overallPcts), 0),
      sd: round(stddev(overallPcts), 1),
      itemsScored: this.seed.liveCycle.assessments.reduce((s, a) => s + a.items.length, 0) - totalExcluded,
      itemsExcluded: totalExcluded,
      meanQuality: qualityCount ? Math.round(qualitySum / qualityCount) : 0,
      awardDist,
      byAssessment,
    };
  }

  getAnalyticsTrends(): AnalyticsTrends {
    const live = this.liveAggregates();
    const awardLevels = this.grading.awardLevels;
    const assessmentIds = this.seed.liveCycle.assessments.map((a) => a.id);
    const priors = mockPriors(awardLevels, assessmentIds);

    const series = (pick: (p: { participants: number; cohortMean: number; itemsExcluded: number; meanQuality: number }) => number, liveVal: number) =>
      [...priors.map(pick), liveVal];
    const delta = (pts: number[]) => {
      const a = pts[pts.length - 1] ?? 0;
      const b = pts[pts.length - 2] ?? a;
      const d = round(a - b, 1);
      return `${d >= 0 ? "+" : "−"}${Math.abs(d)} vs last`;
    };
    const ptsParticipants = series((p) => p.participants, live.participants);
    const ptsMean = series((p) => p.cohortMean, live.cohortMean);
    const ptsExcluded = series((p) => p.itemsExcluded, live.itemsExcluded);
    const ptsQuality = series((p) => p.meanQuality, live.meanQuality);

    const kpis: TrendKpi[] = [
      { label: "Participants", value: live.participants.toLocaleString(), delta: delta(ptsParticipants), points: ptsParticipants, format: "intComma" },
      { label: "Cohort mean", value: `${live.cohortMean}%`, delta: delta(ptsMean), points: ptsMean, format: "pct" },
      { label: "Items excluded", value: String(live.itemsExcluded), delta: delta(ptsExcluded), points: ptsExcluded, format: "int" },
      { label: "Mean item quality", value: String(live.meanQuality), delta: delta(ptsQuality), points: ptsQuality, format: "int" },
    ];

    const byAssessment = this.seed.liveCycle.assessments.map((a) => {
      const pts = [...priors.map((p) => p.byAssessment[a.id] ?? 0), live.byAssessment[a.id] ?? 0];
      const d = round((pts[pts.length - 1] ?? 0) - (pts[pts.length - 2] ?? 0), 1);
      return { name: a.shortName, points: pts, now: `${live.byAssessment[a.id] ?? 0}%`, delta: `${d >= 0 ? "+" : "−"}${Math.abs(d)}` };
    });

    const awardOverTime = [
      ...priors.map((p) => ({ label: p.label, dist: p.awardDist })),
      { label: ANALYTICS_CYCLE_LABELS[ANALYTICS_CYCLE_LABELS.length - 1] ?? "May 26", dist: live.awardDist },
    ];

    // Full cycle names: mock priors' names, with the last replaced by the real
    // live cycle name. Parallel to cycleLabels; the last entry is "current".
    const cycleNames = ANALYTICS_CYCLE_LABELS.map((_, i) =>
      i === ANALYTICS_CYCLE_LABELS.length - 1
        ? this.seed.liveCycle.name
        : ANALYTICS_CYCLE_NAMES[i] ?? ANALYTICS_CYCLE_LABELS[i] ?? "",
    );

    return {
      cycleLabels: ANALYTICS_CYCLE_LABELS,
      cycleNames,
      currentIndex: ANALYTICS_CYCLE_LABELS.length - 1,
      kpis,
      byAssessment,
      awardOverTime,
      awardLevels,
      priorsAreMock: true,
    };
  }

  // ── Overall analytics (bird's-eye, over time × centres) ───────────────────
  // Modelling many REAL cycles is out of scope for the in-memory seed (it holds a
  // single live cycle), so — like getAnalyticsTrends — this returns REAL data for
  // the one live cell (the live centre × year: May is the real sitting, February
  // is the demo best-of-two baseline) and clearly-labelled SYNTHETIC data for the
  // other centres/years, with `hasComparison` set honestly (only one real year
  // exists). The Supabase + seed path is where full multi-cell REAL data renders.
  getOverallAnalytics(filter?: OverallAnalyticsFilter): OverallAnalytics {
    const perfLevels = this.grading.performanceLevels;
    const awardLevels = this.grading.awardLevels;
    const liveId = this.seed.liveCycle.id;

    // Canonical subject list (union) keyed by a stable subject key.
    const subjectsSeen = new Map<string, { key: string; name: string; short: string; rtl?: boolean }>();
    for (const a of this.seed.liveCycle.assessments) {
      const key = subjectKeyOf(a.shortName);
      if (!subjectsSeen.has(key)) subjectsSeen.set(key, { key, name: a.name, short: a.shortName, rtl: a.rtl });
    }
    const subjects = [...subjectsSeen.values()];

    const liveCentre = this.centreFor(this.effectiveCentreId(liveId, this.seed.liveCycle.testCentreId)).name;
    const liveYearRaw = this.yearOf(this.seed.liveCycle.name);
    const liveYear = /^\d{4}$/.test(liveYearRaw) ? Number(liveYearRaw) : 2026;

    const cells: OACell[] = [];

    // The live cell: REAL May grades + demo February baseline (best-of-two rollup).
    const mayGrades = this.getGrades(liveId);
    if (mayGrades && mayGrades.rows.length > 0) {
      const febGrades = this.demoFebruaryGrades(mayGrades);
      cells.push({
        centre: liveCentre,
        year: liveYear,
        february: this.oaSittingFromLevels(febGrades, `feb|${liveYear}|${liveCentre}`),
        may: this.oaSittingFromLiveScores(liveId, mayGrades),
      });
    }

    // Clearly-labelled SYNTHETIC cells so the multi-year / multi-centre views
    // render while real data accrues: a prior synthetic year at the live centre,
    // plus two sample sibling centres across both years. Never real scoring — a
    // deterministic level distribution per (centre, year, sitting) with a small
    // year-on-year and centre bias, so spreads and improvement read meaningfully.
    const rosterN = Math.max(10, mayGrades?.rows.length ?? 14);
    const siblingCentres = ["Sample Centre B", "Sample Centre C"];
    const yearBias = (year: number): number => (year < liveYear ? -1 : 0); // prior years read slightly weaker
    const centreBias: Record<string, number> = { "Sample Centre B": 0, "Sample Centre C": -1 };

    const addSynthCell = (centre: string, year: number, bias: number): void => {
      cells.push({
        centre,
        year,
        synthetic: true,
        february: this.synthOASitting(`${centre}|${year}|feb`, rosterN, bias - 1, subjects), // Feb weaker → May improves
        may: this.synthOASitting(`${centre}|${year}|may`, rosterN, bias, subjects),
      });
    };

    // Prior synthetic year at the live centre.
    addSynthCell(liveCentre, liveYear - 1, yearBias(liveYear - 1));
    // Sibling centres across both years.
    for (const c of siblingCentres) {
      for (const year of [liveYear - 1, liveYear]) {
        addSynthCell(c, year, yearBias(year) + (centreBias[c] ?? 0));
      }
    }

    // A centre subset re-pools every figure from just those cells; the full
    // subject list is kept so the sections can still offer every subject to pick.
    const sel = filter?.centres;
    const usedCells = sel && sel.length ? cells.filter((c) => sel.includes(c.centre)) : cells;

    return computeOverallAnalytics({
      cells: usedCells,
      subjects,
      awards: overallAwardBands(awardLevels),
      plevels: overallPLevels(perfLevels),
      performanceLevels: perfLevels,
      awardLevels,
      starMap: this.grading.starMap,
      // Only the live year carries any real data — comparison is not real yet.
      realYears: [liveYear],
    });
  }

  /** Representative score % for a performance level (demo/synthetic only), jittered
   *  deterministically within the level's band. Never used for real scoring. */
  private pctForLevel(level: string, seed: string): number {
    const levels = this.grading.performanceLevels;
    const cuts = this.grading.performanceCuts;
    const idx = levels.indexOf(level);
    const i = idx < 0 ? levels.length - 1 : idx;
    const upper = i === 0 ? 100 : cuts[i - 1] ?? 100;
    const lower = cuts[i] ?? 0;
    const band = Math.max(1, upper - lower);
    const mid = (upper + lower) / 2;
    const jitter = ((hash32(seed) % 100) / 100 - 0.5) * band * 0.6;
    return round(Math.max(0, Math.min(100, mid + jitter)), 1);
  }

  /** A live sitting → OASitting with REAL per-subject score percentages. */
  private oaSittingFromLiveScores(cycleId: string, grades: GradesModel): OASitting {
    const students: OASittingStudent[] = grades.rows.map((r) => {
      const levels: Record<string, string> = {};
      for (const a of grades.assessments) {
        const lvl = r.grades[a.id]?.level;
        if (lvl) levels[subjectKeyOf(a.shortName)] = lvl;
      }
      return { studentId: r.studentId, award: r.award, levels };
    });
    const scores: Record<string, number[]> = {};
    for (const a of this.seed.liveCycle.assessments) {
      const key = subjectKeyOf(a.shortName);
      scores[key] = [...this.pctByParticipant(cycleId, a).values()].map((v) => round(v.pct, 1));
    }
    return { students, scores };
  }

  /** A (demo) GradesModel with levels but no real scores → OASitting whose scores
   *  are synthesized from each cell's level (demo February baseline only). */
  private oaSittingFromLevels(grades: GradesModel, seedTag: string): OASitting {
    const students: OASittingStudent[] = grades.rows.map((r) => {
      const levels: Record<string, string> = {};
      for (const a of grades.assessments) {
        const lvl = r.grades[a.id]?.level;
        if (lvl) levels[subjectKeyOf(a.shortName)] = lvl;
      }
      return { studentId: r.studentId, award: r.award, levels };
    });
    const scores: Record<string, number[]> = {};
    for (const a of grades.assessments) {
      const key = subjectKeyOf(a.shortName);
      const list: number[] = [];
      for (const r of grades.rows) {
        const lvl = r.grades[a.id]?.level;
        if (lvl) list.push(this.pctForLevel(lvl, `${seedTag}|${r.studentId}|${key}`));
      }
      scores[key] = list;
    }
    return { students, scores };
  }

  /** A fully-synthetic sitting for a (centre, year): deterministic levels with a
   *  small bias (better/worse), award derived by the real rule, scores from levels.
   *  Clearly non-real — used only to populate the Overall views in the demo. */
  private synthOASitting(
    seedTag: string,
    n: number,
    bias: number,
    subjects: { key: string; name: string; short: string }[],
  ): OASitting {
    const levels = this.grading.performanceLevels; // best → lowest
    const L = levels.length;
    const awardLevels = this.grading.awardLevels;
    const students: OASittingStudent[] = [];
    for (let i = 0; i < n; i++) {
      const studentId = `${seedTag}-s${String(i + 1).padStart(2, "0")}`;
      const lvlMap: Record<string, string> = {};
      const subjectLevels: string[] = [];
      for (const s of subjects) {
        const h = hash32(`${seedTag}|${studentId}|${s.key}`) % 100;
        // Base rank from the hash (0 best … L-1 lowest), then shift by bias
        // (positive bias = better i.e. lower rank).
        let rank = h < 15 ? 0 : h < 40 ? 1 : h < 75 ? 2 : 3;
        rank = Math.max(0, Math.min(L - 1, rank - bias));
        const lvl = levels[rank] ?? levels[L - 1]!;
        lvlMap[s.key] = lvl;
        subjectLevels.push(lvl);
      }
      const award = deriveAward(
        { subjectLevels, d3Pass: true },
        { performanceLevels: levels, awardLevels },
      ).award;
      students.push({ studentId, award, levels: lvlMap });
    }
    const scores: Record<string, number[]> = {};
    for (const s of subjects) {
      scores[s.key] = students.map((st) => this.pctForLevel(st.levels[s.key] ?? levels[L - 1]!, `${seedTag}|${st.studentId}|${s.key}`));
    }
    return { students, scores };
  }

  // ── new cycle ─────────────────────────────────────────────────────────────
  getNewCycle(): NewCycleModel {
    // The picker offers the canonical G12++ subject catalog, not the assessments
    // of whatever cycle happens to be loaded — so it is fully populated even
    // before any cycle exists (live Supabase, fresh database).
    const active = this.testCentres.filter((c) => c.active);
    return {
      defaultName: "May 2026",
      // ISO date (yyyy-mm-dd) so it drops straight into the native date picker and
      // the `exam_cycles.sitting_date` column without reformatting.
      sittingDate: "2026-05-14",
      assessments: SUBJECT_CATALOG.map((s) => ({
        id: s.id,
        name: s.name,
        rtl: s.rtl,
        included: true,
        fileName: null,
      })),
      // 0010 — the sitting (and its year) is created under a chosen test centre.
      testCentres: active.map((c) => ({ ...c })),
      defaultTestCentreId: active[0]?.id ?? null,
    };
  }

  createCycle(input: CreateCycleInput): Promise<string> {
    if (!can(this.user, "upload.manage", this.resolvedActions)) return Promise.resolve(this.seed.liveCycle.id);
    // In-memory/demo mode has no database: record the intent in the audit log and
    // resolve to the demo cycle id (the only one with real data) so navigation
    // works. The Supabase provider overrides this to persist a real cycle.
    const centre = this.centreFor(input.testCentreId);
    this.audit(
      "cycle",
      "Created cycle",
      `${centre.name} · ${input.name} — ${input.assessmentIds.length} assessments`,
      this.seed.liveCycle.id,
    );
    this.bump();
    return Promise.resolve(this.seed.liveCycle.id);
  }

  // ── test centres (top-level scoping dimension — migration 0010) ────────────
  listTestCentres(): TestCentreSummary[] {
    return this.testCentres.map((c) => ({ ...c }));
  }

  createTestCentre(input: { name: string; code: string }): void {
    if (!can(this.user, "general.manage_centres", this.resolvedActions)) return;
    const name = input.name.trim();
    const code = input.code.trim();
    if (!name || !code) return;
    const slug = this.uniqueCentreSlug(name);
    this.seq += 1;
    this.testCentres.push({ id: `tc-${this.seq}-${slug}`, name, code, slug, active: true });
    this.audit("config", "Created test centre", `${name} (${code})`, null);
    this.bump();
  }

  updateTestCentre(id: string, patch: { name?: string; code?: string; active?: boolean }): void {
    if (!can(this.user, "general.manage_centres", this.resolvedActions)) return;
    const c = this.testCentres.find((x) => x.id === id);
    if (!c) return;
    if (patch.name !== undefined && patch.name.trim()) c.name = patch.name.trim();
    if (patch.code !== undefined && patch.code.trim()) c.code = patch.code.trim();
    if (patch.active !== undefined) c.active = patch.active;
    this.audit("config", "Updated test centre", `${c.name} (${c.code})`, null);
    this.bump();
  }

  setTestCentreActive(id: string, active: boolean): void {
    if (!can(this.user, "general.manage_centres", this.resolvedActions)) return;
    const c = this.testCentres.find((x) => x.id === id);
    if (!c) return;
    c.active = active;
    this.audit("config", active ? "Activated test centre" : "Deactivated test centre", c.name, null);
    this.bump();
  }

  /**
   * 0013 — reassign an exam year to a different centre. Mirrors the SECURITY
   * DEFINER `move_exam_year_to_centre` RPC: Lead/Admin only (a non-admin is a
   * silent no-op here; rejected server-side on live data), respects the
   * (name, region, centre) uniqueness with a friendly conflict message, and is
   * PURE LABELLING — it only repoints the year's sittings to the new centre
   * (an override map), so no result/grade row is touched and the engine is not
   * re-run. `yearId` is the derived year id from `listYears()`.
   */
  moveExamYearToCentre(yearId: string, testCentreId: string): Promise<void> {
    if (!can(this.user, "general.manage_centres", this.resolvedActions)) return Promise.resolve();
    const years = this.buildYears();
    const year = years.find((y) => y.id === yearId);
    if (!year) return Promise.reject(new Error("Exam year not found."));
    const target = this.testCentres.find((c) => c.id === testCentreId);
    if (!target) return Promise.reject(new Error("Test centre not found."));
    // Idempotent: already in the target centre.
    if (year.testCentreId === testCentreId) return Promise.resolve();
    // Respect unique (name, region, centre): the target centre must not already
    // run a year of the same period. Friendly message matches the server RPC.
    const conflict = years.some(
      (y) => y.id !== year.id && y.testCentreId === testCentreId && y.name === year.name,
    );
    if (conflict) {
      return Promise.reject(new Error(`centre "${target.name}" already has a ${year.name} year`));
    }
    // Repoint every sitting (cycle) in this derived year to the new centre. The
    // cycle's CycleSummary.testCentreId is already the EFFECTIVE id, so matching
    // on the year's current centre selects exactly this year's cycles.
    for (const c of this.listCycles()) {
      if (this.yearOf(c.name) === year.name && c.testCentreId === year.testCentreId) {
        this.cycleCentreOverride.set(c.id, testCentreId);
      }
    }
    this.audit("config", "Moved exam year to centre", `${year.name} → ${target.name}`, null);
    this.bump();
    return Promise.resolve();
  }

  /** Route-safe slug from a centre name, de-duplicated against existing centres. */
  private uniqueCentreSlug(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "centre";
    let slug = base;
    let n = 2;
    while (this.testCentres.some((c) => c.slug === slug)) slug = `${base}-${n++}`;
    return slug;
  }
}
