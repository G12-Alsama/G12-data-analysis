/**
 * Speededness, Omission & Completion workbook — ported cell-by-cell from the
 * team's original `Speededness_OmissionRate_*.xlsx` manual analysis. Three
 * sheets: "README & Methodology", "Assessment Level", "Major Element Level".
 *
 * Median AnswerResponseTimeSeconds and Overall Accuracy are additive fields
 * on SpeededResult (lib/diagnostics/index.ts) — both are pure derivations of
 * data that function's existing `accuracyOf`/records loop already gathers,
 * not new statistics. The Major Element Level breakdown is real data too,
 * from `speededByMajorElement()` (see lib/diagnostics/index.ts) — the
 * majorElement tag is the same curriculum-content-area field
 * lib/engine/reliability.ts already groups its own By_Assessment_Major sheet
 * by, just newly plumbed onto DiagResponse.
 */
import type { DiagnosticsModel, ReliabilityModel } from "@/lib/data/types";
import type { SpeededResult, DiagStatus } from "@/lib/diagnostics";
import { XLSX, styleCell, setColumnWidths, setRowHeightsFromExcelRows, type CellStyle } from "./sheet-utils";
import { applyConditionalFormatting, rangeRef, type SheetCf } from "./ooxml-cf";

export const SPEEDEDNESS_SHEETS = ["README & Methodology", "Assessment Level", "Major Element Level"] as const;

/** xlsx-js-style never writes `<sheetFormatPr>`, so every row without an
 * explicit height falls back to Excel's ~15pt default instead of the
 * original's. Same value on all three sheets in this workbook. */
const DEFAULT_ROW_HEIGHT = 13.8;

export interface SpeededednessReportInput {
  cycleName: string;
  reliability: ReliabilityModel | null;
  diagnostics: DiagnosticsModel | null;
}

const TITLE_STYLE: CellStyle = {
  font: { name: "Carlito", sz: 16, bold: true, color: { rgb: "FFFFFFFF" } },
  fill: { patternType: "solid", fgColor: { rgb: "FFB2375B" } },
  alignment: { horizontal: "left", vertical: "center", wrapText: true },
};
const SUBTITLE_STYLE: CellStyle = {
  font: { name: "Carlito", sz: 10, color: { rgb: "FF47535A" } },
  fill: { patternType: "solid", fgColor: { rgb: "FFF9F5F2" } },
  alignment: { vertical: "top", wrapText: true },
};
const THIN_BORDER = { style: "thin", color: { rgb: "FFD9D9D9" } } as const;
const HEADER_STYLE: CellStyle = {
  font: { name: "Carlito", sz: 11, bold: true },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER },
};
const DATA_STYLE: CellStyle = {
  font: { name: "Carlito", sz: 11 },
  alignment: { vertical: "top", wrapText: true },
  border: { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER },
};

function styleRange(ws: XLSX.WorkSheet, r0: number, c0: number, r1: number, c1: number, style: CellStyle): void {
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) styleCell(ws, r, c, style);
}
function setNumberFormat(ws: XLSX.WorkSheet, r: number, c: number, fmt: string): void {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr] as XLSX.CellObject | undefined;
  if (cell) cell.z = fmt;
}

// --- status/notes text mapping (pure text, off the app's own DiagStatus) ---

function omissionStatusLabel(s: DiagStatus): string {
  return { Good: "Good / Low omission", Review: "Review / Moderate omission", Flag: "Flag / High omission" }[s];
}
function completionStatusLabel(s: DiagStatus): string {
  return { Good: "Good / High completion", Review: "Review / Moderate completion", Flag: "Flag / Low completion" }[s];
}
function speedednessStatusLabel(s: DiagStatus): string {
  return { Good: "Good / Low pressure", Review: "Review / Moderate pressure", Flag: "Flag / Possible speededness" }[s];
}
function speedednessNote(s: DiagStatus): string {
  return {
    Good: "No strong speededness signal based on late items.",
    Review: "Moderate time-pressure signal; review alongside item position and difficulty.",
    Flag: "Possible time-pressure signal: later items show higher omissions and/or lower accuracy.",
  }[s];
}

