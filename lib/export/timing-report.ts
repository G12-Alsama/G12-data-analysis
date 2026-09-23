/**
 * Timing & Performance workbook — ported cell-by-cell from the team's
 * original `Timing_Performance_Analysis_*.xlsx` manual analysis. Three
 * sheets: "README", "Assessment Level", "Major Element Level".
 *
 * This app's TimingResult (lib/diagnostics/index.ts) only carries the
 * correlation pair (Pearson/Spearman between median item time and score %)
 * plus the student count — no raw response-time or score aggregate reaches
 * it. Number of Items/Item Responses are cross-referenced from the sibling
 * SpeededResult for the same assessment (already computed off the same
 * response set); Number of Participants from the sibling ReliabilityRow.
 * Median/mean response-time figures, the score-percentage aggregates, median
 * completion rate, and the separate "Total Time–Performance Correlation"
 * have no source anywhere in the app and are written as the literal text
 * "Not sourced" rather than fabricated.
 *
 * The "Major Element Level" sheet has no data source at all — the
 * diagnostics pipeline's DiagResponse records carry a demand-level and an
 * item-set tag but no major-element tag. It keeps the original's exact
 * header/style/CF shape with one explanatory row instead of fabricated rows.
 */
import type { DiagnosticsModel, ReliabilityModel } from "@/lib/data/types";
import type { TimingResult } from "@/lib/diagnostics";
import { XLSX, styleCell, type CellStyle } from "./sheet-utils";
import { applyConditionalFormatting, rangeRef, type SheetCf } from "./ooxml-cf";

export const TIMING_SHEETS = ["README", "Assessment Level", "Major Element Level"] as const;

export interface TimingReportInput {
  cycleName: string;
  reliability: ReliabilityModel | null;
  diagnostics: DiagnosticsModel | null;
}

const NOT_SOURCED = "Not sourced";

const TITLE_STYLE: CellStyle = {
  font: { name: "Barlow Semi Condensed", sz: 18, bold: true, color: { rgb: "FF25232E" } },
};
const SUBTITLE_STYLE: CellStyle = {
  font: { name: "Barlow", sz: 10, color: { rgb: "FF47535A" } },
};
const HEADER_STYLE: CellStyle = {
  font: { name: "Barlow", sz: 11, bold: true, color: { rgb: "FFFFFFFF" } },
  fill: { patternType: "solid", fgColor: { rgb: "FFB2375B" } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
};
const DATA_STYLE: CellStyle = {
  font: { name: "Barlow", sz: 10 },
  alignment: { horizontal: "center" },
};

function styleRange(ws: XLSX.WorkSheet, r0: number, c0: number, r1: number, c1: number, style: CellStyle): void {
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) styleCell(ws, r, c, style);
}
function setNumberFormat(ws: XLSX.WorkSheet, r: number, c: number, fmt: string): void {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr] as XLSX.CellObject | undefined;
  if (cell) cell.z = fmt;
}

// --- correlation → text bands (same 0.1/0.3/0.5/0.7 breakpoints the app's
// own `correlationStrength()` in lib/diagnostics/index.ts already uses; this
// just re-derives the original workbook's split Strength/Review/Interpretation
// columns from that already-computed magnitude, no new statistic). ----------

type Magnitude = "negligible" | "weak" | "moderate" | "strong" | "verystrong";
function magnitudeOf(r: number | null): Magnitude {
  if (r === null) return "negligible";
  const a = Math.abs(r);
  if (a < 0.1) return "negligible";
  if (a < 0.3) return "weak";
  if (a < 0.5) return "moderate";
  if (a < 0.7) return "strong";
  return "verystrong";
}
const STRENGTH_LABEL: Record<Magnitude, string> = {
  negligible: "Very weak / negligible", weak: "Weak", moderate: "Moderate", strong: "Strong", verystrong: "Very strong",
};
function reviewStatus(r: number | null): string {
  const m = magnitudeOf(r);
  if (m === "negligible") return "Neutral: limited relationship";
  if (r !== null && r < 0) return m === "weak" ? "Monitor: weak negative relationship" : "Review: time may be linked to lower performance";
  return "Informative: more time linked to better performance";
}
function interpretationOf(r: number | null): string {
  if (magnitudeOf(r) === "negligible") return "Near zero: limited relationship";
  return r !== null && r < 0 ? "Negative: more time associated with lower performance" : "Positive: more time associated with higher performance";
}

const ROW_HEADERS = [
  "Number of Participants", "Number of Items", "Number of Item Responses",
  "Median Response Time per Item (sec)", "Mean Response Time per Item (sec)", "Median Total Response Time (sec)",
  "Mean Score (%)", "Median Score (%)", "Median Completion Rate",
  "Time–Performance Correlation (Pearson)", "Time–Performance Correlation (Spearman)",
  "Total Time–Performance Correlation (Pearson)", "Correlation Strength", "Review Status", "Interpretation",
] as const;

