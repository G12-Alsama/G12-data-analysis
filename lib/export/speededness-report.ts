/**
 * Speededness, Omission & Completion workbook — ported cell-by-cell from the
 * team's original `Speededness_OmissionRate_*.xlsx` manual analysis. Three
 * sheets: "README & Methodology", "Assessment Level", "Major Element Level".
 *
 * Two fields have no source in this app's diagnostics engine
 * (lib/diagnostics/index.ts's SpeededResult carries no response-time or
 * combined-accuracy figure) and are written as the literal text "Not sourced"
 * rather than fabricated: Median AnswerResponseTimeSeconds and Overall
 * Accuracy on the Assessment Level sheet.
 *
 * The whole "Major Element Level" sheet has no data source at all: the
 * diagnostics pipeline's DiagResponse records carry a demand-level and an
 * item-set tag but no major-element tag, so there is nothing to group by. It
 * is built with the original's exact headers/styling/CF and one explanatory
 * row instead of fabricated numbers — see the module doc in
 * lib/export/timing-report.ts for the matching gap on that workbook.
 */
import type { DiagnosticsModel, ReliabilityModel } from "@/lib/data/types";
import type { SpeededResult, DiagStatus } from "@/lib/diagnostics";
import { XLSX, styleCell, type CellStyle } from "./sheet-utils";
import { applyConditionalFormatting, rangeRef, type SheetCf } from "./ooxml-cf";

export const SPEEDEDNESS_SHEETS = ["README & Methodology", "Assessment Level", "Major Element Level"] as const;

export interface SpeededednessReportInput {
  cycleName: string;
  reliability: ReliabilityModel | null;
  diagnostics: DiagnosticsModel | null;
}

const NOT_SOURCED = "Not sourced";

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

function rowCells(participants: number | string, speeded: SpeededResult): unknown[] {
  return [
    participants,
    speeded.nItems,
    speeded.nPresentations,
    NOT_SOURCED,
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
    NOT_SOURCED,
    speedednessNote(speeded.speededStatus),
  ];
}

function readmeSheet(cycleName: string): XLSX.WorkSheet {
  const aoa: unknown[][] = [
    [`MCQ Psychometric Analysis — Assessment Level — ${cycleName}`],
    ["Source: this cycle's live QM export (response-time + answer columns)."],
    [],
    ["Metric", "Formula / Calculation", "Interpretation / Thresholds"],
    ["Number of Participants", "Distinct participants attempting at least one MCQ item in the assessment.", "Higher count = more stable interpretation."],
    ["Omission Rate", "Omitted item presentations ÷ total item presentations. An item is omitted when no answer was given.", "Good ≤ 5%; Review > 5% and ≤ 10%; Flag > 10%."],
    ["Completion Rate", "Completed item presentations ÷ total item presentations = 1 − Omission Rate.", "Good ≥ 95%; Review ≥ 90% and < 95%; Flag < 90%."],
    ["Speededness Index", "Average of two late-test signals: max(0, Late Omission − Early Omission) and max(0, Early Accuracy − Late Accuracy). Late items are the final 25% of unique items by presentation order.", "Good ≤ 5%; Review > 5% and ≤ 15%; Flag > 15%. Higher values suggest potential time pressure on later items."],
    ["Early / Late Accuracy", "Mean correctness for early items and late items respectively.", "Used internally to support the speededness calculation."],
    ["Early / Late Omission Rate", "Omission rate separately for early items and final-quartile late items.", "Used internally to support the speededness calculation."],
    [],
    ["Not sourced by this app's diagnostics engine (see column notes on the data sheets)", "Median AnswerResponseTimeSeconds, Overall Accuracy, and the Major Element Level breakdown."],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 11 } }];
  styleRange(ws, 0, 0, 0, 11, TITLE_STYLE);
  styleRange(ws, 1, 0, 1, 11, SUBTITLE_STYLE);
  styleRange(ws, 3, 0, 3, 2, HEADER_STYLE);
  ws["!cols"] = [{ wch: 32 }, { wch: 58 }, { wch: 60 }];
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
  const speedCol = base + 4, omitCol = base + 6, compCol = base + 7;
  const pctCols = [speedCol, omitCol, compCol, base + 10, base + 11, base + 12, base + 13]; // Speed/Omission/Completion/EarlyAcc/LateAcc/EarlyOmRate/LateOmRate
  for (let r = 4; r <= lastRow; r++) {
    for (const c of pctCols) setNumberFormat(ws, r, c, "0.0%");
  }
  ws["!cols"] = headers.map((h) => ({ wch: Math.min(48, Math.max(14, String(h).length + 2)) }));
  return { ws, speedCol, omitCol, compCol };
}

