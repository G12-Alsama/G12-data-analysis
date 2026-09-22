/**
 * The Questionmark "cleaned" schema — the exact columns, in order, of the cleaned
 * export the team reads in Excel. The Clean step renders an on-screen view of the
 * cleaned set using this layout so it mirrors their spreadsheet column-for-column.
 *
 * The app's pipeline is de-identified: it keeps the response/score matrix and item
 * metadata, but NOT the participant PII (email, date of birth, gender, …) or the
 * QM-only per-response metadata (topic ids, possible answers, …). Those columns
 * are still shown — in their canonical position — but stay blank, so the layout
 * matches the Excel without ever fabricating or surfacing PII the app never held.
 * GDPR: blank PII columns must never be back-filled, and this view is read-only —
 * it is never added to any export that doesn't already carry that data.
 */

/** The cleaned-export columns, in the exact order the team's spreadsheet uses. */
export const CLEANED_DATA_COLUMNS = [
  "ResultId",
  "QuestionId",
  "QuestionDescription",
  "QuestionType",
  "QuestionTopicId",
  "QuestionSubElement",
  "QuestionTopicPath",
  "QuestionPresentedNumber",
  "QuestionWording",
  "QuestionCorrectAnswers",
  "QuestionCorrectAnswersChoiceNumber",
  "QuestionPossibleAnswers",
  "QuestionPossibleAnswersCount",
  "QuestionMinimumScore",
  "QuestionMaximumScore",
  "QuestionStatus",
  "AnswerGiven",
  "AnswerGivenChoiceNumber",
  "AnswerScore",
  "AnswerComment",
  "AnswerResponseTimeSeconds",
  "MetaTags",
  "TopicQuestionCount",
  "AssessmentId",
  "AssessmentName",
  "ParticipantEmail",
  "ResultParticipantFirstName",
  "ResultParticipantLastName",
  "ResultGroupName",
  "ResultParticipantDetails",
  "ParticipantDateOfBirth",
  "ParticipantGender",
  "ResultStatus",
  "ResultAssessmentAttemptNumber",
  "ResultResponseTimeSeconds",
  "AssessmentTimeLimitMinutes",
  "ResultTotalScore",
  "ResultPercentageScore",
  "ResultMaximumScore",
  "Feedback",
  "ParticipantFullName",
  "ParticipantID",
  "QuestionMajorElement",
] as const;

export type CleanedDataColumn = (typeof CLEANED_DATA_COLUMNS)[number];

/**
 * Columns the de-identified app does not retain — shown (in position) but blank.
 * Includes PII (kept blank by design) and QM-only per-response metadata that the
 * ingest drops. Used by the UI to mark a column as expected-blank in the header.
 */
export const CLEANED_DATA_UNAVAILABLE: ReadonlySet<CleanedDataColumn> = new Set<CleanedDataColumn>([
  "QuestionTopicId",
  "QuestionTopicPath",
  "QuestionCorrectAnswers",
  "QuestionCorrectAnswersChoiceNumber",
  "QuestionPossibleAnswers",
  "QuestionPossibleAnswersCount",
  "AnswerComment",
  "MetaTags",
  "TopicQuestionCount",
  "ResultParticipantFirstName",
  "ResultParticipantLastName",
  "ResultGroupName",
  "ResultParticipantDetails",
  "ParticipantDateOfBirth",
  "ParticipantGender",
  "ResultAssessmentAttemptNumber",
  "ResultResponseTimeSeconds",
  "AssessmentTimeLimitMinutes",
  "Feedback",
]);

/**
 * PII columns — kept blank by design; never back-fill or export.
 *
 * `ParticipantEmail` is NOT here: it is the participant identity key (the
 * lower-cased email = `ParticipantID`), carried as its own column so a
 * participant's sittings group across subjects independently of the `ResultId`
 * sitting key. It surfaces the SAME value already shown as `ParticipantID` (no new
 * exposure); date-of-birth and gender remain blanked PII.
 */
export const CLEANED_DATA_PII: ReadonlySet<CleanedDataColumn> = new Set<CleanedDataColumn>([
  "ParticipantDateOfBirth",
  "ParticipantGender",
]);