function rowCells(participants: number | string, items: number, itemResponses: number, timing: TimingResult): unknown[] {
  return [
    participants,
    items,
    itemResponses,
    NOT_SOURCED, NOT_SOURCED, NOT_SOURCED,
    NOT_SOURCED, NOT_SOURCED, NOT_SOURCED,
    timing.pearson ?? "n/a",
    timing.spearman ?? "n/a",
    NOT_SOURCED,
    STRENGTH_LABEL[magnitudeOf(timing.pearson)],
    reviewStatus(timing.pearson),
    interpretationOf(timing.pearson),
  ];
}

function readmeSheet(cycleName: string): XLSX.WorkSheet {
  const aoa: unknown[][] = [
    [`G12++ MCQ Timing & Performance Analysis — ${cycleName}`],
    [],
    ["This workbook analyses whether students who spent more time tended to perform better or worse. The primary time metric is the participant-level median item response time because it is less affected by pauses and extreme outliers than average time."],
    [],
    ["Methodology"],
    ["• The primary correlation is between each student's median item response time and their score percentage, computed with both Pearson and Spearman coefficients."],
    ["• Positive correlation means students who took more time tended to score higher; negative correlation means students who took more time tended to score lower."],
    [],
    ["Correlation Strength bands"],
    ["|r| < 0.10", "Very weak / negligible"],
    ["0.10 – 0.29", "Weak"],
    ["0.30 – 0.49", "Moderate"],
    ["0.50 – 0.69", "Strong"],
    ["≥ 0.70", "Very strong"],
    [],
    ["Important interpretation notes"],
    ["• Correlation does not prove causation. A negative value may reflect fatigue, uncertainty, time pressure, or weaker students spending longer."],
    ["• Small participant counts make correlations unstable, so the Review Status should guide discussion rather than be used as a final decision alone."],
    [],
    ["Not sourced by this app's diagnostics engine (see column notes on the data sheets)", "Median/Mean Response Time, Mean/Median Score, Median Completion Rate, Total Time–Performance Correlation, and the Major Element Level breakdown."],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }, { s: { r: 2, c: 0 }, e: { r: 2, c: 8 } }];
  styleRange(ws, 0, 0, 0, 8, TITLE_STYLE);
  styleRange(ws, 2, 0, 2, 8, SUBTITLE_STYLE);
  styleRange(ws, 4, 0, 4, 0, { font: { bold: true, sz: 13 } });
  styleRange(ws, 8, 0, 8, 0, { font: { bold: true, sz: 13 } });
  ws["!cols"] = [{ wch: 26 }, { wch: 70 }];
  return ws;
}

/** The two CF families every data sheet carries: a relative colorScale on the
 * score columns, and a fixed 4-tier correlation-strength band on the two
 * correlation columns. */
function timingCf(sheetIndex: number, firstRow: number, lastRow: number, meanScoreCol: number, medianScoreCol: number, pearsonCol: number, spearmanCol: number): SheetCf {
  const col = (c: number) => XLSX.utils.encode_col(c);
  const rangeOf = (c: number) => rangeRef(col(c), firstRow, col(c), lastRow);
  const colorScaleRule = (c: number) =>
    ({ kind: "colorScale" as const, sqref: rangeOf(c), colors: ["FFF4CCCC", "FFFFF2CC", "FFD9EAD3"] as [string, string, string] });
  const bandRules = (c: number) => {
    const range = rangeOf(c);
    return [
      { kind: "cellIs" as const, sqref: range, operator: "lessThanOrEqual" as const, formula: ["-0.3"], dxf: { fontColor: "FF990000", fillColor: "FFF4CCCC", fillAttr: "bg" as const } },
      { kind: "cellIs" as const, sqref: range, operator: "between" as const, formula: ["-0.299999", "-0.1"], dxf: { fontColor: "FF7F6000", fillColor: "FFFFF2CC", fillAttr: "bg" as const } },
      { kind: "cellIs" as const, sqref: range, operator: "between" as const, formula: ["-0.099999", "0.099999"], dxf: { fontColor: "FF25232E", fillColor: "FFEADCF8", fillAttr: "bg" as const } },
      { kind: "cellIs" as const, sqref: range, operator: "greaterThanOrEqual" as const, formula: ["0.1"], dxf: { fontColor: "FF274E13", fillColor: "FFD9EAD3", fillAttr: "bg" as const } },
    ];
  };
  return {
    sheetIndex,
    rules: [colorScaleRule(meanScoreCol), colorScaleRule(medianScoreCol), ...bandRules(pearsonCol), ...bandRules(spearmanCol)],
  };
}

