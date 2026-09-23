/**
 * Real Excel conditional-formatting injection.
 *
 * `xlsx-js-style` (used everywhere else in lib/export for cell styling) cannot
 * write conditional-formatting XML at all — it has no support for `<dxf>` or
 * `<conditionalFormatting>` elements. That is why the item-analysis/grades
 * exports fall back to pre-baked static fills (RATING_STYLES/PERFORMANCE_STYLES
 * in sheet-utils.ts).
 *
 * The assessment-health reports need genuinely LIVE conditional formatting —
 * rules that re-evaluate if a viewer edits a cell, matching the reference
 * workbooks exactly. This module patches that in after xlsx-js-style has
 * written the file: unzip the generated .xlsx with JSZip (already a project
 * dependency), splice `<dxf>` entries into `xl/styles.xml` and
 * `<conditionalFormatting>` blocks into the target `xl/worksheets/sheetN.xml`
 * files, then rezip. Runs in both Node and the browser (JSZip + Uint8Array).
 */
import JSZip from "jszip";

/** A single dxf-backed visual (font color and/or solid fill). `fillAttr` picks
 * which color attribute the original workbook used for the solid fill — some
 * rules (Reliability) encode the visible color as `fgColor`, others
 * (Speededness/Timing) as `bgColor`; both render identically for a solid
 * pattern in Excel, but we match the source exactly for a clean XML diff. */
export interface DxfSpec {
  fontColor?: string;
  fillColor?: string;
  fillAttr?: "fg" | "bg";
}

export type CfRuleSpec =
  | { kind: "cellIs"; sqref: string; operator: "greaterThanOrEqual" | "lessThan" | "lessThanOrEqual" | "greaterThan" | "between"; formula: string[]; dxf: DxfSpec }
  | { kind: "expression"; sqref: string; formula: string; dxf: DxfSpec }
  | { kind: "colorScale"; sqref: string; colors: [string, string, string] };

export interface SheetCf {
  /** 0-based index matching the order sheets were appended via book_append_sheet. */
  sheetIndex: number;
  rules: CfRuleSpec[];
}

/** An A1 range spanning [c0,r0]..[c1,r1] (0-based columns via XLSX.utils.encode_col,
 * 1-based rows) — collapsed to a single cell ref when it's a 1×1 range, matching
 * how Excel itself writes a single-cell `sqref` (e.g. "I5", not "I5:I5"). */
