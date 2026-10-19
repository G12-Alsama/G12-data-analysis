/**
 * Real Excel Tables (`ListObject`s) injection.
 *
 * `xlsx-js-style` has no writer for Excel Tables, and lib/export/ooxml-cf.ts
 * covers conditional formatting / row defaults but not Tables. This module adds
 * ONLY Tables, as a separate pass over an already-written .xlsx (JSZip is already a
 * project dependency; runs in Node and the browser), so ooxml-cf.ts is untouched.
 *
 * For each table it writes:
 *   - `xl/tables/tableN.xml`  (ids unique across the workbook),
 *   - a `table` relationship in the owning sheet's rels part (creating the part, or
 *     appending with a fresh rId if one already exists),
 *   - a `[Content_Types].xml` Override for the table part,
 *   - a `<tableParts>` element in the worksheet XML.
 *
 * SCHEMA ORDER. CT_Worksheet's children have a fixed order and `tableParts` is
 * nearly LAST (… conditionalFormatting, …, ignoredErrors, smartTags, drawing, …,
 * tableParts, extLst). An out-of-order element makes Excel treat the part as corrupt
 * and drop `<sheetData>` on repair, blanking the sheet. So the insertion point is
 * never "just before </worksheet>": it is computed from the sheet's ACTUAL top-level
 * children — after the last child that must precede `tableParts` (in practice
 * `<ignoredErrors>`, which xlsx-js-style writes whenever a numeric-looking value is
 * stored as text), and before `<extLst>` if present.
 *
 * Mirrors the reference workbook's tables: header row on, totals row off, NO built-in
 * style name, row stripes on.
 */
import JSZip from "jszip";

/** CT_Worksheet child order (ECMA-376 Part 1, 18.3.1.99). */
export const WORKSHEET_CHILD_ORDER = [
  "sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr",
  "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate",
  "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting", "dataValidations",
  "hyperlinks", "printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks",
  "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing", "legacyDrawing",
  "legacyDrawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst",
] as const;

export interface TableSpec {
  /** 0-based index matching the order sheets were appended via book_append_sheet. */
  sheetIndex: number;
  /** Excel table name (also its displayName) — must be valid and workbook-unique. */
  name: string;
  /** A1 range of header + data rows, e.g. "A4:T44". */
  ref: string;
  /** Column names — MUST equal the header cell text, in order. */
  columns: readonly string[];
}

const TABLE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table";
const TABLE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml";
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A valid Excel table name: starts with a letter or underscore, then letters,
 * digits, underscores or periods; not a cell reference; at most 255 characters.
 * (Names built from sanitised sheet names + "ItemTable" are valid except when the
 * sheet name starts with a digit — see `perItemTableName`.)
 */
export function isValidTableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && name.length <= 255 && !/^[A-Za-z]{1,3}\d+$/.test(name);
}