function dataSheet(opts: { title: string; subtitle: string; labelHeaders: readonly string[]; rows: unknown[][] }): {
  ws: XLSX.WorkSheet;
  meanScoreCol: number;
  medianScoreCol: number;
  pearsonCol: number;
  spearmanCol: number;
} {
  const headers = [...opts.labelHeaders, ...ROW_HEADERS];
  const lastCol = headers.length - 1;
  const headerRow = 5; // originals freeze at row 7 (0-based row 6) with title/subtitle spanning several rows above
  const aoa: unknown[][] = [[opts.title], [opts.subtitle], [], [], [], headers, ...opts.rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.min(lastCol, 5) } }, { s: { r: 1, c: 0 }, e: { r: 2, c: Math.min(lastCol, 5) } }];
  styleRange(ws, 0, 0, 0, lastCol, TITLE_STYLE);
  styleRange(ws, 1, 0, 1, lastCol, SUBTITLE_STYLE);
  styleRange(ws, headerRow, 0, headerRow, lastCol, HEADER_STYLE);
  const lastRow = headerRow + opts.rows.length;
  styleRange(ws, headerRow + 1, 0, lastRow, lastCol, DATA_STYLE);

  const base = opts.labelHeaders.length;
  const meanScoreCol = base + 6, medianScoreCol = base + 7, completionCol = base + 8, pearsonCol = base + 9, spearmanCol = base + 10;
  for (let r = headerRow + 1; r <= lastRow; r++) {
    for (const c of [meanScoreCol, medianScoreCol, completionCol]) setNumberFormat(ws, r, c, "0.0%");
    for (const c of [pearsonCol, spearmanCol]) setNumberFormat(ws, r, c, "0.000");
  }
  ws["!cols"] = headers.map((h) => ({ wch: Math.min(48, Math.max(14, String(h).length + 2)) }));
  return { ws, meanScoreCol, medianScoreCol, pearsonCol, spearmanCol };
}

export interface TimingBuildResult {
  workbook: XLSX.WorkBook;
  bytes: () => Promise<Uint8Array>;
}

export function buildTimingWorkbook(input: TimingReportInput): TimingBuildResult {
  const wb = XLSX.utils.book_new();
  const cfSheets: SheetCf[] = [];

  XLSX.utils.book_append_sheet(wb, readmeSheet(input.cycleName), "README");

  const assessments = input.diagnostics?.assessments ?? [];
  const participantsByAssessment = new Map<string, number>();
  for (const row of input.reliability?.rows ?? []) {
    if (row.level === "subject" && row.assessmentId) participantsByAssessment.set(row.assessmentId, row.totalParticipants);
  }

  const assessmentRows = assessments.map((a) => [
    a.assessmentName,
    ...rowCells(participantsByAssessment.get(a.assessmentId) ?? NOT_SOURCED, a.whole.speeded.nItems, a.whole.speeded.nPresentations, a.whole.timing),
  ]);
  const assessmentLevel = dataSheet({
    title: `Assessment Level Timing & Performance — ${input.cycleName}`,
    subtitle: "Primary indicator: Pearson correlation between each student's median item response time and score percentage by assessment.",
    labelHeaders: ["AssessmentName"],
    rows: assessmentRows,
  });
  XLSX.utils.book_append_sheet(wb, assessmentLevel.ws, "Assessment Level");
  if (assessmentRows.length > 0) {
    cfSheets.push(
      timingCf(1, 7, 6 + assessmentRows.length, assessmentLevel.meanScoreCol, assessmentLevel.medianScoreCol, assessmentLevel.pearsonCol, assessmentLevel.spearmanCol),
    );
  }

  // Major Element Level — no data source (no major-element tag on DiagResponse).
  const majorHeaders = ["AssessmentName", "QuestionMajorElement", ...ROW_HEADERS];
  const majorLastCol = majorHeaders.length - 1;
  const majorAoa: unknown[][] = [
    [`Major Element Level Timing & Performance — ${input.cycleName}`],
    ["Primary indicator: Pearson correlation between each student's median item response time and score percentage by Assessment × Major Element."],
    [],
    [],
    [],
    majorHeaders,
    ["Not available", "This app's diagnostics pipeline does not currently tag MCQ items with a major-element construct for speededness/timing — only demand-level and item-set groupings exist. See the PR notes.", ...majorHeaders.slice(2).map(() => "")],
  ];
  const majorWs = XLSX.utils.aoa_to_sheet(majorAoa);
  majorWs["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: Math.min(majorLastCol, 5) } },
    { s: { r: 1, c: 0 }, e: { r: 2, c: Math.min(majorLastCol, 5) } },
    { s: { r: 6, c: 1 }, e: { r: 6, c: majorLastCol } },
  ];
  styleRange(majorWs, 0, 0, 0, majorLastCol, TITLE_STYLE);
  styleRange(majorWs, 1, 0, 1, majorLastCol, SUBTITLE_STYLE);
  styleRange(majorWs, 5, 0, 5, majorLastCol, HEADER_STYLE);
  styleRange(majorWs, 6, 0, 6, majorLastCol, DATA_STYLE);
  majorWs["!cols"] = majorHeaders.map((h) => ({ wch: Math.min(48, Math.max(14, String(h).length + 2)) }));
  XLSX.utils.book_append_sheet(wb, majorWs, "Major Element Level");
  cfSheets.push(timingCf(2, 7, 7, 2 + 6, 2 + 7, 2 + 9, 2 + 10));

  return {
    workbook: wb,
    bytes: async () => {
      const buf = XLSX.write(wb, { type: "buffer" }) as Buffer;
      return applyConditionalFormatting(buf, cfSheets);
    },
  };
}
