/**
 * Structural fidelity checks for the three Assessment Health workbooks
 * (Reliability / Speededness / Timing), each ported cell-by-cell from the
 * team's original manual-analysis files. These assert sheet names, merged
 * ranges, and — critically — that real `<conditionalFormatting>`/`<dxf>` XML
 * actually landed in the generated file (not just that the in-memory
 * xlsx-js-style workbook has cell fills), since that's the part
 * lib/export/ooxml-cf.ts patches in after the fact.
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import {
  buildReliabilityWorkbook,
  RELIABILITY_SHEETS,
  buildSpeedednessWorkbook,
  SPEEDEDNESS_SHEETS,
  buildTimingWorkbook,
  TIMING_SHEETS,
} from "@/lib/export";

const provider = new InMemoryDataProvider();
const cycle = provider.listCycles().find((c) => !c.mock)!;
const reliability = provider.getReliability(cycle.id);
const diagnostics = provider.getDiagnostics(cycle.id);

async function sheetXml(bytes: Uint8Array, sheetIndex: number): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(`xl/worksheets/sheet${sheetIndex + 1}.xml`);
  expect(file).not.toBeNull();
  return file!.async("string");
}
async function stylesXml(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file("xl/styles.xml")!.async("string");
}

describe("Reliability workbook", () => {
  const built = buildReliabilityWorkbook({ cycleName: cycle.name, reliability });

  it("has the six original sheet names, in order", () => {
    expect(built.workbook.SheetNames).toEqual([...RELIABILITY_SHEETS]);
  });

  it("carries merged ranges on every metrics sheet", () => {
    for (const name of RELIABILITY_SHEETS) {
      const ws = built.workbook.Sheets[name]!;
      expect(ws["!merges"]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("patches real conditional-formatting XML into the Overall and By_Assessment sheets", async () => {
    const bytes = await built.bytes();
    const overallXml = await sheetXml(bytes, RELIABILITY_SHEETS.indexOf("Overall"));
    expect(overallXml).toContain("<conditionalFormatting");
    expect(overallXml).toContain('sqref="E5:F5"');
    expect(overallXml).toContain('sqref="I5"');

    const byAssessmentXml = await sheetXml(bytes, RELIABILITY_SHEETS.indexOf("By_Assessment"));
    expect(byAssessmentXml).toContain("<conditionalFormatting");

    const styles = await stylesXml(bytes);
    expect(styles).toMatch(/<dxfs count="\d+">/);
  });

  it("fills the cross-subject By_Demand_Level sheet in fixed D1→D3 order", () => {
    const ws = built.workbook.Sheets["By_Demand_Level"]!;
    // Column A holds DemandLevel from row 5 (0-indexed row 4) onward.
    const labels: string[] = [];
    for (let r = 5; ; r++) {
      const cell = ws[`A${r}`];
      if (!cell) break;
      labels.push(String(cell.v));
    }
    expect(labels).toEqual([...labels].sort((a, b) => ["D1", "D2", "D3"].indexOf(a) - ["D1", "D2", "D3"].indexOf(b)));
    expect(labels.length).toBeGreaterThan(0);
  });
});

describe("Speededness workbook", () => {
  const built = buildSpeedednessWorkbook({ cycleName: cycle.name, reliability, diagnostics });

  it("has the three original sheet names, in order", () => {
    expect(built.workbook.SheetNames).toEqual([...SPEEDEDNESS_SHEETS]);
  });

  it("carries merged title/subtitle ranges on every sheet", () => {
    for (const name of SPEEDEDNESS_SHEETS) {
      const ws = built.workbook.Sheets[name]!;
      expect(ws["!merges"]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("patches the Speededness/Omission/Completion CF triple into Assessment Level", async () => {
    const bytes = await built.bytes();
    const xml = await sheetXml(bytes, SPEEDEDNESS_SHEETS.indexOf("Assessment Level"));
    expect(xml).toContain("<conditionalFormatting");
    expect(xml).toContain('type="expression"');
    const styles = await stylesXml(bytes);
    expect(styles).toMatch(/<dxfs count="\d+">/);
  });

  it("fills the Major Element Level sheet with real speededByMajorElement() rows, not a placeholder", () => {
    if (!diagnostics || diagnostics.assessments.length === 0) return;
    const ws = built.workbook.Sheets["Major Element Level"]!;
    const first = diagnostics.assessments.find((a) => a.byMajorElement.length > 0);
    if (!first) return;
    expect(ws["A5"]?.v).toBe(first.assessmentName);
    expect(ws["B5"]?.v).toBe(first.byMajorElement[0]!.majorElement);
  });

  it("carries the app's own median response time and overall accuracy through to Assessment Level (additive SpeededResult fields)", () => {
    const ws = built.workbook.Sheets["Assessment Level"]!;
    const header: string[] = [];
    for (let c = 0; ws[`${String.fromCharCode(65 + c)}4`]; c++) header.push(String(ws[`${String.fromCharCode(65 + c)}4`]!.v));
    const medianTimeCol = header.indexOf("Median AnswerResponseTimeSeconds");
    const overallAccCol = header.indexOf("Overall Accuracy");
    expect(medianTimeCol).toBeGreaterThanOrEqual(0);
    expect(overallAccCol).toBeGreaterThanOrEqual(0);
    if (diagnostics && diagnostics.assessments.length > 0) {
      const first = diagnostics.assessments[0]!;
      expect(ws[`${String.fromCharCode(65 + medianTimeCol)}5`]?.v).toBe(first.whole.speeded.medianResponseTime ?? undefined);
      expect(ws[`${String.fromCharCode(65 + overallAccCol)}5`]?.v).toBe(first.whole.speeded.overallAccuracy);
    }
  });
});

describe("Timing workbook", () => {
  const built = buildTimingWorkbook({ cycleName: cycle.name, reliability, diagnostics });

  it("has the three original sheet names, in order", () => {
    expect(built.workbook.SheetNames).toEqual([...TIMING_SHEETS]);
  });

  it("carries merged title/subtitle ranges on every sheet", () => {
    for (const name of TIMING_SHEETS) {
      const ws = built.workbook.Sheets[name]!;
      expect(ws["!merges"]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("patches the colorScale + correlation-band CF into Assessment Level", async () => {
    const bytes = await built.bytes();
    const xml = await sheetXml(bytes, TIMING_SHEETS.indexOf("Assessment Level"));
    expect(xml).toContain("<conditionalFormatting");
    expect(xml).toContain('type="colorScale"');
    expect(xml).toContain('type="cellIs"');
    const styles = await stylesXml(bytes);
    expect(styles).toMatch(/<dxfs count="\d+">/);
  });

  it("fills the Major Element Level sheet with real timingByMajorElement() rows, not a placeholder", () => {
    if (!diagnostics || diagnostics.assessments.length === 0) return;
    const ws = built.workbook.Sheets["Major Element Level"]!;
    const first = diagnostics.assessments.find((a) => a.timingByMajorElement.length > 0);
    if (!first) return;
    expect(ws["A7"]?.v).toBe(first.assessmentName);
    expect(ws["B7"]?.v).toBe(first.timingByMajorElement[0]!.majorElement);
  });

  it("carries the app's own Pearson/Spearman correlations through to the Assessment Level sheet", () => {
    if (!diagnostics || diagnostics.assessments.length === 0) return;
    const ws = built.workbook.Sheets["Assessment Level"]!;
    const first = diagnostics.assessments[0]!;
    // Column K (index 10) is Time–Performance Correlation (Pearson), row 7 is the first data row.
    const cell = ws["K7"];
    expect(cell?.v).toBe(first.whole.timing.pearson ?? undefined);
  });
});

// --- OOXML validity ---------------------------------------------------------
// Regression coverage for a real corruption bug: xlsx-js-style writes
// <ignoredErrors> (whenever a numeric-looking value is stored as text — e.g.
// this module's own "n/a"/"Not sourced" cells) near the very end of
// CT_Worksheet's fixed child sequence, well after <conditionalFormatting>'s
// required position (right after <mergeCells>/<sheetData>). Landing the
// patched-in <conditionalFormatting> after <ignoredErrors> is a schema-order
// violation that made Excel treat the sheet as corrupt and drop its
// <sheetData> entirely on repair — every sheet came out blank except the
// CF-free README. Structural checks against openpyxl/JSZip alone didn't catch
// this (both parse the misordered XML leniently), so this guards the actual
// element order and cross-checks with SheetJS's stricter reader.
describe("Generated workbooks are valid OOXML (not just structurally similar)", () => {
  async function assertCfBeforeIgnoredErrors(bytes: Uint8Array, sheetIndex: number): Promise<void> {
    const xml = await sheetXml(bytes, sheetIndex);
    const cfIdx = xml.indexOf("<conditionalFormatting");
    const ignoredIdx = xml.indexOf("<ignoredErrors");
    if (cfIdx === -1) return; // sheet carries no CF (e.g. an empty "not available" placeholder)
    if (ignoredIdx !== -1) expect(cfIdx).toBeLessThan(ignoredIdx);
  }

  it("orders <conditionalFormatting> before <ignoredErrors> on every Reliability data sheet", async () => {
    const built = buildReliabilityWorkbook({ cycleName: cycle.name, reliability });
    const bytes = await built.bytes();
    for (let i = 1; i < RELIABILITY_SHEETS.length; i++) await assertCfBeforeIgnoredErrors(bytes, i);
  });

  it("orders <conditionalFormatting> before <ignoredErrors> on every Speededness/Timing data sheet", async () => {
    const spd = await buildSpeedednessWorkbook({ cycleName: cycle.name, reliability, diagnostics }).bytes();
    const tim = await buildTimingWorkbook({ cycleName: cycle.name, reliability, diagnostics }).bytes();
    for (let i = 1; i < SPEEDEDNESS_SHEETS.length; i++) await assertCfBeforeIgnoredErrors(spd, i);
    for (let i = 1; i < TIMING_SHEETS.length; i++) await assertCfBeforeIgnoredErrors(tim, i);
  });

  it("round-trips through SheetJS's strict reader with the right sheet count and dimensions for every workbook", async () => {
    const XLSX = await import("xlsx");
    const cases: [ReturnType<typeof buildReliabilityWorkbook> | ReturnType<typeof buildSpeedednessWorkbook> | ReturnType<typeof buildTimingWorkbook>, readonly string[]][] = [
      [buildReliabilityWorkbook({ cycleName: cycle.name, reliability }), RELIABILITY_SHEETS],
      [buildSpeedednessWorkbook({ cycleName: cycle.name, reliability, diagnostics }), SPEEDEDNESS_SHEETS],
      [buildTimingWorkbook({ cycleName: cycle.name, reliability, diagnostics }), TIMING_SHEETS],
    ];
    for (const [built, sheetNames] of cases) {
      const bytes = await built.bytes();
      // WTF: true makes SheetJS throw instead of silently tolerating malformed OOXML.
      const parsed = XLSX.read(bytes, { type: "buffer", WTF: true });
      expect(parsed.SheetNames).toEqual([...sheetNames]);
      for (const name of sheetNames) {
        const ref = parsed.Sheets[name]!["!ref"];
        const expected = built.workbook.Sheets[name]!["!ref"];
        expect(ref).toBe(expected);
      }
    }
  });
});
