/**
 * MCQ Reliability & Internal Consistency workbook — ported cell-by-cell from
 * the team's original `MCQ_Reliability_Internal_Consistency_*.xlsx` manual
 * analysis (see reference/assessment_health_reports/originals for the ground
 * truth this was built against). Six sheets: README, Overall, By_Assessment,
 * By_Assessment_Major, By_Demand_Level, By_Assessment_Demand.
 *
 * Data comes from the app's own ReliabilityModel — nothing here recomputes a
 * statistic the engine doesn't already produce (see lib/engine/reliability.ts
 * for the additive fields: Spearman-Brown, average inter-item correlation,
 * total participants, item-response counts, status/interpretation bands).
 *
 * Column widths, merge spans, freeze panes and tab color are hardcoded from
 * the original files (per-sheet, not derived from any auto-fit heuristic) —
 * see verify_fidelity.py in the PR for how these were checked.
 */
import type { ReliabilityModel, ReliabilityRow } from "@/lib/data/types";
import { XLSX, styleCell, setColumnWidths, setRowHeightsFromExcelRows, type CellStyle } from "./sheet-utils";
import { applyConditionalFormatting, rangeRef, type SheetCf } from "./ooxml-cf";

export const RELIABILITY_SHEETS = [
  "README",
  "Overall",
  "By_Assessment",
  "By_Assessment_Major",
  "By_Demand_Level",
  "By_Assessment_Demand",
] as const;

export interface ReliabilityReportInput {
  cycleName: string;
  reliability: ReliabilityModel | null;
}

const DEMAND_ORDER = ["D1", "D2", "D3"] as const;
const FREEZE_A5 = { ySplit: 4, topLeftCell: "A5" } as const;
const TAB_COLOR = "FFB2375B";
const DEFAULT_ROW_HEIGHT = 14.4;

/** Fixed header rows 1-4 share the same heights on every metrics sheet
 * (title/subtitle/blank/header); only the per-sheet title/subtitle height
 * and the repeated data-row height (applied per actual row count) differ. */
function metricsRowHeights(titleHeight: number, dataRowCount: number, dataRowHeight: number): Record<number, number> {
  const heights: Record<number, number> = { 1: titleHeight, 2: 34.05, 4: 36.0 };
  for (let r = 0; r < dataRowCount; r++) heights[5 + r] = dataRowHeight;
  return heights;
}

// --- styling (matches the original workbook's palette/fonts) ---------------

const TITLE_FILL = "FFF9F5F2";
const HEADER_FILL = "FFB2375B";
const DATA_FILL = "FFFCFAF8";
const THIN_HEADER_BORDER = { style: "thin", color: { rgb: "FFD9D9D9" } } as const;
const THIN_DATA_BORDER = { style: "thin", color: { rgb: "FFF9ECE0" } } as const;

const TITLE_STYLE: CellStyle = {
  font: { name: "Barlow Semi Condensed", sz: 17, bold: true, color: { rgb: "FF25232E" } },
  fill: { patternType: "solid", fgColor: { rgb: TITLE_FILL } },
  alignment: { horizontal: "center", vertical: "center" },
};
const SUBTITLE_STYLE: CellStyle = {
  font: { name: "Barlow", sz: 10, italic: true, color: { rgb: "FF47535A" } },
  fill: { patternType: "solid", fgColor: { rgb: TITLE_FILL } },
  alignment: { horizontal: "left", vertical: "center" },
};
const HEADER_STYLE: CellStyle = {
  font: { name: "Barlow Semi Condensed", sz: 11, bold: true, color: { rgb: "FFFFFFFF" } },
  fill: { patternType: "solid", fgColor: { rgb: HEADER_FILL } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: { top: THIN_HEADER_BORDER, bottom: THIN_HEADER_BORDER, left: THIN_HEADER_BORDER, right: THIN_HEADER_BORDER },
};
const DATA_STYLE: CellStyle = {
  font: { name: "Barlow", sz: 11, color: { rgb: "FF25232E" } },
  fill: { patternType: "solid", fgColor: { rgb: DATA_FILL } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: { bottom: THIN_DATA_BORDER },
};
const README_TOPIC_HEADER_STYLE: CellStyle = { font: { bold: true } };
const README_SECTION_STYLE: CellStyle = { font: { bold: true, sz: 12 } };

const FMT_ALPHA = "0.000";
const FMT_MULT = "0.00";

function styleRange(ws: XLSX.WorkSheet, r0: number, c0: number, r1: number, c1: number, style: CellStyle): void {
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) styleCell(ws, r, c, style);
  }
}

