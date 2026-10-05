/**
 * Per-Item Speededness / Omission / Completion workbook (the 4th Assessment Health
 * file): data shaping, thresholds, notes mapping, sheet/table naming (incl. a 31+
 * character assessment name), workbook structure against the spec, and a regression
 * test for the CT_Worksheet child order (tableParts / conditionalFormatting).
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import * as XLSXr from "xlsx";
import spec from "@/reference/assessment_health_reports/per_item_export_spec.json";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import type { PerItemSource, PerItemSourceAssessment, PerItemSourceItem, PerItemSourceResponse } from "@/lib/data/per-item-source";
import { speededness, type DiagResponse } from "@/lib/diagnostics";
import {
  buildPerItemAnalysis, noteFor, speedednessTier, omissionTier, completionTier,
  speedednessLabel, omissionLabel, completionLabel, SPEEDEDNESS_THRESHOLDS, OMISSION_THRESHOLDS,
  COMPLETION_THRESHOLDS, TEST_SECTION_EARLY, TEST_SECTION_LATE,
} from "@/lib/export/per-item-analysis";
import { buildPerItemWorkbook, perItemSheetName, perItemTableName, PER_ITEM_README_SHEET } from "@/lib/export/per-item-report";
import {
  applyExcelTables, insertTableParts, isValidTableName, worksheetChildren, WORKSHEET_CHILD_ORDER,
} from "@/lib/export/ooxml-tables";
import { XLSX, workbookToBuffer } from "@/lib/export/sheet-utils";

// ── fixtures ────────────────────────────────────────────────────────────────

const item = (id: string, over: Partial<PerItemSourceItem> = {}): PerItemSourceItem => ({
  id, qmQuestionId: null, description: `desc-${id}`, wording: `wording-${id}`,
  major: "Major", sub: "Sub", demand: "D1", maxScore: 1, ...over,
});
const resp = (participantId: string, itemId: string, over: Partial<PerItemSourceResponse> = {}): PerItemSourceResponse => ({
  participantId, itemId, score: 1, answered: true, presentedNumber: 1, responseTime: 10, ...over,
});

/**
 * Hand-checkable assessment. Stored item order is deliberately scrambled relative to
 * the presented order. p5 is in the drop-set; p1 has a SUPERSEDED earlier row for i1;
 * i0 is unscored (maxScore 0).
 *
 *   item  scores       answered     median QPN   acc   omission
 *   i3    1 1 1 1      T T T T      1            1.00  0
 *   i1    1 0 1 0      T T T T      2            0.50  0
 *   i2    1 1 0 0      T T T F      3.5          0.50  0.25
 *   i4    0 0 1 0      T F T F      4            0.25  0.50   <- the only Late item (ceil(.25*4)=1)
 *
 * Early baseline (i3,i1,i2 pooled, 12 responses): omission 1/12, accuracy 8/12.
 */
function alpha(): PerItemSourceAssessment {
  const P = ["p1", "p2", "p3", "p4"];
  const rows: PerItemSourceResponse[] = [];
  const add = (itemId: string, scores: number[], answered: boolean[], qpn: number[], times: (number | null)[]) =>
    P.forEach((p, i) => rows.push(resp(p, itemId, { score: scores[i]!, answered: answered[i]!, presentedNumber: qpn[i]!, responseTime: times[i]! })));
  rows.push(resp("p1", "i1", { score: 0, answered: false, presentedNumber: 9, responseTime: 999 })); // superseded (same cell, earlier row)
  add("i3", [1, 1, 1, 1], [true, true, true, true], [1, 1, 2, 1], [10, 20, 30, 40]);
  add("i1", [1, 0, 1, 0], [true, true, true, true], [2, 2, 2, 3], [5, 5, 5, 5]);
  add("i2", [1, 1, 0, 0], [true, true, true, false], [3, 3, 4, 4], [7, null, 9, null]);
  add("i4", [0, 0, 1, 0], [true, false, true, false], [3, 4, 4, 4], [null, null, null, null]);
  add("i0", [1, 1, 1, 1], [true, true, true, true], [5, 5, 5, 5], [1, 1, 1, 1]); // unscored item
  for (const it of ["i3", "i1", "i2", "i4"]) rows.push(resp("p5", it, { score: 0, answered: false, presentedNumber: 1 })); // dropped
  return {
    assessmentId: "A1", assessmentName: "Alpha",
    items: [item("i0", { maxScore: 0 }), item("i4"), item("i2"), item("i1", { qmQuestionId: "100002805825" }), item("i3")],
    responses: rows, excludedParticipantIds: ["p5"],
  };
}
const source = (...assessments: PerItemSourceAssessment[]): PerItemSource => ({ cycleId: "c", sourceFileName: "My_Export.csv", assessments });
const rowsOf = (a: PerItemSourceAssessment) => buildPerItemAnalysis(source(a)).assessments[0]!.rows;

