/**
 * Shape of the generated seed (`seed.generated.json`), produced by
 * `scripts/build-seed.mts` by running the real ingest + engine over
 * `data/sample_qm_export.xlsx`. The in-memory DataProvider reads this; no
 * database is involved in this build.
 *
 * Everything here is genuine computed output except where a field is marked
 * `mock` (prior cycles, which have no data source yet).
 */

import type { QualityRating } from "@/lib/engine";
import type { AssessmentDiagnostics } from "@/lib/diagnostics";
import type { ValidationReport } from "@/lib/ingest/types";
import type { TestCentreSummary } from "./types";

/** One multiple-choice answer option for a question (from the QM export). */
export interface SeedAnswerOption {
  /** Display label for the choice — A, B, C… in presented order. */
  label: string;
  /** Cleaned option text (HTML/entities stripped). */
  text: string;
  /** True when this option is (one of) the correct answer(s). */
  correct: boolean;
}

export interface SeedItem {
  id: string;
  wording: string | null;
  /**
   * The item's `QuestionDescription` (an internal code/label) and its
   * `QuestionParentQuestionWording` (the stimulus/parent passage shown above the
   * question). Optional — only the generated demo seed carries these; live/DB-
   * hydrated items leave them absent (same precedent as `options`).
   */
  description?: string | null;
  parentWording?: string | null;
  major: string | null;
  sub: string | null;
  demand: string | null;
  /**
   * Item-set / shared-stimulus name (a passage/prompt shared by several items), or
   * null when ungrouped. Carried so Assessment Health diagnostics can be recomputed
   * live from `SeedAssessment.items`/`responses` (see `getDiagnostics`) instead of
   * only from the ingest-time snapshot.
   */
  itemSet?: string | null;
  maxScore: number;
  /**
   * The question's multiple-choice answer options, from the QM export
   * (`QuestionPossibleAnswers` / `QuestionCorrectAnswers`). Optional — only the
   * generated demo seed carries these; live/DB-hydrated items leave it absent.
   */
  options?: SeedAnswerOption[] | null;
  /** Participants who answered (engine n) and were presented the item. */
  participantsAnswered: number;
  participantsPresented: number;
  avgResponseTime: number | null;
  // engine statistics
  pValue: number;
  pRating: QualityRating;
  itemTotal: number | null;
  itRating: QualityRating;
  pointBiserial: number | null;
  pbRating: QualityRating;
  discrimination: number;
  discRating: QualityRating;
  overallReview: QualityRating;
  /** Derived 0–100 quality index (transparent composite of the four ratings). */
  qualityIndex: number;
}

export interface SeedResponse {
  p: string; // participant id
  i: string; // item id
  s: number; // score
  /**
   * Whether the participant actually attempted the item. Omitted (treated as
   * answered) for the common case; set to `false` only when the item was
   * presented but left blank. Read as `answered = r.a !== false`. Used for the
   * display-only "% of D3 questions answered" per-student metric.
   */
  a?: boolean;
  /**
   * The raw `AnswerGivenChoiceNumber` (blank normalised to null upstream). The
   * authoritative "was this presented item actually answered?" signal — unlike the
   * raw `AnswerGiven` text (which carries QM's "<Not defined>" sentinel for an
   * unanswered item), this is genuinely blank/null with no sentinel ambiguity.
   */
  answerGivenChoiceNumber?: string | null;
  /** The QM `AnswerGiven` value (raw answer text/choice), for the cleaned export. */
  answerGiven?: string | null;
  /** The QM response time in seconds, for the cleaned export. */
  responseTime?: number | null;
}

/** A participant whose sitting of this assessment finished with a technical-fault status. */
export interface SeedTechnicalIncident {
  /** participant id */
  p: string;
  /** the raw result_status flag, e.g. 'Finished Abnormally' / 'Time Limit Exceeded'. */
  status: string;
}

