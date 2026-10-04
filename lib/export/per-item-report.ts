/**
 * Per-Item Speededness, Omission & Completion workbook — the 4th Assessment
 * Health file. Built from scratch in code (never by opening or copying the
 * reference workbook) and driven by
 * reference/assessment_health_reports/per_item_export_spec.json, which is the
 * single source of truth for the layout, sizes, styling, Excel Table and
 * conditional-formatting rules below (read programmatically, nothing retyped).
 *
 * Sheets: "README & Methodology", then one sheet per assessment with scored,
 * answered items — in the app's existing assessment order (dynamic: never a fixed
 * list). Each item sheet is: title (A1:T1) / subtitle (A2:T2) / spacer / header on
 * row 4 / one row per item from row 5, wrapped in an Excel Table and carrying live
 * conditional formatting on Speededness Index, Omission Rate and Completion Rate.
 *
 * Pipeline: xlsx-js-style writes cells/styles/merges/widths/heights →
 * `applyConditionalFormatting` (lib/export/ooxml-cf.ts, reused unchanged) adds the
 * CF rules and `sheetFormatPr defaultRowHeight` → `applyExcelTables`
 * (lib/export/ooxml-tables.ts, new) adds the Tables.
 *
 * No placeholder text anywhere: a value that isn't available is an empty cell.
 */
import type { PerItemSource } from "@/lib/data/per-item-source";
import spec from "@/reference/assessment_health_reports/per_item_export_spec.json";
import {
  XLSX, styleCell, setColumnWidths, setRowHeightsFromExcelRows, workbookToBuffer, type CellStyle,
} from "./sheet-utils";
import { applyConditionalFormatting, type CfRuleSpec, type SheetCf } from "./ooxml-cf";
import { applyExcelTables, isValidTableName, type TableSpec } from "./ooxml-tables";
import { buildPerItemAnalysis, type PerItemAssessment, type PerItemRow } from "./per-item-analysis";

export const PER_ITEM_README_SHEET = "README & Methodology";

const ITEM = spec.item_sheet;
const README = spec.readme;
const FONT = spec.workbook.font;
const FONT_SIZE = spec.workbook.font_size;
const DEFAULT_ROW_HEIGHT = spec.workbook.default_row_height;
const COL_COUNT = ITEM.columns.length;
/** Thin-border colour used by every table/header cell in the reference workbook. */
const BORDER_COLOR = "FF47535A";

export interface PerItemReportInput {
  cycleName: string;
  source: PerItemSource;
}

export interface PerItemBuildResult {
  workbook: XLSX.WorkBook;
  /** Sheet names in workbook order (README first). */
  sheetNames: string[];
  /** Data-quality notes to surface to the user (never written into a cell). */
  warnings: string[];
  /** Serialise: cells → conditional formatting → Excel Tables. */
  bytes: () => Promise<Uint8Array>;
}

// --- naming ---

