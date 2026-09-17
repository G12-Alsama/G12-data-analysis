/**
 * Supabase → Seed hydration for the live provider.
 *
 * The DataProvider interface is synchronous and the InMemoryDataProvider already
 * computes every read-model from a `Seed` plus decision state. So the Supabase
 * provider hydrates a `Seed` from the database (using the real row UUIDs as the
 * Seed ids, so write RPCs can pass those ids straight through), then REPLAYS the
 * stored decisions through the in-memory provider's own mutators to reach a
 * faithful local state. Reads then delegate to that inner provider; writes go to
 * the SECURITY DEFINER RPCs (see supabase-provider.ts).
 *
 * Nothing here writes to the database — it is read + assemble only.
 *
 * Note on typing: the installed postgrest-js resolves `select("*")` rows to
 * `never` against a hand-written Database type, so we cast each result to the
 * hand-written Row interfaces in lib/types/database.ts (our source of truth).
 */
import type { SupabaseBrowserClient } from "@/lib/supabase/client";
import type {
  ExamCycleRow,
  ExamYearRow,
  TestCentreRow,
  AssessmentRow,
  ItemRow,
  ItemStatsRow,
  ParticipantRow,
  ResponseRow,
  SittingRow,
  ItemReviewRow,
  CleanExclusionRow,
  CohortExclusionRow,
  GradeSchemeRow,
  GradeRow,
  EssayMarkRow,
  ExamIncidentRow,
  IncidentRow,
  AlterationRow,
  DistinctionStateRow,
  DistinctionOverrideRow,
  ScoreRunRow,
  ParticipantScoreRow,
  DocumentSettingsRow,
  WorkspaceSettingRow,
  RoleRow,
  RoleActionRow,
  ElementLabelRow,
  ImportBatchRow,
  MemberRole,
} from "@/lib/types/database";
import type { CurrentUser, Role, TestCentreSummary } from "./types";
import type { ElementLabelsConfig } from "./element-labels";
import type {
  Seed,
  SeedAssessment,
  SeedItem,
  SeedResponse,
  SeedParticipant,
  SeedAssessmentDiagnostics,
  SeedPriorCycle,
  SeedSitting,
  SeedTechnicalIncident,
} from "./seed-types";
import { isTechnicalIncidentStatus } from "./result-status";
import {
  ENGINE_VERSION,
  deriveAward,
  DEFAULT_SCORING_CONFIG,
  performanceLabels,
  awardLabels,
  type QualityRating,
} from "@/lib/engine";
import { subjectKeyOf, type OACell, type OASitting, type OASittingStudent } from "./overall-analytics";
import { buildAssessmentDiagnostics, cleanDiagResponses, type DiagResponse } from "@/lib/diagnostics";
import type { EssayUploadRow, IncidentInput, IncidentDecisionInput } from "./provider";
import type { ExamIncidentRecord, ExamIncidentMatchStatus } from "@/lib/incidents/exam-incident-match";
import type { ValidationReport } from "@/lib/ingest/types";

type DB = SupabaseBrowserClient;

/** Run a select and cast the rows to our hand-written Row type. */
async function sel<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data } = await p;
  return (data ?? []) as T[];
}

/**
 * Page through a cycle-scoped select so a large table is NEVER silently truncated
 * by PostgREST's `max-rows` cap (Supabase default 1000).
 *
 * THE BUG THIS FIXES (the intermittent 15→6 score-matrix collapse). `responses`
 * carries one row per sitting × question — ~2 400 rows for a full cycle — while
 * every other table is under a thousand. A bare `.select("*").eq("cycle_id", …)`
 * with no `.order()`/`.range()` lets PostgREST return AT MOST `max-rows` and, with
 * no explicit ORDER BY, it serves them via the btree on the unique key
 * `(cycle_id, qm_result_id, question_id)` — i.e. ordered by `qm_result_id` AS TEXT.
 * The cap then keeps the first ~1000 rows = the LEXICALLY-FIRST sittings and drops
 * whole sittings past the cut, so Applicable Math collapses to the 6 string-first
 * ResultIds (`1032…,1086…,…` survive; `1572…,3536…,…` — larger *numbers* but later
 * *strings* — vanish). `sittings` (one row per sitting, ~60 rows) is under the cap,
 * so it stays correct — which is exactly why `sittings` and `responses` diverge.
 *
 * The fix: fetch EVERY row in explicit, stable key order, one bounded page at a
 * time, so no page ever hits the cap and nothing is dropped. The order is the
 * sitting-qualified natural key, so pagination is deterministic and complete.
 */
async function selAllByCycle<T>(
  supabase: DB,
  table: string,
  cycleId: string,
  orderCols: readonly string[],
): Promise<T[]> {
  const PAGE = 1000; // request window; the server may return fewer if max-rows is lower
  const out: T[] = [];
  // Advance by the number of rows ACTUALLY returned and stop only on an EMPTY page —
  // so this is correct whatever the server's max-rows cap is (a short page may just be
  // the cap, not the end). Ranges are contiguous and non-overlapping, so no row is
  // fetched twice or skipped.
  for (let from = 0; ; ) {
    let q = supabase.from(table).select("*").eq("cycle_id", cycleId);
    for (const col of orderCols) q = q.order(col, { ascending: true });
    const page = await sel<T>(q.range(from, from + PAGE - 1));
    if (page.length === 0) break;
    out.push(...page);
    from += page.length;
  }
  return out;
}
async function selOne<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T | null> {
  const { data } = await p;
  return (data ?? null) as T | null;
}

// ── assessment name → display + subject code ────────────────────────────────
interface NameInfo {
  shortName: string;
  rtl: boolean;
  order: number;
  subjectCode: "AFL" | "ESL" | "AM" | "ST" | null;
}
function classify(rawName: string): NameInfo {
  if (/[؀-ۿ]/.test(rawName) || /arabic/i.test(rawName))
    return { shortName: "Arabic 1st Lang", rtl: true, order: 3, subjectCode: "AFL" };
  if (/applicable math/i.test(rawName))
    return { shortName: "Applicable Math", rtl: false, order: 0, subjectCode: "AM" };
  if (/english/i.test(rawName))
    return { shortName: "English 2nd Lang", rtl: false, order: 1, subjectCode: "ESL" };
  if (/scientific/i.test(rawName))
    return { shortName: "Scientific", rtl: false, order: 2, subjectCode: "ST" };
  if (/life/i.test(rawName))
    return { shortName: "Life Skills", rtl: false, order: 4, subjectCode: null };
  return { shortName: rawName, rtl: false, order: 9, subjectCode: null };
}

