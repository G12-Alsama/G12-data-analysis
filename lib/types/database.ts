/**
 * Hand-written, strict TypeScript types for the Supabase schema defined in
 * `supabase/migrations/0001_init.sql`. Kept in the shape the Supabase client
 * expects (`Database`) so queries are typed end to end. When the schema
 * changes, update this file alongside the migration (or regenerate with the
 * Supabase type generator and re-apply the `Database` wrapper).
 */

// --- Enums (mirror the Postgres enums) --------------------------------------
export type CycleStatus =
  | "draft"
  | "ingested"
  | "validated"
  | "in_review"
  | "scored"
  | "graded"
  | "locked";

export type AssessmentStatus = "pending" | "in_review" | "reviewed" | "scored";
export type ItemStatus = "active" | "excluded";
// The physical `member_role` DB enum (0001 + 0015). `analyst` (0015) is the
// data-analyst tier; `viewer`/`reviewer` are the two sub-flavours of the
// team-member tier. See lib/auth/roles.ts for the canonical privilege ordering.
export type MemberRole = "lead_admin" | "analyst" | "reviewer" | "viewer";
export type QualityRating = "Good" | "Review" | "Flag";
export type DemandLevel = "D1" | "D2" | "D3";
export type SchemeMethod = "judgemental" | "fixed_pct";
// 0003
export type IncidentSource = "incident_log" | "complaint";
export type AlterationApply = "student" | "subject" | "none";
// 0005 — a year contains two sittings; each sitting is a full pipeline run.
export type SittingPeriod = "february" | "may";

// --- Reusable JSON shapes ----------------------------------------------------
export interface GradeBand {
  label: string;
  min: number;
  max: number;
}

