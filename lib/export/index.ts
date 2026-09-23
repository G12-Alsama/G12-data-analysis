/**
 * Excel export module (Section 9). Generates the workbooks that match the
 * team's reference templates and a helper to serialise to a Buffer.
 *
 * Generation uses `xlsx-js-style` (a drop-in SheetJS fork) so cell fills are
 * written — the item-analysis rating columns are colour-coded green/amber/red.
 * The item-analysis workbook is reconciled to the exact `MCQ_Item_Analysis`
 * layout: a "README & Summary" sheet plus one titled sheet per assessment with
 * the canonical 20-column header and a single Remove/Reason pair.
 *
 * The Assessment Health step exports three separate workbooks — Reliability,
 * Speededness, Timing — each reconciled cell-by-cell against its own original
 * manual-analysis file (see reference/assessment_health_reports/originals).
 * Their live conditional-formatting rules go beyond what xlsx-js-style can
 * write, so each builder's `bytes()` patches real `<conditionalFormatting>`/
 * `<dxf>` XML in afterwards — see lib/export/ooxml-cf.ts.
 */

export {
  buildItemAnalysisWorkbook,
  ITEM_ANALYSIS_HEADERS,
  ITEM_ANALYSIS_SUMMARY_HEADERS,
} from "./item-analysis";
export { assembleItemAnalysis } from "./assemble";
export {
  buildScoreAnalysisWorkbook,
  assembleScoreAnalysis,
  SCORE_ANALYSIS_SHEETS,
} from "./score-analysis";
export {
  buildGradesWorkbook,
  GRADES_STUDENT_HEADERS,
  GRADES_SHEETS,
  DEFAULT_SUBJECT_COLUMNS,
} from "./grades";
export {
  buildPerformanceReportWorkbook,
  PERFORMANCE_REPORT_SHEETS,
  STUDENT_SUMMARY_HEADERS,
} from "./performance-report";
export type {
  PerformanceReportInput,
  PRSubject,
  PRStudent,
  PRStudentSubject,
  PRSummarySubject,
} from "./performance-report";
export {
  buildAlterationsSheet,
  ALTERATION_HEADERS,
  ALTERATIONS_SHEET_NAME,
} from "./alterations";
export {
  buildReliabilityWorkbook,
  RELIABILITY_SHEETS,
} from "./reliability-report";
export type { ReliabilityReportInput, ReliabilityBuildResult } from "./reliability-report";
export {
  buildSpeedednessWorkbook,
  SPEEDEDNESS_SHEETS,
} from "./speededness-report";
export type { SpeededednessReportInput, SpeededednessBuildResult } from "./speededness-report";
export {
  buildTimingWorkbook,
  TIMING_SHEETS,
} from "./timing-report";
export type { TimingReportInput, TimingBuildResult } from "./timing-report";
export {
  buildBoundariesWorkbook,
  BOUNDARIES_SHEETS,
  CUTSCORE_HEADERS,
} from "./boundaries";
export type { BoundariesExportInput } from "./boundaries";
export { buildCleanedMasterWorkbook, CLEANED_MASTER_SHEET } from "./cleaned-master";
export { workbookToBuffer, sanitizeSheetName, RATING_STYLES, PERFORMANCE_STYLES } from "./sheet-utils";
export type * from "./types";
