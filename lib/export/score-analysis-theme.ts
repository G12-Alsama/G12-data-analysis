/**
 * Styling for the Overall Score Analysis workbook, reconciled to the colours,
 * merges, and sizing of the reference `MCQ_Overall_Score_Analysis` template.
 *
 * Scoped to this one export only (not `sheet-utils.ts`'s shared HEADER_STYLE /
 * TITLE_STYLE / etc.) so the other workbooks (item analysis, grades,
 * performance report) keep their current look.
 *
 * The reference file ships a custom "Alsama Brand" theme (`xl/theme/theme1.xml`)
 * — extracted verbatim below — so that `{ theme, tint }` fill/font references
 * resolve to the real brand palette rather than xlsx-js-style's default Office
 * theme. OOXML's `<color theme="n">` index remaps clrScheme entries as
 * 0=lt1, 1=dk1, 2=lt2, 3=dk2, 4=accent1..9=accent6, 10=hlink, 11=folHlink.
 *
 * NOTE ON SCOPE: `xlsx-js-style` (and the community SheetJS it forks) has no
 * writer for native Excel Table objects (`xl/tables/tableN.xml` / `ListObject`)
 * — only worksheet-level AutoFilter (`!autofilter`). Real named Tables would
 * need bespoke post-write OOXML zip surgery, the same category of work already
 * scoped out for Slicers. This module therefore only ever produces AutoFilter,
 * not Table objects — see `applyAutoFilter` below.
 */

import { XLSX } from "./sheet-utils";
import type { CellStyle } from "./sheet-utils";

const ALSAMA_THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Alsama Brand"><a:dk1><a:srgbClr val="25232E"/></a:dk1><a:lt1><a:srgbClr val="F9F5F2"/></a:lt1><a:dk2><a:srgbClr val="47535A"/></a:dk2><a:lt2><a:srgbClr val="F9ECE0"/></a:lt2><a:accent1><a:srgbClr val="B2375B"/></a:accent1><a:accent2><a:srgbClr val="D04C72"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="B2375B"/></a:hlink><a:folHlink><a:srgbClr val="D04C72"/></a:folHlink></a:clrScheme><a:fontScheme name="Alsama Brand"><a:majorFont><a:latin typeface="Barlow SemiCondensed"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Barlow"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="35000"><a:schemeClr val="phClr"><a:tint val="37000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="15000"/><a:satMod val="350000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="1"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:shade val="51000"/><a:satMod val="130000"/></a:schemeClr></a:gs><a:gs pos="80000"><a:schemeClr val="phClr"><a:shade val="93000"/><a:satMod val="130000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="94000"/><a:satMod val="135000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"><a:shade val="95000"/><a:satMod val="105000"/></a:schemeClr></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

/** Theme colour indices, per the `<color theme="n">` remap (not clrScheme order). */
const THEME = {
  lt1: 0,
  dk1: 1,
  lt2: 2,
  dk2: 3,
  accent1: 4,
  accent2: 5,
} as const;

type WorkBookWithTheme = XLSX.WorkBook & { Themes?: { raw: string } };

/** Embed the reference file's "Alsama Brand" theme so `{theme, tint}` styles below render correctly. */
export function applyAlsamaTheme(wb: XLSX.WorkBook): void {
  (wb as WorkBookWithTheme).Themes = { raw: ALSAMA_THEME_XML };
}

/**
 * Page/sheet title row (e.g. "MCQ Overall Scores - Summary"): dark slate
 * banner, near-white bold text.
 *
 * Uses `lt2` rather than `lt1` (index 0) for the light text colour: xlsx-js-style
 * drops a `{theme: 0}` font colour on write (a falsy-index bug in its style
 * writer — verified directly against the installed package), so `lt1` never
 * makes it into the file. `lt2` is a real, non-zero theme slot from the same
 * brand palette and serialises correctly.
 */
export const SA_TITLE_STYLE: CellStyle = {
  font: { bold: true, sz: 16, color: { theme: THEME.lt2 } },
  fill: { patternType: "solid", fgColor: { theme: THEME.dk2, tint: -0.5 } },
  alignment: { vertical: "center" },
};

/** Descriptive/meta text rows (sheet purpose, notes): light pink panel, dark text. */
export const SA_SUBTITLE_STYLE: CellStyle = {
  font: { sz: 12, color: { theme: THEME.dk1 } },
  fill: { patternType: "solid", fgColor: { theme: THEME.accent2, tint: 0.8 } },
  alignment: { wrapText: true, vertical: "center" },
};

/** Section-banner rows introducing each table (e.g. "...summary for each assessment"). */
export const SA_BANNER_STYLE: CellStyle = {
  font: { bold: true, italic: true, color: { theme: THEME.dk1 } },
  fill: { patternType: "solid", fgColor: { theme: THEME.accent2, tint: 0.6 } },
  alignment: { wrapText: true, vertical: "center" },
};

/**
 * Column-header rows. The reference file leaves these unfilled because Excel's
 * Table banding supplies the colour; since we only emit AutoFilter (see the
 * module note above), we fill explicitly with Accent 1 — the same theme colour
 * Excel's default table style would have banded the header with.
 */
export const SA_HEADER_STYLE: CellStyle = {
  font: { bold: true, color: { theme: THEME.lt2 } }, // lt2, not lt1 — see SA_TITLE_STYLE note
  fill: { patternType: "solid", fgColor: { theme: THEME.accent1 } },
  alignment: { vertical: "center", wrapText: true },
};

/** A merge spanning the full current column width of a title/subtitle/banner row. */
export function fullWidthMerge(row: number, ncols: number): XLSX.Range {
  return { s: { r: row, c: 0 }, e: { r: row, c: ncols - 1 } };
}

/**
 * Column widths derived from the header label and the actual current cell
 * contents (not a fixed guess), so widths track the data as it changes cycle
 * to cycle.
 */
export function computeColWidths(
  header: readonly string[],
  rows: readonly (string | number | null)[][],
): XLSX.ColInfo[] {
  return header.map((h, c) => {
    let max = h.length;
    for (const row of rows) {
      const v = row[c];
      if (v == null) continue;
      const len = String(v).length;
      if (len > max) max = len;
    }
    return { wch: Math.min(Math.max(max + 2, 10), 40) };
  });
}

/**
 * Row-height overrides for specific rows (title / section-banner rows only),
 * as a dense array sized to the highest overridden index + 1 — SheetJS keeps
 * every row past the array's end at its default height.
 */
export function buildRowHeights(overrides: Record<number, number>): XLSX.RowInfo[] {
  const maxRow = Math.max(...Object.keys(overrides).map(Number));
  const rows: XLSX.RowInfo[] = Array.from({ length: maxRow + 1 }, () => ({}));
  for (const [r, hpt] of Object.entries(overrides)) rows[Number(r)] = { hpt };
  return rows;
}

/**
 * Real, working AutoFilter over one table's header + data range — the
 * deliberate stand-in for the reference file's Table objects (see the module
 * note above). Excel supports only one AutoFilter region per worksheet, so a
 * sheet with more than one table block can only wrap its primary block.
 */
export function applyAutoFilter(
  ws: XLSX.WorkSheet,
  headerRow: number,
  lastDataRow: number,
  ncols: number,
): void {
  if (lastDataRow < headerRow) return; // no data rows — nothing to filter
  ws["!autofilter"] = {
    ref: `A${headerRow + 1}:${XLSX.utils.encode_col(ncols - 1)}${lastDataRow + 1}`,
  };
}