const RATING_SCORE: Record<QualityRating, number> = { Good: 1, Review: 0.55, Flag: 0.12 };
function qualityIndex(s: { pRating: QualityRating; itRating: QualityRating; pbRating: QualityRating; discRating: QualityRating }): number {
  const avg = (RATING_SCORE[s.pRating] + RATING_SCORE[s.itRating] + RATING_SCORE[s.pbRating] + RATING_SCORE[s.discRating]) / 4;
  return Math.round(avg * 100);
}
function initialsOf(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "U";
}

// ── session → current user (invite-only via memberships) ────────────────────
export type SessionStatus = "ok" | "no-session" | "not-member";
export interface SessionUser {
  status: SessionStatus;
  user: CurrentUser | null;
}
export async function fetchSessionUser(supabase: DB): Promise<SessionUser> {
  const { data: auth } = await supabase.auth.getUser();
  const u = auth.user;
  if (!u) return { status: "no-session", user: null };

  const memberships = await sel<{ role: MemberRole | null; role_id: string | null; cycle_id: string | null }>(
    supabase.from("memberships").select("role, role_id, cycle_id").eq("user_id", u.id),
  );
  // "is_member" for the access gate = has ANY membership (unchanged; not the enum).
  if (memberships.length === 0) return { status: "not-member", user: null };

  // Resolve the carried role from role_id, not the enum (0040/0042): prefer the
  // workspace-wide membership (cycle_id is null — admin over every cycle), else the
  // first. `can()` (the whole-user path) resolves this role_id against the hydrated
  // grid; the server `can_do` stays authoritative, so this only fixes the client
  // picture. The legacy enum is carried best-effort (nullable post-0040) purely so
  // the `.role` fallback in bare-string `can()` call sites keeps working.
  const chosen = memberships.find((m) => m.cycle_id === null) ?? memberships[0]!;
  const roleId = chosen.role_id ?? null;
  const role: Role = chosen.role ?? "viewer";
  // The role's display name, resolved role_id → roles.name (0040). Drives the
  // account-menu label so it reflects the real (incl. custom) role, not the enum.
  let roleName: string | null = null;
  if (roleId) {
    const roleRow = await selOne<{ name: string }>(
      supabase.from("roles").select("name").eq("id", roleId).maybeSingle(),
    );
    roleName = roleRow?.name ?? null;
  }
  const name =
    ((u.user_metadata?.full_name as string | undefined) ||
      (u.email ? u.email.split("@")[0] : undefined)) ??
    "User";
  return { status: "ok", user: { id: u.id, name, initials: initialsOf(name), role, roleId, roleName } };
}

// ── decision state replayed into the inner provider ─────────────────────────
export interface DecisionState {
  exclusions: { assessmentId: string; itemId: string; reason: string | null }[];
  /** Clean-stage non-destructive removals, grouped per subject. */
  cleanRemovals: { assessmentId: string; rows: string[]; cols: string[] }[];
  /** Cohort-wide participant exclusions (0033) — staff/test/withdrawn, resolved from
   *  the stable key to the current participant UUID; replayed cohort-wide. */
  cohortExclusions: { participantId: string; reason: string }[];
  schemes: { scope: string; method: string; bands: { label: string; min: number; max: number }[] }[];
  locked: boolean;
  essays: EssayUploadRow[];
  incidents: IncidentInput[];
  /** Aligned to `incidents` order (inner ids become inc-1, inc-2, …). */
  incidentDecisions: (IncidentDecisionInput | null)[];
  distinctionConfirmed: boolean;
  distinctionOverrides: { studentId: string; reason: string }[];
  docSettings: Record<string, unknown> | null;
  workspace: Record<string, unknown>;
  /** Per-subject A–E element labels (0014); absent when the table is empty. */
  elementLabels?: ElementLabelsConfig;
  /** Dynamic roles + the role_id → action grid (0040). Empty on a pre-migration or
   *  fresh DB — the provider then keeps the seeded defaults in place. */
  roles: { id: string; name: string; is_system: boolean; sort: number | null }[];
  roleActions: { role_id: string; action: string }[];
  /** Staged technical-incident export records (0044). Loaded verbatim and replayed
   *  WITHOUT re-matching — the stored `match_status` is authoritative. Empty on a
   *  pre-migration DB (the `sel` reader swallows the missing-table error). */
  examIncidents: ExamIncidentRecord[];
}

/** Group element-label rows (already sort_order-ordered) into the config shape. */
function groupElementLabels(rows: ElementLabelRow[]): ElementLabelsConfig {
  const out: ElementLabelsConfig = {};
  for (const r of rows) {
    (out[r.subject] ??= []).push({ matchKey: r.match_key, letter: r.letter, label: r.label });
  }
  return out;
}
export interface Hydrated {
  seed: Seed;
  decisions: DecisionState;
  /** Id-resolution maps the provider needs to translate UI ids → DB ids for RPCs. */
  lookups: {
    /** qm_participant_id (A-A-…) → participant uuid (for essay-file uploads). */
    qmToUuid: Map<string, string>;
    /** essay subject code (AFL/ESL) → assessment uuid. */
    subjectCodeToAssessmentId: Map<string, string>;
    /** DB incident uuids in the same order they are replayed (→ inner inc-1, inc-2 …). */
    incidentDbIds: string[];
  };
}

// A brand-new cycle has no raw export yet: an empty-but-well-formed report so
// every reader (the Import screen reads `report.stats.mcqRows`) is safe before
// any upload. `stats` is required by ValidationReport — never leave it absent.
const EMPTY_VALIDATION: ValidationReport = {
  passed: true,
  checks: [],
  stats: { rawRows: 0, mcqRows: 0, droppedSurveyRows: 0, droppedNonMcqRows: 0, assessments: 0, participants: 0, items: 0 },
};
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * The real `test_centres`, mapped to the seed shape — the SINGLE source for the
 * centre dropdowns (each option value is the row's real UUID `id`, never a slug or
 * mock). Read independently of whether any cycle exists so the "Start a sitting"
 * picker surfaces real centres on a fresh database too (before this, a no-cycle DB
 * fell back to a hard-coded mock centre whose non-UUID id broke the create insert
 * with `invalid input syntax for type uuid`).
 */