function setNumberFormat(ws: XLSX.WorkSheet, r: number, c: number, fmt: string): void {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr] as XLSX.CellObject | undefined;
  if (cell) cell.z = fmt;
}

/** Applied to every group-level row: the metrics + status/interpretation
 * columns that are identical across Overall/By_Assessment/By_Assessment_Major/
 * By_Demand_Level/By_Assessment_Demand, just offset by however many label
 * columns (AssessmentName, DemandLevel, ...) precede them.
 *
 * `participants` picks whether the sheet shows one participant count (Overall
 * — "all assessments together" has no separate complete-case notion worth a
 * second column) or two (every other sheet: raw attempts + complete-case n),
 * matching the originals exactly. Unsourceable/undefined metrics are left as
 * `null` (a genuinely blank cell), never a placeholder string, so they never
 * sit as text inside a numerically-formatted column. */
function metricCells(row: ReliabilityRow, participants: "single" | "dual", includeAvgInterItem: boolean): unknown[] {
  const cells: unknown[] = participants === "single" ? [row.totalParticipants] : [row.totalParticipants, row.n];
  cells.push(row.k, row.itemResponses, row.alpha, row.spearmanBrown, row.sbMultiplier80, row.sbMultiplier90);
  if (includeAvgInterItem) cells.push(row.avgInterItemCorrelation);
  cells.push(row.status, row.interpretation);
  return cells;
}

const METRIC_TAIL_NO_AVG = [
  "Number of Items", "Number of Item Responses",
  "Cronbach's Alpha", "Spearman-Brown Reliability if Test Length Doubled",
  "Spearman-Brown Multiplier to Reach 0.80", "Spearman-Brown Multiplier to Reach 0.90",
  "Status", "Interpretation",
] as const;
const METRIC_TAIL_WITH_AVG = [
  "Number of Items", "Number of Item Responses",
  "Cronbach's Alpha", "Spearman-Brown Reliability if Test Length Doubled",
  "Spearman-Brown Multiplier to Reach 0.80", "Spearman-Brown Multiplier to Reach 0.90",
  "Average Inter-Item Correlation", "Status", "Interpretation",
] as const;
function metricHeaders(participants: "single" | "dual", includeAvgInterItem: boolean): string[] {
  const head = participants === "single" ? ["Number of Participants"] : ["Number of Participants", "Participants with Complete Data"];
  return [...head, ...(includeAvgInterItem ? METRIC_TAIL_WITH_AVG : METRIC_TAIL_NO_AVG)];
}

/** README's exact original layout (title, Purpose label + paragraph, topic
 * table, status-threshold table), built with a running row index so a
 * merge/style can never drift out of sync with what it's meant to decorate —
 * see lib/export/ooxml-cf.ts's schema-order lesson for why hardcoded row
 * numbers are the thing to avoid here. */