const ROW_HEADERS = [
  "Number of Participants", "Number of Items", "Number of Item Responses", "Median AnswerResponseTimeSeconds",
  "Speededness Index", "Speededness Status", "Omission Rate", "Completion Rate", "Omission Status", "Completion Status",
  "Early Accuracy", "Late Accuracy", "Early Omission Rate", "Late Omission Rate", "Overall Accuracy", "Notes",
] as const;

function rowCells(participants: number | null, speeded: SpeededResult): unknown[] {
  return [
    participants,
    speeded.nItems,
    speeded.nPresentations,
    speeded.medianResponseTime,
    speeded.speedednessIndex,
    speedednessStatusLabel(speeded.speededStatus),
    speeded.omissionRate,
    speeded.completion,
    omissionStatusLabel(speeded.omissionStatus),
    completionStatusLabel(speeded.completionStatus),
    speeded.earlyAccuracy,
    speeded.lateAccuracy,
    speeded.earlyOmission,
    speeded.lateOmission,
    speeded.overallAccuracy,
    speedednessNote(speeded.speededStatus),
  ];
}

/** README & Methodology's exact original layout: a 4-column methodology
 * table (Metric / Formula / Data Used / Interpretation) plus a separate
 * Summary/Value side-table one gap column to the right — built with a
 * running row index (see reliability-report.ts's readmeSheet for why). The
 * Summary/Value counts are computed live from the SAME assessments feeding
 * the data sheets below, not copied from the original file. */
