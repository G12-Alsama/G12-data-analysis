/**
 * Helpers for building workbooks.
 *
 * Uses `xlsx-js-style` — a drop-in fork of SheetJS (same `XLSX.utils` API) that
 * additionally writes cell styles (fills/fonts/alignment). The community SheetJS
 * build silently drops styles on write, so it cannot produce the green/amber/red
 * rating fills the templates require. Reading/parsing on import still uses the
 * upstream `xlsx` package.
 */

import * as XLSX from "xlsx-js-style";

export { XLSX };

export type CellStyle = NonNullable<XLSX.CellObject["s"]>;

/** Conditional-format-style fills for the three quality ratings (Excel palette). */
export const RATING_STYLES: Record<string, CellStyle> = {
  Good: {
    fill: { patternType: "solid", fgColor: { rgb: "C6EFCE" } },
    font: { color: { rgb: "006100" } },
  },
  Review: {
    fill: { patternType: "solid", fgColor: { rgb: "FFEB9C" } },
    font: { color: { rgb: "9C6500" } },
  },
  Flag: {
    fill: { patternType: "solid", fgColor: { rgb: "FFC7CE" } },
    font: { color: { rgb: "9C0006" } },
  },
};

/**
 * Performance-level fills, best → lowest (4 bands): strong green, light green,
 * amber, red. The green / amber / red reuse the item-analysis rating palette;
 * the second band is a lighter green. Applied by the level's index in the
 * (configurable) performance-levels list, so it never hardcodes band names.
 *
 * DOWNSTREAM: this palette is a FIXED 4-entry list indexed by performance-level
 * position. A ScoringConfig with N≠4 performance levels has no colour for the
 * extra band(s) (grades.ts falls back to "no fill"). The next prompt (Settings
 * CRUD + exports) must either generate a colour ramp of length N or validate
 * that the configured level count matches the available styles before export.
 */
export const PERFORMANCE_STYLES: CellStyle[] = [
  { fill: { patternType: "solid", fgColor: { rgb: "C6EFCE" } }, font: { color: { rgb: "006100" } } },
  { fill: { patternType: "solid", fgColor: { rgb: "E2EFDA" } }, font: { color: { rgb: "375623" } } },
  { fill: { patternType: "solid", fgColor: { rgb: "FFEB9C" } }, font: { color: { rgb: "9C6500" } } },
  { fill: { patternType: "solid", fgColor: { rgb: "FFC7CE" } }, font: { color: { rgb: "9C0006" } } },
];

export const HEADER_STYLE: CellStyle = {
  font: { bold: true },
  fill: { patternType: "solid", fgColor: { rgb: "E7E6E6" } },
  alignment: { vertical: "center", wrapText: true },
};

export const TITLE_STYLE: CellStyle = {
  font: { bold: true, sz: 14 },
};

export const META_STYLE: CellStyle = {
  font: { italic: true, color: { rgb: "595959" } },
};

export const GUIDE_STYLE: CellStyle = {
  font: { color: { rgb: "595959" } },
  alignment: { wrapText: true, vertical: "top" },
};

/** Set a cell's style, creating the cell if necessary. */
export function styleCell(
  ws: XLSX.WorkSheet,
  row: number,
  col: number,
  style: CellStyle,
): void {
  const addr = XLSX.utils.encode_cell({ r: row, c: col });
  const cell = (ws[addr] ?? (ws[addr] = { t: "z" } as XLSX.CellObject)) as XLSX.CellObject;
  cell.s = { ...(cell.s as CellStyle | undefined), ...style };
}

/**
 * Excel sheet names: max 31 chars, may not contain []:*?/\ and must be unique
 * within a workbook. Sanitise and de-duplicate.
 */
export function sanitizeSheetName(name: string, used: Set<string>): string {
  let base = (name || "Sheet").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31);
  if (base.length === 0) base = "Sheet";

  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${i})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    i += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Serialise a workbook to an xlsx Buffer (for download / upload to storage). */
export function workbookToBuffer(wb: XLSX.WorkBook): Buffer {
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Median of the numeric values, ignoring null/undefined. Null if none. */
export function median(values: (number | null | undefined)[]): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  nums.sort((a, b) => a - b);
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0
    ? (nums[mid - 1]! + nums[mid]!) / 2
    : nums[mid]!;
}

/** Round to n decimals, or pass null through. */
export function roundOrNull(value: number | null, decimals: number): number | null {
  if (value === null) return null;
  const f = 10 ** decimals;
  const r = Math.round(value * f) / f;
  return r === 0 ? 0 : r;
}

// --- Students' Performance Report brand palette ------------------------------
//
// Shared by lib/export/performance-report.ts, which builds that workbook on
// ExcelJS (not xlsx-js-style) because it needs image embedding and freeze
// panes that xlsx-js-style/xlsx cannot write. These constants live here,
// rather than in that file, purely so a second builder can reuse the same
// 4-tier color scale without duplicating hex values.

/** Brand accent (title bars, hyperlink text) for the Students' Performance Report. */
export const PERFORMANCE_REPORT_BRAND = "B2375B";
/** Standard sheet-wide divider/border color for the Students' Performance Report. */
export const PERFORMANCE_REPORT_BORDER = "B7C9D6";
/** Dark (not pure-black) body text used throughout the Students' Performance Report. */
export const PERFORMANCE_REPORT_TEXT = "1F1F1F";
/** Accent for the "Performance levels" legend heading — dark blue, distinct from the brand maroon. */
export const PERFORMANCE_REPORT_LEGEND_ACCENT = "1F4E78";
export const PERFORMANCE_REPORT_FONT = "Aptos";

export type LevelColorPalette = "classPerformance" | "summary";

const LEVEL_FILLS: Record<LevelColorPalette, readonly string[]> = {
  // Class Performance uses a slightly more saturated tier-1 green and a
  // stronger tier-4 red than Student Summary / Student Profiles.
  classPerformance: ["A9D18E", "E2F0D9", "FFF2CC", "FFC7CE"],
  summary: ["C6E0B4", "E2F0D9", "FFF2CC", "F4CCCC"],
};
/** Tier-4 gets red-tinted text (confirmed against the reference file); the rest use the standard dark body text. */
const LEVEL_TEXT: readonly string[] = [
  PERFORMANCE_REPORT_TEXT,
  PERFORMANCE_REPORT_TEXT,
  PERFORMANCE_REPORT_TEXT,
  "9C0006",
];

/**
 * The 4-tier color scale shared by every "performance level" / "award level"
 * cell in the Students' Performance Report (Class Performance, Student
 * Summary, Student Profiles legend + data cells). Keyed off the value's RANK
 * (0 = best) among the configured levels — never by string-matching label
 * text — so relabelling a level doesn't break the color.
 */
export function colorForLevel(rankIndex: number, palette: LevelColorPalette): { fill: string; text: string } {
  const i = Math.min(Math.max(rankIndex, 0), LEVEL_TEXT.length - 1);
  return { fill: LEVEL_FILLS[palette][i]!, text: LEVEL_TEXT[i]! };
}
