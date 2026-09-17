/**
 * Types for the Questionmark ingest + validation pipeline (Sections 5 & 10).
 */

import type { DemandLevel } from "@/lib/types/database";

/** A raw row from the Questionmark export (xlsx `in` sheet or csv). */
export type RawExportRow = Record<string, unknown>;

/** A cleaned, MCQ-only, encoding-repaired response in long format. */
export interface CleanResponse {
  assessmentName: string;
  qmQuestionId: string;
  /** The export's `ResultId` — the result→participant mapping. Carried so the
   *  detection-boundary invariant can compare distinct sitters (results) against
   *  distinct output participants (pseudonyms) per subject. */
  qmResultId: string;
  /** Stable INTERNAL participant id — a deterministic 1:1 mint of the collision-free
   *  natural key (ParticipantID / email = ResultParticipantName / result id); never a
   *  name-, initial- or DOB-shaped field. See participant-identity.ts. */
  qmParticipantId: string;
  participantPseudonym: string;
  wording: string | null;
  /** The item's `QuestionDescription` (an internal code/label), or null. */
  description: string | null;
  /** The `QuestionParentQuestionWording` — the stimulus/parent passage shown
   *  above a question (e.g. an English reading/listening passage), or null when
   *  the item has no parent (`<Not defined>` in the export). */
  parentWording: string | null;
  majorElement: string | null;
  subElement: string | null;
  demandLevel: DemandLevel | null;
  /** Item-set / shared-stimulus name (e.g. a reading passage), or null. */
  itemSet: string | null;
  questionType: string;
  maxScore: number;
  answerGiven: string | null;
  /**
   * The export's `AnswerGivenChoiceNumber` — QM's own answer-index field, blank
   * (normalised to null) when the item was left unanswered. Unlike `answerGiven`
   * (which carries the sentinel text "<Not defined>" for an unanswered item, a
   * truthy string), this is the field to key "was this item answered?" off of.
   */
  answerGivenChoiceNumber: string | null;
  answerScore: number;
  responseTime: number | null;
  resultStatus: string | null;
}

export type CheckStatus = "pass" | "warn" | "fail";

export interface ValidationCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  count?: number;
}

export interface ValidationReport {
  /** True when no check hard-failed. Warnings do not block. */
  passed: boolean;
  checks: ValidationCheck[];
  stats: {
    rawRows: number;
    mcqRows: number;
    droppedSurveyRows: number;
    droppedNonMcqRows: number;
    assessments: number;
    participants: number;
    items: number;
  };
}

export interface IngestOptions {
  /** Preferred sheet name for xlsx files. Defaults to "in". */
  sheetName?: string;
}