function readmeSheet(): XLSX.WorkSheet {
  const aoa: unknown[][] = [];
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
  const styled: { r0: number; c0: number; r1: number; c1: number; style: CellStyle }[] = [];
  let row = 0;
  const push = (cells: unknown[]): number => {
    aoa.push(cells);
    return row++;
  };
  const mergeFull = (r: number, c1: number): void => { merges.push({ s: { r, c: 0 }, e: { r, c: c1 } }); };

  const titleRow = push(["G12++ MCQ Reliability & Internal Consistency Analysis"]);
  mergeFull(titleRow, 8);
  styled.push({ r0: titleRow, c0: 0, r1: titleRow, c1: 8, style: TITLE_STYLE });

  const purposeLabelRow = push(["Purpose"]);
  mergeFull(purposeLabelRow, 8);
  styled.push({ r0: purposeLabelRow, c0: 0, r1: purposeLabelRow, c1: 8, style: SUBTITLE_STYLE });

  const purposeTextRow = push(["This workbook evaluates how consistently MCQ items work together using Cronbach's Alpha and Spearman-Brown reliability indicators."]);
  mergeFull(purposeTextRow, 8);
  styled.push({ r0: purposeTextRow, c0: 0, r1: purposeTextRow, c1: 8, style: SUBTITLE_STYLE });

  push([]);

  const topicHeaderRow = push(["Topic", "Explanation"]);
  styled.push({ r0: topicHeaderRow, c0: 0, r1: topicHeaderRow, c1: 1, style: README_TOPIC_HEADER_STYLE });
  push(["Analysis Levels", "Overall, Assessment Level, Assessment × Major Element, Demand Level, and Assessment × Demand Level."]);
  push(["Cronbach's Alpha", "Internal-consistency coefficient. Higher values indicate that items are more consistently measuring the same score construct."]);
  push(["Spearman-Brown Reliability if Test Length Doubled", "Predicted reliability if the test section length were doubled with similar-quality items: SB = (2 × Alpha) / (1 + Alpha)."]);
  push(["Spearman-Brown Multiplier to Reach 0.80 / 0.90", "Estimated test length multiplier needed to reach the target reliability: n = target × (1 - Alpha) / [Alpha × (1 - target)]."]);
  push(["Important Caution", "Small cohorts make major-element and demand-level reliability estimates unstable — treat them as screening evidence, not final psychometric proof."]);

  push([]);
  push([]);

  const statusSectionRow = push(["Reliability Status Thresholds"]);
  mergeFull(statusSectionRow, 3);
  styled.push({ r0: statusSectionRow, c0: 0, r1: statusSectionRow, c1: 0, style: README_SECTION_STYLE });

  const statusHeaderRow = push(["Alpha Range", "Status", "Interpretation", "Recommended Use"]);
  styled.push({ r0: statusHeaderRow, c0: 0, r1: statusHeaderRow, c1: 3, style: HEADER_STYLE });
  push(["≥ 0.90", "Excellent", "Very strong consistency", "Use confidently; check redundancy if extremely high"]);
  push(["0.80 – 0.89", "Good", "Strong consistency", "Suitable for group-level reporting"]);
  push(["0.70 – 0.79", "Acceptable", "Adequate consistency", "Generally usable with normal caution"]);
  push(["0.60 – 0.69", "Questionable", "Limited consistency", "Use cautiously and review alignment"]);
  push(["< 0.60", "Flag / Low", "Weak consistency", "Review item quality, construct alignment, and sample size"]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = merges;
  for (const s of styled) styleRange(ws, s.r0, s.c0, s.r1, s.c1, s.style);
  setColumnWidths(ws, { A: 44.109375, B: 101.88671875, C: 30.0, D: 36.0, E: 12.0, F: 12.0, G: 12.0, H: 12.0, I: 12.0 }, 9);
  setRowHeightsFromExcelRows(ws, {
    1: 39.6, 2: 18.0, 5: 16.8, 6: 48, 7: 48, 8: 48, 9: 48, 10: 48,
    13: 16.8, 14: 16.8, 15: 31.2, 16: 15.6, 17: 15.6, 18: 15.6, 19: 31.2,
  });
  return ws;
}

/** Build one metrics sheet (Overall / By_Assessment / By_Assessment_Major /
 * By_Demand_Level / By_Assessment_Demand) — same title/header/data styling,
 * only the leading label column(s), row set, and per-sheet layout constants
 * (titleMergeEndCol, columnWidths) differ. */
function metricsSheet(opts: {
  title: string;
  subtitle: string;
  labelHeaders: readonly string[];
  participants: "single" | "dual";
  includeAvgInterItem: boolean;
  titleMergeEndCol: number;
  titleRowHeight: number;
  columnWidths: Record<string, number>;
  rows: { labels: unknown[]; row: ReliabilityRow }[];
}): { ws: XLSX.WorkSheet; alphaCol: number; sbRelCol: number; statusCol: number; autoFilterRef: string } {
  const headers = [...opts.labelHeaders, ...metricHeaders(opts.participants, opts.includeAvgInterItem)];
  const lastCol = headers.length - 1;
  const aoa: unknown[][] = [[opts.title], [opts.subtitle], [], headers];
  for (const { labels, row } of opts.rows) {
    aoa.push([...labels, ...metricCells(row, opts.participants, opts.includeAvgInterItem)]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: opts.titleMergeEndCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: opts.titleMergeEndCol } },
  ];
  styleRange(ws, 0, 0, 0, lastCol, TITLE_STYLE);
  styleRange(ws, 1, 0, 1, lastCol, SUBTITLE_STYLE);
  styleRange(ws, 3, 0, 3, lastCol, HEADER_STYLE);
  const lastRow = 3 + opts.rows.length;
  styleRange(ws, 4, 0, lastRow, lastCol, DATA_STYLE);

  const participantCols = opts.participants === "single" ? 1 : 2;
  const alphaCol = opts.labelHeaders.length + participantCols + 2; // + Items + ItemResponses
  const sbRelCol = alphaCol + 1;
  const sb80Col = alphaCol + 2;
  const sb90Col = alphaCol + 3;
  const avgCol = opts.includeAvgInterItem ? alphaCol + 4 : -1;
  const statusCol = alphaCol + (opts.includeAvgInterItem ? 5 : 4);
  for (let r = 4; r <= lastRow; r++) {
    setNumberFormat(ws, r, alphaCol, FMT_ALPHA);
    setNumberFormat(ws, r, sbRelCol, FMT_ALPHA);
    setNumberFormat(ws, r, sb80Col, FMT_MULT);
    setNumberFormat(ws, r, sb90Col, FMT_MULT);
    if (avgCol >= 0) setNumberFormat(ws, r, avgCol, FMT_ALPHA);
  }
  setColumnWidths(ws, opts.columnWidths, headers.length);
  setRowHeightsFromExcelRows(ws, metricsRowHeights(opts.titleRowHeight, opts.rows.length, 42.0));
  const autoFilterRef = rangeRef("A", 4, XLSX.utils.encode_col(lastCol), lastRow + 1);
  return { ws, alphaCol, sbRelCol, statusCol, autoFilterRef };
}

