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
 * Two sheets have no data source in this app and are intentionally left as
 * structure-only with an explanatory note rather than fabricated numbers —
 * see NOT_SOURCED_NOTE below.
 */
import type { ReliabilityModel, ReliabilityRow } from "@/lib/data/types";
import { XLSX, styleCell, type CellStyle } from "./sheet-utils";
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
 * matching the originals exactly. */
function metricCells(row: ReliabilityRow, participants: "single" | "dual", includeAvgInterItem: boolean): unknown[] {
  const cells: unknown[] = participants === "single" ? [row.totalParticipants] : [row.totalParticipants, row.n];
  cells.push(
    row.k,
    row.itemResponses,
    row.alpha ?? "n/a",
    row.spearmanBrown ?? "n/a",
    row.sbMultiplier80 ?? "n/a",
    row.sbMultiplier90 ?? "n/a",
  );
  if (includeAvgInterItem) cells.push(row.avgInterItemCorrelation ?? "n/a");
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

function readmeSheet(cycleName: string): XLSX.WorkSheet {
  const aoa: unknown[][] = [
    ["G12++ MCQ Reliability & Internal Consistency Analysis"],
    [],
    [`Purpose — ${cycleName}`],
    ["This workbook evaluates how consistently MCQ items work together using Cronbach's Alpha and Spearman-Brown reliability indicators."],
    [],
    ["Topic", "Explanation"],
    ["Analysis Levels", "Overall, Assessment Level, Assessment × Major Element, Demand Level, and Assessment × Demand Level."],
    ["Cronbach's Alpha", "Internal-consistency coefficient. Higher values indicate that items are more consistently measuring the same score construct."],
    ["Spearman-Brown Reliability if Test Length Doubled", "Predicted reliability if the test section length were doubled with similar-quality items: SB = (2 × Alpha) / (1 + Alpha)."],
    ["Spearman-Brown Multiplier to Reach 0.80 / 0.90", "Estimated test length multiplier needed to reach the target reliability: n = target × (1 - Alpha) / [Alpha × (1 - target)]."],
    ["Important Caution", "Small cohorts make major-element and demand-level reliability estimates unstable — treat them as screening evidence, not final psychometric proof."],
    [],
    [],
    ["Reliability Status Thresholds"],
    ["Alpha Range", "Status", "Interpretation", "Recommended Use"],
    ["≥ 0.90", "Excellent", "Very strong consistency", "Use confidently; check redundancy if extremely high"],
    ["0.80 – 0.89", "Good", "Strong consistency", "Suitable for group-level reporting"],
    ["0.70 – 0.79", "Acceptable", "Adequate consistency", "Generally usable with normal caution"],
    ["0.60 – 0.69", "Questionable", "Limited consistency", "Use cautiously and review alignment"],
    ["< 0.60", "Flag / Low", "Weak consistency", "Review item quality, construct alignment, and sample size"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 8 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 8 } },
    { s: { r: 3, c: 0 }, e: { r: 3, c: 8 } },
    { s: { r: 12, c: 0 }, e: { r: 12, c: 3 } },
  ];
  styleRange(ws, 0, 0, 0, 8, TITLE_STYLE);
  styleRange(ws, 2, 0, 3, 8, SUBTITLE_STYLE);
  styleRange(ws, 5, 0, 5, 1, HEADER_STYLE);
  styleRange(ws, 13, 0, 13, 0, { font: { bold: true, sz: 12 } });
  styleRange(ws, 14, 0, 14, 3, HEADER_STYLE);
  ws["!cols"] = [{ wch: 44 }, { wch: 90 }, { wch: 30 }, { wch: 36 }];
  return ws;
}

/** Build one metrics sheet (Overall / By_Assessment / By_Assessment_Major /
 * By_Demand_Level / By_Assessment_Demand) — same title/header/data styling,
 * only the leading label column(s) and row set differ. */
function metricsSheet(opts: {
  title: string;
  subtitle: string;
  labelHeaders: readonly string[];
  participants: "single" | "dual";
  includeAvgInterItem: boolean;
  rows: { labels: unknown[]; row: ReliabilityRow }[];
}): { ws: XLSX.WorkSheet; alphaCol: number; sbRelCol: number; statusCol: number } {
  const headers = [...opts.labelHeaders, ...metricHeaders(opts.participants, opts.includeAvgInterItem)];
  const lastCol = headers.length - 1;
  const aoa: unknown[][] = [[opts.title], [opts.subtitle], [], headers];
  for (const { labels, row } of opts.rows) {
    aoa.push([...labels, ...metricCells(row, opts.participants, opts.includeAvgInterItem)]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: Math.min(lastCol, 6) } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: Math.min(lastCol, 6) } },
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
  ws["!cols"] = headers.map((h) => ({ wch: Math.min(55, Math.max(14, String(h).length + 2)) }));
  return { ws, alphaCol, sbRelCol, statusCol };
}

/** The 3-tier CF rules shared by every metrics sheet: green/amber/red on the
 * Alpha + SB-reliability pair, and on the Status column by label. */