// ── data shaping ────────────────────────────────────────────────────────────

describe("per-item analysis — data shaping", () => {
  const rows = rowsOf(alpha());
  const byQ = (q: number | string) => rows.find((r) => r.questionId === q)!;

  it("keeps only scored items that have responses, ordered by MEDIAN QuestionPresentedNumber", () => {
    expect(rows.map((r) => r.questionId)).toEqual(["i3", 100002805825, "i2", "i4"]); // i0 (maxScore 0) gone
    expect(rows.map((r) => r.presentedNumber)).toEqual([1, 2, 3.5, 4]);
  });

  it("applies the participant drop-set and de-duplicates (participant,item) keeping the LAST row", () => {
    for (const r of rows) {
      expect(r.responses).toBe(4); // p5 dropped; the superseded p1/i1 row not counted
      expect(r.participants).toBe(4);
    }
  });

  it("Item Accuracy = mean AnswerScore; Omission = omitted/total; Completion = 1 − Omission", () => {
    expect(byQ("i3").accuracy).toBe(1);
    expect(byQ(100002805825).accuracy).toBe(0.5);
    expect(byQ("i2").accuracy).toBe(0.5); // omitted row still counts (score 0) — mean over ALL responses
    expect(byQ("i4").accuracy).toBe(0.25);
    expect(byQ("i2").omissionRate).toBe(0.25);
    expect(byQ("i4").omissionRate).toBe(0.5);
    for (const r of rows) expect(r.omissionRate + r.completionRate).toBeCloseTo(1, 12);
  });

  it("median response time ignores missing times; null when an item has none", () => {
    expect(byQ("i3").medianResponseTime).toBe(25);
    expect(byQ("i2").medianResponseTime).toBe(8); // [7, 9]
    expect(byQ("i4").medianResponseTime).toBeNull();
  });

  it("final ceil(25%) of items are Late; the rest Early / Middle", () => {
    expect(rows.map((r) => r.testSection)).toEqual([TEST_SECTION_EARLY, TEST_SECTION_EARLY, TEST_SECTION_EARLY, TEST_SECTION_LATE]);
  });

  it("Speededness Index uses the pooled Early/Middle baseline and is computed for EVERY item", () => {
    const eo = 1 / 12, ea = 8 / 12;
    const expected = (r: { omissionRate: number; accuracy: number }) => (Math.max(0, r.omissionRate - eo) + Math.max(0, ea - r.accuracy)) / 2;
    for (const r of rows) expect(r.speedednessIndex).toBeCloseTo(expected(r), 12);
    expect(byQ("i3").speedednessIndex).toBe(0);
    expect(byQ("i4").speedednessIndex).toBeCloseTo(0.4166666667, 9);
  });

  it("statuses and notes follow the thresholds and (Test Section, Speededness Status)", () => {
    expect(byQ("i3").speedednessStatus).toBe(spec.item_sheet.status_labels.speededness[0]);
    expect(byQ(100002805825).speedednessStatus).toBe(spec.item_sheet.status_labels.speededness[1]); // 0.0833
    expect(byQ("i2").speedednessStatus).toBe(spec.item_sheet.status_labels.speededness[2]); //         0.1667
    expect(byQ("i4").notes).toBe(spec.item_sheet.notes_templates.late.Flag);
    expect(byQ("i2").notes).toBe(spec.item_sheet.notes_templates.early_middle.Flag);
    expect(byQ("i3").notes).toBe(spec.item_sheet.notes_templates.early_middle.Good);
  });

  it("QuestionId is the real QM id (numeric) when present, else the item id", () => {
    expect(byQ(100002805825).questionId).toBe(100002805825);
    expect(byQ("i3").questionId).toBe("i3");
  });

  it("an item with no QuestionPresentedNumber is ordered by stored position, shown EMPTY, and reported", () => {
    const a = alpha();
    a.responses = a.responses.map((r) => ({ ...r, presentedNumber: null }));
    const out = buildPerItemAnalysis(source(a));
    expect(out.assessments[0]!.rows.every((r) => r.presentedNumber === null)).toBe(true);
    expect(out.assessments[0]!.rows.map((r) => r.questionId)).toEqual(["i4", "i2", 100002805825, "i3"]); // stored order
    expect(out.warnings.join(" ")).toMatch(/no QuestionPresentedNumber/);
  });

  it("with no Early / Middle items (a single item) the index/status/notes are EMPTY, not invented", () => {
    const a: PerItemSourceAssessment = {
      assessmentId: "A", assessmentName: "Solo", items: [item("only")],
      responses: [resp("p1", "only"), resp("p2", "only")], excludedParticipantIds: [],
    };
    const out = buildPerItemAnalysis(source(a));
    const r = out.assessments[0]!.rows[0]!;
    expect(r.testSection).toBe(TEST_SECTION_LATE);
    expect([r.speedednessIndex, r.speedednessStatus, r.notes]).toEqual([null, null, null]);
    expect(out.warnings.join(" ")).toMatch(/no Early \/ Middle items/);
  });

  it("drops an assessment with nothing to tabulate; keeps the others in source order", () => {
    const empty: PerItemSourceAssessment = { assessmentId: "E", assessmentName: "Empty", items: [item("x")], responses: [], excludedParticipantIds: [] };
    const out = buildPerItemAnalysis(source(empty, alpha()));
    expect(out.assessments.map((a) => a.assessmentName)).toEqual(["Alpha"]);
  });

  it("does not mutate its input", () => {
    const a = alpha();
    const snap = JSON.stringify(a);
    buildPerItemAnalysis(source(a));
    expect(JSON.stringify(a)).toBe(snap);
  });
});