// --- Table row shapes --------------------------------------------------------
// 0010 — test_centres are the top-level scoping dimension. A centre (e.g.
// "Shatila 1") owns its own exam_years; sittings + results inherit the centre
// through the exam_cycles.year_id → exam_years.test_centre_id chain.
export interface TestCentreRow {
  id: string;
  name: string;
  /** Short tag, e.g. "SHA1". */
  code: string;
  /** Route-safe, unique, e.g. "shatila-1". */
  slug: string;
  region: string;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// 0005 — exam_years group sittings. A year is "2026"; its sittings are the
// February and May exam_cycles (pipeline runs) plus a derived Overall view.
export interface ExamYearRow {
  id: string;
  name: string;
  region: string;
  /**
   * 0010 — the test centre this year belongs to. NOT NULL after the 0010
   * backfill (every existing year was assigned to the "Unassigned" placeholder).
   * Definer-only: set exclusively by create_exam_year / create_cycle_with_assessments.
   */
  test_centre_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ExamCycleRow {
  id: string;
  name: string;
  status: CycleStatus;
  region: string;
  /** 0005 — the year this sitting belongs to (NULL only for un-migrated rows). */
  year_id: string | null;
  /** 0005 — which sitting of the year this pipeline run is. */
  sitting: SittingPeriod | null;
  /** 0031 — the exam date the human picked when creating the sitting (ISO date,
   *  NULL when not set). Display/reference only — not a key. */
  sitting_date: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MembershipRow {
  id: string;
  /** NULL means a workspace-level membership: the role applies to ALL cycles. */
  cycle_id: string | null;
  user_id: string;
  /** Legacy `member_role` enum — retained nullable for one release after 0040. */
  role: MemberRole;
  /** 0040 — the dynamic role this membership points at (backfilled from `role`). */
  role_id: string | null;
  created_at: string;
}

export interface AssessmentRow {
  id: string;
  cycle_id: string;
  name: string;
  item_count: number;
  status: AssessmentStatus;
  created_at: string;
}

export interface ItemRow {
  id: string;
  cycle_id: string;
  assessment_id: string;
  qm_question_id: string;
  wording: string | null;
  major_element: string | null;
  sub_element: string | null;
  demand_level: DemandLevel | null;
  /** Item-set / shared-stimulus name (e.g. a reading passage), or null. */
  item_set: string | null;
  max_score: number;
  status: ItemStatus;
  created_at: string;
}

export interface ItemStatsRow {
  item_id: string;
  p_value: number | null;
  p_rating: QualityRating | null;
  item_total: number | null;
  it_rating: QualityRating | null;
  point_biserial: number | null;
  pb_rating: QualityRating | null;
  discrimination: number | null;
  disc_rating: QualityRating | null;
  overall_review: QualityRating | null;
  computed_at: string;
  engine_version: string;
}

export interface ParticipantRow {
  id: string;
  cycle_id: string;
  qm_participant_id: string;
  pseudonym_id: string;
  full_name: string | null;
  email: string | null;
  dob: string | null;
  gender: string | null;
  created_at: string;
}

/** The per-sitting spine (migration 0026): one row per participant × subject, keyed
 *  on the natural (cycle_id, qm_result_id). The authoritative ingest roster. */
export interface SittingRow {
  cycle_id: string;
  qm_result_id: string;
  participant_email: string;
  participant_id: string | null;
  assessment_id: string | null;
  subject_name: string | null;
  result_status: string | null;
  attempt_number: number | null;
  total_score: number | null;
  maximum_score: number | null;
  percentage_score: number | null;
  scoreband: string | null;
  sitting: string | null;
  reconciled: boolean;
  created_at: string;
}

export interface ResponseRow {
  id: string;
  cycle_id: string;
  /** The QM `ResultId` (sitting natural key) — one per participant × subject. The
   *  authoritative uniqueness is (cycle_id, qm_result_id, question_id) and the row
   *  FK-cascades from `sittings` (migration 0026). */
  qm_result_id: string;
  /** The QM `QuestionId` (question natural key). */
  question_id: string;
  /** Participant email (natural key). */
  participant_email: string | null;
  /** Engine-feed join surrogates (the scoring feed reads these). */
  participant_id: string;
  item_id: string;
  assessment_id: string | null;
  answer_given: string | null;
  /** 0046 — raw QM `AnswerGivenChoiceNumber`, blank normalised to NULL upstream.
   *  The correct field for "was this item answered?" (`answer_given` carries the
   *  sentinel "<Not defined>" for an unanswered item and stays non-null). */
  answer_given_choice_number: string | null;
  /** 0047 — raw QM `QuestionPresentedNumber` for this participant's sitting of
   *  this question. VARIES per participant even for the same question (confirmed
   *  against the 700435 fixture) — a per-response value, never a per-question
   *  constant. The authoritative "presentation order" for Assessment Health. */
  question_presented_number: number | null;
  answer_score: number;
  response_time: number | null;
  result_status: string | null;
  question_type: string | null;
  question_status: string | null;
  created_at: string;
}

export interface ItemReviewRow {
  id: string;
  item_id: string;
  reviewer_id: string;
  exclude: boolean;
  reason: string | null;
  notes: string | null;
  decided_at: string;
}

/** Clean-stage non-destructive removal of a row (participant) or column (item). */
export interface CleanExclusionRow {
  id: string;
  cycle_id: string;
  assessment_id: string;
  kind: "row" | "col";
  target_id: string;
  /** kind='row': participant stable natural key (qm_participant_id / email) so the
   *  removal re-resolves to the current row UUID after a re-import (migration 0016).
   *  Null for legacy rows and for kind='col'. */
  target_key: string | null;
  decided_by: string;
  decided_at: string;
}

/** Cohort-wide participant exclusion (migration 0033) — staff/test/withdrawn,
 *  keyed on the participant's STABLE natural key so it survives a re-import.
 *  Distinct from the per-subject `clean_exclusions`. */
export interface CohortExclusionRow {
  id: string;
  cycle_id: string;
  participant_key: string;
  reason: string;
  decided_by: string | null;
  decided_at: string;
}

export interface ScoreRunRow {
  id: string;
  cycle_id: string;
  assessment_id: string;
  excluded_item_ids: string[];
  engine_version: string;
  computed_at: string;
}

export interface ParticipantScoreRow {
  id: string;
  score_run_id: string;
  participant_id: string;
  assessment_id: string;
  raw: number;
  pct: number;
  items_seen: number;
}

export interface GradeSchemeRow {
  id: string;
  cycle_id: string;
  scope: string; // assessment_id (uuid) | "overall"
  method: SchemeMethod;
  bands: GradeBand[];
  created_at: string;
  updated_at: string;
}

export interface GradeRow {
  id: string;
  cycle_id: string;
  participant_id: string;
  scope: string;
  grade_label: string | null;
  score: number | null;
  locked: boolean;
  signed_off_by: string | null;
  signed_off_at: string | null;
}

export interface ImportBatchRow {
  id: string;
  cycle_id: string;
  file_ref: string | null;
  /** Combined size (MB) of the uploaded export set — migration 0009. */
  file_size_mb: number | null;
  parsed_rows: number | null;
  validation_passed: boolean;
  report_json: unknown | null;
  // 3-CSV source filenames + reconciliation counts — migration 0006.
  items_file: string | null;
  assessments_file: string | null;
  topics_file: string | null;
  results_total: number | null;
  results_reconciled: number | null;
  created_by: string;
  created_at: string;
}

export interface AuditLogRow {
  id: string;
  cycle_id: string | null;
  actor_id: string;
  action: string;
  entity: string;
  entity_id: string | null;
  before: unknown | null;
  after: unknown | null;
  ts: string;
}

// --- 0003: adjustments / essays / config tables -----------------------------
export interface EssayMarkRow {
  id: string;
  cycle_id: string;
  participant_id: string;
  assessment_id: string;
  mark: number;
  essays_counted: number;
  file_ref: string | null;
  decided_by: string | null;
  decided_at: string;
}

export interface IncidentRow {
  id: string;
  cycle_id: string;
  source: IncidentSource;
  student_name: string | null;
  exam: string | null;
  issue_type: string | null;
  action_taken: string | null;
  questions_affected: string | null;
  staff: string | null;
  email: string | null;
  school: string | null;
  description: string | null;
  created_at: string;
}

export interface AlterationRow {
  id: string;
  cycle_id: string;
  incident_id: string | null;
  apply_to: AlterationApply;
  participant_id: string | null;
  assessment_id: string | null;
  marks: number;
  reason: string | null;
  decided_by: string | null;
  decided_at: string;
}

export interface DistinctionStateRow {
  cycle_id: string;
  confirmed: boolean;
  confirmed_by: string | null;
  confirmed_at: string | null;
}

export interface DistinctionOverrideRow {
  id: string;
  cycle_id: string;
  participant_id: string;
  scope: string;
  reason: string;
  decided_by: string | null;
  decided_at: string;
}

export interface DocumentSettingsRow {
  cycle_id: string;
  settings: Record<string, unknown>;
  updated_at: string;
}

export interface WorkspaceSettingRow {
  key: string;
  value: unknown;
  updated_at: string;
}

// 0040 — dynamic roles × granular actions: add/deletable role rows, plus the
// role_id → action grid. Readable by any signed-in member; written only via the
// definer RPCs (create/rename/delete_role, set_role_action).
export interface RoleRow {
  id: string;
  name: string;
  is_system: boolean;
  sort: number | null;
  created_at: string;
}
export interface RoleActionRow {
  role_id: string;
  action: string;
  granted: boolean;
}

// 0014 — per-subject A–E element labels. Writes are definer-only (set_element_labels).
export interface ElementLabelRow {
  id: string;
  subject: string;
  match_key: string;
  letter: string;
  label: string;
  sort_order: number;
  updated_at: string;
}

// 0016 — Incident Adjustments config registry + parsed rows. Writes are
// definer-only (upsert_incident_code / set_incident_settings / set_incident_mapping
// / import_incident_rows). `formula` / `mapping` are opaque JSON blobs whose shape
// is owned by lib/incidents/types.ts.
export interface IncidentCodeRow {
  id: string;
  code: string;
  label: string;
  match_types: string[];
  formula: unknown;
  per_code_cap: number;
  active: boolean;
  updated_by: string | null;
  updated_at: string;
}
export interface IncidentSettingsRow {
  id: boolean;
  per_student_cap: number | null;
  updated_by: string | null;
  updated_at: string;
}
export interface IncidentImportMappingRow {
  id: boolean;
  mapping: unknown;
  updated_by: string | null;
  updated_at: string;
}
export interface IncidentRowRow {
  id: string;
  cycle_id: string;
  /** P-A stable internal participant id (participants.qm_participant_id). */
  participant_key: string;
  /** Resolved cohort participant UUID, or null when unmatched. */
  participant_id: string | null;
  raw_student_id: string | null;
  student_name: string | null;
  incident_type: string | null;
  question_number: string | null;
  duration_minutes: number | null;
  code_id: string | null;
  status: string;
  errors: string[];
  created_at: string;
}

// --- 0044: technical-incident export staging table --------------------------
export interface ExamIncidentRow {
  id: string;
  cycle_id: string;
  reference: string;
  import_batch_id: string;
  file_name: string | null;
  exam_cycle: string;
  subject_raw: string;
  subject_key: string | null;
  exam_date: string | null;
  partner_center: string | null;
  category: string | null;
  issue: string | null;
  code: string | null;
  student_name: string | null;
  student_email: string;
  student_id_external: string | null;
  time_started: string | null;
  time_resolved: string | null;
  duration_min: number | null;
  action_taken: string | null;
  questions_affected_count: number | null;
  questions_affected_list: string[] | null;
  status: string | null;
  invigilator: string | null;
  source_created_at: string | null;
  imported_at: string;
  /** Resolved sitting id (qm_result_id is TEXT); null when unmatched. */
  matched_qm_result_id: string | null;
  match_status: string;
  flags: string[];
  /** Always null until the §3 gate is passed (staging never adjusts). */
  adjustment_type: string | null;
  adjustment_magnitude: number | null;
  adjustment_notes: string | null;
}

// --- Helper to describe a table to the Supabase client -----------------------
type TableDef<Row, Insert, Update> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

/**
 * The `Database` type consumed by `@supabase/supabase-js`. Insert/Update types
 * omit server-defaulted and definer-only columns where appropriate, but the key
 * guarantee that protected columns are not writable is enforced in the database
 * (RLS + column GRANTs), not the type system.
 */
export interface Database {
  public: {
    Tables: {
      // 0010 — top-level scoping dimension. Writes are definer-only (RPCs).
      test_centres: TableDef<TestCentreRow, never, never>;
      // 0005 — exam_years group the per-sitting exam_cycles pipeline runs.
      exam_years: TableDef<
        ExamYearRow,
        Pick<ExamYearRow, "name"> & Partial<Pick<ExamYearRow, "region">>,
        Partial<Pick<ExamYearRow, "name" | "region">>
      >;
      exam_cycles: TableDef<
        ExamCycleRow,
        Pick<ExamCycleRow, "name"> &
          Partial<Pick<ExamCycleRow, "region" | "year_id" | "sitting">>,
        Partial<Pick<ExamCycleRow, "name" | "region" | "year_id" | "sitting">>
      >;
      memberships: TableDef<
        MembershipRow,
        Pick<MembershipRow, "cycle_id" | "user_id" | "role">,
        Partial<Pick<MembershipRow, "role">>
      >;
      assessments: TableDef<
        AssessmentRow,
        Pick<AssessmentRow, "cycle_id" | "name"> &
          Partial<Pick<AssessmentRow, "item_count">>,
        Partial<Pick<AssessmentRow, "name" | "item_count">>
      >;
      items: TableDef<
        ItemRow,
        Omit<ItemRow, "id" | "status" | "created_at"> &
          Partial<Pick<ItemRow, "max_score">>,
        Partial<
          Pick<
            ItemRow,
            | "wording"
            | "major_element"
            | "sub_element"
            | "demand_level"
            | "max_score"
          >
        >
      >;
      item_stats: TableDef<ItemStatsRow, never, never>;
      participants: TableDef<
        ParticipantRow,
        Omit<ParticipantRow, "id" | "created_at">,
        Partial<Omit<ParticipantRow, "id" | "cycle_id" | "created_at">>
      >;
      responses: TableDef<
        ResponseRow,
        Omit<ResponseRow, "id" | "created_at">,
        never
      >;
      item_reviews: TableDef<
        ItemReviewRow,
        Pick<ItemReviewRow, "item_id" | "exclude"> &
          Partial<Pick<ItemReviewRow, "reason" | "notes">>,
        Partial<Pick<ItemReviewRow, "exclude" | "reason" | "notes">>
      >;
      // 0008 — clean-stage removals. All writes flow through SECURITY DEFINER RPCs.
      clean_exclusions: TableDef<CleanExclusionRow, never, never>;
      // 0033 — cohort-wide exclusions. Writes flow through set_cohort_exclusion.
      cohort_exclusions: TableDef<CohortExclusionRow, never, never>;
      score_runs: TableDef<
        ScoreRunRow,
        Pick<ScoreRunRow, "cycle_id" | "assessment_id" | "engine_version"> &
          Partial<Pick<ScoreRunRow, "excluded_item_ids">>,
        Partial<Pick<ScoreRunRow, "excluded_item_ids">>
      >;
      participant_scores: TableDef<ParticipantScoreRow, never, never>;
      grade_schemes: TableDef<
        GradeSchemeRow,
        Pick<GradeSchemeRow, "cycle_id" | "scope" | "method" | "bands">,
        Partial<Pick<GradeSchemeRow, "method" | "bands">>
      >;
      grades: TableDef<
        GradeRow,
        Pick<GradeRow, "cycle_id" | "participant_id" | "scope"> &
          Partial<Pick<GradeRow, "grade_label" | "score">>,
        Partial<Pick<GradeRow, "grade_label" | "score">>
      >;
      import_batches: TableDef<
        ImportBatchRow,
        Pick<ImportBatchRow, "cycle_id"> &
          Partial<Pick<ImportBatchRow, "file_ref" | "parsed_rows">>,
        never
      >;
      audit_log: TableDef<AuditLogRow, never, never>;
      // 0003 — all writes flow through SECURITY DEFINER RPCs, so no client Insert/Update.
      essay_marks: TableDef<EssayMarkRow, never, never>;
      incidents: TableDef<IncidentRow, never, never>;
      alterations: TableDef<AlterationRow, never, never>;
      distinction_state: TableDef<DistinctionStateRow, never, never>;
      distinction_overrides: TableDef<DistinctionOverrideRow, never, never>;
      document_settings: TableDef<DocumentSettingsRow, never, never>;
      workspace_settings: TableDef<WorkspaceSettingRow, never, never>;
      // 0040 — dynamic roles + the role_id → action grid (definer-only writes).
      roles: TableDef<RoleRow, never, never>;
      role_actions: TableDef<RoleActionRow, never, never>;
      // 0014 — per-subject A–E element labels (definer-only writes).
      element_labels: TableDef<ElementLabelRow, never, never>;
      // 0016 — Incident Adjustments config + parsed rows (definer-only writes).
      incident_codes: TableDef<IncidentCodeRow, never, never>;
      incident_settings: TableDef<IncidentSettingsRow, never, never>;
      incident_import_mappings: TableDef<IncidentImportMappingRow, never, never>;
      incident_rows: TableDef<IncidentRowRow, never, never>;
      exam_incidents: TableDef<ExamIncidentRow, never, never>;
    };
    Views: Record<string, never>;
    Functions: {
      // 0001
      create_cycle: { Args: { p_name: string; p_region?: string }; Returns: ExamCycleRow };
      // 0004 (extended in 0005 with year_id / sitting; in 0010 with test_centre_id;
      // in 0031 with sitting_date)
      create_cycle_with_assessments: {
        Args: {
          p_name: string;
          p_region?: string;
          p_assessments?: unknown;
          p_year_id?: string | null;
          p_sitting?: SittingPeriod;
          p_test_centre_id?: string | null;
          p_sitting_date?: string | null;
        };
        Returns: string;
      };
      // 0005 (extended in 0010 with test_centre_id) — create/find an exam year.
      create_exam_year: {
        Args: { p_name: string; p_region?: string; p_test_centre_id?: string | null };
        Returns: ExamYearRow;
      };
      // 0010 — test centre management (definer-only writes).
      create_test_centre: {
        Args: { p_name: string; p_code: string; p_slug?: string | null; p_region?: string };
        Returns: TestCentreRow;
      };
      update_test_centre: {
        Args: { p_id: string; p_name?: string | null; p_code?: string | null; p_active?: boolean | null };
        Returns: TestCentreRow;
      };
      set_test_centre_active: {
        Args: { p_id: string; p_active: boolean };
        Returns: TestCentreRow;
      };
      // 0013 — admin-gated reassignment of an exam year onto a different centre.
      move_exam_year_to_centre: {
        Args: { p_year_id: string; p_test_centre_id: string };
        Returns: ExamYearRow;
      };
      set_cycle_status: { Args: { p_cycle: string; p_status: CycleStatus }; Returns: ExamCycleRow };
      set_assessment_status: { Args: { p_assessment: string; p_status: AssessmentStatus }; Returns: undefined };
      decide_item_exclusion: { Args: { p_item: string; p_exclude: boolean; p_reason: string | null; p_notes?: string | null }; Returns: undefined };
      set_clean_removal: { Args: { p_cycle: string; p_assessment: string; p_kind: string; p_targets: string[]; p_keys: string[]; p_remove: boolean }; Returns: undefined };
      clear_clean_removals: { Args: { p_cycle: string; p_assessment: string }; Returns: undefined };
      set_cohort_exclusion: { Args: { p_cycle: string; p_key: string; p_reason: string | null; p_remove: boolean }; Returns: undefined };
      write_item_stats: { Args: { p_cycle: string; p_engine_version: string; p_stats: unknown }; Returns: undefined };
      lock_grades: { Args: { p_cycle: string }; Returns: undefined };
      unlock_grades: { Args: { p_cycle: string; p_reason: string }; Returns: undefined };
      set_import_validation: { Args: { p_batch: string; p_passed: boolean; p_report: unknown }; Returns: undefined };
      record_export: { Args: { p_cycle: string; p_kind: string }; Returns: undefined };
      save_grade_scheme: { Args: { p_cycle: string; p_scope: string; p_method: SchemeMethod; p_bands: unknown }; Returns: GradeSchemeRow };
      // 0003
      write_scores: { Args: { p_cycle: string; p_engine_version: string; p_runs: unknown }; Returns: undefined };
      upsert_essay_marks: { Args: { p_cycle: string; p_file_ref: string | null; p_marks: unknown }; Returns: undefined };
      clear_essay_marks: { Args: { p_cycle: string }; Returns: undefined };
      insert_incidents: { Args: { p_cycle: string; p_rows: unknown }; Returns: undefined };
      clear_incidents: { Args: { p_cycle: string }; Returns: undefined };
      decide_incident: { Args: { p_cycle: string; p_incident: string; p_apply_to: AlterationApply; p_participant: string | null; p_assessment: string | null; p_marks: number; p_reason: string | null }; Returns: undefined };
      confirm_distinction_caps: { Args: { p_cycle: string }; Returns: undefined };
      override_distinction_cap: { Args: { p_cycle: string; p_participant: string; p_scope: string; p_reason: string }; Returns: undefined };
      undo_distinction_override: { Args: { p_cycle: string; p_participant: string; p_scope: string }; Returns: undefined };
      adjust_participant_mark: { Args: { p_cycle: string; p_participant: string; p_assessment: string; p_new_mark: number; p_reason: string }; Returns: string | null };
      remove_mark_adjustment: { Args: { p_cycle: string; p_participant: string; p_assessment: string }; Returns: undefined };
      set_document_settings: { Args: { p_cycle: string; p_settings: unknown }; Returns: undefined };
      record_documents: { Args: { p_cycle: string; p_detail: string }; Returns: undefined };
      set_workspace_setting: { Args: { p_key: string; p_value: unknown }; Returns: undefined };
      // 0040 — dynamic roles × granular actions (admin-gated on general.manage_roles,
      // lockout-guarded: Admin undeletable, manage_roles/manage_users locked on, never
      // orphan manage_roles, no delete of a role that still has members).
      create_role: { Args: { p_name: string }; Returns: string };
      rename_role: { Args: { p_id: string; p_name: string }; Returns: undefined };
      delete_role: { Args: { p_id: string }; Returns: undefined };
      set_role_action: { Args: { p_role_id: string; p_action: string; p_granted: boolean }; Returns: undefined };
      // 0014 — replace the per-subject element-label config (definer-only).
      set_element_labels: { Args: { p_config: unknown }; Returns: undefined };
      // 0016 — Incident Adjustments config registry + import (admin-only config).
      upsert_incident_code: { Args: { p_id: string | null; p_code: string; p_label: string; p_match_types: string[]; p_formula: unknown; p_per_code_cap: number; p_active: boolean }; Returns: string };
      delete_incident_code: { Args: { p_id: string }; Returns: undefined };
      set_incident_settings: { Args: { p_per_student_cap: number | null }; Returns: undefined };
      set_incident_mapping: { Args: { p_mapping: unknown }; Returns: undefined };
      import_incident_rows: { Args: { p_cycle: string; p_rows: unknown }; Returns: undefined };
      upsert_exam_incidents: { Args: { p_cycle: string; p_batch: string; p_file_name: string | null; p_rows: unknown }; Returns: number };
      clear_exam_incidents: { Args: { p_cycle: string }; Returns: undefined };
      clear_incident_rows: { Args: { p_cycle: string }; Returns: undefined };
      // 0017 — Incident Adjustments apply/commit (admin-only, explicit action).
      apply_incident_adjustments: { Args: { p_cycle: string }; Returns: undefined };
      unapply_incident_adjustments: { Args: { p_cycle: string }; Returns: undefined };
      // 0018 — Incident Adjustments imported-source provenance (cycle role).
      set_incident_import_source: { Args: { p_cycle: string; p_file_name: string; p_is_sample: boolean }; Returns: undefined };
      clear_incident_import_source: { Args: { p_cycle: string }; Returns: undefined };
      // 0007 — atomic, idempotent 3-CSV persist + destructive sitting controls.
      // 0020 — clear/delete now RETURN the deleted-row count so the UI confirms
      // the operation did something (0 rows → explicit error, never silent).
      ingest_persist: { Args: { p_cycle: string; p_payload: unknown; p_actor: string }; Returns: unknown };
      clear_sitting_data: { Args: { p_cycle: string }; Returns: number };
      delete_sitting: { Args: { p_cycle: string }; Returns: number };
      // 0018 — SQL-editor clean re-ingest reset (returns the deleted-row count).
      reset_cycle_for_reingest: { Args: { p_cycle: string; p_actor?: string | null }; Returns: number };
      // 0020 — schema drift probe (columns/functions the code requires vs live DB).
      schema_health: { Args: Record<string, never>; Returns: unknown };
    };
    Enums: {
      cycle_status: CycleStatus;
      assessment_status: AssessmentStatus;
      item_status: ItemStatus;
      member_role: MemberRole;
      quality_rating: QualityRating;
      demand_level: DemandLevel;
      scheme_method: SchemeMethod;
      incident_source: IncidentSource;
      alteration_apply: AlterationApply;
    };
    CompositeTypes: Record<string, never>;
  };
}