export async function fetchSeedTestCentres(supabase: DB): Promise<TestCentreSummary[]> {
  const rows = await sel<TestCentreRow>(
    supabase.from("test_centres").select("*").order("created_at", { ascending: true }),
  );
  return rows.map((t) => ({ id: t.id, name: t.name, code: t.code, slug: t.slug, active: t.active }));
}

export async function hydrate(supabase: DB): Promise<Hydrated | null> {
  const cycles = await sel<ExamCycleRow>(
    supabase.from("exam_cycles").select("*").order("created_at", { ascending: false }),
  );
  if (cycles.length === 0) return null;
  const live = cycles[0]!;
  const cycleId = live.id;

  // 0010 — test centres + the year→centre map, so each sitting resolves to its
  // centre (exam_cycles.year_id → exam_years.test_centre_id). Defensive against a
  // pre-0010 database (no rows / column): the provider falls back to a default
  // centre when the list is empty.
  const [testCentreRows, yearRows] = await Promise.all([
    sel<TestCentreRow>(supabase.from("test_centres").select("*").order("created_at", { ascending: true })),
    sel<ExamYearRow>(supabase.from("exam_years").select("*")),
  ]);
  const yearToCentre = new Map<string, string>();
  for (const y of yearRows) if (y.test_centre_id) yearToCentre.set(y.id, y.test_centre_id);
  const centreOfCycle = (c: ExamCycleRow): string | undefined =>
    c.year_id ? yearToCentre.get(c.year_id) : undefined;
  const seedTestCentres = testCentreRows.map((t) => ({
    id: t.id,
    name: t.name,
    code: t.code,
    slug: t.slug,
    active: t.active,
  }));

  const [assessments, items, participants, responses, sittingRows] = await Promise.all([
    sel<AssessmentRow>(supabase.from("assessments").select("*").eq("cycle_id", cycleId)),
    sel<ItemRow>(supabase.from("items").select("*").eq("cycle_id", cycleId)),
    sel<ParticipantRow>(supabase.from("participants").select("*").eq("cycle_id", cycleId)),
    // `responses` is the ONLY per-(sitting × question) table and routinely exceeds
    // the PostgREST max-rows cap — page through it in stable key order so no sitting
    // is ever silently dropped by a truncated, text-ordered read (see selAllByCycle).
    selAllByCycle<ResponseRow>(supabase, "responses", cycleId, ["qm_result_id", "question_id"]),
    // The authoritative ingest roster (migration 0026). Every ingest-stage
    // participant count reads from this, not the MCQ `responses` matrix.
    sel<SittingRow>(supabase.from("sittings").select("*").eq("cycle_id", cycleId)),
  ]);

  // ── READ-TIME INTEGRITY GUARD: responses distinct sittings == sittings, per subject.
  // The persist transaction guarantees every sitting carries responses (migration
  // 0029/0030), so at read time the two MUST still agree per subject. If `responses`
  // shows FEWER distinct `qm_result_id` than `sittings` for a subject that has any
  // responses, the read dropped whole sittings (a truncated/mis-ordered fetch — the
  // 15→6 collapse). Fail LOUD here rather than render a silently-collapsed score
  // matrix. Subjects with zero MCQ responses (e.g. a held-out re-sit form) are skipped.
  {
    const sitBySubject = new Map<string, Set<string>>();
    for (const s of sittingRows) {
      if (!s.assessment_id || !s.qm_result_id) continue;
      (sitBySubject.get(s.assessment_id) ?? sitBySubject.set(s.assessment_id, new Set()).get(s.assessment_id)!).add(s.qm_result_id);
    }
    const respBySubject = new Map<string, Set<string>>();
    const assessmentOfItem = new Map(items.map((it) => [it.id, it.assessment_id] as const));
    for (const r of responses) {
      const aId = assessmentOfItem.get(r.item_id);
      if (!aId || !r.qm_result_id) continue;
      (respBySubject.get(aId) ?? respBySubject.set(aId, new Set()).get(aId)!).add(r.qm_result_id);
    }
    const nameOf = new Map(assessments.map((a) => [a.id, a.name] as const));
    for (const [aId, sits] of sitBySubject) {
      const resp = respBySubject.get(aId);
      if (!resp || resp.size === 0) continue; // no MCQ responses for this subject — nothing to reconcile
      if (resp.size < sits.size) {
        throw new Error(
          `hydrate: "${nameOf.get(aId) ?? aId}" read ${resp.size} distinct sitting(s) from responses but ` +
            `${sits.size} exist in the sittings roster — whole sittings were dropped on read (a truncated or ` +
            `text-ordered responses fetch). The score matrix would be collapsed; refusing to render it.`,
        );
      }
    }
  }

  const itemIds = items.map((i) => i.id);
  const idFilter = itemIds.length ? itemIds : [ZERO_UUID];
  const [stats, reviews] = await Promise.all([
    sel<ItemStatsRow>(supabase.from("item_stats").select("*").in("item_id", idFilter)),
    sel<ItemReviewRow>(supabase.from("item_reviews").select("*").in("item_id", idFilter)),
  ]);

  const [schemes, grades, essayRows, incidentRows, alterationRows, distOverrides, workspace] =
    await Promise.all([
      sel<GradeSchemeRow>(supabase.from("grade_schemes").select("*").eq("cycle_id", cycleId)),
      sel<GradeRow>(supabase.from("grades").select("*").eq("cycle_id", cycleId)),
      sel<EssayMarkRow>(supabase.from("essay_marks").select("*").eq("cycle_id", cycleId)),
      sel<IncidentRow>(supabase.from("incidents").select("*").eq("cycle_id", cycleId).order("created_at", { ascending: true })),
      sel<AlterationRow>(supabase.from("alterations").select("*").eq("cycle_id", cycleId)),
      sel<DistinctionOverrideRow>(supabase.from("distinction_overrides").select("*").eq("cycle_id", cycleId)),
      sel<WorkspaceSettingRow>(supabase.from("workspace_settings").select("*")),
    ]);
  // 0014 — per-subject A–E element labels (workspace-wide config table).
  const elementLabelRows = await sel<ElementLabelRow>(
    supabase.from("element_labels").select("*").order("sort_order", { ascending: true }),
  );
  // 0044 — staged technical-incident export records. `sel` tolerates a
  // pre-migration DB (missing table → []), so hydrate never crashes before the
  // migration is applied. Loaded verbatim; the stored match is authoritative.
  const examIncidentRows = await sel<ExamIncidentRow>(
    supabase.from("exam_incidents").select("*").eq("cycle_id", cycleId).order("imported_at", { ascending: true }),
  );
  // 0040 — dynamic roles + the role_id → action grid (workspace-wide). `sel`
  // tolerates a pre-migration DB (missing table → []), so hydrate never crashes
  // before the migration is run; empty results keep the seeded defaults in place.
  const roleRows = await sel<RoleRow>(supabase.from("roles").select("*"));
  const roleActionRows = await sel<RoleActionRow>(supabase.from("role_actions").select("*").eq("granted", true));
  const cleanExclusionRows = await sel<CleanExclusionRow>(
    supabase.from("clean_exclusions").select("*").eq("cycle_id", cycleId),
  );
  // Cohort-wide exclusions (migration 0033). `sel` tolerates a pre-migration DB
  // (missing table → []), so hydrate never crashes before the migration is run.
  const cohortExclusionRows = await sel<CohortExclusionRow>(
    supabase.from("cohort_exclusions").select("*").eq("cycle_id", cycleId),
  );
  const distState = await selOne<DistinctionStateRow>(
    supabase.from("distinction_state").select("*").eq("cycle_id", cycleId).maybeSingle(),
  );
  const docRow = await selOne<DocumentSettingsRow>(
    supabase.from("document_settings").select("*").eq("cycle_id", cycleId).maybeSingle(),
  );
  // Latest raw-export ingest batch — its stored validation report + file ref are
  // what the Upload screen shows after a refresh (proving persistence, and
  // surfacing any blocking issues from the original upload).
  const importBatch = await selOne<ImportBatchRow>(
    supabase
      .from("import_batches")
      .select("*")
      .eq("cycle_id", cycleId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );

  // Index helpers ----------------------------------------------------------
  const statByItem = new Map(stats.map((s) => [s.item_id, s]));
  const infoByAssessment = new Map(assessments.map((a) => [a.id, classify(a.name)] as const));
  const subjectCodeByAssessment = new Map(assessments.map((a) => [a.id, classify(a.name).subjectCode] as const));
  const itemAssessment = new Map(items.map((it) => [it.id, it.assessment_id]));

  const seedParticipants: SeedParticipant[] = participants
    .map((p, i) => ({
      id: p.id,
      // Real full name when present (RLS gates who can read it); fall back to the
      // pseudonym, then a positional placeholder, so the column is never blank.
      label: p.full_name || p.pseudonym_id || `Student ${String(i + 1).padStart(2, "0")}`,
      // Real Student ID (qm_participant_id) for display; the row UUID stays the key.
      studentId: p.qm_participant_id || p.pseudonym_id || p.id,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // INVARIANT (root cause D — mirrored from buildLiveCycleData into the live
  // hydrate path it could not previously reach). Downstream the naive-overall +
  // grades exports bucket per-(participant × subject) cells on the participant row
  // id, and match students ACROSS sittings (the best-of-two Overall) on studentId
  // (qm_participant_id). BOTH must be GUARANTEED-UNIQUE per real participant: a
  // collapsed key — two students sharing a qm_participant_id because the source
  // export's ResultParticipantName was blank/duplicated, so DB dedup folded them
  // into one row — would silently overwrite one student's scores (the "fewer rows
  // than results, survivor holds a stray mark" signature). Fail loudly here rather
  // than ship corrupt cells; the InMemoryDataProvider's analogous guard never sees
  // this path because it runs on the seed AFTER hydrate has already assembled it.
  const idSeen = new Set<string>();
  const studentIdSeen = new Set<string>();
  for (const sp of seedParticipants) {
    if (idSeen.has(sp.id))
      throw new Error(`hydrate: duplicate participant row id "${sp.id}" — per-(participant,subject) cells would collide.`);
    idSeen.add(sp.id);
    const sid = sp.studentId ?? sp.id;
    if (studentIdSeen.has(sid))
      throw new Error(
        `hydrate: studentId "${sid}" maps to more than one participant row — cross-sitting matching and the grades/overall matrix would collapse these students.`,
      );
    studentIdSeen.add(sid);
  }

  // The authoritative ingest roster (migration 0026 `sittings`): one row per
  // participant × subject, STAFF INCLUDED. Carried into the seed so every
  // ingest-stage participant count reads `count(distinct participant_email)` from
  // here, not the MCQ response matrix. Only rows that resolve to a live participant
  // + subject are kept (the FK targets always do post-0026).
  const seedSittings: SeedSitting[] = sittingRows
    .filter((s) => s.participant_id && s.assessment_id)
    .map((s) => ({
      assessmentId: s.assessment_id!,
      participantId: s.participant_id!,
      participantEmail: (s.participant_email ?? "").toLowerCase(),
    }));

  const respByAssessment = new Map<string, ResponseRow[]>();
  for (const r of responses) {
    const aId = itemAssessment.get(r.item_id);
    if (!aId) continue;
    (respByAssessment.get(aId) ?? respByAssessment.set(aId, []).get(aId)!).push(r);
  }

  // Cohort-excluded participant row ids — staff/test/withdrawn accounts, read from
  // the per-cohort `cohort_exclusions` DATA (migration 0033), resolved from the
  // stable key (qm_participant_id) to the current row UUID. No email is matched
  // against a constant in code. Diagnostics then run on the corrected cohort.
  const qmByKey = new Map(participants.map((p) => [p.qm_participant_id, p.id]));
  const cohortExcludedIds = new Set(
    cohortExclusionRows
      .map((r) => qmByKey.get(r.participant_key))
      .filter((id): id is string => id != null),
  );

  const seedAssessments: (SeedAssessment & { _order: number })[] = [];
  const diagnostics: (SeedAssessmentDiagnostics & { _order: number })[] = [];
  const rate = (v: QualityRating | null): QualityRating => v ?? "Review";

  for (const a of assessments) {
    const info = infoByAssessment.get(a.id)!;
    const aItems = items.filter((it) => it.assessment_id === a.id);
    const aResp = respByAssessment.get(a.id) ?? [];

    const seedItems: SeedItem[] = aItems.map((it) => {
      const s = statByItem.get(it.id);
      const composite = { pRating: rate(s?.p_rating ?? null), itRating: rate(s?.it_rating ?? null), pbRating: rate(s?.pb_rating ?? null), discRating: rate(s?.disc_rating ?? null) };
      const presented = aResp.filter((r) => r.item_id === it.id);
      const answered = presented.filter((r) => r.answer_given != null);
      const times = answered.map((r) => r.response_time).filter((t): t is number => t != null && Number.isFinite(t));
      return {
        id: it.id,
        wording: it.wording,
        major: it.major_element,
        sub: it.sub_element,
        demand: it.demand_level,
        maxScore: it.max_score ?? 1,
        participantsAnswered: answered.length,
        participantsPresented: presented.length,
        avgResponseTime: times.length ? Math.round((times.reduce((x, y) => x + y, 0) / times.length) * 10) / 10 : null,
        pValue: s?.p_value ?? 0,
        pRating: composite.pRating,
        itemTotal: s?.item_total ?? null,
        itRating: composite.itRating,
        pointBiserial: s?.point_biserial ?? null,
        pbRating: composite.pbRating,
        discrimination: s?.discrimination ?? 0,
        discRating: composite.discRating,
        overallReview: rate(s?.overall_review ?? null),
        qualityIndex: qualityIndex(composite),
      };
    });

    const seedResponses: SeedResponse[] = aResp.map((r) => {
      const resp: SeedResponse = {
        p: r.participant_id,
        i: r.item_id,
        s: Number(r.answer_score),
        answerGiven: r.answer_given,
        answerGivenChoiceNumber: r.answer_given_choice_number,
        responseTime: r.response_time,
      };
      // Answered iff answer_given_choice_number is present — answer_given carries
      // QM's "<Not defined>" sentinel for an unanswered item, so it is never used here.
      if (r.answer_given_choice_number == null) resp.a = false;
      return resp;
    });

    // Per-participant SITTING key: participant row id → the QM ResultId carried on
    // its responses (one sitting per participant × subject). Keys the cleaned
    // export's ResultId to the real sitting, not the participant id.
    const resultIdByParticipant: Record<string, string> = {};
    for (const r of aResp) {
      if (r.qm_result_id && resultIdByParticipant[r.participant_id] === undefined) {
        resultIdByParticipant[r.participant_id] = r.qm_result_id;
      }
    }

    // INVARIANT (root cause D): every distinct participant in this subject's input
    // responses must survive to a distinct output participant in the bucketed cell
    // matrix — no silent overwrite (mirror of buildLiveCycleData's per-subject
    // guard, applied here to the hydrated DB rows the in-memory path never sees).
    const inParticipants = new Set(aResp.map((r) => r.participant_id)).size;
    const outParticipants = new Set(seedResponses.map((r) => r.p)).size;
    if (inParticipants !== outParticipants) {
      throw new Error(
        `hydrate: ${a.name} bucketed ${inParticipants} input participants into ${outParticipants} output participants — participant collapse.`,
      );
    }

    // Per-participant technical incidents from the sitting's result_status flag.
    const statusByP = new Map<string, string>();
    for (const r of aResp) {
      if (r.result_status && !statusByP.has(r.participant_id)) statusByP.set(r.participant_id, r.result_status);
    }
    const technicalIncidents: SeedTechnicalIncident[] = [...statusByP.entries()]
      .filter(([, status]) => isTechnicalIncidentStatus(status))
      .map(([p, status]) => ({ p, status }));

    // Max Score = 0 items (instructions/stimuli) were never scored — exclude their
    // responses here too, so they don't inflate omission/completion/correlation inputs
    // (mirrors buildLiveCycleData's diagSourceRecs filter).
    const scoredItemIds = new Set(aItems.filter((it) => (it.max_score ?? 1) >= 1).map((it) => it.id));
    const diagSourceResp = aResp.filter((r) => scoredItemIds.has(r.item_id));
    const ordered = [...diagSourceResp].sort((x, y) => (x.created_at < y.created_at ? -1 : 1));
    const order = new Map<string, number>();
    for (const r of ordered) if (!order.has(r.item_id)) order.set(r.item_id, order.size);
    const demandByItem = new Map(aItems.map((it) => [it.id, it.demand_level]));
    const itemSetByItem = new Map(aItems.map((it) => [it.id, it.item_set]));
    const diagRecs: DiagResponse[] = diagSourceResp.map((r) => ({
      participantId: r.participant_id,
      itemId: r.item_id,
      demandLevel: demandByItem.get(r.item_id) ?? null,
      itemSet: itemSetByItem.get(r.item_id) ?? null,
      order: order.get(r.item_id) ?? 0,
      // answer_given carries QM's "<Not defined>" sentinel for an unanswered item
      // (never null), so omission/speededness/timing key off
      // answer_given_choice_number, which is genuinely null instead.
      answered: r.answer_given_choice_number != null,
      correct: Number(r.answer_score) === 1,
      responseTime: r.response_time,
    }));
    // Match P-B's matrix: drop staff/test accounts and dedupe (participant, item)
    // keeping the last row before computing (see cleanDiagResponses).
    const cleanDiag = cleanDiagResponses(diagRecs, { excludedParticipantIds: cohortExcludedIds });
    diagnostics.push({ assessmentId: a.id, assessmentName: a.name, ...buildAssessmentDiagnostics(cleanDiag), _order: info.order });

    seedAssessments.push({
      id: a.id,
      name: a.name,
      shortName: info.shortName,
      rtl: info.rtl,
      stageIndex: 1,
      items: seedItems,
      responses: seedResponses,
      technicalIncidents,
      resultIdByParticipant,
      _order: info.order,
    });
  }

  seedAssessments.sort((a, b) => a._order - b._order);
  diagnostics.sort((a, b) => a._order - b._order);

  // The stored validation report (if a raw export has been ingested) drives the
  // Upload screen's validation panel + blocking-issue gating across refreshes.
  const ingestReport =
    (importBatch?.report_json as ValidationReport | null | undefined) ?? null;
  const ingestValidation: ValidationReport = ingestReport ?? EMPTY_VALIDATION;
  // Name the upload from the real 3-CSV source filenames (the assessments export
  // is the representative); fall back through the others, then to a neutral
  // 3-CSV label. NOT the legacy single-file "exam_export.xlsx" default.
  const ingestFileName =
    importBatch?.file_ref ||
    importBatch?.assessments_file ||
    importBatch?.items_file ||
    importBatch?.topics_file ||
    "Questionmark CSV exports";
  // Real combined size persisted at ingest (migration 0009); 0 when unknown.
  const ingestFileSizeMB = importBatch?.file_size_mb ?? 0;
  // The three QM CSVs recognised at ingest (migration 0006 columns). null per kind
  // when absent (legacy single-file rows) — the Upload step then shows that kind as
  // missing/unrecognised rather than inventing a filename.
  const ingestFiles = {
    items: importBatch?.items_file ?? null,
    assessments: importBatch?.assessments_file ?? null,
    topics: importBatch?.topics_file ?? null,
  };
  const ingestDuplicates = ingestReport?.checks.find((c) => c.id === "duplicates")?.count ?? 0;

  const priorCycles: SeedPriorCycle[] = cycles.slice(1).map((c) => ({
    id: c.id,
    name: c.name,
    testCentreId: centreOfCycle(c),
    yearId: c.year_id ?? undefined,
    stageIndex: 6,
    stepsDone: 7,
    participants: 0,
    assessments: 0,
    lastActivity: new Date(c.updated_at).toLocaleDateString(),
    locked: c.status === "locked",
    mock: false,
  }));

  const seed: Seed = {
    generatedAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    testCentres: seedTestCentres.length > 0 ? seedTestCentres : undefined,
    liveCycle: {
      id: cycleId,
      name: live.name,
      region: live.region,
      testCentreId: centreOfCycle(live),
      yearId: live.year_id ?? undefined,
      startedAt: new Date(live.created_at).toLocaleDateString(),
      lastActivity: new Date(live.updated_at).toLocaleString(),
      stageIndex: stageIndexFromStatus(live.status),
      fileName: ingestFileName,
      fileSizeMB: ingestFileSizeMB,
      files: ingestFiles,
      uploadedAgo: importBatch ? new Date(importBatch.created_at).toLocaleString() : new Date(live.created_at).toLocaleDateString(),
      validation: ingestValidation,
      preview: { headers: [], rows: [] },
      duplicates: ingestDuplicates,
      participants: seedParticipants,
      assessments: seedAssessments.map(({ _order, ...a }) => { void _order; return a; }),
      diagnostics: diagnostics.map(({ _order, ...d }) => { void _order; return d; }),
      sittings: seedSittings,
    },
    priorCycles,
  };

  // ── decision state ────────────────────────────────────────────────────
  const excluded = new Set([
    ...items.filter((it) => it.status === "excluded").map((it) => it.id),
    ...reviews.filter((r) => r.exclude).map((r) => r.item_id),
  ]);
  const reasonByItem = new Map(reviews.map((r) => [r.item_id, r.reason]));
  const exclusions = [...excluded]
    .map((itemId) => ({ itemId, assessmentId: itemAssessment.get(itemId) ?? "", reason: reasonByItem.get(itemId) ?? null }))
    .filter((e) => e.assessmentId);

  const essays: EssayUploadRow[] = essayRows
    .map((e) => {
      const code = subjectCodeByAssessment.get(e.assessment_id);
      if (code !== "AFL" && code !== "ESL") return null;
      return { participantId: e.participant_id, subjectCode: code, totalScore: Number(e.mark) };
    })
    .filter((r): r is EssayUploadRow => r !== null);

  const altByIncident = new Map(alterationRows.filter((a) => a.incident_id).map((a) => [a.incident_id!, a]));
  const incidents: IncidentInput[] = incidentRows.map((r) => ({
    source: r.source,
    studentName: r.student_name ?? "",
    exam: r.exam ?? undefined,
    issueType: r.issue_type ?? undefined,
    actionTaken: r.action_taken ?? undefined,
    questionsAffected: r.questions_affected ?? undefined,
    staff: r.staff ?? undefined,
    email: r.email ?? undefined,
    school: r.school ?? undefined,
    description: r.description ?? undefined,
  }));
  const incidentDecisions: (IncidentDecisionInput | null)[] = incidentRows.map((r) => {
    const al = altByIncident.get(r.id);
    if (!al) return null;
    return { applyTo: al.apply_to, studentId: al.participant_id, subjectId: al.assessment_id, marks: Number(al.marks), reason: al.reason };
  });

  // Clean-stage removals, grouped per subject (rows = participants, cols = items).
  // Row removals re-resolve through the participant's STABLE key (qm_participant_id,
  // migration 0016) to the CURRENT row UUID, so an exclusion recorded before a
  // re-import still applies to the freshly-minted participant row. Rows whose stable
  // key no longer maps to any participant (or legacy rows with no stable key whose
  // stored UUID is now dangling) are dropped — they cannot match a live participant.
  const qmToUuid = new Map(participants.map((p) => [p.qm_participant_id, p.id]));
  const liveIds = new Set(participants.map((p) => p.id));
  const cleanByAssessment = new Map<string, { rows: string[]; cols: string[] }>();
  for (const r of cleanExclusionRows) {
    const g = cleanByAssessment.get(r.assessment_id) ?? { rows: [], cols: [] };
    if (r.kind === "row") {
      const resolved = (r.target_key && qmToUuid.get(r.target_key)) || (liveIds.has(r.target_id) ? r.target_id : undefined);
      if (resolved) g.rows.push(resolved);
    } else {
      g.cols.push(r.target_id);
    }
    cleanByAssessment.set(r.assessment_id, g);
  }
  const cleanRemovals = [...cleanByAssessment.entries()].map(([assessmentId, g]) => ({ assessmentId, ...g }));

  // Cohort-wide exclusions, resolved from the stable key to the CURRENT row UUID so
  // they survive a re-import. Rows whose key no longer maps to a participant (e.g.
  // an account dropped from a later import) are ignored rather than dangling.
  const cohortExclusions = cohortExclusionRows
    .map((r) => {
      const participantId = qmToUuid.get(r.participant_key);
      return participantId ? { participantId, reason: r.reason } : null;
    })
    .filter((x): x is { participantId: string; reason: string } => x !== null);

  // 0044 — staged incident export records, mapped verbatim from the DB rows
  // (camelCase for the app). The stored match is authoritative; adjustment_* are
  // carried through as null (staging never adjusts).
  const examIncidents: ExamIncidentRecord[] = examIncidentRows.map((r) => ({
    reference: r.reference,
    importBatchId: r.import_batch_id,
    examCycle: r.exam_cycle,
    subjectRaw: r.subject_raw,
    subjectKey: r.subject_key,
    examDate: r.exam_date,
    partnerCenter: r.partner_center ?? "",
    category: r.category ?? "",
    issue: r.issue ?? "",
    code: r.code ?? "",
    studentName: r.student_name ?? "",
    studentEmail: r.student_email,
    studentIdExternal: r.student_id_external ?? "",
    timeStarted: r.time_started ?? "",
    timeResolved: r.time_resolved ?? "",
    durationMin: r.duration_min,
    actionTaken: r.action_taken ?? "",
    questionsAffectedCount: r.questions_affected_count,
    questionsAffectedList: r.questions_affected_list,
    status: r.status ?? "",
    invigilator: r.invigilator ?? "",
    sourceCreatedAt: r.source_created_at,
    matchedQmResultId: r.matched_qm_result_id,
    matchStatus: r.match_status as ExamIncidentMatchStatus,
    flags: r.flags ?? [],
    adjustmentType: null,
    adjustmentMagnitude: null,
    adjustmentNotes: null,
  }));

  const decisions: DecisionState = {
    exclusions,
    cleanRemovals,
    cohortExclusions,
    schemes: schemes.map((s) => ({ scope: s.scope, method: s.method, bands: s.bands })),
    locked: grades.some((g) => g.locked),
    essays,
    incidents,
    incidentDecisions,
    distinctionConfirmed: distState?.confirmed ?? false,
    distinctionOverrides: distOverrides.map((o) => ({ studentId: o.participant_id, reason: o.reason })),
    docSettings: (docRow?.settings as Record<string, unknown> | undefined) ?? null,
    workspace: Object.fromEntries(workspace.map((w) => [w.key, w.value])),
    elementLabels: elementLabelRows.length ? groupElementLabels(elementLabelRows) : undefined,
    roles: roleRows.map((r) => ({ id: r.id, name: r.name, is_system: r.is_system, sort: r.sort })),
    roleActions: roleActionRows.map((r) => ({ role_id: r.role_id, action: r.action })),
    examIncidents,
  };

  const subjectCodeToAssessmentId = new Map<string, string>();
  for (const a of assessments) {
    const code = classify(a.name).subjectCode;
    if (code) subjectCodeToAssessmentId.set(code, a.id);
  }
  const lookups = {
    qmToUuid,
    subjectCodeToAssessmentId,
    incidentDbIds: incidentRows.map((r) => r.id),
  };

  return { seed, decisions, lookups };
}

// ── Overall analytics: multi-cycle projection ───────────────────────────────
/**
 * Page through a whole table in stable key order (no cycle filter), so a large
 * table is never silently truncated by PostgREST's max-rows cap. Mirrors
 * `selAllByCycle` but spans EVERY centre × year × sitting — the read-model needs
 * all of them, not just the single live cycle.
 */
async function selAllRows<T>(supabase: DB, table: string, orderCols: readonly string[]): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; ) {
    let q = supabase.from(table).select("*");
    for (const col of orderCols) q = q.order(col, { ascending: true });
    const page = await sel<T>(q.range(from, from + PAGE - 1));
    if (page.length === 0) break;
    out.push(...page);
    from += page.length;
  }
  return out;
}

export interface OverallAnalyticsProjection {
  cells: OACell[];
  subjects: { key: string; name: string; short: string; rtl?: boolean }[];
  years: number[];
}

/**
 * Build the Overall-analytics multi-cell projection from the PERSISTED per-sitting
 * outputs across EVERY centre × year × sitting — additive to the single-live-cycle
 * hydrate above, and never touches it. It reads the signed-off grades (per-subject
 * performance level + overall award) and per-subject score percentages, groups
 * them by (centre, year) with their February / May sittings, and hands the result
 * to `computeOverallAnalytics` (which does the best-of-two roll-up via the existing
 * `rollupOverall` / `deriveAward`). Seeding at this persisted-output grain is
 * sufficient — no raw responses or engine re-run required.
 *
 * Defensive: a pre-migration / empty database yields an empty projection, and the
 * provider then falls back to the in-memory demo. Never throws — a missing table
 * resolves to `[]` via `sel`.
 */
export async function fetchOverallAnalytics(supabase: DB): Promise<OverallAnalyticsProjection> {
  const empty: OverallAnalyticsProjection = { cells: [], subjects: [], years: [] };
  try {
    const [cycles, years, centres, assessments, participants, grades, scoreRuns, scores] =
      await Promise.all([
        sel<ExamCycleRow>(supabase.from("exam_cycles").select("*")),
        sel<ExamYearRow>(supabase.from("exam_years").select("*")),
        sel<TestCentreRow>(supabase.from("test_centres").select("*")),
        sel<AssessmentRow>(supabase.from("assessments").select("*")),
        sel<ParticipantRow>(supabase.from("participants").select("*")),
        selAllRows<GradeRow>(supabase, "grades", ["cycle_id", "participant_id"]),
        selAllRows<ScoreRunRow>(supabase, "score_runs", ["cycle_id", "assessment_id", "computed_at"]),
        selAllRows<ParticipantScoreRow>(supabase, "participant_scores", ["score_run_id"]),
      ]);
    if (cycles.length === 0) return empty;

    const yearById = new Map(years.map((y) => [y.id, y] as const));
    const centreNameById = new Map(centres.map((c) => [c.id, c.name] as const));
    const assessmentById = new Map(assessments.map((a) => [a.id, a] as const));
    const studentIdByParticipant = new Map(
      participants.map((p) => [p.id, p.qm_participant_id || p.pseudonym_id || p.id] as const),
    );

    // Assessment id → canonical subject key + display, and the union subject list.
    const subjectByKey = new Map<string, { key: string; name: string; short: string; rtl?: boolean }>();
    const subjectKeyByAssessment = new Map<string, string>();
    for (const a of assessments) {
      const info = classify(a.name);
      const key = subjectKeyOf(a.name);
      subjectKeyByAssessment.set(a.id, key);
      if (!subjectByKey.has(key)) {
        subjectByKey.set(key, { key, name: a.name, short: info.shortName, ...(info.rtl ? { rtl: true } : {}) });
      }
    }

    // Latest score_run per (cycle, assessment); then its participant scores → pct.
    const latestRunByCycleAssessment = new Map<string, string>();
    const latestRunTime = new Map<string, string>();
    for (const r of scoreRuns) {
      const key = `${r.cycle_id}|${r.assessment_id}`;
      const prev = latestRunTime.get(key);
      if (prev === undefined || r.computed_at > prev) {
        latestRunTime.set(key, r.computed_at);
        latestRunByCycleAssessment.set(key, r.id);
      }
    }
    const scoresByRun = new Map<string, ParticipantScoreRow[]>();
    for (const s of scores) {
      (scoresByRun.get(s.score_run_id) ?? scoresByRun.set(s.score_run_id, []).get(s.score_run_id)!).push(s);
    }

    // Grades grouped by (cycle, participant).
    const gradesByCycleParticipant = new Map<string, GradeRow[]>();
    for (const g of grades) {
      const key = `${g.cycle_id}|${g.participant_id}`;
      (gradesByCycleParticipant.get(key) ?? gradesByCycleParticipant.set(key, []).get(key)!).push(g);
    }

    const perfLevels = performanceLabels(DEFAULT_SCORING_CONFIG);
    const awards = awardLabels(DEFAULT_SCORING_CONFIG);
    const assessmentsByCycle = new Map<string, AssessmentRow[]>();
    for (const a of assessments) {
      (assessmentsByCycle.get(a.cycle_id) ?? assessmentsByCycle.set(a.cycle_id, []).get(a.cycle_id)!).push(a);
    }

    /** Build one sitting's OASitting from its persisted grades + scores. */
    const buildSitting = (cycleId: string): OASitting | null => {
      const cycleAssessments = assessmentsByCycle.get(cycleId) ?? [];
      // Which participants have any grade row in this cycle.
      const participantIds = new Set<string>();
      for (const g of grades) if (g.cycle_id === cycleId) participantIds.add(g.participant_id);
      if (participantIds.size === 0) return null;

      const students: OASittingStudent[] = [];
      for (const pid of participantIds) {
        const gRows = gradesByCycleParticipant.get(`${cycleId}|${pid}`) ?? [];
        const levels: Record<string, string> = {};
        let award = "";
        const subjectLevels: string[] = [];
        for (const g of gRows) {
          if (g.scope === "overall") {
            award = g.grade_label ?? "";
          } else {
            const key = subjectKeyByAssessment.get(g.scope);
            if (key && g.grade_label) {
              levels[key] = g.grade_label;
              subjectLevels.push(g.grade_label);
            }
          }
        }
        // Derive the overall award when a graded sitting has per-subject levels but
        // no persisted 'overall' row (never for the seed, which writes one).
        if (!award && subjectLevels.length > 0) {
          award = deriveAward(
            { subjectLevels, d3Pass: true },
            { performanceLevels: perfLevels, awardLevels: awards },
          ).award;
        }
        students.push({ studentId: studentIdByParticipant.get(pid) ?? pid, award, levels });
      }

      const scoresOut: Record<string, number[]> = {};
      for (const a of cycleAssessments) {
        const key = subjectKeyByAssessment.get(a.id);
        if (!key) continue;
        const runId = latestRunByCycleAssessment.get(`${cycleId}|${a.id}`);
        const list = runId ? (scoresByRun.get(runId) ?? []).map((s) => s.pct) : [];
        (scoresOut[key] ??= []).push(...list);
      }
      return { students, scores: scoresOut };
    };

    // Group cycles into (centre, year) cells with their February / May sittings.
    const cellByKey = new Map<string, OACell>();
    const yearsPresent = new Set<number>();
    for (const c of cycles) {
      if (!c.year_id || !c.sitting) continue;
      const y = yearById.get(c.year_id);
      if (!y) continue;
      const yearNum = Number(y.name.match(/(19|20)\d{2}/)?.[0] ?? y.name);
      if (!Number.isFinite(yearNum)) continue;
      const centre = centreNameById.get(y.test_centre_id) ?? "Unassigned";
      const sitting = c.sitting === "february" ? "february" : "may";
      const sit = buildSitting(c.id);
      if (!sit) continue;
      const key = `${centre}|${yearNum}`;
      const cell = cellByKey.get(key) ?? { centre, year: yearNum, february: null, may: null };
      // First non-empty sitting wins per slot (a re-run cycle shouldn't double it).
      if (sitting === "february") cell.february ??= sit;
      else cell.may ??= sit;
      cellByKey.set(key, cell);
      yearsPresent.add(yearNum);
    }

    const cells = [...cellByKey.values()].filter((c) => c.february !== null || c.may !== null);
    if (cells.length === 0) return empty;

    // Subjects in canonical order (classify order), union across the cells.
    const orderOf = (name: string): number => classify(name).order;
    const subjects = [...subjectByKey.values()].sort((a, b) => orderOf(a.name) - orderOf(b.name));
    return { cells, subjects, years: [...yearsPresent].sort((a, b) => a - b) };
  } catch {
    return empty;
  }
}

function stageIndexFromStatus(status: string): number {
  // 10-stage order: Upload(0) Clean(1) Raw scores(2) Question review(3)
  // Diagnostics(4) Incident adjustments(5) Score(6) Cut scores(7) CGJ(8)
  // Grades(9). Essay marks are uploaded on Upload (step 1) and fold into the
  // scored totals automatically — not a standalone stage. CGJ (centre grade
  // judgement) is an optional comparison step with no status of its own; a graded
  // sitting resolves to Grades, the final per-sitting step. Document generation
  // lives at the cycle/overall level, not on a sitting.
  switch (status) {
    case "draft":
    case "ingested": return 0;
    case "validated": return 1; // Clean
    case "in_review": return 3; // Question review
    case "scored": return 6; // Score (computed post-adjustment)
    case "graded": return 9; // Grades
    case "locked": return 9; // Grades (signed off) — terminal per-sitting step
    default: return 1;
  }
}