function reliabilityCf(sheetIndex: number, firstRow: number, lastRow: number, alphaCol: number, sbRelCol: number, statusCol: number): SheetCf {
  const valueRange = rangeRef(XLSX.utils.encode_col(alphaCol), firstRow, XLSX.utils.encode_col(sbRelCol), lastRow);
  const statusRange = rangeRef(XLSX.utils.encode_col(statusCol), firstRow, XLSX.utils.encode_col(statusCol), lastRow);
  const statusCell = `$${XLSX.utils.encode_col(statusCol)}${firstRow}`;
  return {
    sheetIndex,
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
  const cfSheets: SheetCf[] = [];
  const r = input.reliability;

  XLSX.utils.book_append_sheet(wb, readmeSheet(input.cycleName), "README");

  // Overall (no Average Inter-Item Correlation column — matches the original).
  const overallRows = r ? r.rows.filter((row) => row.level === "overall") : [];
  const overall = metricsSheet({
    title: `Overall Reliability: All Assessments Together — ${input.cycleName}`,
    subtitle: "Combines all MCQ items across assessments using unique AssessmentName × QuestionId item keys.",
    labelHeaders: ["Scope"],
    participants: "single",
    includeAvgInterItem: false,
    rows: overallRows.map((row) => ({ labels: ["All Assessments Together"], row })),
  });
  XLSX.utils.book_append_sheet(wb, overall.ws, "Overall");
  if (overallRows.length > 0) {
    cfSheets.push(reliabilityCf(1, 5, 4 + overallRows.length, overall.alphaCol, overall.sbRelCol, overall.statusCol));
  }

  // By_Assessment (no Average Inter-Item Correlation column).
  const subjectRows = r ? r.rows.filter((row) => row.level === "subject") : [];
  const bySubject = metricsSheet({
    title: `Assessment Level Reliability — ${input.cycleName}`,
    subtitle: "Cronbach's Alpha and Spearman-Brown indicators calculated separately for each assessment.",
    labelHeaders: ["AssessmentName"],
    participants: "dual",
    includeAvgInterItem: false,
    rows: subjectRows.map((row) => ({ labels: [row.assessmentName ?? row.label], row })),
  });
  XLSX.utils.book_append_sheet(wb, bySubject.ws, "By_Assessment");
  if (subjectRows.length > 0) {
    cfSheets.push(reliabilityCf(2, 5, 4 + subjectRows.length, bySubject.alphaCol, bySubject.sbRelCol, bySubject.statusCol));
  }

  // By_Assessment_Major — grouped by assessment (appearance order), major element alphabetical within.
  const majorRows = r ? r.rows.filter((row) => row.level === "majorElement") : [];
  const majorGroups = groupPreservingOrder(majorRows, (row) => row.assessmentName ?? "");
  const majorOrdered: ReliabilityRow[] = [];
  for (const group of majorGroups.values()) {
    majorOrdered.push(...[...group].sort((a, b) => a.label.localeCompare(b.label)));
  }
  const byMajor = metricsSheet({
    title: `Major Element Level Reliability — ${input.cycleName}`,
    subtitle: "Reliability indicators calculated by Assessment × QuestionMajorElement.",
    labelHeaders: ["AssessmentName", "QuestionMajorElement"],
    participants: "dual",
    includeAvgInterItem: true,
    rows: majorOrdered.map((row) => ({ labels: [row.assessmentName ?? "", row.label], row })),
  });
  XLSX.utils.book_append_sheet(wb, byMajor.ws, "By_Assessment_Major");
  if (majorOrdered.length > 0) {
    cfSheets.push(reliabilityCf(3, 5, 4 + majorOrdered.length, byMajor.alphaCol, byMajor.sbRelCol, byMajor.statusCol));
  }

  // By_Demand_Level — cross-assessment (assessmentId null), fixed D1→D3 order.
  const demandAllRows = r ? r.rows.filter((row) => row.level === "demandLevel" && row.assessmentId === null) : [];
  const demandAllOrdered = sortByDemand(demandAllRows.map((row) => ({ demand: row.label, row })));
  const byDemand = metricsSheet({
    title: `Demand Level Reliability — ${input.cycleName}`,
    subtitle: "Reliability indicators calculated across all assessments by DemandLevel.",
    labelHeaders: ["DemandLevel"],
    participants: "dual",
    includeAvgInterItem: true,
    rows: demandAllOrdered.map(({ demand, row }) => ({ labels: [demand], row })),
  });
  XLSX.utils.book_append_sheet(wb, byDemand.ws, "By_Demand_Level");
  if (demandAllOrdered.length > 0) {
    cfSheets.push(reliabilityCf(4, 5, 4 + demandAllOrdered.length, byDemand.alphaCol, byDemand.sbRelCol, byDemand.statusCol));
  }

  // By_Assessment_Demand — grouped by assessment (appearance order), D1→D3 within.
  const assessmentDemandRows = r ? r.rows.filter((row) => row.level === "demandLevel" && row.assessmentId !== null) : [];
  const assessmentDemandGroups = groupPreservingOrder(assessmentDemandRows, (row) => row.assessmentName ?? "");
  const assessmentDemandOrdered: ReliabilityRow[] = [];
  for (const group of assessmentDemandGroups.values()) {
    assessmentDemandOrdered.push(...sortByDemand(group.map((row) => ({ demand: row.label, row }))).map((x) => x.row));
  }
  const byAssessmentDemand = metricsSheet({
    title: `Assessment × Demand Level Reliability — ${input.cycleName}`,
    subtitle: "Additional diagnostic table showing reliability within each Assessment × DemandLevel.",
    labelHeaders: ["AssessmentName", "DemandLevel"],
    participants: "dual",
    includeAvgInterItem: true,
    rows: assessmentDemandOrdered.map((row) => ({ labels: [row.assessmentName ?? "", row.label], row })),
  });
  XLSX.utils.book_append_sheet(wb, byAssessmentDemand.ws, "By_Assessment_Demand");
  if (assessmentDemandOrdered.length > 0) {
    cfSheets.push(
      reliabilityCf(5, 5, 4 + assessmentDemandOrdered.length, byAssessmentDemand.alphaCol, byAssessmentDemand.sbRelCol, byAssessmentDemand.statusCol),
    );
  }

  return {
    workbook: wb,
    bytes: async () => {
      const buf = XLSX.write(wb, { type: "buffer" }) as Buffer;
      return applyConditionalFormatting(buf, cfSheets);
    },
  };
}
