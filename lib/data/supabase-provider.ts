"use client";

/**
 * SupabaseDataProvider — the live DataProvider implementation.
 *
 * Strategy (light list + lazy per-cycle providers, shared workspace):
 *
 *  - A DIRECTORY `InMemoryDataProvider` holds the WORKSPACE (grading config, roles, element
 *    labels, centres, members, audit …, via a shared `WorkspaceState`) and the cycle LIST
 *    (a light summary of every sitting — id, name, year, period, date, status, lock, counts).
 *    It answers the Years pages and every workspace-level call. It hosts no sitting's data.
 *  - Each sitting's FULL data is loaded lazily, when it is opened, into its OWN
 *    `InMemoryDataProvider` (a "slot"), built over the same shared workspace and then
 *    replayed with that sitting's stored decisions. Every cycle-scoped call is ROUTED by
 *    `cycleId` to that sitting's provider, so reading or editing sitting A never touches
 *    sitting B, and opening B never changes A.
 *  - WRITES apply optimistically to the sitting's provider (instant UI) AND go to the
 *    SECURITY DEFINER RPCs over the RLS-scoped client — the only sanctioned path for
 *    status/decision/computed columns. The database enforces authorization (RLS + each
 *    function's role check), so a write the user isn't allowed to make is rejected
 *    server-side even though the optimistic local copy updated.
 *  - A write that changes what the database holds in a way the client can't mirror (a new
 *    id, an ingest, a clear) refreshes ONLY the affected sitting and the light list —
 *    never the other sittings, and never "which sitting you are looking at".
 *
 * Hydration is async; the synchronous interface is satisfied by serving the (empty) list
 * until the light load finishes, then bumping the version so screens re-render. Reactivity
 * is driven by this provider's own version/subscribe.
 *
 * `getAccessStatus()` (not part of DataProvider) lets the shell render the sign-in /
 * access-denied states for the invite-only model. See docs/multi-sitting-provider.md.
 */
import type { Database, ExamYearRow } from "@/lib/types/database";
import { isSittingKey, sortPeriods, type SittingKey } from "./periods";
import type { ActionDef, ActionKey, Role } from "@/lib/auth/actions";
import { buildMembersModel, parseMemberKey, type MemberDirRow } from "./member-directory";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";
import type { IncidentCodeInput, IncidentColumnMapping } from "@/lib/incidents/types";
import type {
  ExamIncidentMatchContext,
  ExamIncidentRecord,
  ExamIncidentReconciliation,
} from "@/lib/incidents/exam-incident-match";
import { InMemoryDataProvider } from "./in-memory-provider";
import { WorkspaceState } from "./workspace-state";
import { gzipText, GZIP_MARKER_HEADER, GZIP_MARKER_VALUE } from "@/lib/transport/gzip";
import {
  hydrateCycle,
  loadWorkspace,
  lightToSeedCycle,
  fetchSessionUser,
  fetchOverallAnalytics,
  type CycleDecisionState,
  type CycleHydrationContext,
  type HydratedCycle,
  type LightCycle,
  type OverallAnalyticsProjection,
  type WorkspaceDecisionState,
} from "./supabase-hydrate";
import { computeOverallAnalytics, overallAwardBands, overallPLevels } from "./overall-analytics";
import { catalogNamesFor } from "./subject-catalog";
import {
  SITTING_REGION,
  buildCreateCycleArgs,
  findPeriodConflict,
  friendlyCreateCycleError,
  normalizeYearName,
  sittingLabel,
} from "./create-cycle";
import type { Seed, SeedPriorCycle } from "./seed-types";
import type { GradingConfig } from "./grading";
import type { ElementLabelsConfig } from "./element-labels";
import type { ScoringConfig, QualityThresholds } from "@/lib/engine";
import type {
  DataProvider,
  SetBoundaryInput,
  TechnicalErrorRow,
  IncidentInput,
  IncidentDecisionInput,
  EssayUploadRow,
  CgjUploadRow,
  SchemaHealth,
  SittingRoster,
} from "./provider";
import type { CleanResponse, ValidationReport } from "@/lib/ingest/types";
import type { PerItemSource } from "@/lib/data/per-item-source";
import type { CanonicalModel } from "@/lib/ingest/qm";
import type {
  AnalyticsTrends,
  OverallAnalytics,
  OverallAnalyticsFilter,
  AuditFilter,
  AuditModel,
  OverrideViewModel,
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
  IncidentConfigModel,
  IncidentReviewModel,
  CompositionModel,
  DiagnosticsModel,
  ReliabilityModel,
  IncidentDecision,
} from "./types";
import type { ResolvedIncidentRow, RosterParticipant } from "@/lib/incidents/import";

type DB = SupabaseBrowserClient;

export type AccessStatus = "loading" | "ok" | "no-session" | "not-member" | "no-cycle" | "error";

const LOADING_USER: CurrentUser = { id: "loading", name: "…", initials: "…", role: "viewer" };

/**
 * The directory's seed. It hosts NO sitting: `liveCycle` is an empty placeholder (id "")
 * that never appears in a list, and `priorCycles` carries the light summary of every real
 * sitting. A well-formed (empty) validation report is still supplied — `stats` is required
 * by ValidationReport and must never be absent.
 */
function directorySeed(priorCycles: SeedPriorCycle[]): Seed {
  return {
    generatedAt: new Date(0).toISOString(),
    engineVersion: "directory",
    // DEFINED (even when empty) = live data: the centre picker offers only real centres.
    testCentres: [],
    liveCycle: {
      id: "", name: "", region: "eu-west", startedAt: "", lastActivity: "",
      stageIndex: 0, fileName: "", fileSizeMB: 0, uploadedAgo: "",
      validation: {
        passed: true,
        checks: [],
        stats: { rawRows: 0, mcqRows: 0, droppedSurveyRows: 0, droppedNonMcqRows: 0, assessments: 0, participants: 0, items: 0 },
      },
      preview: { headers: [], rows: [] }, duplicates: 0,
      participants: [], assessments: [], diagnostics: [],
    },
    priorCycles,
  };
}

/** Per-sitting id lookups the RPCs need (row ids are per-cycle, so these are too). */
interface CycleLookups {
  /** qm_participant_id → participant row uuid (essay-file uploads). */
  qmToUuid: Map<string, string>;
  /** participant row uuid → stable qm_participant_id. */
  uuidToQm: Map<string, string>;
  /** essay subject code (AFL/ESL) → assessment uuid. */
  subjectToAssessment: Map<string, string>;
  /** inner inc-N → DB incident uuid. */
  incIdMap: Map<string, string>;
}

/** One sitting's loaded state. `provider` is null until the first successful load. */
interface CycleSlot {
  provider: InMemoryDataProvider | null;
  lookups: CycleLookups;
  /** In-flight load, shared by every concurrent caller. */
  load: Promise<void> | null;
  /** Invalidated while a load was in flight → reload once it lands. */
  stale: boolean;
  error: string | null;
}

const emptyLookups = (): CycleLookups => ({
  qmToUuid: new Map(),
  uuidToQm: new Map(),
  subjectToAssessment: new Map(),
  incIdMap: new Map(),
});

export class SupabaseDataProvider implements DataProvider {
  /** Workspace-level state, shared BY REFERENCE with the directory and every sitting. */
  private readonly workspace: WorkspaceState;
  /** Workspace reads/writes + the light cycle list. Hosts no sitting's data. */
  private dir: InMemoryDataProvider;
  /** One provider per opened sitting, keyed by cycle id. */
  private slots = new Map<string, CycleSlot>();
  /** The light cycle list (every sitting), as the last load reported it. */
  private lights = new Map<string, LightCycle>();
  /** Years + centres from the last light load (what `hydrateCycle` needs). */
  private ctx: CycleHydrationContext = { years: [], testCentres: [] };
  private version = 0;
  private listeners = new Set<() => void>();
  private status: AccessStatus = "loading";
  /** The REAL member roster (auth.users ⋈ memberships), via the list_members RPC.
   *  Replaces the mock member list entirely in the live app. */
  private realMembers: MemberDirRow[] = [];
  /** Multi-cycle Overall-analytics projection (every centre × year × sitting). Loaded
   *  lazily, the first time /analytics asks — it reads three unfiltered fact tables, so
   *  it is not part of sign-in. Empty until then → getOverallAnalytics falls back to the demo. */
  private overall: OverallAnalyticsProjection = { cells: [], subjects: [], years: [] };
  private overallLoad: "idle" | "loading" | "done" = "idle";