function readmeSheet(summary: { totalResponses: number; assessmentGroups: number; majorElementGroups: number; assessmentFlags: number; majorElementFlags: number }): XLSX.WorkSheet {
  const aoa: unknown[][] = [];
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
  const styled: { r0: number; c0: number; r1: number; c1: number; style: CellStyle }[] = [];
  let row = 0;
  const push = (cells: unknown[]): number => { aoa.push(cells); return row++; };
  const mergeFull = (r: number, c1: number): void => { merges.push({ s: { r, c: 0 }, e: { r, c: c1 } }); };

  const titleRow = push(["MCQ Psychometric Analysis — Assessment & Major Element Level"]);
  mergeFull(titleRow, 11);
  styled.push({ r0: titleRow, c0: 0, r1: titleRow, c1: 11, style: TITLE_STYLE });

  const sourceRow = push(["Source dataset: this cycle's live QM export"]);
  mergeFull(sourceRow, 11);
  styled.push({ r0: sourceRow, c0: 0, r1: sourceRow, c1: 11, style: SUBTITLE_STYLE });

  push([]);

  const headerRow = push(["Metric", "Formula / Calculation", "Data Used", "Interpretation / Thresholds", undefined, "Summary", "Value"]);
  styled.push({ r0: headerRow, c0: 0, r1: headerRow, c1: 3, style: HEADER_STYLE });
  styled.push({ r0: headerRow, c0: 5, r1: headerRow, c1: 6, style: HEADER_STYLE });

  push([
    "Number of Participants", "Unique count of ParticipantID within the assessment or major element. ParticipantEmail/ResultId used only as fallback if needed.",
    "ParticipantID, ParticipantEmail, ResultId", "Higher count = more stable interpretation.", undefined,
    "Total MCQ item response records used", summary.totalResponses,
  ]);
  push([
    "Median AnswerResponseTimeSeconds", "Median of AnswerResponseTimeSeconds across all item presentations in the unit.",
    "AnswerResponseTimeSeconds", "Median was selected instead of average because response time is usually skewed by pauses/outliers.", undefined,
    "Assessment groups produced", summary.assessmentGroups,
  ]);
  push([
    "Omission Rate", "Omitted item presentations ÷ total item presentations. An item is omitted when AnswerGivenChoiceNumber is blank or undefined.",
    "AnswerGivenChoiceNumber", "Good ≤ 5%; Review > 5% and ≤ 10%; Flag > 10%.", undefined,
    "Assessment × Major Element groups produced", summary.majorElementGroups,
  ]);
  push([
    "Completion Rate", "Completed item presentations ÷ total item presentations = 1 − Omission Rate.",
    "AnswerGivenChoiceNumber", "Good ≥ 95%; Review ≥ 90% and < 95%; Flag < 90%.", undefined,
    "Assessment-level rows flagged for possible speededness", summary.assessmentFlags,
  ]);
  push([
    "Speededness Index",
    "Average of two positive late-test signals: max(0, Late Omission Rate − Early Omission Rate) and max(0, Early Accuracy − Late Accuracy). Late items are the final 25% of unique items by QuestionPresentedNumber within the analysis unit.",
    "QuestionPresentedNumber, AnswerGivenChoiceNumber, AnswerScore",
    "Good ≤ 5%; Review > 5% and ≤ 15%; Flag > 15%. Higher values suggest potential time pressure on later items.", undefined,
    "Major-element rows flagged for possible speededness", summary.majorElementFlags,
  ]);
  push([
    "Early / Late Accuracy", "Mean AnswerScore for early items and late items. Omitted items contribute 0 because AnswerScore is 0/blank for unanswered rows.",
    "AnswerScore, QuestionPresentedNumber", "Used internally to support the speededness calculation.",
  ]);
  push([
    "Early / Late Omission Rate", "Omission rate separately for early items and final-quartile late items.",
    "AnswerGivenChoiceNumber, QuestionPresentedNumber", "Used internally to support the speededness calculation.",
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = merges;
  for (const s of styled) styleRange(ws, s.r0, s.c0, s.r1, s.c1, s.style);
  setColumnWidths(ws, { A: 32.796875, B: 58.0, C: 34.0, D: 91.8984375, F: 42.0, G: 18.0 }, 12);
  setRowHeightsFromExcelRows(ws, { 1: 40.05, 4: 27.0, 5: 27.6, 6: 27.6, 7: 27.6, 8: 27.6, 9: 55.2, 10: 27.6 });
  return ws;
}

/** The Speededness Index / Omission Rate / Completion Rate CF triples, at the
 * given 0-based column offsets within the row (identical bands the app's own
 * `speededness()` uses — see lib/diagnostics/index.ts's `band()` calls). */
function speedednessCf(sheetIndex: number, firstRow: number, lastRow: number, speedCol: number, omitCol: number, compCol: number): SheetCf {
  const col = (c: number) => XLSX.utils.encode_col(c);
  const rangeOf = (c: number) => rangeRef(col(c), firstRow, col(c), lastRow);
  const speedRange = rangeOf(speedCol), omitRange = rangeOf(omitCol), compRange = rangeOf(compCol);
  const cellAt = (c: number) => `${col(c)}${firstRow}`;
  const green = { fontColor: "FF006100", fillColor: "FFE2F0D9", fillAttr: "bg" as const };
  const amber = { fontColor: "FF9C6500", fillColor: "FFFFF2CC", fillAttr: "bg" as const };
  const red = { fontColor: "FF9C0006", fillColor: "FFF4CCCC", fillAttr: "bg" as const };
  return {
    sheetIndex,
    rules: [
      { kind: "expression", sqref: speedRange, formula: `AND(${cellAt(speedCol)}<>"",${cellAt(speedCol)}<=0.05)`, dxf: green },
      { kind: "expression", sqref: speedRange, formula: `AND(${cellAt(speedCol)}>0.05,${cellAt(speedCol)}<=0.15)`, dxf: amber },
      { kind: "expression", sqref: speedRange, formula: `${cellAt(speedCol)}>0.15`, dxf: red },
      { kind: "expression", sqref: omitRange, formula: `AND(${cellAt(omitCol)}<>"",${cellAt(omitCol)}<=0.05)`, dxf: green },
      { kind: "expression", sqref: omitRange, formula: `AND(${cellAt(omitCol)}>0.05,${cellAt(omitCol)}<=0.1)`, dxf: amber },
      { kind: "expression", sqref: omitRange, formula: `${cellAt(omitCol)}>0.1`, dxf: red },
      { kind: "expression", sqref: compRange, formula: `${cellAt(compCol)}>=0.95`, dxf: green },
      { kind: "expression", sqref: compRange, formula: `AND(${cellAt(compCol)}>=0.9,${cellAt(compCol)}<0.95)`, dxf: amber },
      { kind: "expression", sqref: compRange, formula: `AND(${cellAt(compCol)}<0.9,${cellAt(compCol)}<>"")`, dxf: red },
    ],
  };
}

function dataSheet(opts: {
  title: string;
  subtitle: string;
  labelHeaders: readonly string[];
  columnWidths: Record<string, number>;
  rowHeights: Record<number, number>;
  rows: unknown[][];
}): { ws: XLSX.WorkSheet; speedCol: number; omitCol: number; compCol: number } {
  const headers = [...opts.labelHeaders, ...ROW_HEADERS];
  const lastCol = headers.length - 1;
  const aoa: unknown[][] = [[opts.title], [opts.subtitle], [], headers, ...opts.rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 11 } }];
  styleRange(ws, 0, 0, 0, lastCol, TITLE_STYLE);
  styleRange(ws, 1, 0, 1, lastCol, SUBTITLE_STYLE);
  styleRange(ws, 3, 0, 3, lastCol, HEADER_STYLE);
  const lastRow = 3 + opts.rows.length;
  styleRange(ws, 4, 0, lastRow, lastCol, DATA_STYLE);

  const base = opts.labelHeaders.length;
  const medianTimeCol = base + 3;
  const speedCol = base + 4, omitCol = base + 6, compCol = base + 7;
  const pctCols = [speedCol, omitCol, compCol, base + 10, base + 11, base + 12, base + 13]; // Speed/Omission/Completion/EarlyAcc/LateAcc/EarlyOmRate/LateOmRate
  for (let r = 4; r <= lastRow; r++) {
    setNumberFormat(ws, r, medianTimeCol, "0.0");
    for (const c of pctCols) setNumberFormat(ws, r, c, "0.0%");
  }
  setColumnWidths(ws, opts.columnWidths, headers.length);
  setRowHeightsFromExcelRows(ws, opts.rowHeights);
  return { ws, speedCol, omitCol, compCol };
}