export interface SpeededednessBuildResult {
  workbook: XLSX.WorkBook;
  bytes: () => Promise<Uint8Array>;
}

export function buildSpeedednessWorkbook(input: SpeededednessReportInput): SpeededednessBuildResult {
  const wb = XLSX.utils.book_new();
  const cfSheets: SheetCf[] = [];

  XLSX.utils.book_append_sheet(wb, readmeSheet(input.cycleName), "README & Methodology");

  const assessments = input.diagnostics?.assessments ?? [];
  const participantsByAssessment = new Map<string, number>();
  for (const row of input.reliability?.rows ?? []) {
    if (row.level === "subject" && row.assessmentId) participantsByAssessment.set(row.assessmentId, row.totalParticipants);
  }

  const assessmentRows = assessments.map((a) =>
    [a.assessmentName, ...rowCells(participantsByAssessment.get(a.assessmentId) ?? NOT_SOURCED, a.whole.speeded)],
  );
  const assessmentLevel = dataSheet({
    title: `Assessment-Level Speededness, Omission, and Completion Analysis — ${input.cycleName}`,
    subtitle: "Interpret Speededness together with Omission Rate and Completion Rate. Small units can fluctuate because one or two students/items may change percentages substantially.",
    labelHeaders: ["AssessmentName"],
    rows: assessmentRows,
  });
  XLSX.utils.book_append_sheet(wb, assessmentLevel.ws, "Assessment Level");
  if (assessmentRows.length > 0) {
    cfSheets.push(speedednessCf(1, 5, 4 + assessmentRows.length, assessmentLevel.speedCol, assessmentLevel.omitCol, assessmentLevel.compCol));
  }

  // Major Element Level — no data source (DiagResponse carries demand-level and
  // item-set tags, but no major-element tag), so the sheet keeps the original's
  // exact header/style/CF shape with one explanatory row instead of numbers.
  const majorHeaders = ["AssessmentName", "QuestionMajorElement", ...ROW_HEADERS];
  const majorAoa: unknown[][] = [
    [`Major Element-Level Speededness, Omission, and Completion Analysis — ${input.cycleName}`],
    ["Interpret Speededness together with Omission Rate and Completion Rate. Small units can fluctuate because one or two students/items may change percentages substantially."],
    [],
    majorHeaders,
    ["Not available", "This app's diagnostics pipeline does not currently tag MCQ items with a major-element construct for speededness/timing — only demand-level and item-set groupings exist. See the PR notes.", ...majorHeaders.slice(2).map(() => "")],
  ];
  const majorWs = XLSX.utils.aoa_to_sheet(majorAoa);
  const majorLastCol = majorHeaders.length - 1;
  majorWs["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 11 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 11 } },
    { s: { r: 4, c: 1 }, e: { r: 4, c: majorLastCol } },
  ];
  styleRange(majorWs, 0, 0, 0, majorLastCol, TITLE_STYLE);
  styleRange(majorWs, 1, 0, 1, majorLastCol, SUBTITLE_STYLE);
  styleRange(majorWs, 3, 0, 3, majorLastCol, HEADER_STYLE);
  styleRange(majorWs, 4, 0, 4, majorLastCol, DATA_STYLE);
  majorWs["!cols"] = majorHeaders.map((h) => ({ wch: Math.min(48, Math.max(14, String(h).length + 2)) }));
  XLSX.utils.book_append_sheet(wb, majorWs, "Major Element Level");
  cfSheets.push(speedednessCf(2, 5, 5, 2 + 4, 2 + 6, 2 + 7));

  return {
    workbook: wb,
    bytes: async () => {
      const buf = XLSX.write(wb, { type: "buffer" }) as Buffer;
      return applyConditionalFormatting(buf, cfSheets);
    },
  };
}