// ── thresholds & notes ──────────────────────────────────────────────────────

describe("thresholds", () => {
  it("match the numbers inside the spec's conditional-formatting rules", () => {
    const nums = (range: string) => {
      const block = spec.item_sheet.conditional_formatting.find((b) => b.range.startsWith(range))!;
      return new Set(block.rules.flatMap(([f]) => [...(f ?? "").matchAll(/[<>]=?(\d*\.\d+)/g)].map((m) => Number(m[1]))));
    };
    expect(nums("N")).toEqual(new Set([SPEEDEDNESS_THRESHOLDS.good, SPEEDEDNESS_THRESHOLDS.review]));
    expect(nums("P")).toEqual(new Set([OMISSION_THRESHOLDS.good, OMISSION_THRESHOLDS.review]));
    expect(nums("Q")).toEqual(new Set([COMPLETION_THRESHOLDS.good, COMPLETION_THRESHOLDS.review]));
  });

  it("classify the boundaries exactly (<= / >= are inclusive)", () => {
    expect([0, 0.05, 0.0500001, 0.15, 0.1500001].map(speedednessTier)).toEqual(["Good", "Good", "Review", "Review", "Flag"]);
    expect([0, 0.05, 0.0500001, 0.1, 0.1000001].map(omissionTier)).toEqual(["Good", "Good", "Review", "Review", "Flag"]);
    expect([1, 0.95, 0.9499, 0.9, 0.8999].map(completionTier)).toEqual(["Good", "Good", "Review", "Review", "Flag"]);
  });

  it("agree with the existing diagnostics bands for omission / completion", () => {
    for (const omitted of [0, 1, 2, 3, 5, 10]) {
      const recs: DiagResponse[] = Array.from({ length: 20 }, (_, i) => ({
        participantId: `p${i}`, itemId: "q", demandLevel: null, itemSet: null, majorElement: null, order: 1,
        answered: i >= omitted, correct: true, responseTime: 1,
      }));
      const d = speededness(recs);
      expect(omissionTier(omitted / 20)).toBe(d.omissionStatus);
      expect(completionTier(1 - omitted / 20)).toBe(d.completionStatus);
    }
  });

  it("use the spec's status labels", () => {
    expect(["Good", "Review", "Flag"].map((t) => speedednessLabel(t as never))).toEqual(spec.item_sheet.status_labels.speededness);
    expect(["Good", "Review", "Flag"].map((t) => omissionLabel(t as never))).toEqual(spec.item_sheet.status_labels.omission);
    expect(["Good", "Review", "Flag"].map((t) => completionLabel(t as never))).toEqual(spec.item_sheet.status_labels.completion);
  });
});

describe("notes mapping", () => {
  it("all six (section × status) templates match the spec exactly and are distinct", () => {
    const got = new Set<string>();
    for (const tier of ["Good", "Review", "Flag"] as const) {
      expect(noteFor(TEST_SECTION_EARLY, tier)).toBe(spec.item_sheet.notes_templates.early_middle[tier]);
      expect(noteFor(TEST_SECTION_LATE, tier)).toBe(spec.item_sheet.notes_templates.late[tier]);
      got.add(noteFor(TEST_SECTION_EARLY, tier));
      got.add(noteFor(TEST_SECTION_LATE, tier));
    }
    expect(got.size).toBe(6);
  });
});