export function rangeRef(colStart: string, r0: number, colEnd: string, r1: number): string {
  return colStart === colEnd && r0 === r1 ? `${colStart}${r0}` : `${colStart}${r0}:${colEnd}${r1}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dxfXml(dxf: DxfSpec): string {
  const font = dxf.fontColor ? `<font><color rgb="${dxf.fontColor}"/></font>` : "";
  const attr = dxf.fillAttr === "fg" ? "fgColor" : "bgColor";
  const fill = dxf.fillColor ? `<fill><patternFill patternType="solid"><${attr} rgb="${dxf.fillColor}"/></patternFill></fill>` : "";
  return `<dxf>${font}${fill}</dxf>`;
}

function cfRuleXml(rule: CfRuleSpec, priority: number, dxfId: number | null): string {
  if (rule.kind === "cellIs") {
    const formulas = rule.formula.map((f) => `<formula>${escapeXml(f)}</formula>`).join("");
    return `<cfRule type="cellIs" dxfId="${dxfId}" priority="${priority}" operator="${rule.operator}">${formulas}</cfRule>`;
  }
  if (rule.kind === "expression") {
    return `<cfRule type="expression" dxfId="${dxfId}" priority="${priority}"><formula>${escapeXml(rule.formula)}</formula></cfRule>`;
  }
  const [c1, c2, c3] = rule.colors;
  return (
    `<cfRule type="colorScale" priority="${priority}"><colorScale>` +
    `<cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/>` +
    `<color rgb="${c1}"/><color rgb="${c2}"/><color rgb="${c3}"/></colorScale></cfRule>`
  );
}

/** Group rules by sqref, preserving first-seen order (matches how the
 * originals bundle several cfRules under one `<conditionalFormatting>`). */
function groupBySqref(rules: readonly CfRuleSpec[]): Map<string, CfRuleSpec[]> {
  const groups = new Map<string, CfRuleSpec[]>();
  for (const r of rules) {
    const list = groups.get(r.sqref);
    if (list) list.push(r);
    else groups.set(r.sqref, [r]);
  }
  return groups;
}

function injectDxfs(stylesXml: string, newDxfs: string[]): { xml: string; baseCount: number } {
  if (newDxfs.length === 0) return { xml: stylesXml, baseCount: 0 };
  const withChildren = stylesXml.match(/<dxfs count="(\d+)">([\s\S]*?)<\/dxfs>/);
  if (withChildren) {
    const base = parseInt(withChildren[1]!, 10);
    const merged = `<dxfs count="${base + newDxfs.length}">${withChildren[2]}${newDxfs.join("")}</dxfs>`;
    return { xml: stylesXml.replace(withChildren[0], merged), baseCount: base };
  }
  const selfClosing = stylesXml.match(/<dxfs count="(\d+)"\s*\/>/);
  if (selfClosing) {
    const base = parseInt(selfClosing[1]!, 10);
    const block = `<dxfs count="${base + newDxfs.length}">${newDxfs.join("")}</dxfs>`;
    return { xml: stylesXml.replace(selfClosing[0], block), baseCount: base };
  }
  const block = `<dxfs count="${newDxfs.length}">${newDxfs.join("")}</dxfs>`;
  if (stylesXml.includes("</cellStyles>")) {
    return { xml: stylesXml.replace("</cellStyles>", `</cellStyles>${block}`), baseCount: 0 };
  }
  if (stylesXml.includes("<tableStyles")) {
    return { xml: stylesXml.replace("<tableStyles", `${block}<tableStyles`), baseCount: 0 };
  }
  return { xml: stylesXml.replace("</styleSheet>", `${block}</styleSheet>`), baseCount: 0 };
}

/** Insert `<conditionalFormatting>` blocks at the schema-correct position:
 * after mergeCells/sheetData, before dataValidations/pageMargins. */
function injectSheetCf(sheetXml: string, cfXml: string): string {
  if (cfXml === "") return sheetXml;
  for (const marker of ["<dataValidations", "<pageMargins", "<pageSetup", "<extLst"]) {
    const idx = sheetXml.indexOf(marker);
    if (idx !== -1) return sheetXml.slice(0, idx) + cfXml + sheetXml.slice(idx);
  }
  return sheetXml.replace("</worksheet>", `${cfXml}</worksheet>`);
}

/**
 * Patch real conditional-formatting rules into an xlsx-js-style-generated
 * workbook buffer. Returns the patched file bytes (universal Uint8Array —
 * safe for both a Node Buffer write and a browser Blob).
 */
export async function applyConditionalFormatting(
  source: Buffer | Uint8Array,
  sheets: readonly SheetCf[],
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(source);

  // Single pass: assign each non-colorScale rule a dxfId (insertion order),
  // building the new <dxf> entries to splice into styles.xml.
  const newDxfs: string[] = [];
  const dxfIdOf = new Map<CfRuleSpec, number>();
  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      if (rule.kind === "colorScale") continue;
      dxfIdOf.set(rule, newDxfs.length);
      newDxfs.push(dxfXml(rule.dxf));
    }
  }

  const stylesFile = zip.file("xl/styles.xml");
  if (!stylesFile) throw new Error("applyConditionalFormatting: xl/styles.xml missing from workbook");
  const stylesXml = await stylesFile.async("string");
  const { xml: patchedStyles, baseCount } = injectDxfs(stylesXml, newDxfs);
  zip.file("xl/styles.xml", patchedStyles);

  for (const sheet of sheets) {
    if (sheet.rules.length === 0) continue;
    const path = `xl/worksheets/sheet${sheet.sheetIndex + 1}.xml`;
    const sheetFile = zip.file(path);
    if (!sheetFile) throw new Error(`applyConditionalFormatting: ${path} missing from workbook`);
    const sheetXml = await sheetFile.async("string");

    const groups = groupBySqref(sheet.rules);
    let priority = 1;
    const blocks: string[] = [];
    for (const [sqref, rules] of groups) {
      const inner = rules
        .map((r) => cfRuleXml(r, priority++, r.kind === "colorScale" ? null : baseCount + dxfIdOf.get(r)!))
        .join("");
      blocks.push(`<conditionalFormatting sqref="${sqref}">${inner}</conditionalFormatting>`);
    }
    zip.file(path, injectSheetCf(sheetXml, blocks.join("")));
  }

  return zip.generateAsync({ type: "uint8array" });
}
