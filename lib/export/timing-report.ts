/**
 * Timing & Performance workbook — ported cell-by-cell from the team's
 * original `Timing_Performance_Analysis_*.xlsx` manual analysis. Three
 * sheets: "README", "Assessment Level", "Major Element Level".
 *
 * Every metric here is real, sourced data. The seven aggregates that used to
 * ship as "Not sourced" (median/mean response time, total response time,
 * mean/median score %, median completion rate, the total-time correlation)
 * are additive fields on TimingResult (lib/diagnostics/index.ts) — all pure
 * derivations of the SAME per-student `medTime`/`scorePct` arrays
 * `timingPerformance()` already builds to compute its Pearson/Spearman
 * pair, just newly returned instead of discarded. The Major Element Level
 * sheet is real data too, from `timingByMajorElement()` — the majorElement
 * tag is the same curriculum-content-area field lib/engine/reliability.ts
 * already groups its own By_Assessment_Major sheet by, just newly plumbed
 * onto DiagResponse. Number of Items/Item Responses are cross-referenced
 * from the sibling SpeededResult for the same (assessment, major element)
 * group — already computed off the same response set; Number of
 * Participants from the sibling ReliabilityRow.
 */
import type { DiagnosticsModel, ReliabilityModel } from "@/lib/data/types";
import type { TimingResult } from "@/lib/diagnostics";
import { XLSX, styleCell, setColumnWidths, setRowHeightsFromExcelRows, type CellStyle } from "./sheet-utils";
import { applyConditionalFormatting, rangeRef, type SheetCf } from "./ooxml-cf";

export const TIMING_SHEETS = ["README", "Assessment Level", "Major Element Level"] as const;

export interface TimingReportInput {
  cycleName: string;
  reliability: ReliabilityModel | null;
  diagnostics: DiagnosticsModel | null;
}

const FREEZE_A7 = { ySplit: 6, topLeftCell: "A7" } as const;
const TAB_COLOR = "FFB2375B";
// xlsx-js-style never writes <sheetFormatPr>, so unset rows fall back to
// Excel's ~15pt default instead of the original's. README differs from the
// two data sheets in this workbook.
const README_DEFAULT_ROW_HEIGHT = 14.4;
const DATA_DEFAULT_ROW_HEIGHT = 15.6;

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
const README_SECTION_STYLE: CellStyle = { font: { bold: true, sz: 13 } };

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

function rowCells(participants: number | null, items: number, itemResponses: number, timing: TimingResult): unknown[] {
  return [
    participants,
    items,
    itemResponses,
    timing.medianResponseTimePerItem,
    timing.meanResponseTimePerItem,
    timing.medianTotalResponseTime,
    timing.meanScorePct,
    timing.medianScorePct,
    timing.medianCompletionRate,
    timing.pearson,
    timing.spearman,
    timing.totalTimePearson,
    STRENGTH_LABEL[magnitudeOf(timing.pearson)],
    reviewStatus(timing.pearson),
    interpretationOf(timing.pearson),
  ];
}

/** README's exact original layout (title, intro paragraph, Methodology,
 * Metrics and formulas, Important interpretation notes, source footer) —
 * built with a running row index, see reliability-report.ts's readmeSheet
 * for why hardcoded row numbers are the thing to avoid here. */