// ── naming ──────────────────────────────────────────────────────────────────

describe("sheet and table naming", () => {
  it("sheet: strips []:*?/\\, caps at 31 chars, stays unique and never clashes with the README", () => {
    const used = new Set([PER_ITEM_README_SHEET.toLowerCase()]);
    expect(perItemSheetName("G12++ English as a 2nd Language", used)).toBe("G12++ English as a 2nd Language"); // exactly 31
    expect(perItemSheetName("A[B]:C*D?E/F\\G", new Set())).toBe("ABCDEFG");
    const long = "Mathematics and Quantitative Reasoning (Applied) — Extended Edition";
    const s1 = perItemSheetName(long, used);
    const s2 = perItemSheetName(long, used);
    expect(s1.length).toBeLessThanOrEqual(31);
    expect(s2.length).toBeLessThanOrEqual(31);
    expect(s2).not.toBe(s1);
    expect(s2).toMatch(/ \(2\)$/);
    expect(perItemSheetName("readme & methodology", used)).not.toBe("readme & methodology");
  });

  it("table: sanitised sheet name, 20 chars, + ItemTable — reproduces the spec's examples", () => {
    const sheets = Object.keys(spec.item_sheet.col_widths_variable.A.per_sheet);
    const used = new Set<string>();
    expect(sheets.map((s) => perItemTableName(s, used))).toEqual(spec.item_sheet.excel_table.examples);
  });

  it("table: always valid and workbook-unique (digit-led, non-Latin and colliding names)", () => {
    const used = new Set<string>();
    const names = [
      "2nd Language",
      "اللّغة العربيّة",
      "اللّغة العربيّة 2",
      "Mathematics and Quantitative Reasoning A",
      "Mathematics and Quantitative Reasoning B", // same first 20 alnum chars as the one above
      "Applicable Math",
      "Applicable Math",
    ].map((n) => perItemTableName(n, used));
    for (const n of names) expect(isValidTableName(n)).toBe(true);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    expect(names[0]).toBe("_2ndLanguageItemTable");
    expect(names[3]!.startsWith("MathematicsandQuanti")).toBe(true);
  });
});

// ── workbook structure ──────────────────────────────────────────────────────

const LONG_NAME = "Mathematics and Quantitative Reasoning (Applied) — Extended Edition"; // 66 chars

function beta(name: string, id: string): PerItemSourceAssessment {
  const a = alpha();
  return { ...a, assessmentId: id, assessmentName: name };
}

async function openBuilt(src: PerItemSource) {
  const built = buildPerItemWorkbook({ cycleName: "May 2026", source: src });
  const bytes = await built.bytes();
  const zip = await JSZip.loadAsync(bytes);
  const sheetXml = async (i: number) => zip.file(`xl/worksheets/sheet${i + 1}.xml`)!.async("string");
  return { built, bytes, zip, sheetXml };
}

