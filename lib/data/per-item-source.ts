/**
 * Raw per-item source for the Per-Item Speededness / Omission / Completion export.
 *
 * A read-only snapshot of one cycle's CURRENT items + responses per assessment, in
 * the app's existing assessment order, plus the participant drop-set (Clean-stage
 * removals + cohort exclusions) — exactly the inputs `getDiagnostics` starts from.
 * Nothing is filtered or computed here: the drop-set, the Max Score >= 1 item
 * filter, de-duplication and every metric are applied by the (separate) analysis
 * module in lib/export/per-item-analysis.ts, so the existing diagnostics path is
 * never touched.
 */

export interface PerItemSourceItem {
  /** App item id (QM QuestionId on live ingest; the items row UUID after DB hydrate). */
  id: string;
  /** QM's own QuestionId. Falls back to `id` upstream when the model doesn't carry it. */
  qmQuestionId: string | null;
  /** QM `QuestionDescription` (internal code/label); null until the sitting is (re-)ingested. */
  description: string | null;
  wording: string | null;
  major: string | null;
  sub: string | null;
  demand: string | null;
  /** QuestionMaximumScore — items below 1 are unscored and never enter diagnostics. */
  maxScore: number;
}

export interface PerItemSourceResponse {
  participantId: string;
  itemId: string;
  /** AnswerScore. */
  score: number;
  /** False when AnswerGivenChoiceNumber was blank (the omission definition). */
  answered: boolean;
  /** QM's per-sitting QuestionPresentedNumber, or null when not captured. */
  presentedNumber: number | null;
  /** AnswerResponseTimeSeconds, or null when missing. */
  responseTime: number | null;
}

export interface PerItemSourceAssessment {
  assessmentId: string;
  assessmentName: string;
  /** In stored item order (the ingest-time first-appearance order). */
  items: PerItemSourceItem[];
  responses: PerItemSourceResponse[];
  /** Participants removed at Clean (this subject) ∪ cohort-wide exclusions. */
  excludedParticipantIds: string[];
}

export interface PerItemSource {
  cycleId: string;
  /** The real source file name of the ingested export, or null when none is recorded. */
  sourceFileName: string | null;
  assessments: PerItemSourceAssessment[];
}