/** The 3-tier CF rules shared by every metrics sheet: green/amber/red on the
 * Alpha + SB-reliability pair, and on the Status column by label. */
function reliabilityCf(sheetIndex: number, firstRow: number, lastRow: number, alphaCol: number, sbRelCol: number, statusCol: number): SheetCf {
  const valueRange = rangeRef(XLSX.utils.encode_col(alphaCol), firstRow, XLSX.utils.encode_col(sbRelCol), lastRow);
  const statusRange = rangeRef(XLSX.utils.encode_col(statusCol), firstRow, XLSX.utils.encode_col(statusCol), lastRow);
  const statusCell = `$${XLSX.utils.encode_col(statusCol)}${firstRow}`;
  return {
    sheetIndex,
    freeze: FREEZE_A5,
    tabColor: TAB_COLOR,
    rules: [
      { kind: "cellIs", sqref: valueRange, operator: "greaterThanOrEqual", formula: ["0.8"], dxf: { fillColor: "FFDDEAD6", fillAttr: "fg" } },
      { kind: "cellIs", sqref: valueRange, operator: "between", formula: ["0.6", "0.799999"], dxf: { fillColor: "FFFFF2CC", fillAttr: "fg" } },
      { kind: "cellIs", sqref: valueRange, operator: "lessThan", formula: ["0.6"], dxf: { fillColor: "FFF4CCCC", fillAttr: "fg" } },
      { kind: "expression", sqref: statusRange, formula: `OR(${statusCell}="Excellent",${statusCell}="Good")`, dxf: { fillColor: "FFDDEAD6", fillAttr: "fg" } },
      { kind: "expression", sqref: statusRange, formula: `OR(${statusCell}="Acceptable",${statusCell}="Questionable")`, dxf: { fillColor: "FFFFF2CC", fillAttr: "fg" } },
      { kind: "expression", sqref: statusRange, formula: `OR(${statusCell}="Flag / Low",${statusCell}="Not Available")`, dxf: { fillColor: "FFF4CCCC", fillAttr: "fg" } },
    ],
  };
}

function sortByDemand<T extends { demand: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => DEMAND_ORDER.indexOf(a.demand as never) - DEMAND_ORDER.indexOf(b.demand as never));
}

function groupPreservingOrder<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

export interface ReliabilityBuildResult {
  workbook: XLSX.WorkBook;
  /** Bytes with real conditional-formatting rules patched in — write this, not `workbook` directly. */
  bytes: () => Promise<Uint8Array>;
}

