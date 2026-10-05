/**
 * WorkspaceState — the state that belongs to the WORKSPACE, not to any one sitting.
 *
 * A single instance is created per provider tree and shared BY REFERENCE with every
 * `InMemoryDataProvider` in it (the directory and one per opened sitting). Editing it
 * through any of them is immediately visible to all the others — nothing is copied or
 * broadcast — so changing the grading config in Settings re-grades every loaded sitting
 * on its next read, and a role change gates every sitting at once.
 *
 * What is NOT here: anything keyed by a cycle (exclusions, boundaries, essay marks,
 * locks, …). That stays with the cycle's own provider instance. See
 * docs/multi-sitting-provider.md for the full split.
 */
import { defaultScoringConfig } from "@/lib/engine";
import type { QualityThresholds } from "@/lib/engine";
import {
  defaultRoles,
  defaultRoleActions,
  resolveRoleActions,
  type ActionKey,
  type ResolvedRoleActions,
  type Role as RoleModel,
} from "@/lib/auth/actions";
import { defaultIncidentConfig } from "@/lib/incidents/config";
import type { IncidentAdjustmentConfig } from "@/lib/incidents/types";
import { DEFAULT_ELEMENT_LABELS, type ElementLabelsConfig } from "./element-labels";
import { defaultGradingConfig, DEFAULT_BORDERLINE_BAND_PCT, type GradingConfig } from "./grading";
import { defaultMembers, seedAuditEntries } from "./mock-admin";
import type { AuditEntry, BorderlineConfig, CurrentUser, Member, TestCentreSummary } from "./types";

export interface WorkspaceInit {
  user: CurrentUser;
  testCentres: TestCentreSummary[];
}

export class WorkspaceState {
  /** The signed-in user (the same person acts on every sitting). */
  user: CurrentUser;

  // ── grading / scoring configuration ────────────────────────────────────────
  grading: GradingConfig = defaultGradingConfig();
  /** Item-quality Good/Review/Flag thresholds (the configurable half of ScoringConfig). */
  quality: QualityThresholds = defaultScoringConfig().quality;
  /** Distinction safeguard: empty topDifficultyDemand resolves to the highest demand present. */
  safeguard: { topDifficultyDemand: string } = { topDifficultyDemand: "" };
  /** Borderline (marginal) flagging band, percentage points. */
  borderline: BorderlineConfig = { bandPct: DEFAULT_BORDERLINE_BAND_PCT };

  // ── access control ────────────────────────────────────────────────────────
  roles: RoleModel[] = defaultRoles();
  roleActions: Record<string, ActionKey[]> = defaultRoleActions();
  /** role_id → granted action set; recomputed whenever roles / roleActions change. */
  resolvedActions: ResolvedRoleActions = resolveRoleActions(this.roles, this.roleActions);

  // ── configuration registries ──────────────────────────────────────────────
  incidentConfig: IncidentAdjustmentConfig = defaultIncidentConfig();
  elementLabels: ElementLabelsConfig = JSON.parse(JSON.stringify(DEFAULT_ELEMENT_LABELS));

  // ── directory / audit ─────────────────────────────────────────────────────
  members: Member[] = defaultMembers();
  /** Session-local audit trail (newest first); entries carry their own cycleId. */
  auditEntries: AuditEntry[] = seedAuditEntries("may-2026");
  auditSeq = 0;

  /** Test centres (top-level scoping dimension). */
  testCentres: TestCentreSummary[];
  /** Id sequence for optimistic (demo) test centres. */
  seq = 0;

  constructor(init: WorkspaceInit) {
    this.user = init.user;
    this.testCentres = init.testCentres;
  }
}