export interface SeedAssessment {
  id: string;
  name: string;
  shortName: string;
  rtl: boolean;
  stageIndex: number;
  items: SeedItem[];
  responses: SeedResponse[];
  /**
   * Participants whose sitting of this assessment finished with a technical-fault
   * result status (non-normal). Display-only — feeds the per-student technical-
   * incident count; never affects scoring. Absent/empty when all finished OK.
   */
  technicalIncidents?: SeedTechnicalIncident[];
  /**
   * Per-participant SITTING key for this subject: participant id → the QM
   * `ResultId` (one sitting per participant × subject). The cleaned export keys its
   * `ResultId` column on this so a participant's separate subject-sittings stay
   * distinct records (never one synthetic id per participant). Optional — legacy
   * seeds without it fall back to the participant id.
   */
  resultIdByParticipant?: Record<string, string>;
}

export interface SeedParticipant {
  /** Stable internal key (pseudonym in the demo seed; row UUID on live data). */
  id: string;
  /** Display name (full name on live data; "Student NN" in the de-identified demo). */
  label: string;
  /** Human Student ID for display (qm_participant_id on live data). Falls back to `id`. */
  studentId?: string;
}

export interface SeedPreview {
  headers: string[];
  rows: (string | number | null)[][];
}

/**
 * Diagnostics for one assessment: a single whole-assessment speededness + timing
 * measure, a demand-level speededness lens, and omission rate by item position.
 * (Construct/element breakdowns were removed — they were not actionable.)
 */
export interface SeedAssessmentDiagnostics extends AssessmentDiagnostics {
  assessmentId: string;
  assessmentName: string;
}

export interface SeedLiveCycle {
  id: string;
  name: string;
  region: string;
  /** 0010 — the test centre this sitting belongs to (via its year). Optional so
   *  legacy/demo seeds without it still load (defaulted to the primary centre). */
  testCentreId?: string;
  /** 0013 — the real exam_years.id this sitting groups under (live data only).
   *  Absent in the demo seed (no database year rows); carried so the Years list
   *  can target the year-reassignment RPC. */
  yearId?: string;
  startedAt: string;
  lastActivity: string;
  stageIndex: number;
  fileName: string;
  fileSizeMB: number;
  /**
   * The three Questionmark CSVs recognised at ingest (by columns). Optional so
   * legacy seeds / generated data without it still load; the provider defaults the
   * absent kinds to null.
   */
  files?: { items: string | null; assessments: string | null; topics: string | null };
  uploadedAgo: string;
  validation: ValidationReport;
  preview: SeedPreview;
  duplicates: number;
  participants: SeedParticipant[];
  assessments: SeedAssessment[];
  /** Informational speededness/timing diagnostics, computed at build time. */
  diagnostics: SeedAssessmentDiagnostics[];
  /**
   * The authoritative per-sitting roster — one entry per (participant × subject),
   * mirrored from the `sittings` table (migration 0026). This is the source every
   * INGEST-stage participant count reads (`count(distinct participant_email)` per
   * subject / per cycle), NOT the MCQ `responses` matrix — the two agree on
   * correctly-ingested data, but `sittings` is the roster of record and includes a
   * sitter even when a subject carries non-MCQ questions. Optional — legacy seeds
   * without it fall back to the response matrix.
   */
  sittings?: SeedSitting[];
}

/** One row of the sitting spine, carried into the seed for the ingest-roster count. */
export interface SeedSitting {
  /** The subject this sitting belongs to. */
  assessmentId: string;
  /** Participant row id / pseudonym (the seed's participant key). */
  participantId: string;
  /** Participant email — the `count(distinct participant_email)` natural key. */
  participantEmail: string;
}

export interface SeedPriorCycle {
  id: string;
  name: string;
  /** 0010 — the test centre this sitting belongs to (via its year). */
  testCentreId?: string;
  /** 0013 — the real exam_years.id this sitting groups under (live data only). */
  yearId?: string;
  stageIndex: number;
  stepsDone: number;
  participants: number;
  assessments: number;
  lastActivity: string;
  locked: boolean;
  /** Always true — prior cycles have no real data source yet. */
  mock: boolean;
}

export interface Seed {
  generatedAt: string;
  engineVersion: string;
  liveCycle: SeedLiveCycle;
  priorCycles: SeedPriorCycle[];
  /** 0010 — test centres (top-level scoping dimension). Absent in legacy/demo
   *  seeds; the provider falls back to a single active centre. */
  testCentres?: TestCentreSummary[];
}