export interface SpeededednessBuildResult {
  workbook: XLSX.WorkBook;
  bytes: () => Promise<Uint8Array>;
}

export function buildSpeedednessWorkbook(input: SpeededednessReportInput): SpeededednessBuildResult {
  const assessments = input.diagnostics?.assessments ?? [];
  const participantsByAssessment = new Map<string, number>();
  for (const row of input.reliability?.rows ?? []) {
    if (row.level === "subject" && row.assessmentId) participantsByAssessment.set(row.assessmentId, row.totalParticipants);
  }

  // Compute every sheet's rows up front — README's live Summary/Value table
  // needs the other two sheets' row counts, and building it first (rather
  // than appending it last and reordering `wb.SheetNames`) keeps sheet
  // append order matching reading order matching CF sheetIndex, with no
  // indirection to keep in sync.
  const assessmentRows = assessments.map((a) =>
    [a.assessmentName, ...rowCells(participantsByAssessment.get(a.assessmentId) ?? null, a.whole.speeded)],
  );
  const majorRows: unknown[][] = [];
  for (const a of assessments) {
    const participants = participantsByAssessment.get(a.assessmentId) ?? null;
    for (const m of a.byMajorElement) {
      majorRows.push([a.assessmentName, m.majorElement, ...rowCells(participants, m.speeded)]);
    }
  }
  const totalResponses = assessments.reduce((acc, a) => acc + a.whole.speeded.nPresentations, 0);
  const assessmentFlags = assessments.filter((a) => a.whole.speeded.speededStatus === "Flag").length;
  const majorElementFlags = assessments.reduce(
    (acc, a) => acc + a.byMajorElement.filter((m) => m.speeded.speededStatus === "Flag").length,
    0,
  );

  const wb = XLSX.utils.book_new();
  const cfSheets: SheetCf[] = [{ sheetIndex: 0, rules: [], defaultRowHeight: DEFAULT_ROW_HEIGHT }];

  XLSX.utils.book_append_sheet(
    wb,
    readmeSheet({
      totalResponses,
      assessmentGroups: assessments.length,
      majorElementGroups: majorRows.length,
      assessmentFlags,
      majorElementFlags,
    }),
    "README & Methodology",
  );

  const assessmentLevel = dataSheet({
    title: "Assessment-Level Speededness, Omission, and Completion Analysis",
    subtitle: "Interpret Speededness together with Omission Rate and Completion Rate. Small units can fluctuate because one or two students/items may change percentages substantially.",
    labelHeaders: ["AssessmentName"],
    columnWidths: { A: 28.0, B: 15.0, E: 28.796875, F: 15.0, J: 24.0, L: 15.0, Q: 48.0 },
    rowHeights: { 1: 40.05, 4: 31.65, 5: 31.65, 6: 21.15, 7: 31.65, 8: 31.65, 9: 21.15 },
    rows: assessmentRows,
  });
  XLSX.utils.book_append_sheet(wb, assessmentLevel.ws, "Assessment Level");
  cfSheets.push({
    ...(assessmentRows.length > 0
      ? speedednessCf(1, 5, 4 + assessmentRows.length, assessmentLevel.speedCol, assessmentLevel.omitCol, assessmentLevel.compCol)
      : { sheetIndex: 1, rules: [] }),
    defaultRowHeight: DEFAULT_ROW_HEIGHT,
  });

  // Major Element Level — real data from speededByMajorElement(), grouped by
  // assessment (appearance order) with major elements alphabetical within,
  // matching By_Assessment_Major's ordering in the reliability workbook.
  const majorElementLevel = dataSheet({
    title: "Major Element-Level Speededness, Omission, and Completion Analysis",
    subtitle: "Interpret Speededness together with Omission Rate and Completion Rate. Small units can fluctuate because one or two students/items may change percentages substantially.",
    labelHeaders: ["AssessmentName", "QuestionMajorElement"],
    columnWidths: { A: 23.0, B: 39.09765625, C: 15.0, F: 32.796875, G: 15.0, H: 24.19921875, I: 15.0, K: 24.0, M: 15.0, R: 72.19921875 },
    rowHeights: {
      1: 40.05, 4: 31.65, 5: 21.15, 6: 21.15, 7: 21.15, 8: 31.65, 9: 31.65, 10: 31.65,
      11: 21.15, 12: 21.15, 13: 21.15, 14: 21.15, 15: 31.65, 16: 21.15, 17: 31.65, 18: 31.65, 19: 21.15, 20: 31.65,
    },
    rows: majorRows,
  });
  XLSX.utils.book_append_sheet(wb, majorElementLevel.ws, "Major Element Level");
  cfSheets.push({
    ...(majorRows.length > 0
      ? speedednessCf(2, 5, 4 + majorRows.length, majorElementLevel.speedCol, majorElementLevel.omitCol, majorElementLevel.compCol)
      : { sheetIndex: 2, rules: [] }),
    defaultRowHeight: DEFAULT_ROW_HEIGHT,
  });

  return {
    workbook: wb,
    bytes: async () => {
      const buf = XLSX.write(wb, { type: "buffer" }) as Buffer;
      return applyConditionalFormatting(buf, cfSheets);
    },
  };
}