describe("workbook structure", () => {
  const src = source(alpha(), beta(LONG_NAME, "A2"), beta("Odd [Name]: *?/\\ Test", "A3"));

  it("README first, then one sheet per assessment in source order; names sanitised; no hardcoded list", async () => {
    const { built } = await openBuilt(src);
    expect(built.sheetNames[0]).toBe("README & Methodology");
    expect(built.sheetNames).toHaveLength(4);
    expect(built.sheetNames[1]).toBe("Alpha");
    expect(built.sheetNames[2]).toBe(LONG_NAME.slice(0, 31).trim());
    expect(built.sheetNames[3]).toBe("Odd Name  Test"); // []:*?/\ stripped, nothing else touched
    for (const n of built.sheetNames) expect(n.length).toBeLessThanOrEqual(31);
    // dynamic: one assessment in → one item sheet out
    const one = await openBuilt(source(alpha()));
    expect(one.built.sheetNames).toEqual(["README & Methodology", "Alpha"]);
  });

  it("every sheet: explicit width on EVERY column (no stubs), explicit heights, defaultRowHeight, no hidden/freeze/tab colour", async () => {
    const { built, sheetXml } = await openBuilt(src);
    for (let i = 0; i < built.sheetNames.length; i++) {
      const xml = await sheetXml(i);
      expect(xml).toContain('<sheetFormatPr defaultRowHeight="13.8"/>');
      const cols = xml.match(/<col\b[^>]*\/>/g) ?? [];
      expect(cols.length).toBe(i === 0 ? 4 : 20);
      for (const c of cols) {
        expect(c).toMatch(/\bwidth="[\d.]+"/);
        expect(c).not.toMatch(/hidden/);
      }
      expect(xml).not.toMatch(/<pane\b|<tabColor\b|hidden="1"/);
    }
  });

  it("README: merges, widths and per-row heights from the spec; real source file name", async () => {
    const { sheetXml } = await openBuilt(src);
    const xml = await sheetXml(0);
    for (const m of spec.readme.merges) expect(xml).toContain(`<mergeCell ref="${m}"/>`);
    for (const [c, w] of Object.entries(spec.readme.col_widths)) {
      const idx = c.charCodeAt(0) - 64;
      expect(xml).toMatch(new RegExp(`<col min="${idx}" max="${idx}" width="${w}"`));
    }
    for (const [r, h] of Object.entries(spec.readme.row_heights)) expect(xml).toMatch(new RegExp(`<row r="${r}" ht="${h}" customHeight="1"`));
    const wb = XLSXr.read(await (await openBuilt(src)).bytes, { type: "array" });
    const ws = wb.Sheets["README & Methodology"]!;
    expect(ws["A2"]!.v).toBe("Source dataset: My_Export.csv");
    expect(ws["A1"]!.v).toBe(spec.readme.title);
    spec.readme.rows.forEach((row, i) => row.forEach((v, c) => expect(ws[XLSX.utils.encode_cell({ r: 4 + i, c })]!.v).toBe(v)));
  });

  it("item sheets: spec row heights, widths (variable columns at the spec maximum), merges, headers, number formats", async () => {
    const { sheetXml, built, bytes } = await openBuilt(src);
    const wb = XLSXr.read(bytes, { type: "array", cellStyles: true });
    for (let i = 1; i < built.sheetNames.length; i++) {
      const xml = await sheetXml(i);
      const last = 4 + 4; // four items
      for (const r of [1, 2, 3, 4]) expect(xml).toContain(`<row r="${r}" ht="${(spec.item_sheet.row_heights as Record<string, number>)[r]}" customHeight="1"`);
      for (let r = 5; r <= last; r++) expect(xml).toContain(`<row r="${r}" ht="${spec.item_sheet.row_heights.data_rows}" customHeight="1"`);
      for (const m of spec.item_sheet.merges) expect(xml).toContain(`<mergeCell ref="${m}"/>`);
      const widths: Record<string, number> = { ...spec.item_sheet.col_widths_fixed };
      for (const [c, v] of Object.entries(spec.item_sheet.col_widths_variable)) widths[c] = v.max;
      for (const [c, w] of Object.entries(widths)) {
        const idx = c.charCodeAt(0) - 64;
        expect(xml).toMatch(new RegExp(`<col min="${idx}" max="${idx}" width="${w}"`));
      }
      const ws = wb.Sheets[built.sheetNames[i]!]!;
      spec.item_sheet.columns.forEach((c, ci) => expect(ws[XLSX.utils.encode_cell({ r: 3, c: ci })]!.v).toBe(c.header));
      expect(ws["B5"]!.z).toBe("0");
    }
  });

  it("title uses the FULL assessment name even when the sheet tab is truncated", async () => {
    const { bytes, built } = await openBuilt(src);
    const wb = XLSXr.read(bytes, { type: "array" });
    const ws = wb.Sheets[built.sheetNames[2]!]!;
    expect(ws["A1"]!.v).toBe(`${LONG_NAME} — Item-Level Speededness, Omission, and Completion Analysis`);
    expect(ws["A5"]!.v).toBe(LONG_NAME);
  });

  it("Excel Table per item sheet: A4:T<last>, spec headers, valid unique names, no style name, stripes on", async () => {
    const { zip, built, sheetXml } = await openBuilt(src);
    const tables = Object.keys(zip.files).filter((n) => /^xl\/tables\/table\d+\.xml$/.test(n));
    expect(tables).toHaveLength(built.sheetNames.length - 1);
    const names: string[] = [];
    for (const t of tables) {
      const xml = await zip.file(t)!.async("string");
      const name = xml.match(/\bname="([^"]+)" displayName="\1"/)![1]!;
      names.push(name.toLowerCase());
      expect(isValidTableName(name)).toBe(true);
      expect(xml).toContain('ref="A4:T8"');
      expect([...xml.matchAll(/<tableColumn id="\d+" name="([^"]+)"/g)].map((m) => m[1])).toEqual(spec.item_sheet.columns.map((c) => c.header));
      expect(xml).toContain('showRowStripes="1"');
      expect(xml).not.toMatch(/tableStyleInfo[^>]*\bname=/);
      expect(xml).not.toContain("totalsRow");
    }
    expect(new Set(names).size).toBe(names.length);
    const ct = await zip.file("[Content_Types].xml")!.async("string");
    for (const t of tables) expect(ct).toContain(`PartName="/${t}"`);
    const xml1 = await sheetXml(1);
    expect(xml1).toMatch(/<tableParts count="1"><tablePart r:id="rId1"\/><\/tableParts>/);
    const rels = await zip.file("xl/worksheets/_rels/sheet2.xml.rels")!.async("string");
    expect(rels).toContain('Target="../tables/table1.xml"');
  });

  it("conditional formatting: native expression rules on N, P, Q ending at the real last row, spec colours", async () => {
    const { sheetXml, zip } = await openBuilt(src);
    const xml = await sheetXml(1);
    for (const block of spec.item_sheet.conditional_formatting) {
      const sqref = block.range.replace("<last>", "8");
      expect(xml).toContain(`<conditionalFormatting sqref="${sqref}">`);
      for (const [formula] of block.rules) expect(xml).toContain(`<formula>${(formula ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</formula>`);
    }
    expect((xml.match(/<conditionalFormatting /g) ?? []).length).toBe(3);
    const styles = await zip.file("xl/styles.xml")!.async("string");
    for (const c of Object.values(spec.item_sheet.cf_colors)) {
      expect(styles).toContain(`rgb="${c.fill}"`);
      expect(styles).toContain(`rgb="${c.font}"`);
    }
  });

  it("CF ranges track each sheet's own last row", async () => {
    const big = alpha();
    const more: PerItemSourceAssessment = {
      ...beta("Bigger", "A9"),
      items: [...big.items, item("i5"), item("i6")],
      responses: [...big.responses, ...["p1", "p2", "p3", "p4"].flatMap((p) => [resp(p, "i5", { presentedNumber: 6 }), resp(p, "i6", { presentedNumber: 7 })])],
    };
    const { sheetXml } = await openBuilt(source(alpha(), more));
    expect(await sheetXml(1)).toContain('sqref="N5:N8"');
    const xml2 = await sheetXml(2);
    expect(xml2).toContain('sqref="N5:N10"');
    expect(xml2).toContain('sqref="Q5:Q10"');
  });

  it("writes empty cells — never placeholder text — for values that are absent", async () => {
    const a = alpha();
    a.items = a.items.map((it) => ({ ...it, description: null, wording: null, major: null, sub: null, demand: null }));
    const { bytes } = await openBuilt(source(a));
    const wb = XLSXr.read(bytes, { type: "array" });
    const ws = wb.Sheets["Alpha"]!;
    for (const col of ["C", "D", "E", "F", "G"]) expect(ws[`${col}5`]).toBeUndefined();
    for (const name of wb.SheetNames) {
      for (const [addr, cell] of Object.entries(wb.Sheets[name]!)) {
        if (addr.startsWith("!")) continue;
        expect(String((cell as { v: unknown }).v)).not.toMatch(/not sourced|not available|^n\/?a$|^tbd$|^unknown$|^undefined$|^null$|^NaN$/i);
      }
    }
  });

  it("throws a clear error when no assessment has anything to tabulate", () => {
    const empty: PerItemSourceAssessment = { assessmentId: "E", assessmentName: "Empty", items: [item("x")], responses: [], excludedParticipantIds: [] };
    expect(() => buildPerItemWorkbook({ cycleName: "c", source: source(empty) })).toThrow(/no assessment has scored items/i);
  });
});

