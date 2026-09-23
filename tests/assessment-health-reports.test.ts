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

  it("marks the unsourced Major Element Level sheet instead of fabricating rows", () => {
    const ws = built.workbook.Sheets["Major Element Level"]!;
    expect(ws["A5"]?.v).toBe("Not available");
  });

  it("marks Median AnswerResponseTimeSeconds and Overall Accuracy as not sourced on Assessment Level", () => {
    const ws = built.workbook.Sheets["Assessment Level"]!;
    const header: string[] = [];
    for (let c = 0; ws[`${String.fromCharCode(65 + c)}4`]; c++) header.push(String(ws[`${String.fromCharCode(65 + c)}4`]!.v));
    const medianTimeCol = header.indexOf("Median AnswerResponseTimeSeconds");
    const overallAccCol = header.indexOf("Overall Accuracy");
    expect(medianTimeCol).toBeGreaterThanOrEqual(0);
    expect(overallAccCol).toBeGreaterThanOrEqual(0);
    if (diagnostics && diagnostics.assessments.length > 0) {
      expect(ws[`${String.fromCharCode(65 + medianTimeCol)}5`]?.v).toBe("Not sourced");
      expect(ws[`${String.fromCharCode(65 + overallAccCol)}5`]?.v).toBe("Not sourced");
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

  it("marks the unsourced Major Element Level sheet instead of fabricating rows", () => {
    const ws = built.workbook.Sheets["Major Element Level"]!;
    expect(ws["A7"]?.v).toBe("Not available");
  });

  it("carries the app's own Pearson/Spearman correlations through to the Assessment Level sheet", () => {
    if (!diagnostics || diagnostics.assessments.length === 0) return;
    const ws = built.workbook.Sheets["Assessment Level"]!;
    const first = diagnostics.assessments[0]!;
    // Column K (index 10) is Time–Performance Correlation (Pearson), row 7 is the first data row.
    const cell = ws["K7"];
    expect(cell?.v).toBe(first.whole.timing.pearson ?? "n/a");
  });
});