function readmeSheet(cycleName: string): XLSX.WorkSheet {
  const aoa: unknown[][] = [];
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
  const styled: { r0: number; c0: number; r1: number; c1: number; style: CellStyle }[] = [];
  let row = 0;
  const push = (cells: unknown[]): number => { aoa.push(cells); return row++; };
  const merge = (r0: number, r1: number, c0: number, c1: number): void => { merges.push({ s: { r: r0, c: c0 }, e: { r: r1, c: c1 } }); };
  const bullet = (text: string): number => {
    const r = push([undefined, `• ${text}`]);
    merge(r, r, 1, 8);
    return r;
  };
  const section = (title: string): number => {
    const r = push([undefined, title]);
    merge(r, r, 1, 8);
    styled.push({ r0: r, c0: 1, r1: r, c1: 1, style: README_SECTION_STYLE });
    return r;
  };

  const titleRow = push(["G12++ MCQ Timing & Performance Analysis"]);
  merge(titleRow, titleRow + 1, 0, 7);
  styled.push({ r0: titleRow, c0: 0, r1: titleRow, c1: 7, style: TITLE_STYLE });
  push([]);

  const introRow = push(["This workbook analyses whether students who spent more time tended to perform better or worse. The primary time metric is the participant-level median item response time because it is less affected by pauses and extreme outliers than average time."]);
  merge(introRow, introRow + 1, 0, 7);
  styled.push({ r0: introRow, c0: 0, r1: introRow, c1: 7, style: SUBTITLE_STYLE });
  push([]);
  push([]);
  push([]);

  section("Methodology");
  bullet(`Rows were analysed at student-response level using ParticipantID, AssessmentName, QuestionMajorElement, QuestionId, AnswerScore, and AnswerResponseTimeSeconds — this cycle: ${cycleName}.`);
  bullet("For each Assessment or Major Element, student-level score percentage and time metrics were calculated first; correlations were then calculated across students.");
  bullet("The primary correlation uses Median Item Response Time vs Score Percentage. Total Time vs Score Percentage is included as an additional supporting indicator.");
  push([]);

  section("Metrics and formulas");
  bullet("Score Percentage = mean(AnswerScore) for each student inside the analysis unit.");
  bullet("Median Response Time per Item = median of each student's AnswerResponseTimeSeconds inside the analysis unit.");
  bullet("Time–Performance Correlation (Pearson) = correlation(student median item time, student score percentage).");
  bullet("Time–Performance Correlation (Spearman) = rank correlation between the same two variables, useful when relationships are monotonic but not linear.");
  bullet("Positive correlation means students who took more time tended to score higher; negative correlation means students who took more time tended to score lower.");
  push([]);

  section("Important interpretation notes");
  bullet("Correlation does not prove causation. A negative value may reflect fatigue, uncertainty, time pressure, or weaker students spending longer.");
  bullet("Small participant counts make correlations unstable, so the Review Status should guide discussion rather than be used as a final decision alone.");
  push([]);
  const footerRow = push([undefined, `Source: this cycle's live QM export | Cycle: ${cycleName}`]);
  merge(footerRow, footerRow, 1, 8);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = merges;
  for (const s of styled) styleRange(ws, s.r0, s.c0, s.r1, s.c1, s.style);
  setColumnWidths(ws, { A: 3.6640625, B: 28.6640625, C: 18.6640625, I: 25.6640625 }, 9);
  setRowHeightsFromExcelRows(ws, {
    1: 16.05, 2: 36.0, 3: 14.4, 4: 14.4, 7: 18.0, 8: 15.6, 9: 15.6, 10: 15.6,
    12: 18.0, 13: 15.6, 14: 15.6, 15: 15.6, 16: 15.6, 17: 15.6, 19: 18.0,
  });
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
    freeze: FREEZE_A7,
    tabColor: TAB_COLOR,
    rules: [colorScaleRule(meanScoreCol), colorScaleRule(medianScoreCol), ...bandRules(pearsonCol), ...bandRules(spearmanCol)],
  };
}

function dataSheet(opts: { title: string; subtitle: string; labelHeaders: readonly string[]; columnWidths: Record<string, number>; rowHeights: Record<number, number>; rows: unknown[][] }): {
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
  const timeCol = base + 3, meanTimeCol = base + 4, totalTimeCol = base + 5;
  const meanScoreCol = base + 6, medianScoreCol = base + 7, completionCol = base + 8, pearsonCol = base + 9, spearmanCol = base + 10, totalTimeCorrCol = base + 11;
  for (let r = headerRow + 1; r <= lastRow; r++) {
    for (const c of [timeCol, meanTimeCol, totalTimeCol]) setNumberFormat(ws, r, c, "0.000");
    for (const c of [meanScoreCol, medianScoreCol, completionCol]) setNumberFormat(ws, r, c, "0.0%");
    for (const c of [pearsonCol, spearmanCol, totalTimeCorrCol]) setNumberFormat(ws, r, c, "0.000");
  }
  setColumnWidths(ws, opts.columnWidths, headers.length);
  setRowHeightsFromExcelRows(ws, opts.rowHeights);
  return { ws, meanScoreCol, medianScoreCol, pearsonCol, spearmanCol };
}

export interface TimingBuildResult {
  workbook: XLSX.WorkBook;
  bytes: () => Promise<Uint8Array>;
}