// ── REGRESSION: CT_Worksheet child order ────────────────────────────────────

/** True when a worksheet's top-level children appear in CT_Worksheet order. */
function isSchemaOrdered(xml: string): boolean {
  const idx = worksheetChildren(xml).map((c) => (WORKSHEET_CHILD_ORDER as readonly string[]).indexOf(c.name));
  return idx.every((i) => i !== -1) && idx.every((v, k) => k === 0 || idx[k - 1]! <= v);
}
const SHEET_HEAD = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
const names = (xml: string) => worksheetChildren(xml).map((c) => c.name);

describe("regression: worksheet element order (an out-of-order element makes Excel blank sheetData)", () => {
  it("every generated sheet is in schema order, with conditionalFormatting after mergeCells and tableParts after ignoredErrors", async () => {
    const { built, sheetXml } = await openBuilt(source(alpha(), beta("Second", "A2")));
    for (let i = 0; i < built.sheetNames.length; i++) {
      const xml = await sheetXml(i);
      expect(isSchemaOrdered(xml)).toBe(true);
      const order = names(xml);
      if (i === 0) { expect(order).not.toContain("tableParts"); continue; }
      expect(order.indexOf("conditionalFormatting")).toBeGreaterThan(order.indexOf("mergeCells"));
      expect(order.indexOf("tableParts")).toBeGreaterThan(order.indexOf("ignoredErrors"));
      expect(order.indexOf("tableParts")).toBeGreaterThan(order.indexOf("conditionalFormatting"));
      expect(order.indexOf("ignoredErrors")).toBeGreaterThan(order.indexOf("conditionalFormatting"));
      expect(order[order.length - 1]).toBe("tableParts");
      expect(order.indexOf("sheetData")).toBeGreaterThan(-1); // sheetData survives
    }
  });

  it("the check itself catches the corrupting order (tableParts BEFORE ignoredErrors, CF AFTER ignoredErrors)", () => {
    const bad1 = `${SHEET_HEAD}<sheetData/><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><tableParts count="1"><tablePart r:id="rId1"/></tableParts><ignoredErrors><ignoredError sqref="A1"/></ignoredErrors></worksheet>`;
    const bad2 = `${SHEET_HEAD}<sheetData/><ignoredErrors><ignoredError sqref="A1"/></ignoredErrors><conditionalFormatting sqref="A1"/></worksheet>`;
    expect(isSchemaOrdered(bad1)).toBe(false);
    expect(isSchemaOrdered(bad2)).toBe(false);
  });

  it("insertTableParts anchors on the sheet's own children, not on </worksheet>", () => {
    const parts = '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>';
    const cf = '<conditionalFormatting sqref="A1"/>';
    const ign = '<ignoredErrors><ignoredError sqref="A1"/></ignoredErrors>';
    const base = `${SHEET_HEAD}<dimension ref="A1"/><sheetData/><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>`;

    // after ignoredErrors when present
    let out = insertTableParts(`${base}${cf}${ign}</worksheet>`, parts);
    expect(names(out)).toEqual(["dimension", "sheetData", "mergeCells", "conditionalFormatting", "ignoredErrors", "tableParts"]);
    expect(isSchemaOrdered(out)).toBe(true);

    // before extLst, after pageMargins — NOT merely before </worksheet>
    out = insertTableParts(`${base}${cf}<pageMargins left="1" right="1" top="1" bottom="1" header="0" footer="0"/><extLst><ext uri="x"/></extLst></worksheet>`, parts);
    expect(names(out)).toEqual(["dimension", "sheetData", "mergeCells", "conditionalFormatting", "pageMargins", "tableParts", "extLst"]);
    expect(isSchemaOrdered(out)).toBe(true);

    // no ignoredErrors / no CF: straight after mergeCells
    out = insertTableParts(`${base}</worksheet>`, parts);
    expect(names(out)).toEqual(["dimension", "sheetData", "mergeCells", "tableParts"]);

    // never inserts twice
    expect(() => insertTableParts(out, parts)).toThrow(/already has <tableParts>/);
  });

  it("applyExcelTables keeps an existing sheet rels part (fresh rId) and rejects bad / duplicate table names", async () => {
    const ws = XLSX.utils.aoa_to_sheet([["H1", "H2"], ["a", 1]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S1");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["H1", "H2"], ["a", 1]]), "S2");
    const zip = await JSZip.loadAsync(workbookToBuffer(wb));
    zip.file("xl/worksheets/_rels/sheet1.xml.rels",
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="y"/></Relationships>');
    const prepared = await zip.generateAsync({ type: "uint8array" });

    const out = await JSZip.loadAsync(await applyExcelTables(prepared, [
      { sheetIndex: 0, name: "FirstTable", ref: "A1:B2", columns: ["H1", "H2"] },
      { sheetIndex: 1, name: "SecondTable", ref: "A1:B2", columns: ["H1", "H2"] },
    ]));
    const rels = await out.file("xl/worksheets/_rels/sheet1.xml.rels")!.async("string");
    expect(rels).toContain('Id="rId1"'); // existing kept
    expect(rels).toContain('Id="rId2"'); // new one is fresh
    expect(await out.file("xl/worksheets/sheet1.xml")!.async("string")).toContain('<tablePart r:id="rId2"/>');
    expect(Object.keys(out.files).filter((n) => /^xl\/tables\//.test(n)).sort()).toEqual(["xl/tables/table1.xml", "xl/tables/table2.xml"]);
    expect(Object.keys(out.files).filter((n) => n.endsWith("/"))).toEqual([]); // no zip directory entries

    await expect(applyExcelTables(prepared, [
      { sheetIndex: 0, name: "Same", ref: "A1:B2", columns: ["H1", "H2"] },
      { sheetIndex: 1, name: "same", ref: "A1:B2", columns: ["H1", "H2"] },
    ])).rejects.toThrow(/duplicate table name/);
    await expect(applyExcelTables(prepared, [{ sheetIndex: 0, name: "1Bad", ref: "A1:B2", columns: ["H1", "H2"] }])).rejects.toThrow(/invalid table name/);
    await expect(applyExcelTables(prepared, [{ sheetIndex: 0, name: "Dup", ref: "A1:B2", columns: ["H1", "H1"] }])).rejects.toThrow(/duplicate column names/);
  });
});

// ── provider source + cross-check against the existing diagnostics ───────────

describe("getPerItemSource (live provider)", () => {
  const provider = new InMemoryDataProvider();
  const cycle = provider.listCycles().find((c) => !c.mock)!;

  it("returns the assessments in the app's existing order; null for a non-live cycle", () => {
    const src = provider.getPerItemSource(cycle.id)!;
    const diag = provider.getDiagnostics(cycle.id)!;
    expect(src.assessments.map((a) => a.assessmentId)).toEqual(diag.assessments.map((a) => a.assessmentId));
    expect(provider.getPerItemSource("no-such-cycle")).toBeNull();
  });

  it("hands over the SAME drop-set the diagnostics use: cohort exclusions and Clean-stage row removals", () => {
    const fresh = new InMemoryDataProvider();
    const cyc = fresh.listCycles().find((c) => !c.mock)!;
    const before = fresh.getPerItemSource(cyc.id)!;
    const a0 = before.assessments[0]!;
    const a1 = before.assessments[1]!;
    const pid = a0.responses[0]!.participantId;
    const other = a0.responses.find((r) => r.participantId !== pid)!.participantId;

    fresh.excludeParticipantFromCohort(cyc.id, pid, true, "test");
    const afterCohort = fresh.getPerItemSource(cyc.id)!;
    for (const a of afterCohort.assessments) expect(a.excludedParticipantIds).toContain(pid);

    fresh.setCleanRemoval(cyc.id, a1.assessmentId, { rows: [other] }, true);
    const afterClean = fresh.getPerItemSource(cyc.id)!;
    expect(afterClean.assessments[1]!.excludedParticipantIds).toContain(other); // that subject only
    expect(afterClean.assessments[0]!.excludedParticipantIds).not.toContain(other);

    // …and the analysis honours it: the excluded participant's responses vanish from the counts.
    const totalResponses = (s: PerItemSource, i: number) =>
      buildPerItemAnalysis({ ...s, assessments: [s.assessments[i]!] }).assessments[0]!.rows.reduce((n, r) => n + r.responses, 0);
    expect(totalResponses(afterCohort, 0)).toBeLessThan(totalResponses(before, 0));
    expect(totalResponses(afterClean, 1)).toBeLessThan(totalResponses(afterCohort, 1));
  });

  it("per-item rates reconcile with the existing whole-assessment diagnostics (independent implementation)", () => {
    const src = provider.getPerItemSource(cycle.id)!;
    const diag = provider.getDiagnostics(cycle.id)!;
    const out = buildPerItemAnalysis(src);
    expect(out.assessments.length).toBe(src.assessments.length);
    for (const a of out.assessments) {
      const d = diag.assessments.find((x) => x.assessmentId === a.assessmentId)!;
      const total = a.rows.reduce((s, r) => s + r.responses, 0);
      const omitted = a.rows.reduce((s, r) => s + r.omissionRate * r.responses, 0);
      expect(total).toBe(d.whole.speeded.nPresentations);
      expect(a.rows.length).toBe(d.whole.speeded.nItems);
      expect(Math.round((omitted / total) * 1e4) / 1e4).toBeCloseTo(d.whole.speeded.omissionRate, 4);
    }
  });

  it("builds a complete workbook from the live provider data", async () => {
    const src = provider.getPerItemSource(cycle.id)!;
    const built = buildPerItemWorkbook({ cycleName: cycle.name, source: src });
    expect(built.sheetNames.length).toBe(1 + src.assessments.length);
    const bytes = await built.bytes();
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});