export function buildReliabilityWorkbook(input: ReliabilityReportInput): ReliabilityBuildResult {
  const wb = XLSX.utils.book_new();
  const cfSheets: SheetCf[] = [{ sheetIndex: 0, rules: [], freeze: FREEZE_A5, tabColor: TAB_COLOR, defaultRowHeight: DEFAULT_ROW_HEIGHT }];
  const r = input.reliability;

  XLSX.utils.book_append_sheet(wb, readmeSheet(), "README");

  // Overall (no Average Inter-Item Correlation column — matches the original).
  const overallRows = r ? r.rows.filter((row) => row.level === "overall") : [];
  const overall = metricsSheet({
    title: "Overall Reliability: All Assessments Together",
    subtitle: "Combines all MCQ items across assessments using unique AssessmentName × QuestionId item keys.",
    labelHeaders: ["Scope"],
    participants: "single",
    includeAvgInterItem: false,
    titleMergeEndCol: 6,
    titleRowHeight: 50.4,
    columnWidths: { A: 32.0, B: 25.0, C: 18.0, D: 29.109375, E: 21.0, F: 45.0, G: 42.0, H: 42.0, I: 15.0, J: 55.0 },
    rows: overallRows.map((row) => ({ labels: ["All Assessments Together"], row })),
  });
  XLSX.utils.book_append_sheet(wb, overall.ws, "Overall");
  cfSheets.push({
    ...(overallRows.length > 0
      ? reliabilityCf(1, 5, 4 + overallRows.length, overall.alphaCol, overall.sbRelCol, overall.statusCol)
      : { sheetIndex: 1, rules: [], freeze: FREEZE_A5, tabColor: TAB_COLOR }),
    defaultRowHeight: DEFAULT_ROW_HEIGHT,
    autoFilterRef: overall.autoFilterRef,
  });

  // By_Assessment (no Average Inter-Item Correlation column).
  const subjectRows = r ? r.rows.filter((row) => row.level === "subject") : [];
  const bySubject = metricsSheet({
    title: "Assessment Level Reliability",
    subtitle: "Cronbach's Alpha and Spearman-Brown indicators calculated separately for each assessment.",
    labelHeaders: ["AssessmentName"],
    participants: "dual",
    includeAvgInterItem: false,
    titleMergeEndCol: 5,
    titleRowHeight: 47.4,
    columnWidths: { A: 34.0, B: 25.0, C: 34.0, D: 18.0, E: 27.0, F: 25.0, G: 45.0, H: 42.0, I: 41.33203125, J: 15.0, K: 104.5546875 },
    rows: subjectRows.map((row) => ({ labels: [row.assessmentName ?? row.label], row })),
  });
  XLSX.utils.book_append_sheet(wb, bySubject.ws, "By_Assessment");
  cfSheets.push({
    ...(subjectRows.length > 0
      ? reliabilityCf(2, 5, 4 + subjectRows.length, bySubject.alphaCol, bySubject.sbRelCol, bySubject.statusCol)
      : { sheetIndex: 2, rules: [], freeze: FREEZE_A5, tabColor: TAB_COLOR }),
    defaultRowHeight: DEFAULT_ROW_HEIGHT,
    autoFilterRef: bySubject.autoFilterRef,
  });

  // By_Assessment_Major — grouped by assessment (appearance order), major element alphabetical within.
  const majorRows = r ? r.rows.filter((row) => row.level === "majorElement") : [];
  const majorGroups = groupPreservingOrder(majorRows, (row) => row.assessmentName ?? "");
  const majorOrdered: ReliabilityRow[] = [];
  for (const group of majorGroups.values()) {
    majorOrdered.push(...[...group].sort((a, b) => a.label.localeCompare(b.label)));
  }
  const byMajor = metricsSheet({
    title: "Major Element Level Reliability",
    subtitle: "Reliability indicators calculated by Assessment × QuestionMajorElement.",
    labelHeaders: ["AssessmentName", "QuestionMajorElement"],
    participants: "dual",
    includeAvgInterItem: true,
    titleMergeEndCol: 5,
    titleRowHeight: 44.4,
    columnWidths: { A: 34.0, B: 31.0, C: 25.0, D: 34.0, E: 18.0, F: 27.0, G: 24.0, H: 45.0, I: 42.0, J: 42.0, K: 33.0, L: 15.0, M: 104.5546875 },
    rows: majorOrdered.map((row) => ({ labels: [row.assessmentName ?? "", row.label], row })),
  });
  XLSX.utils.book_append_sheet(wb, byMajor.ws, "By_Assessment_Major");
  cfSheets.push({
    ...(majorOrdered.length > 0
      ? reliabilityCf(3, 5, 4 + majorOrdered.length, byMajor.alphaCol, byMajor.sbRelCol, byMajor.statusCol)
      : { sheetIndex: 3, rules: [], freeze: FREEZE_A5, tabColor: TAB_COLOR }),
    defaultRowHeight: DEFAULT_ROW_HEIGHT,
    autoFilterRef: byMajor.autoFilterRef,
  });

  // By_Demand_Level — cross-assessment (assessmentId null), fixed D1→D3 order.
  const demandAllRows = r ? r.rows.filter((row) => row.level === "demandLevel" && row.assessmentId === null) : [];
  const demandAllOrdered = sortByDemand(demandAllRows.map((row) => ({ demand: row.label, row })));
  const byDemand = metricsSheet({
    title: "Demand Level Reliability",
    subtitle: "Reliability indicators calculated across all assessments by DemandLevel.",
    labelHeaders: ["DemandLevel"],
    participants: "dual",
    includeAvgInterItem: true,
    titleMergeEndCol: 4,
    titleRowHeight: 47.4,
    columnWidths: { A: 14.0, B: 25.0, C: 34.0, D: 18.0, E: 27.0, F: 22.0, G: 45.0, H: 42.0, I: 42.0, J: 33.0, K: 15.0, L: 54.5546875 },
    rows: demandAllOrdered.map(({ demand, row }) => ({ labels: [demand], row })),
  });
  XLSX.utils.book_append_sheet(wb, byDemand.ws, "By_Demand_Level");
  cfSheets.push({
    ...(demandAllOrdered.length > 0
      ? reliabilityCf(4, 5, 4 + demandAllOrdered.length, byDemand.alphaCol, byDemand.sbRelCol, byDemand.statusCol)
      : { sheetIndex: 4, rules: [], freeze: FREEZE_A5, tabColor: TAB_COLOR }),
    defaultRowHeight: DEFAULT_ROW_HEIGHT,
    autoFilterRef: byDemand.autoFilterRef,
  });

  // By_Assessment_Demand — grouped by assessment (appearance order), D1→D3 within.
  const assessmentDemandRows = r ? r.rows.filter((row) => row.level === "demandLevel" && row.assessmentId !== null) : [];
  const assessmentDemandGroups = groupPreservingOrder(assessmentDemandRows, (row) => row.assessmentName ?? "");
  const assessmentDemandOrdered: ReliabilityRow[] = [];
  for (const group of assessmentDemandGroups.values()) {
    assessmentDemandOrdered.push(...sortByDemand(group.map((row) => ({ demand: row.label, row }))).map((x) => x.row));
  }
  const byAssessmentDemand = metricsSheet({
    title: "Assessment × Demand Level Reliability",
    subtitle: "Additional diagnostic table showing reliability within each Assessment × DemandLevel.",
    labelHeaders: ["AssessmentName", "DemandLevel"],
    participants: "dual",
    includeAvgInterItem: true,
    titleMergeEndCol: 8,
    titleRowHeight: 42.0,
    columnWidths: { A: 34.0, B: 14.0, C: 25.0, D: 34.0, E: 18.0, F: 27.0, G: 23.0, H: 45.0, I: 42.0, J: 42.0, K: 33.0, L: 13.0, M: 54.77734375 },
    rows: assessmentDemandOrdered.map((row) => ({ labels: [row.assessmentName ?? "", row.label], row })),
  });
  XLSX.utils.book_append_sheet(wb, byAssessmentDemand.ws, "By_Assessment_Demand");
  cfSheets.push({
    ...(assessmentDemandOrdered.length > 0
      ? reliabilityCf(5, 5, 4 + assessmentDemandOrdered.length, byAssessmentDemand.alphaCol, byAssessmentDemand.sbRelCol, byAssessmentDemand.statusCol)
      : { sheetIndex: 5, rules: [], freeze: FREEZE_A5, tabColor: TAB_COLOR }),
    defaultRowHeight: DEFAULT_ROW_HEIGHT,
    autoFilterRef: byAssessmentDemand.autoFilterRef,
  });

  return {
    workbook: wb,
    bytes: async () => {
      const buf = XLSX.write(wb, { type: "buffer" }) as Buffer;
      return applyConditionalFormatting(buf, cfSheets);
    },
  };
}