export function buildTimingWorkbook(input: TimingReportInput): TimingBuildResult {
  const wb = XLSX.utils.book_new();
  const cfSheets: SheetCf[] = [{ sheetIndex: 0, rules: [], tabColor: TAB_COLOR, defaultRowHeight: README_DEFAULT_ROW_HEIGHT }];

  XLSX.utils.book_append_sheet(wb, readmeSheet(input.cycleName), "README");

  const assessments = input.diagnostics?.assessments ?? [];
  const participantsByAssessment = new Map<string, number>();
  for (const row of input.reliability?.rows ?? []) {
    if (row.level === "subject" && row.assessmentId) participantsByAssessment.set(row.assessmentId, row.totalParticipants);
  }

  const assessmentRows = assessments.map((a) => [
    a.assessmentName,
    ...rowCells(participantsByAssessment.get(a.assessmentId) ?? null, a.whole.speeded.nItems, a.whole.speeded.nPresentations, a.whole.timing),
  ]);
  const assessmentLevel = dataSheet({
    title: "Assessment Level Timing & Performance",
    subtitle: "Primary indicator: Pearson correlation between each student's median item response time and score percentage by assessment.",
    labelHeaders: ["AssessmentName"],
    columnWidths: {
      A: 22.5546875, B: 22.44140625, C: 16.109375, D: 25.6640625, E: 35.33203125, F: 33.6640625, G: 32.33203125,
      H: 15.109375, I: 16.77734375, J: 23.109375, K: 39.0, L: 40.77734375, M: 44.21875, N: 19.77734375, O: 43.88671875, P: 47.109375,
    },
    rowHeights: { 1: 43.2, 6: 34.05, 7: 22.05, 8: 22.05, 9: 22.05, 10: 22.05, 11: 22.05 },
    rows: assessmentRows,
  });
  XLSX.utils.book_append_sheet(wb, assessmentLevel.ws, "Assessment Level");
  cfSheets.push({
    ...(assessmentRows.length > 0
      ? timingCf(1, 7, 6 + assessmentRows.length, assessmentLevel.meanScoreCol, assessmentLevel.medianScoreCol, assessmentLevel.pearsonCol, assessmentLevel.spearmanCol)
      : { sheetIndex: 1, rules: [], freeze: FREEZE_A7, tabColor: TAB_COLOR }),
    defaultRowHeight: DATA_DEFAULT_ROW_HEIGHT,
  });

  // Major Element Level — real data from timingByMajorElement(), grouped by
  // assessment (appearance order) with major elements alphabetical within,
  // matching By_Assessment_Major's ordering in the reliability workbook.
  // Items/Item Responses are cross-referenced from the matching entry in
  // byMajorElement (same group, already computed off the same responses).
  const majorRows: unknown[][] = [];
  for (const a of assessments) {
    const participants = participantsByAssessment.get(a.assessmentId) ?? null;
    const speededByMajor = new Map(a.byMajorElement.map((m) => [m.majorElement, m.speeded]));
    for (const m of a.timingByMajorElement) {
      const speeded = speededByMajor.get(m.majorElement);
      majorRows.push([a.assessmentName, m.majorElement, ...rowCells(participants, speeded?.nItems ?? 0, speeded?.nPresentations ?? 0, m.timing)]);
    }
  }
  const majorElementLevel = dataSheet({
    title: "Major Element Level Timing & Performance",
    subtitle: "Primary indicator: Pearson correlation between each student's median item response time and score percentage by Assessment × Major Element.",
    labelHeaders: ["AssessmentName", "QuestionMajorElement"],
    columnWidths: {
      A: 22.5546875, B: 39.77734375, C: 26.88671875, D: 20.5546875, E: 30.109375, F: 39.77734375, G: 38.109375,
      H: 36.77734375, I: 21.6640625, J: 21.21875, K: 27.5546875, L: 43.44140625, M: 45.21875, N: 48.6640625, O: 24.21875, P: 43.88671875, Q: 47.109375,
    },
    rowHeights: {
      1: 45.0, 6: 34.05, 7: 22.05, 8: 22.05, 9: 22.05, 10: 22.05, 11: 22.05, 12: 22.05, 13: 22.05,
      14: 22.05, 15: 22.05, 16: 22.05, 17: 22.05, 18: 22.05, 19: 22.05, 20: 22.05, 21: 22.05, 22: 22.05,
    },
    rows: majorRows,
  });
  XLSX.utils.book_append_sheet(wb, majorElementLevel.ws, "Major Element Level");
  cfSheets.push({
    ...(majorRows.length > 0
      ? timingCf(2, 7, 6 + majorRows.length, majorElementLevel.meanScoreCol, majorElementLevel.medianScoreCol, majorElementLevel.pearsonCol, majorElementLevel.spearmanCol)
      : { sheetIndex: 2, rules: [], freeze: FREEZE_A7, tabColor: TAB_COLOR }),
    defaultRowHeight: DATA_DEFAULT_ROW_HEIGHT,
  });

  return {
    workbook: wb,
    bytes: async () => {
      const buf = XLSX.write(wb, { type: "buffer" }) as Buffer;
      return applyConditionalFormatting(buf, cfSheets);
    },
  };
}