/** Sheet name: strip []:*?/\ (and a leading/trailing apostrophe), max 31 chars, unique. */
export function perItemSheetName(assessmentName: string, used: Set<string>): string {
  let base = (assessmentName || "")
    .replace(/[[\]:*?/\\]/g, "")
    .replace(/^'+|'+$/g, "")
    .trim()
    .slice(0, 31)
    .trim();
  if (base.length === 0) base = "Sheet";
  let candidate = base;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Table name: sheet name stripped to [A-Za-z0-9], truncated to 20 chars, + "ItemTable".
 * Names must be unique workbook-wide and valid, so two edge cases deviate from the
 * plain rule: a leading digit gets a "_" prefix (Excel rejects a digit-led name), and
 * a collision gets a numeric suffix. Ordinary names follow the rule exactly.
 */
export function perItemTableName(sheetName: string, used: Set<string>): string {
  let stem = sheetName.replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
  if (/^[0-9]/.test(stem)) stem = `_${stem}`;
  const base = `${stem}ItemTable`;
  let candidate = base;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${base}${i}`;
  if (!isValidTableName(candidate)) throw new Error(`per-item export: could not derive a valid table name for sheet "${sheetName}"`);
  used.add(candidate.toLowerCase());
  return candidate;
}

// --- styles (all values from the spec; the border colour from the reference) ---

const side = (s: string | null) => (s ? { style: s as "thin", color: { rgb: BORDER_COLOR } } : undefined);
const border = (b: { left: string | null; right: string | null; top: string | null; bottom: string | null }): CellStyle["border"] => ({
  ...(b.left ? { left: side(b.left) } : {}),
  ...(b.right ? { right: side(b.right) } : {}),
  ...(b.top ? { top: side(b.top) } : {}),
  ...(b.bottom ? { bottom: side(b.bottom) } : {}),
});
const align = (a: { h: string | null; v: string | null; wrap: boolean | null }): CellStyle["alignment"] => ({
  ...(a.h ? { horizontal: a.h as "center" } : {}),
  ...(a.v ? { vertical: a.v as "top" } : {}),
  ...(a.wrap ? { wrapText: true } : {}),
});
const base = (extra: Partial<CellStyle> = {}): CellStyle => ({ font: { name: FONT, sz: FONT_SIZE }, ...extra });
const fill = (rgb: string): CellStyle["fill"] => ({ patternType: "solid", fgColor: { rgb } });

function titleStyle(s: { font_color: string; fill: string; align: { h: string; v: string; wrap: boolean } }): CellStyle {
  return {
    font: { name: FONT, sz: FONT_SIZE, bold: true, color: { rgb: s.font_color } },
    fill: fill(s.fill),
    alignment: align(s.align),
  };
}
function subtitleStyle(s: { font_color: string; fill: string; wrap: boolean; v?: string }): CellStyle {
  return {
    font: { name: FONT, sz: FONT_SIZE, color: { rgb: s.font_color } },
    fill: fill(s.fill),
    alignment: { wrapText: s.wrap, ...(s.v ? { vertical: s.v as "center" } : {}) },
  };
}
const allSides = { left: "thin", right: "thin", top: "thin", bottom: "thin" };

function styleRange(ws: XLSX.WorkSheet, r0: number, c0: number, r1: number, c1: number, style: CellStyle): void {
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) styleCell(ws, r, c, style);
}
function setNumberFormat(ws: XLSX.WorkSheet, r: number, c: number, fmt: string): void {
  const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
  if (cell && fmt !== "General") cell.z = fmt;
}

// --- cell values, keyed by the spec's own header text ---

const VALUE_BY_HEADER: Record<string, (r: PerItemRow) => unknown> = {
  AssessmentName: (r) => r.assessmentName,
  QuestionId: (r) => r.questionId,
  QuestionDescription: (r) => r.description,
  QuestionWording: (r) => r.wording,
  QuestionMajorElement: (r) => r.majorElement,
  QuestionSubElement: (r) => r.subElement,
  DemandLevel: (r) => r.demandLevel,
  QuestionPresentedNumber: (r) => r.presentedNumber,
  "Test Section": (r) => r.testSection,
  "Number of Participants": (r) => r.participants,
  "Number of Item Responses": (r) => r.responses,
  "Median AnswerResponseTimeSeconds": (r) => r.medianResponseTime,
  "Item Accuracy": (r) => r.accuracy,
  "Speededness Index": (r) => r.speedednessIndex,
  "Speededness Status": (r) => r.speedednessStatus,
  "Omission Rate": (r) => r.omissionRate,
  "Completion Rate": (r) => r.completionRate,
  "Omission Status": (r) => r.omissionStatus,
  "Completion Status": (r) => r.completionStatus,
  Notes: (r) => r.notes,
};

for (const c of ITEM.columns) {
  if (!VALUE_BY_HEADER[c.header]) throw new Error(`per-item export: spec column "${c.header}" has no value mapping`);
}

/** Empty / absent text becomes an EMPTY cell (undefined), never a placeholder string. */
const cellValue = (v: unknown): unknown => (v === null || v === undefined || v === "" ? undefined : v);

// --- sheets ---

function readmeSheet(sourceFileName: string | null): XLSX.WorkSheet {
  const aoa: unknown[][] = [
    [README.title],
    [README.subtitle.replace("<source dataset file name>", sourceFileName ?? "this cycle's live QM export")],
    [],
    [...README.table_header],
    ...README.rows.map((r) => [...r]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = README.merges.map((m) => XLSX.utils.decode_range(m));
  const lastCol = README.table_header.length - 1;
  styleRange(ws, 0, 0, 0, lastCol, titleStyle(README.title_style));
  styleRange(ws, 1, 0, 1, lastCol, subtitleStyle(README.subtitle_style));
  styleRange(ws, 3, 0, 3, lastCol, base({
    font: { name: FONT, sz: FONT_SIZE, bold: true },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border: border(allSides),
  }));
  styleRange(ws, 4, 0, 3 + README.rows.length, lastCol, base({
    alignment: { vertical: "top", wrapText: true },
    border: border(allSides),
  }));
  setColumnWidths(ws, README.col_widths, README.table_header.length);
  setRowHeightsFromExcelRows(ws, Object.fromEntries(Object.entries(README.row_heights).map(([r, h]) => [Number(r), h])));
  return ws;
}

function itemSheet(a: PerItemAssessment): { ws: XLSX.WorkSheet; lastRow: number } {
  const aoa: unknown[][] = [
    [ITEM.title_template.replace("{AssessmentName}", a.assessmentName)],
    [ITEM.subtitle],
    [],
    ITEM.columns.map((c) => c.header),
    ...a.rows.map((r) => ITEM.columns.map((c) => cellValue(VALUE_BY_HEADER[c.header]!(r)))),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const lastRow = 4 + a.rows.length; // 1-based Excel row of the last data row
  ws["!merges"] = ITEM.merges.map((m) => XLSX.utils.decode_range(m));
  styleRange(ws, 0, 0, 0, COL_COUNT - 1, titleStyle(ITEM.title_style));
  styleRange(ws, 1, 0, 1, COL_COUNT - 1, subtitleStyle(ITEM.subtitle_style));

  ITEM.columns.forEach((c, ci) => {
    styleCell(ws, ITEM.header_row - 1, ci, base({
      font: { name: FONT, sz: FONT_SIZE, bold: true },
      alignment: align(c.header_align),
      border: border(c.header_border),
    }));
    for (let r = ITEM.first_data_row - 1; r < lastRow; r++) {
      styleCell(ws, r, ci, base({ alignment: align(c.data_align), border: border(c.data_border) }));
      setNumberFormat(ws, r, ci, c.number_format);
    }
  });

  // Every column on the sheet gets an explicit numeric width. Fixed columns use the
  // spec value; variable columns use the spec MAXIMUM (never narrower).
  const widths: Record<string, number> = { ...ITEM.col_widths_fixed };
  for (const [col, v] of Object.entries(ITEM.col_widths_variable)) widths[col] = v.max;
  setColumnWidths(ws, widths, COL_COUNT);

  const heights: Record<number, number> = {
    1: ITEM.row_heights["1"], 2: ITEM.row_heights["2"], 3: ITEM.row_heights["3"], 4: ITEM.row_heights["4"],
  };
  for (let r = ITEM.first_data_row; r <= lastRow; r++) heights[r] = ITEM.row_heights.data_rows;
  setRowHeightsFromExcelRows(ws, heights);
  return { ws, lastRow };
}

function cfRulesFor(lastRow: number): CfRuleSpec[] {
  const colors = ITEM.cf_colors as Record<string, { fill: string; font: string }>;
  const out: CfRuleSpec[] = [];
  for (const block of ITEM.conditional_formatting) {
    const sqref = block.range.replace("<last>", String(lastRow));
    for (const [formula, tier] of block.rules as [string, string][]) {
      const c = colors[tier]!;
      out.push({ kind: "expression", sqref, formula, dxf: { fontColor: c.font, fillColor: c.fill, fillAttr: "bg" } });
    }
  }
  return out;
}

/**
 * Build the Per-Item Speededness / Omission / Completion workbook. Throws when no
 * assessment has a scored item with responses (there would be nothing to tabulate).
 */
export function buildPerItemWorkbook(input: PerItemReportInput): PerItemBuildResult {
  const analysis = buildPerItemAnalysis(input.source);
  if (analysis.assessments.length === 0) {
    throw new Error("Per-item export: no assessment has scored items with responses for this sitting.");
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, readmeSheet(analysis.sourceFileName), PER_ITEM_README_SHEET);

  const usedSheets = new Set<string>([PER_ITEM_README_SHEET.toLowerCase()]);
  const usedTables = new Set<string>();
  const sheetNames: string[] = [PER_ITEM_README_SHEET];
  const cfs: SheetCf[] = [{ sheetIndex: 0, rules: [], defaultRowHeight: DEFAULT_ROW_HEIGHT }];
  const tables: TableSpec[] = [];

  for (const a of analysis.assessments) {
    const name = perItemSheetName(a.assessmentName, usedSheets);
    const { ws, lastRow } = itemSheet(a);
    XLSX.utils.book_append_sheet(wb, ws, name);
    const sheetIndex = sheetNames.length;
    sheetNames.push(name);
    cfs.push({ sheetIndex, rules: cfRulesFor(lastRow), defaultRowHeight: DEFAULT_ROW_HEIGHT });
    tables.push({
      sheetIndex,
      name: perItemTableName(name, usedTables),
      ref: `A${ITEM.header_row}:${XLSX.utils.encode_col(COL_COUNT - 1)}${lastRow}`,
      columns: ITEM.columns.map((c) => c.header),
    });
  }

  return {
    workbook: wb,
    sheetNames,
    warnings: analysis.warnings,
    bytes: async () => applyExcelTables(await applyConditionalFormatting(workbookToBuffer(wb), cfs), tables),
  };
}