  constructor(private supabase: DB) {
    this.workspace = new WorkspaceState({ user: LOADING_USER, testCentres: [] });
    this.dir = this.makeDirectory();
    void this.init();
    // The provider instance outlives client-side navigation, so a sign-in that
    // happens after construction (on /signin) would otherwise leave `status`
    // stuck at its initial value and the access gate would bounce back to
    // /signin. React to auth changes so the gate re-evaluates without a reload.
    this.supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        this.workspace.user = LOADING_USER;
        this.slots.clear();
        this.lights.clear();
        this.publishDirectory();
        this.status = "no-session";
        this.bump();
      } else if (event === "SIGNED_IN" && this.status === "no-session") {
        // We were locked out and now hold a session — load from scratch.
        this.status = "loading";
        this.bump();
        void this.init();
      }
    });
  }

  private makeDirectory(): InMemoryDataProvider {
    const dir = new InMemoryDataProvider(directorySeed([]), undefined, true, this.workspace);
    // Year-level reads (Overall) reach each sitting's grades through the provider that holds it.
    dir.setCycleResolver((cycleId) => this.slots.get(cycleId)?.provider ?? null);
    return dir;
  }

  // ── reactivity ─────────────────────────────────────────────────────────
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
  /** For the shell: render sign-in / access-denied for the invite-only model. */
  getAccessStatus(): AccessStatus {
    return this.status;
  }

  // ── loading ────────────────────────────────────────────────────────────
  private async init(): Promise<void> {
    try {
      const session = await fetchSessionUser(this.supabase);
      if (session.status !== "ok" || !session.user) {
        this.status = session.status === "no-session" ? "no-session" : "not-member";
        this.bump();
        return;
      }
      this.workspace.user = session.user;
      await this.refreshWorkspace();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Supabase hydration failed:", e);
      this.status = "error";
      this.bump();
    }
  }

  /**
   * (Re)load the WORKSPACE: config, roles, centres, members and the light list of every
   * sitting. Touches no sitting's detailed data — loaded sittings stay exactly as they are.
   */
  private async refreshWorkspace(): Promise<void> {
    const ws = await loadWorkspace(this.supabase);
    // Centres first: a fresh database may have real centres before any cycle exists, and
    // the "Start a sitting" picker must offer real centre UUIDs (never a mock slug).
    this.workspace.testCentres = ws.testCentres.map((c) => ({ ...c }));
    this.ctx = { years: ws.years, testCentres: ws.testCentres };
    this.applyYearExpectedPeriods(ws.years);
    this.applyWorkspaceDecisions(ws.decisions);
    this.setLights(ws.cycles);
    await this.fetchMembers();
    this.status = this.lights.size === 0 ? "no-cycle" : "ok";
    this.bump();
  }

  /**
   * (Re)load ONLY the light cycle list (+ the year/centre context). Used after a create,
   * delete or any change to a sitting's summary; does not re-apply workspace config
   * (which could clobber an edit whose RPC is still in flight).
   */
  private async refreshCycleList(): Promise<void> {
    const ws = await loadWorkspace(this.supabase);
    this.workspace.testCentres = ws.testCentres.map((c) => ({ ...c }));
    this.ctx = { years: ws.years, testCentres: ws.testCentres };
    this.applyYearExpectedPeriods(ws.years);
    this.setLights(ws.cycles);
    this.status = this.lights.size === 0 ? "no-cycle" : "ok";
    this.bump();
  }

  /**
   * Publish each year's `expected_periods` to the shared workspace. A year whose column is
   * absent (a database that has not applied 0051 yet) or holds nothing usable is left out of
   * the map, so it expects the registry defaults — exactly the old February + May behaviour.
   */
  private applyYearExpectedPeriods(years: ExamYearRow[]): void {
    const map = new Map<string, SittingKey[]>();
    for (const y of years) {
      const raw = (y as { expected_periods?: unknown }).expected_periods;
      if (!Array.isArray(raw)) continue;
      const keys = sortPeriods([...new Set(raw.filter(isSittingKey))]);
      if (keys.length > 0) map.set(y.id, keys);
    }
    this.workspace.expectedPeriodsByYear = map;
  }

  private setLights(cycles: LightCycle[]): void {
    this.lights = new Map(cycles.map((c) => [c.id, c]));
    // A sitting that no longer exists must not linger as a loaded slot.
    for (const id of [...this.slots.keys()]) if (!this.lights.has(id)) this.slots.delete(id);
    this.publishDirectory();
  }

  /** Apply persisted roles, action grid, settings and labels to the SHARED workspace. */
  private applyWorkspaceDecisions(d: WorkspaceDecisionState): void {
    // Roles first: the grid decides what `can()` says about every later gated call.
    this.dir.applyRolesAndActions(d.roles, d.roleActions);
    this.dir.hydrateWorkspaceConfig(d.workspace, d.elementLabels);
    this.reconcileAllBoundaries();
  }

  /** Push the light list (with each loaded sitting's live numbers) into the directory. */
  private publishDirectory(): void {
    this.dir.setCycleDirectory([...this.lights.values()].map((l) => this.directoryEntry(l)));
  }

  /** A sitting's directory entry: its light summary, or — once loaded — its live numbers. */
  private directoryEntry(l: LightCycle): SeedPriorCycle {
    const base = lightToSeedCycle(l);
    const p = this.slots.get(l.id)?.provider;
    const live = p?.listCycles().find((c) => c.id === l.id);
    if (!live) return base;
    return {
      ...base,
      stageIndex: live.stageIndex,
      stepsDone: live.stepsDone,
      participants: live.participants,
      assessments: live.assessments,
      lastActivity: live.lastActivity,
      locked: live.locked,
    };
  }

  private slotFor(cycleId: string): CycleSlot {
    let s = this.slots.get(cycleId);
    if (!s) {
      s = { provider: null, lookups: emptyLookups(), load: null, stale: false, error: null };
      this.slots.set(cycleId, s);
    }
    return s;
  }

  /** The provider holding a sitting's detailed data, if it is loaded. */
  private cycleProvider(cycleId: string): InMemoryDataProvider | null {
    return this.slots.get(cycleId)?.provider ?? null;
  }

  /** Route a read to the sitting's provider; `fallback` when it isn't loaded. */
  private read<T>(cycleId: string, f: (p: InMemoryDataProvider) => T, fallback: T): T {
    const p = this.cycleProvider(cycleId);
    return p ? f(p) : fallback;
  }

  /** Apply a write to the sitting's provider; false (and nothing done) when it isn't loaded. */
  private write(cycleId: string, f: (p: InMemoryDataProvider) => void): boolean {
    const p = this.cycleProvider(cycleId);
    if (!p) return false;
    f(p);
    this.afterCycleChange();
    return true;
  }

  /** A sitting changed in memory: refresh its directory summary and notify. */
  private afterCycleChange(): void {
    this.publishDirectory();
    this.bump();
  }

  // ── lazy per-sitting loading ───────────────────────────────────────────
  getCycleLoadState(cycleId: string): CycleLoadState {
    if (this.status === "loading") return "loading";
    const slot = this.slots.get(cycleId);
    if (slot?.provider) return "ready";
    if (!this.lights.has(cycleId)) return "missing";
    return slot?.error ? "error" : "loading";
  }

  ensureCycleLoaded(cycleId: string): Promise<void> {
    if (!this.lights.has(cycleId)) return Promise.resolve();
    const slot = this.slotFor(cycleId);
    if (slot.provider && !slot.stale) return Promise.resolve();
    return this.loadCycle(cycleId);
  }

  /**
   * Load (or reload) ONE sitting's full data into its own provider. Concurrent callers
   * share one load; a reload builds the new provider off to the side and swaps it in on
   * success, so the screen never flashes empty and a failed refresh keeps the old data.
   * Nothing but this sitting's slot (and the directory's summary of it) is touched.
   */
  private loadCycle(cycleId: string): Promise<void> {
    const slot = this.slotFor(cycleId);
    if (slot.load) return slot.load;
    slot.stale = false;
    slot.error = null;
    slot.load = (async () => {
      try {
        const h = await hydrateCycle(this.supabase, cycleId, this.ctx);
        if (!h) {
          // Deleted elsewhere since the list was read.
          this.slots.delete(cycleId);
          this.lights.delete(cycleId);
          return;
        }
        this.adopt(slot, cycleId, h);
      } catch (e) {
        slot.error = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.error(`Hydrating sitting ${cycleId} failed:`, e);
      } finally {
        slot.load = null;
      }
      if (slot.stale && this.slots.get(cycleId) === slot) return this.loadCycle(cycleId);
    })().then(() => {
      this.publishDirectory();
      this.bump();
    });
    return slot.load;
  }

  /** Build the sitting's provider over the shared workspace, replay its decisions, swap in. */
  private adopt(slot: CycleSlot, cycleId: string, h: HydratedCycle): void {
    const next = new InMemoryDataProvider(h.seed, undefined, true, this.workspace);
    this.replayCycle(next, cycleId, h.decisions);
    slot.provider = next;
    slot.lookups = {
      qmToUuid: h.lookups.qmToUuid,
      uuidToQm: new Map([...h.lookups.qmToUuid].map(([qm, uuid]) => [uuid, qm])),
      subjectToAssessment: h.lookups.subjectCodeToAssessmentId,
      incIdMap: new Map(h.lookups.incidentDbIds.map((id, i) => [`inc-${i + 1}`, id])),
    };
    slot.error = null;
  }

  /** The stored sitting is out of date: re-read just that sitting (and its list entry). */
  private async refreshCycle(cycleId: string): Promise<void> {
    const slot = this.slots.get(cycleId);
    if (slot) slot.stale = true;
    await this.refreshCycleList();
    if (this.lights.has(cycleId)) await this.loadCycle(cycleId);
  }

  /** Reload the sitting only if it is already loaded (don't load sittings nobody opened). */
  private async refreshLoadedCycle(cycleId: string): Promise<void> {
    if (this.slots.get(cycleId)?.provider) await this.refreshCycle(cycleId);
    else await this.refreshCycleList();
  }

  /** After a grading change: every loaded sitting drops boundary state that no longer fits. */
  private reconcileAllBoundaries(): void {
    for (const s of this.slots.values()) s.provider?.reconcileBoundariesWithGrading();
  }

  /**
   * Replay one sitting's stored decisions into its provider as DATABASE TRUTH
   * (`replayPersisted`: ungated, unaudited — a viewer must see the same grades as an admin).
   * The lock is restored last, through an ungated setter, so it freezes further edits.
   */
  private replayCycle(p: InMemoryDataProvider, cid: string, d: CycleDecisionState): void {
    p.replayPersisted(() => {
      for (const e of d.exclusions) p.setItemExcluded(cid, e.assessmentId, e.itemId, true, e.reason);
      for (const c of d.cleanRemovals) {
        if (c.rows.length) p.setCleanRemoval(cid, c.assessmentId, { rows: c.rows }, true);
        if (c.cols.length) p.setCleanRemoval(cid, c.assessmentId, { cols: c.cols }, true);
      }
      // Cohort-wide exclusions (0033) — replayed as one whole-cohort action each, the
      // same mutator the "Remove from all subjects" control drives. Seeded staff/test
      // accounts arrive here as data, not a hard-coded email.
      for (const ce of d.cohortExclusions) p.excludeParticipantFromCohort(cid, ce.participantId, true, ce.reason);
      for (const s of d.schemes) {
        const cuts = s.bands.slice(0, -1).map((b) => b.min);
        p.setBoundary(cid, s.scope, { mode: s.method === "fixed_pct" ? "pct" : "cuts", cuts });
      }
      if (d.essays.length) p.hydrateEssayMarks(cid, "essay_marks.xlsx", d.essays);
      if (d.incidents.length) {
        p.hydrateIncidentLog(cid, "incident_log.xlsx", d.incidents);
        d.incidentDecisions.forEach((dec, i) => {
          if (dec) p.hydrateIncidentDecision(cid, `inc-${i + 1}`, dec);
        });
      }
      if (d.distinctionConfirmed) p.confirmDistinctionCaps(cid);
      for (const o of d.distinctionOverrides) p.overrideDistinctionCap(cid, o.studentId, o.reason);
      if (d.docSettings) p.setDocumentSettings(cid, d.docSettings as Partial<DocSettings>);
      // 0044 — staged technical incidents loaded verbatim (no re-matching).
      if (d.examIncidents.length) p.hydrateExamIncidents(cid, d.examIncidents);
      // Last — freezes further edits. exam_cycles.status is the source of truth.
      p.hydrateLocked(cid, d.locked);
    });
  }

  // ── RPC helpers ────────────────────────────────────────────────────────
  /** Narrowly-typed view of `.rpc` (the dynamic function name defeats the typed
   *  client's per-function arg inference; the names/args are checked at the call
   *  sites by the `Functions` map keys). */
  private get rpcFn(): (name: string, args: unknown) => Promise<{ error: { message: string } | null }> {
    return this.supabase.rpc.bind(this.supabase) as unknown as (
      name: string,
      args: unknown,
    ) => Promise<{ error: { message: string } | null }>;
  }
  /** Like `rpcFn` but keeps the returned scalar/row (for RPCs that return an id). */
  private rpcData<T>(name: string, args: unknown): Promise<{ data: T | null; error: { message: string } | null }> {
    return (this.supabase.rpc.bind(this.supabase) as unknown as (
      n: string,
      a: unknown,
    ) => Promise<{ data: T | null; error: { message: string } | null }>)(name, args);
  }
  private rpc<N extends keyof Database["public"]["Functions"]>(
    name: N,
    args: Database["public"]["Functions"][N]["Args"],
  ): void {
    // Fire-and-forget: the interface is synchronous. Errors (incl. server-side
    // authorization failures) are logged; the optimistic local state remains.
    void (async () => {
      const { error } = await this.rpcFn(name as string, args);
      if (error) {
        // eslint-disable-next-line no-console
        console.error(`RPC ${String(name)} failed:`, error.message);
      }
    })();
  }
  /** Persist, then re-read ONLY this sitting (for RPCs that mint DB ids the client can't mirror). */
  private async rpcThenRefreshCycle<N extends keyof Database["public"]["Functions"]>(
    cycleId: string,
    name: N,
    args: Database["public"]["Functions"][N]["Args"],
  ): Promise<void> {
    const { error } = await this.rpcFn(name as string, args);
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`RPC ${String(name)} failed:`, error.message);
      return;
    }
    await this.refreshLoadedCycle(cycleId);
  }
  /** Persist an optimistic write; if the server REFUSES it, re-read the sitting so the
   *  screen shows what the database actually holds instead of diverging silently. */
  private async rpcOrReconcile<N extends keyof Database["public"]["Functions"]>(
    cycleId: string,
    name: N,
    args: Database["public"]["Functions"][N]["Args"],
  ): Promise<void> {
    const { error } = await this.rpcFn(name as string, args);
    if (!error) return;
    // eslint-disable-next-line no-console
    console.error(`RPC ${String(name)} failed:`, error.message);
    await this.refreshLoadedCycle(cycleId);
  }
  /** Persist, then re-read the WORKSPACE (roles, centres: server-generated ids). Sittings untouched. */
  private async rpcThenRefreshWorkspace<N extends keyof Database["public"]["Functions"]>(
    name: N,
    args: Database["public"]["Functions"][N]["Args"],
  ): Promise<void> {
    const { error } = await this.rpcFn(name as string, args);
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`RPC ${String(name)} failed:`, error.message);
      return;
    }
    await this.refreshWorkspace();
  }

  // ── identity ───────────────────────────────────────────────────────────
  getCurrentUser(): CurrentUser {
    return this.workspace.user;
  }

  // ── cycle list & years (the directory) ──────────────────────────────────
  listYears(): YearSummary[] { return this.dir.listYears(); }
  getYear(yearId: string): YearDetail | null { return this.dir.getYear(yearId); }
  listCycles(): CycleSummary[] { return this.dir.listCycles(); }
  /** A loaded sitting answers in full; one the list only knows answers from its summary. */
  getCycle(cycleId: string): CycleDetail | null {
    const p = this.cycleProvider(cycleId);
    return p ? p.getCycle(cycleId) : this.dir.getCycle(cycleId);
  }

  // ── reads (routed to the sitting's provider) ─────────────────────────────
  getIngest(cycleId: string): IngestModel | null { return this.read(cycleId, (p) => p.getIngest(cycleId), null); }
  getSittingRoster(cycleId: string): SittingRoster | null { return this.read(cycleId, (p) => p.getSittingRoster(cycleId), null); }
  getCombinedSplit(cycleId: string): CombinedSplitModel | null { return this.read(cycleId, (p) => p.getCombinedSplit(cycleId), null); }
  getRawData(cycleId: string, assessmentId: string): RawDataModel | null { return this.read(cycleId, (p) => p.getRawData(cycleId, assessmentId), null); }
  getDataCleaning(cycleId: string, assessmentId: string): DataCleaningModel | null { return this.read(cycleId, (p) => p.getDataCleaning(cycleId, assessmentId), null); }
  getCleanedData(cycleId: string, assessmentId: string): CleanedDataModel | null { return this.read(cycleId, (p) => p.getCleanedData(cycleId, assessmentId), null); }
  getCleaningImpact(cycleId: string): CleaningImpactModel | null { return this.read(cycleId, (p) => p.getCleaningImpact(cycleId), null); }
  getCleaningSummary(cycleId: string): CleaningSummaryModel | null { return this.read(cycleId, (p) => p.getCleaningSummary(cycleId), null); }
  getCleanedMasterDataset(cycleId: string): CleanedMasterDataset | null { return this.read(cycleId, (p) => p.getCleanedMasterDataset(cycleId), null); }
  getNaiveScores(cycleId: string, assessmentId: string): NaiveScoresModel | null { return this.read(cycleId, (p) => p.getNaiveScores(cycleId, assessmentId), null); }
  getReview(cycleId: string, assessmentId: string): ReviewModel | null { return this.read(cycleId, (p) => p.getReview(cycleId, assessmentId), null); }
  getItemDetail(cycleId: string, assessmentId: string, itemId: string): ItemDetailModel | null { return this.read(cycleId, (p) => p.getItemDetail(cycleId, assessmentId, itemId), null); }
  getBoundaries(cycleId: string, scope: string): BoundaryModel | null { return this.read(cycleId, (p) => p.getBoundaries(cycleId, scope), null); }
  getGrades(cycleId: string): GradesModel | null { return this.read(cycleId, (p) => p.getGrades(cycleId), null); }
  getOverallGrades(yearId: string): OverallGradesModel | null { return this.dir.getOverallGrades(yearId); }
  getOverallDocuments(yearId: string): DocumentsModel | null { return this.dir.getOverallDocuments(yearId); }
  getPerformanceReport(cycleId: string): PerformanceReportModel | null { return this.read(cycleId, (p) => p.getPerformanceReport(cycleId), null); }
  getGradingDefaults(): GradingDefaultsModel { return this.dir.getGradingDefaults(); }
  getStudentReview(cycleId: string): StudentReviewModel | null { return this.read(cycleId, (p) => p.getStudentReview(cycleId), null); }
  getDistinctionSafeguard(cycleId: string, scope?: string): DistinctionSafeguardModel | null { return this.read(cycleId, (p) => p.getDistinctionSafeguard(cycleId, scope), null); }
  getDocuments(cycleId: string): DocumentsModel | null { return this.read(cycleId, (p) => p.getDocuments(cycleId), null); }
  getScoreAnalysisData(cycleId: string, preExclusion?: boolean) { return this.read(cycleId, (p) => p.getScoreAnalysisData(cycleId, preExclusion), null); }
  getItemAnalysisData(cycleId: string) { return this.read(cycleId, (p) => p.getItemAnalysisData(cycleId), null); }
  /** The REAL Users & access roster — auth.users ⋈ memberships, mapped through the
   *  one canonical role vocabulary (lib/auth/roles.ts). The signed-in account is
   *  flagged `isCurrent` by the session id, so displayed identity = authenticated
   *  identity. NOT the mock member list. */
  getMembers(): MembersModel {
    // Roles are the DYNAMIC role rows (0040) — the same ids the roster resolves each
    // member to (role_id) and the Roles × actions grid counts by — so the Users
    // dropdown lists them and each row's value matches. NOT the legacy enum tiers.
    return buildMembersModel(this.realMembers, this.workspace.user.id, this.dir.getRoles());
  }

  /** Load the real roster via the SECURITY DEFINER list_members RPC. */
  private async fetchMembers(): Promise<void> {
    const { data, error } = await this.rpcData<MemberDirRow[]>("list_members", {});
    if (error) {
      // eslint-disable-next-line no-console
      console.error("list_members failed:", error.message);
      return;
    }
    this.realMembers = data ?? [];
  }
  listTestCentres(): TestCentreSummary[] { return this.dir.listTestCentres(); }
  getConfig(): ConfigModel { return this.dir.getConfig(); }
  getScoringConfig(): ScoringConfig { return this.dir.getScoringConfig(); }
  getElementLabels(): ElementLabelsConfig { return this.dir.getElementLabels(); }
  getIncidentConfig(): IncidentConfigModel { return this.dir.getIncidentConfig(); }
  /** The audit trail is workspace-level (shared) — entries carry their own cycle id. */
  getAuditLog(cycleId: string | null, filter: AuditFilter, search: string): AuditModel { return this.dir.getAuditLog(cycleId, filter, search); }
  getOverrideView(cycleId: string): OverrideViewModel {
    return this.read(cycleId, (p) => p.getOverrideView(cycleId), this.dir.getOverrideView(cycleId));
  }
  getAnalyticsTrends(): AnalyticsTrends { return this.dir.getAnalyticsTrends(); }
  /**
   * The Overall analytics read-model, computed from the LIVE multi-cycle
   * projection (persisted grades + scores across every centre × year × sitting)
   * via `computeOverallAnalytics`. The projection loads lazily on first use; until it
   * arrives (and when no persisted multi-cell data exists, e.g. a fresh/pre-seed DB) it
   * falls back to the in-memory demo so the page still renders — mirroring
   * getAnalyticsTrends' clearly-labelled priors.
   */
  getOverallAnalytics(filter?: OverallAnalyticsFilter): OverallAnalytics {
    this.ensureOverallProjection();
    if (this.overall.cells.length === 0) return this.dir.getOverallAnalytics(filter);
    const g = this.dir.getGradingDefaults();
    // A centre subset re-pools every figure from just those cells; the full
    // subject list is kept so the sections can still offer every subject to pick.
    const sel = filter?.centres;
    const cells = sel && sel.length ? this.overall.cells.filter((c) => sel.includes(c.centre)) : this.overall.cells;
    return computeOverallAnalytics({
      cells,
      subjects: this.overall.subjects,
      awards: overallAwardBands(g.awardLevels),
      plevels: overallPLevels(g.performanceLevels),
      performanceLevels: g.performanceLevels,
      awardLevels: g.awardLevels,
      starMap: g.starMap,
      realYears: this.overall.years,
    });
  }

  /** Kick off the (heavy, unfiltered) analytics projection once. Idempotent. */
  private ensureOverallProjection(): void {
    if (this.overallLoad !== "idle" || this.status !== "ok") return;
    this.overallLoad = "loading";
    void fetchOverallAnalytics(this.supabase)
      .catch((): OverallAnalyticsProjection => ({ cells: [], subjects: [], years: [] }))
      .then((projection) => {
        this.overall = projection;
        this.overallLoad = "done";
        this.bump();
      });
  }

  getNewCycle(): NewCycleModel { return this.dir.getNewCycle(); }
  getEssayMarks(cycleId: string): EssayMarksModel | null { return this.read(cycleId, (p) => p.getEssayMarks(cycleId), null); }
  getEssayContext(cycleId: string): EssayUploadContext | null { return this.read(cycleId, (p) => p.getEssayContext(cycleId), null); }
  getExamIncidentMatchContext(cycleId: string): ExamIncidentMatchContext | null { return this.read(cycleId, (p) => p.getExamIncidentMatchContext(cycleId), null); }
  getExamIncidentsForCycle(cycleId: string): ExamIncidentRecord[] { return this.read(cycleId, (p) => p.getExamIncidentsForCycle(cycleId), []); }
  getExamIncidentReconciliation(cycleId: string, batchId: string): ExamIncidentReconciliation | null { return this.read(cycleId, (p) => p.getExamIncidentReconciliation(cycleId, batchId), null); }
  getAdjustments(cycleId: string): AdjustmentsModel | null { return this.read(cycleId, (p) => p.getAdjustments(cycleId), null); }
  getCgj(cycleId: string): CgjModel | null { return this.read(cycleId, (p) => p.getCgj(cycleId), null); }
  getComposition(cycleId: string): CompositionModel | null { return this.read(cycleId, (p) => p.getComposition(cycleId), null); }
  getDiagnostics(cycleId: string): DiagnosticsModel | null { return this.read(cycleId, (p) => p.getDiagnostics(cycleId), null); }
  getReliability(cycleId: string): ReliabilityModel | null { return this.read(cycleId, (p) => p.getReliability(cycleId), null); }
  getPerItemSource(cycleId: string): PerItemSource | null { return this.read(cycleId, (p) => p.getPerItemSource(cycleId), null); }

  // ── year-level loading ───────────────────────────────────────────────────
  /** The ids of the sittings that belong to a year (resolves either year id form). */
  private cycleIdsOfYear(yearId: string): string[] {
    const y = this.dir.listYears().find((yr) => yr.id === yearId || yr.examYearId === yearId);
    if (!y) return [];
    return [...this.lights.values()]
      .filter((l) => (y.examYearId ? l.yearId === y.examYearId : l.id === y.id))
      .map((l) => l.id);
  }

  /**
   * Load the sittings an Overall needs: the year's LOCKED sittings (only those count
   * toward it, so an unlocked sitting's data is never fetched for the rollup). Lock state
   * is read from the directory, so a sitting locked or re-opened a moment ago is already
   * reflected.
   */
  async ensureYearLoaded(yearId: string): Promise<void> {
    const lockedNow = new Set(this.dir.listCycles().filter((c) => c.locked).map((c) => c.id));
    await Promise.all(
      this.cycleIdsOfYear(yearId)
        .filter((id) => lockedNow.has(id))
        .map((id) => this.ensureCycleLoaded(id)),
    );
  }

  // ── writes (optimistic local + SECURITY DEFINER RPC) ────────────────────
  setItemExcluded(cycleId: string, assessmentId: string, itemId: string, excluded: boolean, reason?: string | null): void {
    if (!this.write(cycleId, (p) => p.setItemExcluded(cycleId, assessmentId, itemId, excluded, reason))) return;
    this.rpc("decide_item_exclusion", { p_item: itemId, p_exclude: excluded, p_reason: reason ?? null });
  }

  setCleanRemoval(
    cycleId: string,
    assessmentId: string,
    target: { rows?: string[]; cols?: string[] },
    removed: boolean,
  ): void {
    if (!this.write(cycleId, (p) => p.setCleanRemoval(cycleId, assessmentId, target, removed))) return;
    const rows = target.rows ?? [];
    const cols = target.cols ?? [];
    const uuidToQm = this.slots.get(cycleId)!.lookups.uuidToQm;
    // Rows carry the participant's STABLE natural key (qm_participant_id) so the
    // removal re-resolves after a re-import (0016); cols have none.
    if (rows.length) this.rpc("set_clean_removal", { p_cycle: cycleId, p_assessment: assessmentId, p_kind: "row", p_targets: rows, p_keys: rows.map((id) => uuidToQm.get(id) ?? id), p_remove: removed });
    if (cols.length) this.rpc("set_clean_removal", { p_cycle: cycleId, p_assessment: assessmentId, p_kind: "col", p_targets: cols, p_keys: [], p_remove: removed });
  }

  clearCleanRemovals(cycleId: string, assessmentId: string): void {
    if (!this.write(cycleId, (p) => p.clearCleanRemovals(cycleId, assessmentId))) return;
    this.rpc("clear_clean_removals", { p_cycle: cycleId, p_assessment: assessmentId });
  }

  excludeParticipantFromCohort(
    cycleId: string,
    participantId: string,
    excluded: boolean,
    reason?: string | null,
  ): void {
    if (!this.write(cycleId, (p) => p.excludeParticipantFromCohort(cycleId, participantId, excluded, reason))) return;
    // Persist durably in the dedicated `cohort_exclusions` store (migration 0033),
    // keyed on P-A's stable natural key (qm_participant_id) so the exclusion
    // re-resolves after a re-import instead of dangling on the volatile row UUID.
    // This is a SEPARATE scope from the per-subject clean_exclusions, so "remove from
    // all subjects" and "remove from one subject" never conflate on reload.
    const stableKey = this.slots.get(cycleId)!.lookups.uuidToQm.get(participantId) ?? participantId;
    this.rpc("set_cohort_exclusion", {
      p_cycle: cycleId,
      p_key: stableKey,
      p_reason: reason ?? null,
      p_remove: excluded,
    });
  }

  setBoundary(cycleId: string, scope: string, input: SetBoundaryInput): void {
    const p = this.cycleProvider(cycleId);
    if (!p) return;
    this.write(cycleId, (c) => c.setBoundary(cycleId, scope, input));
    const m = p.getBoundaries(cycleId, scope);
    if (!m) return;
    const bands = m.levels.map((label, i) => ({
      label,
      min: i < m.cuts.length ? (m.cuts[i] ?? 0) : 0,
      max: i === 0 ? 100 : (m.cuts[i - 1] ?? 100),
    }));
    this.rpc("save_grade_scheme", {
      p_cycle: cycleId,
      p_scope: scope,
      p_method: m.mode === "pct" ? "fixed_pct" : "judgemental",
      p_bands: bands,
    });
  }

  // Workspace configuration: mutates the SHARED workspace through the directory, so every
  // loaded sitting sees it on its next read; sittings whose boundary state no longer fits
  // the new band count re-derive.
  setGradingDefaults(patch: Partial<GradingConfig>): void {
    this.dir.setGradingDefaults(patch);
    this.reconcileAllBoundaries();
    this.publishDirectory();
    this.bump();
    this.rpc("set_workspace_setting", { p_key: "grading_defaults", p_value: patch });
  }
  setQualityThresholds(patch: Partial<QualityThresholds>): void {
    this.dir.setQualityThresholds(patch);
    this.bump();
    this.rpc("set_workspace_setting", { p_key: "quality_thresholds", p_value: patch });
  }
  setDocumentSettings(cycleId: string, patch: Partial<DocSettings>): void {
    if (!this.write(cycleId, (p) => p.setDocumentSettings(cycleId, patch))) return;
    this.rpc("set_document_settings", { p_cycle: cycleId, p_settings: patch });
  }
  resolveDuplicates(cycleId: string, strategy: DuplicateStrategy): void {
    // Ingest-time action with no protected column; local only.
    this.write(cycleId, (p) => p.resolveDuplicates(cycleId, strategy));
  }

  // raw-export ingest — the browser parses + cleans + validates the file (reusing
  // lib/ingest) and hands the cleaned responses here. Persist + recompute must run
  // server-side (the engine never runs in the browser; these tables aren't
  // client-writable), so we POST to the ingest route and then re-read THAT sitting from
  // the database, which makes every downstream screen read the freshly-stored data.
  async ingestRawExport(
    cycleId: string,
    file: { name: string; sizeMB: number },
    clean: CleanResponse[],
    report: ValidationReport,
    extra?: { canonical?: CanonicalModel; files?: { items?: string; assessments?: string; topics?: string } },
  ): Promise<void> {
    // Gzip the JSON body so the request stays well under Vercel's hard 4.5 MB
    // request-body ceiling regardless of cohort size. The body compresses ~10×,
    // so this removes payload size as a class of failure (was: 413 on large
    // sittings). Mark it with a custom header — never `Content-Encoding`, which
    // a proxy may auto-decompress and desync — so the server decompresses it
    // itself; an older client that skips the marker is still read raw server-side.
    const payload = JSON.stringify({
      clean,
      report,
      fileName: file.name,
      fileSizeMB: file.sizeMB,
      canonical: extra?.canonical,
      files: extra?.files,
    });
    const res = await fetch(`/api/cycles/${cycleId}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", [GZIP_MARKER_HEADER]: GZIP_MARKER_VALUE },
      body: await gzipText(payload),
    });
    if (!res.ok) {
      let message = `Ingest failed (${res.status}).`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(message);
    }
    await this.refreshCycle(cycleId);
  }

  // Destructive sitting controls (0007). Both go through SECURITY DEFINER RPCs
  // that authorize lead/admin and audit with the resolved session user
  // (auth.uid() — the session client is present here, unlike the ingest path).
  // We await and refresh ONLY the affected sitting (and the list) so the UI reflects
  // the new state immediately without disturbing any other sitting.
  //
  // 0020/0022: the RPCs RETURN the deleted-row count. We CHECK it — a null
  // (function absent / stale schema) or a 0 (nothing removed) surfaces an explicit
  // error instead of a silent "success" while rows survive across tables. (0022
  // also hardens schema_health so a stale void delete can't pass the drift probe.)
  async clearSittingData(cycleId: string): Promise<void> {
    const { data, error } = await this.rpcData<number>("clear_sitting_data", { p_cycle: cycleId });
    if (error) throw new Error(this.driftHint(error.message));
    this.assertDeleted(data, "clear");
    await this.refreshCycle(cycleId);
  }
  async deleteSitting(cycleId: string): Promise<void> {
    const { data, error } = await this.rpcData<number>("delete_sitting", { p_cycle: cycleId });
    if (error) throw new Error(this.driftHint(error.message));
    this.assertDeleted(data, "delete");
    await this.afterCycleRemoved(cycleId);
  }
  // 0032 (last-cycle guard dropped in 0035) — full-cascade cycle delete with no
  // last-cycle restriction. Same count-check contract as deleteSitting; an admin may
  // delete every cycle, leaving an empty workspace.
  async deleteCycle(cycleId: string): Promise<void> {
    const { data, error } = await this.rpcData<number>("delete_cycle", { p_cycle: cycleId });
    if (error) throw new Error(this.driftHint(error.message));
    this.assertDeleted(data, "delete");
    await this.afterCycleRemoved(cycleId);
  }

  /** The sitting is gone from the database: drop its slot, re-read the light list. */
  private async afterCycleRemoved(cycleId: string): Promise<void> {
    this.slots.delete(cycleId);
    await this.refreshCycleList();
  }

  /** Turn a raw DB error into an actionable message when it's a known class
   *  (schema drift, or an authorization denial), else pass it through unchanged. */
  private driftHint(message: string): string {
    const e = message.toLowerCase();
    // Authorization denial: delete_sitting / clear_sitting_data raise 'not authorized'
    // when app.has_role can't match the caller — most often a workspace-scope
    // (cycle_id = NULL) admin membership that a drifted, strict app.has_role no
    // longer honours. Name the fix instead of surfacing a bare permission word.
    const authDenied =
      e.includes("not authorized") ||
      e.includes("permission denied") ||
      e.includes("row-level security") ||
      e.includes("row level security");
    if (authDenied) {
      return (
        "Not authorized to modify this sitting — your admin (lead_admin) membership isn’t being " +
        "recognised. If you hold a workspace-wide (cycle_id = NULL) admin membership, run migration " +
        `0024 in the Supabase SQL editor so workspace admins are permitted again, then retry. (${message})`
      );
    }
    const drift =
      /function .* does not exist/.test(e) ||
      /could not find the function/.test(e) ||
      e.includes("schema cache") ||
      e.includes("pgrst202");
    return drift
      ? `Database schema is out of date — run migration 0024 in Supabase, then retry. (${message})`
      : message;
  }

  /** A count of 0 or a null/absent return means the operation did nothing —
   *  never let that read as success. */
  private assertDeleted(count: number | null | undefined, kind: "clear" | "delete"): void {
    if (count == null) {
      throw new Error(
        `Couldn’t ${kind} this sitting — the database returned no row count. ` +
          "The delete function may be missing or stale (run migration 0022 in Supabase).",
      );
    }
    if (count === 0) {
      throw new Error(
        kind === "delete"
          ? "Nothing was deleted — no rows found for this sitting."
          : "Nothing was cleared — this sitting has no ingested data.",
      );
    }
  }

  /** Probe the live schema for drift (columns/functions the code requires). */
  async getSchemaHealth(): Promise<SchemaHealth> {
    const { data, error } = await this.rpcData<{
      ok?: boolean;
      migration?: string;
      missing_columns?: string[];
      missing_functions?: string[];
    }>("schema_health", {});
    // An absent probe (older DB) — report drift so the operator installs 0024.
    if (error || !data) {
      return { ok: false, migration: "0024", missingColumns: [], missingFunctions: ["public.schema_health"] };
    }
    return {
      ok: data.ok ?? true,
      migration: data.migration ?? "0024",
      missingColumns: data.missing_columns ?? [],
      missingFunctions: data.missing_functions ?? [],
    };
  }

  lockCycle(cycleId: string): void {
    const p = this.cycleProvider(cycleId);
    // Not loaded, or already locked: nothing to do, and nothing to send.
    if (!p || p.isCycleLocked(cycleId)) return;
    p.lockCycle(cycleId);
    // The in-memory gate (general.signoff) refused: do NOT fire the RPC — otherwise the
    // database would lock a sitting the screen still shows as open.
    if (!p.isCycleLocked(cycleId)) return;
    this.afterCycleChange();
    void this.rpcOrReconcile(cycleId, "lock_grades", { p_cycle: cycleId });
  }
  unlockCycle(cycleId: string): void {
    const p = this.cycleProvider(cycleId);
    if (!p || !p.isCycleLocked(cycleId)) return;
    p.unlockCycle(cycleId);
    if (p.isCycleLocked(cycleId)) return; // refused locally — send nothing
    this.afterCycleChange();
    void this.rpcOrReconcile(cycleId, "unlock_grades", { p_cycle: cycleId, p_reason: "Re-opened for editing" });
  }

  // members — the REAL memberships table (via SECURITY DEFINER RPCs, admin-gated
  // by the C1 authorization primitive). No mock state, no workspace blob.
  //
  // The UI passes a dynamic role_id as roleId (migration 0040); we persist it via
  // memberships.role_id. The member id encodes (user_id, cycle_id) so the write
  // targets the exact membership scope.
  inviteMember(email: string, roleId: string): void {
    void this.mutateMembers("invite_member", { p_email: email.trim(), p_role_id: roleId, p_cycle: null });
  }
  setMemberRole(memberId: string, roleId: string): void {
    const { userId, cycleId } = parseMemberKey(memberId);
    void this.mutateMembers("set_member_role", { p_user: userId, p_cycle: cycleId, p_role_id: roleId });
  }
  removeMember(memberId: string): void {
    const { userId, cycleId } = parseMemberKey(memberId);
    void this.mutateMembers("remove_member", { p_user: userId, p_cycle: cycleId });
  }
  resendInvite(_memberId: string): void {
    // Real accounts are already active; re-sending an auth invite is a Supabase
    // auth (admin API) action, not a membership mutation. No-op here.
  }

  /** Run a member-directory write RPC, surface any error, then refresh the roster. */
  private async mutateMembers(name: string, args: unknown): Promise<void> {
    const { error } = await this.rpcData<unknown>(name, args);
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`${name} failed:`, error.message);
      return;
    }
    await this.fetchMembers();
    this.bump();
  }
  // dynamic roles × granular actions (migration 0040). Reads delegate to the shared
  // workspace; writes mutate it (which applies the admin gate + the lockout guards), bump,
  // and persist via the definer RPCs (the DB re-checks + re-guards server-side), then
  // re-read the workspace to pick up DB-generated ids.
  getActionCatalogue(): ActionDef[] { return this.dir.getActionCatalogue(); }
  getRoles(): Role[] { return this.dir.getRoles(); }
  getRoleActions(): Record<string, ActionKey[]> { return this.dir.getRoleActions(); }
  createRole(name: string): void {
    this.dir.createRole(name);
    this.bump();
    void this.rpcThenRefreshWorkspace("create_role", { p_name: name });
  }
  renameRole(id: string, name: string): void {
    this.dir.renameRole(id, name);
    this.bump();
    void this.rpcThenRefreshWorkspace("rename_role", { p_id: id, p_name: name });
  }
  deleteRole(id: string): void {
    this.dir.deleteRole(id);
    this.bump();
    void this.rpcThenRefreshWorkspace("delete_role", { p_id: id });
  }
  setRoleAction(roleId: string, action: ActionKey, granted: boolean): void {
    this.dir.setRoleAction(roleId, action, granted);
    this.bump();
    this.rpc("set_role_action", { p_role_id: roleId, p_action: action, p_granted: granted });
  }

  // technical errors / student-review — legacy surface, no DB backing; local only.
  uploadTechnicalErrors(cycleId: string, fileName: string, rows: TechnicalErrorRow[]): void {
    this.write(cycleId, (p) => p.uploadTechnicalErrors(cycleId, fileName, rows));
  }
  clearTechnicalErrors(cycleId: string): void {
    this.write(cycleId, (p) => p.clearTechnicalErrors(cycleId));
  }
  setIncidentDecision(cycleId: string, incidentId: string, decision: IncidentDecision, reason?: string | null): void {
    this.write(cycleId, (p) => p.setIncidentDecision(cycleId, incidentId, decision, reason));
  }

  // essay marks (English/Arabic) — translate file qm-ids → uuids for both the
  // optimistic local apply and the RPC.
  uploadEssayMarks(cycleId: string, fileName: string, rows: EssayUploadRow[]): void {
    const slot = this.slots.get(cycleId);
    if (!slot?.provider) return;
    const translated = rows.map((r) => ({ ...r, participantId: slot.lookups.qmToUuid.get(r.participantId) ?? r.participantId }));
    this.write(cycleId, (p) => p.uploadEssayMarks(cycleId, fileName, translated));
    // Send the FULL merged set (all languages) so the full-cycle-replace RPC keeps
    // separately-uploaded languages intact. The sitting's provider merges per subject.
    void this.rpcThenRefreshCycle(cycleId, "upsert_essay_marks", {
      p_cycle: cycleId,
      p_file_ref: fileName,
      p_marks: slot.provider.essayMarksForPersistence(cycleId),
    });
  }
  clearEssayMarks(cycleId: string): void {
    if (!this.write(cycleId, (p) => p.clearEssayMarks(cycleId))) return;
    this.rpc("clear_essay_marks", { p_cycle: cycleId });
  }

  // technical incident upload (0044) — stage the matched export by `reference`.
  // Optimistic local apply, then the upsert RPC + a refresh of THIS sitting (mirrors essay
  // marks). STAGING ONLY: the adjustment_* fields are never sent (§3 gate).
  upsertExamIncidents(cycleId: string, batchId: string, fileName: string, records: readonly ExamIncidentRecord[]): void {
    if (!this.write(cycleId, (p) => p.upsertExamIncidents(cycleId, batchId, fileName, records))) return;
    void this.rpcThenRefreshCycle(cycleId, "upsert_exam_incidents", {
      p_cycle: cycleId,
      p_batch: batchId,
      p_file_name: fileName,
      p_rows: records.map((r) => ({
        reference: r.reference,
        exam_cycle: r.examCycle,
        subject_raw: r.subjectRaw,
        subject_key: r.subjectKey,
        exam_date: r.examDate,
        partner_center: r.partnerCenter,
        category: r.category,
        issue: r.issue,
        code: r.code,
        student_name: r.studentName,
        student_email: r.studentEmail,
        student_id_external: r.studentIdExternal,
        time_started: r.timeStarted,
        time_resolved: r.timeResolved,
        duration_min: r.durationMin,
        action_taken: r.actionTaken,
        questions_affected_count: r.questionsAffectedCount,
        questions_affected_list: r.questionsAffectedList,
        status: r.status,
        invigilator: r.invigilator,
        source_created_at: r.sourceCreatedAt,
        matched_qm_result_id: r.matchedQmResultId,
        match_status: r.matchStatus,
        flags: r.flags,
      })),
    });
  }
  clearExamIncidents(cycleId: string): void {
    if (!this.write(cycleId, (p) => p.clearExamIncidents(cycleId))) return;
    this.rpc("clear_exam_incidents", { p_cycle: cycleId });
  }

  // incident log → alterations triage
  uploadIncidentLog(cycleId: string, fileName: string, rows: IncidentInput[]): void {
    if (!this.write(cycleId, (p) => p.uploadIncidentLog(cycleId, fileName, rows))) return;
    const p_rows = rows.map((r) => ({
      source: r.source,
      student_name: r.studentName,
      exam: r.exam ?? null,
      issue_type: r.issueType ?? null,
      action_taken: r.actionTaken ?? null,
      questions_affected: r.questionsAffected ?? null,
      staff: r.staff ?? null,
      email: r.email ?? null,
      school: r.school ?? null,
      description: r.description ?? null,
    }));
    void this.rpcThenRefreshCycle(cycleId, "insert_incidents", { p_cycle: cycleId, p_rows });
  }
  clearIncidentLog(cycleId: string): void {
    if (!this.write(cycleId, (p) => p.clearIncidentLog(cycleId))) return;
    void this.rpcThenRefreshCycle(cycleId, "clear_incidents", { p_cycle: cycleId });
  }

  // CGJ (Centre Grade Judgement) — comparison-only, no scoring impact. Held in
  // the sitting's provider for now (local to the session); a persistence RPC can be
  // added later without touching the UI.
  uploadCgjFile(cycleId: string, fileName: string, rows: CgjUploadRow[]): void {
    this.write(cycleId, (p) => p.uploadCgjFile(cycleId, fileName, rows));
  }
  clearCgj(cycleId: string): void {
    this.write(cycleId, (p) => p.clearCgj(cycleId));
  }
  decideIncident(cycleId: string, incidentId: string, decision: IncidentDecisionInput): void {
    if (!this.write(cycleId, (p) => p.decideIncident(cycleId, incidentId, decision))) return;
    const dbId = this.slots.get(cycleId)!.lookups.incIdMap.get(incidentId);
    if (!dbId) return; // freshly-uploaded incident not yet mapped (the refresh fixes this)
    this.rpc("decide_incident", {
      p_cycle: cycleId,
      p_incident: dbId,
      p_apply_to: decision.applyTo,
      p_participant: decision.studentId ?? null,
      p_assessment: decision.subjectId ?? null,
      p_marks: decision.marks ?? 0,
      p_reason: decision.reason ?? null,
    });
  }

  // distinction safeguard (overall scope)
  confirmDistinctionCaps(cycleId: string): void {
    if (!this.write(cycleId, (p) => p.confirmDistinctionCaps(cycleId))) return;
    this.rpc("confirm_distinction_caps", { p_cycle: cycleId });
  }
  overrideDistinctionCap(cycleId: string, studentId: string, reason: string): void {
    if (!this.write(cycleId, (p) => p.overrideDistinctionCap(cycleId, studentId, reason))) return;
    this.rpc("override_distinction_cap", { p_cycle: cycleId, p_participant: studentId, p_scope: "overall", p_reason: reason });
  }
  undoDistinctionOverride(cycleId: string, studentId: string): void {
    if (!this.write(cycleId, (p) => p.undoDistinctionOverride(cycleId, studentId))) return;
    this.rpc("undo_distinction_override", { p_cycle: cycleId, p_participant: studentId, p_scope: "overall" });
  }

  // manual mark adjustment (rides the existing alterations table server-side; the
  // RPC resolves the actor via auth.uid() and writes the audit entry)
  adjustStudentMark(cycleId: string, participantId: string, assessmentId: string, newMark: number, reason: string): void {
    if (!this.write(cycleId, (p) => p.adjustStudentMark(cycleId, participantId, assessmentId, newMark, reason))) return;
    this.rpc("adjust_participant_mark", {
      p_cycle: cycleId,
      p_participant: participantId,
      p_assessment: assessmentId,
      p_new_mark: newMark,
      p_reason: reason,
    });
  }
  removeStudentMarkAdjustment(cycleId: string, adjustmentId: string): void {
    const sitting = this.cycleProvider(cycleId);
    if (!sitting) return;
    // Capture the cell before the optimistic remove so the RPC can key the DB
    // alteration row by (cycle, participant, assessment).
    const rec = sitting.findManualAdjustment(cycleId, adjustmentId);
    this.write(cycleId, (p) => p.removeStudentMarkAdjustment(cycleId, adjustmentId));
    if (rec) {
      this.rpc("remove_mark_adjustment", {
        p_cycle: cycleId,
        p_participant: rec.participantId,
        p_assessment: rec.assessmentId,
      });
    }
  }

  // overrides — optimistic local apply (the sitting's provider holds the real session
  // user, so authorization is mirrored locally) + the admin-only SECURITY DEFINER
  // override RPC, which re-checks lead_admin server-side and writes the override
  // audit row. The override re-applies the SAME effective state the original
  // action used, so the grade recomputes through the full engine (incl. D3).
  overrideItemExclusion(cycleId: string, assessmentId: string, itemId: string, exclude: boolean, reason: string): void {
    if (!this.write(cycleId, (p) => p.overrideItemExclusion(cycleId, assessmentId, itemId, exclude, reason))) return;
    void this.rpcFn("override_item_exclusion", { p_item: itemId, p_exclude: exclude, p_reason: reason }).then(({ error }) => {
      // eslint-disable-next-line no-console
      if (error) console.error("RPC override_item_exclusion failed:", error.message);
    });
  }
  overrideMarkAdjustment(cycleId: string, participantId: string, assessmentId: string, newMark: number | null, reason: string): void {
    if (!this.write(cycleId, (p) => p.overrideMarkAdjustment(cycleId, participantId, assessmentId, newMark, reason))) return;
    void this.rpcFn("override_mark_adjustment", {
      p_cycle: cycleId,
      p_participant: participantId,
      p_assessment: assessmentId,
      p_new_mark: newMark,
      p_reason: reason,
    }).then(({ error }) => {
      // eslint-disable-next-line no-console
      if (error) console.error("RPC override_mark_adjustment failed:", error.message);
    });
  }

  // test centres (migration 0010) — optimistic local update, then persist via the
  // SECURITY DEFINER RPC and re-read the workspace so the server-generated row (real id +
  // slug) replaces the optimistic one.
  createTestCentre(input: { name: string; code: string }): void {
    this.dir.createTestCentre(input);
    this.bump();
    void this.rpcThenRefreshWorkspace("create_test_centre", { p_name: input.name, p_code: input.code });
  }
  updateTestCentre(id: string, patch: { name?: string; code?: string; active?: boolean }): void {
    this.dir.updateTestCentre(id, patch);
    this.bump();
    void this.rpcThenRefreshWorkspace("update_test_centre", {
      p_id: id,
      p_name: patch.name ?? null,
      p_code: patch.code ?? null,
      p_active: patch.active ?? null,
    });
  }
  setTestCentreActive(id: string, active: boolean): void {
    this.dir.setTestCentreActive(id, active);
    this.bump();
    void this.rpcThenRefreshWorkspace("set_test_centre_active", { p_id: id, p_active: active });
  }
  // 0013 — reassign a year onto another centre. Server-authoritative (the RPC owns
  // the admin check AND the (name, region, centre) uniqueness), so we call it
  // FIRST and rethrow its friendly message on failure rather than optimistically
  // relabelling — a conflict/permission error must surface, not be guessed locally.
  // The move is pure labelling: no scoring/grade data is read or recomputed, so no
  // sitting is reloaded — only the workspace + list are re-read.
  async moveExamYearToCentre(yearId: string, testCentreId: string): Promise<void> {
    const year = this.dir.listYears().find((y) => y.id === yearId);
    const realYearId = year?.examYearId;
    if (!realYearId) {
      throw new Error("This year can't be reassigned — it has no database record yet.");
    }
    const { error } = await this.rpcFn("move_exam_year_to_centre", {
      p_year_id: realYearId,
      p_test_centre_id: testCentreId,
    });
    if (error) throw new Error(error.message);
    await this.refreshWorkspace();
  }
  // Which periods a year must have a LOCKED sitting in before its Overall is final
  // (0051). Server-authoritative like the centre move: the RPC owns the gate and the
  // validation, so call it first and surface its message, then re-read the workspace.
  async setYearExpectedPeriods(yearId: string, periods: SittingKey[]): Promise<void> {
    const year = this.dir.listYears().find((y) => y.id === yearId || y.examYearId === yearId);
    const realYearId = year?.examYearId;
    if (!realYearId) throw new Error("This year can't be configured — it has no database record yet.");
    if (periods.length === 0) throw new Error("A year must expect at least one period.");
    const { error } = await this.rpcFn("set_year_expected_periods", {
      p_year_id: realYearId,
      p_periods: sortPeriods([...new Set(periods)]),
    });
    if (error) throw new Error(error.message);
    await this.refreshCycleList();
  }
  setSafeguardConfig(patch: { topDifficultyDemand?: string }): void {
    this.dir.setSafeguardConfig(patch);
    this.bump();
    this.rpc("set_workspace_setting", { p_key: "safeguard", p_value: patch });
  }
  setBorderlineConfig(patch: Partial<BorderlineConfig>): void {
    // Optimistic local update (clamped in the provider), then persist via the
    // SECURITY DEFINER RPC, which re-validates the band server-side before writing.
    this.dir.setBorderlineConfig(patch);
    this.bump();
    this.rpc("set_workspace_setting", { p_key: "borderline", p_value: patch });
  }
  setElementLabels(config: ElementLabelsConfig): void {
    // Optimistic local update (validated in the provider), then persist via
    // the SECURITY DEFINER RPC, which re-validates server-side before replacing.
    this.dir.setElementLabels(config);
    this.bump();
    const payload = Object.entries(config).flatMap(([subject, entries]) =>
      entries.map((e) => ({ subject, matchKey: e.matchKey, letter: e.letter, label: e.label })),
    );
    this.rpc("set_element_labels", { p_config: payload });
  }

  // Incident Adjustments configuration (admin-only writes; the RPCs re-check the
  // workspace-admin role and re-validate add-only server-side). Optimistic local
  // update via the shared workspace, then persist.
  upsertIncidentCode(input: IncidentCodeInput): void {
    this.dir.upsertIncidentCode(input);
    this.bump();
    this.rpc("upsert_incident_code", {
      p_id: input.id ?? null,
      p_code: input.code,
      p_label: input.label,
      p_match_types: input.matchTypes,
      p_formula: input.formula,
      p_per_code_cap: input.perCodeCap,
      p_active: input.active ?? true,
    });
  }
  deleteIncidentCode(id: string): void {
    this.dir.deleteIncidentCode(id);
    this.bump();
    this.rpc("delete_incident_code", { p_id: id });
  }
  setIncidentPerStudentCap(cap: number | null): void {
    this.dir.setIncidentPerStudentCap(cap);
    this.bump();
    this.rpc("set_incident_settings", { p_per_student_cap: cap });
  }
  setIncidentMapping(mapping: IncidentColumnMapping): void {
    this.dir.setIncidentMapping(mapping);
    this.bump();
    this.rpc("set_incident_mapping", { p_mapping: mapping });
  }

  // Incident Adjustments — apply engine + per-student review surface (02b). Reads
  // are served from the sitting's provider (hydrated from incident_rows /
  // incident_applications); writes persist through the SECURITY DEFINER RPCs
  // (0016 import_incident_rows; 0017 apply/unapply, admin-only re-checked server-side).
  getIncidentReview(cycleId: string): IncidentReviewModel | null { return this.read(cycleId, (p) => p.getIncidentReview(cycleId), null); }
  getIncidentRoster(cycleId: string): RosterParticipant[] { return this.read(cycleId, (p) => p.getIncidentRoster(cycleId), []); }
  importIncidentRows(
    cycleId: string,
    rows: readonly ResolvedIncidentRow[],
    source?: { fileName: string; sample: boolean },
  ): void {
    if (!this.write(cycleId, (p) => p.importIncidentRows(cycleId, rows, source))) return;
    this.rpc("import_incident_rows", {
      p_cycle: cycleId,
      p_rows: rows.map((r) => ({
        participant_key: r.participantInternalId ?? r.rawStudentId,
        raw_student_id: r.rawStudentId,
        student_name: r.studentName,
        incident_type: r.incidentType,
        question_number: r.questionNumber,
        duration_minutes: r.durationMinutes,
        code_id: r.codeId,
        status: r.status,
        errors: r.errors,
      })),
    });
    // Persist the import source (real file vs sample) so the review surface can
    // show it after a reload. The labelled sample is demo-only — not persisted.
    if (source && !source.sample) {
      this.rpc("set_incident_import_source", { p_cycle: cycleId, p_file_name: source.fileName, p_is_sample: false });
    }
  }
  clearIncidentRows(cycleId: string): void {
    if (!this.write(cycleId, (p) => p.clearIncidentRows(cycleId))) return;
    this.rpc("clear_incident_import_source", { p_cycle: cycleId });
    void this.rpcThenRefreshCycle(cycleId, "clear_incident_rows", { p_cycle: cycleId });
  }
  applyIncidentAdjustments(cycleId: string): void {
    if (!this.write(cycleId, (p) => p.applyIncidentAdjustments(cycleId))) return;
    this.rpc("apply_incident_adjustments", { p_cycle: cycleId });
  }
  unapplyIncidentAdjustments(cycleId: string): void {
    if (!this.write(cycleId, (p) => p.unapplyIncidentAdjustments(cycleId))) return;
    this.rpc("unapply_incident_adjustments", { p_cycle: cycleId });
  }

  // audit-writing actions
  recordExport(cycleId: string, detail: string): void {
    if (!this.write(cycleId, (p) => p.recordExport(cycleId, detail))) return;
    this.rpc("record_export", { p_cycle: cycleId, p_kind: detail });
  }
  recordDocuments(cycleId: string, detail: string): void {
    if (!this.write(cycleId, (p) => p.recordDocuments(cycleId, detail))) return;
    this.rpc("record_documents", { p_cycle: cycleId, p_detail: detail });
  }

  // new cycle — persists the cycle AND its chosen assessments in one audited
  // SECURITY DEFINER call, then re-reads the LIGHT cycle list and returns its REAL id so
  // the caller can navigate straight to it. Creating a sitting changes nothing the user
  // is looking at: no other sitting is reloaded, and the new one is not loaded until opened.
  //
  // The PERIOD (february | may) and the YEAR are explicit inputs, sent as
  // `p_sitting` / `p_year_id` — never inferred from the sitting's name. An existing
  // year is attached by id; a new year is find-or-created first through
  // `create_exam_year` (centre-aware, idempotent) so its id can be passed too.
  async createCycle(input: CreateCycleInput): Promise<string> {
    const examYearId = await this.resolveExamYearId(input);

    // One sitting per (year, period): refuse a second one in the same year up front with
    // a readable message (the DB constraint is migration 0050_year_sitting_unique.sql).
    const conflict = findPeriodConflict(this.dir.listYears(), examYearId, input.sitting);
    if (conflict) {
      throw new Error(
        `A ${sittingLabel(input.sitting)} sitting already exists for ${conflict.yearName} at ${conflict.centreName}` +
          (conflict.cycleName ? ` (“${conflict.cycleName}”)` : "") + ".",
      );
    }

    const { data, error } = await this.rpcData<string>(
      "create_cycle_with_assessments",
      buildCreateCycleArgs(
        input,
        examYearId,
        catalogNamesFor(input.assessmentIds),
      ),
    );
    if (error || !data) {
      // eslint-disable-next-line no-console
      console.error("create_cycle_with_assessments failed:", error?.message ?? "no id returned");
      throw new Error(friendlyCreateCycleError(error?.message, input));
    }
    await this.refreshCycleList();
    return data;
  }

  /** The exam_years.id a new sitting attaches to: the chosen existing year, or the
   *  year find-or-created for the typed 4-digit name under the chosen centre. */
  private async resolveExamYearId(input: CreateCycleInput): Promise<string> {
    if (input.examYearId) {
      // The year decides the centre; refuse a mismatch rather than silently moving it.
      const known = this.dir.listYears().find((y) => y.examYearId === input.examYearId);
      if (known && input.testCentreId && known.testCentreId !== input.testCentreId) {
        throw new Error(`Year ${known.name} belongs to ${known.testCentreName}, not the chosen centre.`);
      }
      return input.examYearId;
    }
    const yearName = normalizeYearName(input.yearName);
    if (!yearName) throw new Error("Choose an existing year or enter a 4-digit year (e.g. 2026).");
    const { data, error } = await this.rpcData<{ id: string }>("create_exam_year", {
      p_name: yearName,
      p_region: SITTING_REGION,
      p_test_centre_id: input.testCentreId || null,
    });
    if (error || !data?.id) {
      // eslint-disable-next-line no-console
      console.error("create_exam_year failed:", error?.message ?? "no year returned");
      throw new Error(error?.message ?? `Could not create the ${yearName} year.`);
    }
    return data.id;
  }
}