export function tableXml(t: TableSpec, id: number): string {
  if (!isValidTableName(t.name)) throw new Error(`applyExcelTables: invalid table name "${t.name}"`);
  const names = new Set(t.columns);
  if (names.size !== t.columns.length) throw new Error(`applyExcelTables: duplicate column names in table "${t.name}"`);
  const cols = t.columns.map((c, i) => `<tableColumn id="${i + 1}" name="${escapeXml(c)}"/>`).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<table xmlns="${MAIN_NS}" id="${id}" name="${t.name}" displayName="${t.name}" ref="${t.ref}">` +
    `<tableColumns count="${t.columns.length}">${cols}</tableColumns>` +
    `<tableStyleInfo showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>` +
    `</table>`
  );
}

interface Child { name: string; start: number; end: number }

/** Top-level children of <worksheet> with their source spans (depth-aware). */
export function worksheetChildren(sheetXml: string): Child[] {
  const open = sheetXml.match(/<worksheet\b[^>]*>/);
  if (!open) throw new Error("applyExcelTables: no <worksheet> element");
  const bodyStart = open.index! + open[0].length;
  const bodyEnd = sheetXml.lastIndexOf("</worksheet>");
  const out: Child[] = [];
  const tag = /<(\/?)([A-Za-z0-9:_-]+)\b[^>]*?(\/?)>/g;
  tag.lastIndex = bodyStart;
  let depth = 0;
  let cur: { name: string; start: number } | null = null;
  for (let m = tag.exec(sheetXml); m && m.index < bodyEnd; m = tag.exec(sheetXml)) {
    const [whole, closing, rawName, selfClose] = m as unknown as [string, string, string, string];
    const name = rawName.split(":").pop()!;
    if (closing) {
      depth -= 1;
      if (depth === 0 && cur) { out.push({ name: cur.name, start: cur.start, end: m.index + whole.length }); cur = null; }
    } else if (selfClose) {
      if (depth === 0) out.push({ name, start: m.index, end: m.index + whole.length });
    } else {
      if (depth === 0) cur = { name, start: m.index };
      depth += 1;
    }
  }
  return out;
}

/**
 * Insert `<tableParts>` at its schema-correct position, anchored on the sheet's own
 * top-level children: immediately after the last child that precedes `tableParts` in
 * CT_Worksheet (and so before `extLst`, if any). Throws if the sheet already has
 * `tableParts` — this pass owns the element.
 */
export function insertTableParts(sheetXml: string, tablePartsXml: string): string {
  const order = WORKSHEET_CHILD_ORDER as readonly string[];
  const target = order.indexOf("tableParts");
  const children = worksheetChildren(sheetXml);
  if (children.some((c) => c.name === "tableParts")) throw new Error("applyExcelTables: sheet already has <tableParts>");
  let anchor: Child | null = null;
  for (const c of children) {
    const idx = order.indexOf(c.name);
    if (idx === -1) throw new Error(`applyExcelTables: unknown worksheet child <${c.name}>`);
    if (idx < target) anchor = c;
  }
  if (!anchor) throw new Error("applyExcelTables: worksheet has no children to anchor <tableParts> on");
  return sheetXml.slice(0, anchor.end) + tablePartsXml + sheetXml.slice(anchor.end);
}

function ensureRelNamespace(sheetXml: string): string {
  const open = sheetXml.match(/<worksheet\b[^>]*>/)!;
  if (/\sxmlns:r=/.test(open[0])) return sheetXml;
  return sheetXml.replace(open[0], open[0].replace(/>$/, ` xmlns:r="${REL_NS}">`));
}

/**
 * Patch real Excel Tables into an xlsx-js-style-generated workbook buffer. Returns
 * the patched bytes (universal Uint8Array — safe for a Node Buffer write or a Blob).
 * Safe to chain after `applyConditionalFormatting` (it only adds `tableParts`).
 */
export async function applyExcelTables(source: Buffer | Uint8Array, tables: readonly TableSpec[]): Promise<Uint8Array> {
  if (tables.length === 0) return source instanceof Uint8Array ? source : new Uint8Array(source);

  const seen = new Set<string>();
  for (const t of tables) {
    const key = t.name.toLowerCase();
    if (seen.has(key)) throw new Error(`applyExcelTables: duplicate table name "${t.name}" (names are workbook-unique, case-insensitive)`);
    seen.add(key);
  }

  const zip = await JSZip.loadAsync(source);
  const ctFile = zip.file("[Content_Types].xml");
  if (!ctFile) throw new Error("applyExcelTables: [Content_Types].xml missing from workbook");
  let contentTypes = await ctFile.async("string");

  // Table ids / part numbers continue after any tables already in the package.
  let nextId = 1;
  for (const name of Object.keys(zip.files)) {
    const m = name.match(/^xl\/tables\/table(\d+)\.xml$/);
    if (m) nextId = Math.max(nextId, parseInt(m[1]!, 10) + 1);
  }

  const bySheet = new Map<number, TableSpec[]>();
  for (const t of tables) {
    const list = bySheet.get(t.sheetIndex);
    if (list) list.push(t);
    else bySheet.set(t.sheetIndex, [t]);
  }

  for (const [sheetIndex, sheetTables] of bySheet) {
    const sheetPath = `xl/worksheets/sheet${sheetIndex + 1}.xml`;
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) throw new Error(`applyExcelTables: ${sheetPath} missing from workbook`);
    let sheetXml = ensureRelNamespace(await sheetFile.async("string"));

    const relsPath = `xl/worksheets/_rels/sheet${sheetIndex + 1}.xml.rels`;
    const relsFile = zip.file(relsPath);
    let relsXml = relsFile
      ? await relsFile.async("string")
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const usedRids = new Set([...relsXml.matchAll(/\bId="(rId\d+)"/g)].map((m) => m[1]!));
    let ridCounter = 1;
    const nextRid = (): string => {
      while (usedRids.has(`rId${ridCounter}`)) ridCounter += 1;
      const rid = `rId${ridCounter}`;
      usedRids.add(rid);
      return rid;
    };

    const parts: string[] = [];
    const rels: string[] = [];
    for (const t of sheetTables) {
      const id = nextId++;
      const rid = nextRid();
      zip.file(`xl/tables/table${id}.xml`, tableXml(t, id));
      contentTypes = contentTypes.replace(
        "</Types>",
        `<Override PartName="/xl/tables/table${id}.xml" ContentType="${TABLE_CONTENT_TYPE}"/></Types>`,
      );
      rels.push(`<Relationship Id="${rid}" Type="${TABLE_REL_TYPE}" Target="../tables/table${id}.xml"/>`);
      parts.push(`<tablePart r:id="${rid}"/>`);
    }
    relsXml = relsXml.replace("</Relationships>", `${rels.join("")}</Relationships>`);
    zip.file(relsPath, relsXml);
    sheetXml = insertTableParts(sheetXml, `<tableParts count="${parts.length}">${parts.join("")}</tableParts>`);
    zip.file(sheetPath, sheetXml);
  }

  zip.file("[Content_Types].xml", contentTypes);

  // Emit a clean OPC package: files only (JSZip adds directory entries such as
  // "xl/tables/" whenever a nested path is written, and an OOXML package should not
  // carry them), DEFLATE-compressed like any other .xlsx.
  const clean = new JSZip();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    clean.file(name, await entry.async("uint8array"), { createFolders: false });
  }
  return clean.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
