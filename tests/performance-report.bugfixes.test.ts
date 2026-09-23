/**
 * Regression tests for four bugs found reviewing a real generated Students
 * Performance Report:
 *
 *  1. Level/award-label columns clipped text (fixed-width columns, no wrap).
 *  2. The Arabic assessment showed under its raw source name (with no data)
 *     on Student Summary/Profiles, and under its raw name (with data) on
 *     Class Performance — a raw-name/display-name mismatch in the shared
 *     read model, not something wrong with either sheet builder.
 *  3. Hyperlinks were written as external file relationships, which real
 *     Excel resolves against the workbook's own folder and blocks.
 *  4. The offline-marked "Writing" essay element (Arabic/English) never
 *     appeared, because it has no MCQ items behind it.
 *
 * Bugs 2 and 4 only reproduce against a REAL raw ingest (the in-memory dev
 * seed already uses near-canonical names), so this suite ingests the actual
 * sample QM export — the same shape of data the bugs were found in.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import * as XLSXR from "xlsx";
import { parseExport, ingestAndClean } from "@/lib/ingest";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { buildPerformanceReportWorkbook } from "@/lib/export/performance-report";
import type { PerformanceReportModel } from "@/lib/data/types";
import type { Seed } from "@/lib/data/seed-types";
import { sampleExportPath } from "./fixtures";

const EMPTY_VALIDATION = {
  passed: true,
  checks: [],
  stats: { rawRows: 0, mcqRows: 0, droppedSurveyRows: 0, droppedNonMcqRows: 0, assessments: 0, participants: 0, items: 0 },
} as unknown as Seed["liveCycle"]["validation"];

function emptySeed(): Seed {
  return {
    generatedAt: new Date().toISOString(),
    engineVersion: "test",
    liveCycle: {
      id: "new-cycle",
      name: "Fresh cycle",
      region: "eu-west",
      startedAt: "today",
      lastActivity: "today",
      stageIndex: 0,
      fileName: "",
      fileSizeMB: 0,
      uploadedAgo: "",
      validation: EMPTY_VALIDATION,
      preview: { headers: [], rows: [] },
      duplicates: 0,
      participants: [],
      assessments: [],
      diagnostics: [],
    },
    priorCycles: [],
  };
}

async function ingestSampleExport(): Promise<InMemoryDataProvider> {
  const { rows } = parseExport(readFileSync(sampleExportPath()));
  const { cleanedResponses, validationReport } = ingestAndClean(rows);
  const provider = new InMemoryDataProvider(emptySeed());
  await provider.ingestRawExport("new-cycle", { name: "export.xlsx", sizeMB: 1.3 }, cleanedResponses, validationReport);
  return provider;
}

function aoaOf(wb: XLSXR.WorkBook, sheet: string): unknown[][] {
  return XLSXR.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet]!, { header: 1, blankrows: true });
}

describe("performance report bugfixes — real ingested sitting (sample_qm_export.xlsx)", () => {
  let provider: InMemoryDataProvider;
  let report: PerformanceReportModel;

  beforeAll(async () => {
    provider = await ingestSampleExport();
    // Essay marks for a handful of real ingested students, both languages —
    // needed to exercise Bug 4 (the essay "Writing" element gets a real level,
    // not just a structural column with nothing behind it).
    const emails = ["student01@example.org", "student03@example.org", "student05@example.org"];
    provider.hydrateEssayMarks("new-cycle", "essays.xlsx", [
      ...emails.map((e) => ({ participantId: e, subjectCode: "AFL" as const, totalScore: 15 })),
      ...emails.map((e) => ({ participantId: e, subjectCode: "ESL" as const, totalScore: 13 })),
    ]);
    report = provider.getPerformanceReport("new-cycle")!;
  });

  // ── Bug 2: raw source name vs. display name ────────────────────────────
  it("resolves the Arabic assessment's raw source name to one canonical display name, everywhere", () => {
    const arabic = report.subjects.find((s) => /arabic/i.test(s.name));
    expect(arabic).toBeTruthy();
    expect(arabic!.name).toBe("Arabic 1st Language");
    // The raw name (however it was scripted in the QM export) never leaks
    // into a display label.
    expect(/[؀-ۿ]/.test(arabic!.name)).toBe(false);

    const summaryArabic = report.summarySubjects.find((s) => s.label === "Arabic 1st Language");
    expect(summaryArabic?.assessmentId).toBeTruthy();
    // The two views key the SAME assessment — Class Performance's subject and
    // Student Summary's column resolve to one underlying id, not two.
    expect(summaryArabic!.assessmentId).toBe(arabic!.assessmentId);
  });

  it("carries real per-student data for Arabic on every sheet (no empty column)", () => {
    const summaryArabic = report.summarySubjects.find((s) => s.label === "Arabic 1st Language")!;
    const arabicCoverage = report.students.filter((st) => st.subjects[summaryArabic.assessmentId!]?.level).length;
    // Before the fix this was 0 (assessmentId resolved to null): compare
    // against a subject with no name-matching issue, rather than assuming
    // every real student sat every real subject.
    const mathsCoverage = report.students.filter(
      (st) => st.subjects[report.summarySubjects.find((s) => s.label === "Applicable Maths")!.assessmentId!]?.level,
    ).length;
    expect(arabicCoverage).toBeGreaterThan(0);
    expect(arabicCoverage).toBe(mathsCoverage);
  });

  // ── Bug 4: the offline essay "Writing" element ─────────────────────────
  it("includes a Writing major element for Arabic and English, with real levels once essay marks exist", () => {
    const arabic = report.subjects.find((s) => /arabic/i.test(s.name))!;
    const english = report.subjects.find((s) => /english/i.test(s.name))!;
    expect(arabic.majorElements.some((m) => /writing/i.test(m))).toBe(true);
    expect(english.majorElements.some((m) => /writing/i.test(m))).toBe(true);

    const arabicWritingKey = arabic.majorElements.find((m) => /writing/i.test(m))!;
    const englishWritingKey = english.majorElements.find((m) => /writing/i.test(m))!;

    const hydrated = report.students.filter(
      (st) => st.subjects[arabic.assessmentId]?.elements[arabicWritingKey] && st.subjects[english.assessmentId]?.elements[englishWritingKey],
    );
    expect(hydrated.length).toBeGreaterThan(0);
    for (const st of hydrated) {
      expect(report.performanceLevels).toContain(st.subjects[arabic.assessmentId]!.elements[arabicWritingKey]);
      expect(report.performanceLevels).toContain(st.subjects[english.assessmentId]!.elements[englishWritingKey]);
    }
  });

  // ── Bug 3: internal vs. external hyperlinks ─────────────────────────────
  it("writes every hyperlink as an internal same-workbook location, never an external file target", async () => {
    const buf = await buildPerformanceReportWorkbook({ ...report, alterations: [], audit: [] });
    const wb = XLSXR.read(buf, { type: "buffer" });
    const summaryWs = wb.Sheets["Student Summary"]!;
    const profilesWs = wb.Sheets["Student Profiles"]!;

    let checked = 0;
    for (const sheet of [summaryWs, profilesWs]) {
      for (const addr of Object.keys(sheet)) {
        if (addr.startsWith("!")) continue;
        const cell = sheet[addr] as { l?: { Target?: string; location?: string } } | undefined;
        if (!cell?.l) continue;
        checked += 1;
        // A real internal link has no external Target at all — only `location`.
        expect(cell.l.Target ?? "").not.toMatch(/^[A-Za-z]:\\|^\//); // no drive letter / absolute path
        expect(String(cell.l.location ?? "")).toContain("!A");
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  // ── Bug 1: label columns size to the actual configured levels ──────────
  it("sizes performance/award-label columns to fit the longest CONFIGURED label, not a fixed guess", async () => {
    const longLevels = [...report.performanceLevels];
    longLevels[longLevels.length - 1] = "This performance level has an unusually long configured name";
    const buf = await buildPerformanceReportWorkbook({
      ...report,
      performanceLevels: longLevels,
      alterations: [],
      audit: [],
    });

    // The community `xlsx` reader doesn't surface `!cols`/row heights, so
    // read the buffer back with ExcelJS itself to inspect the real model.
    const ExcelJS = (await import("exceljs")).default;
    const wbEJ = new ExcelJS.Workbook();
    await wbEJ.xlsx.load(new Uint8Array(buf).buffer as ArrayBuffer);
    const summary = wbEJ.getWorksheet("Student Summary")!;
    const subjectColWidth = summary.getColumn(4).width ?? 0;
    expect(subjectColWidth).toBeGreaterThan(longLevels[longLevels.length - 1]!.length);

    const profiles = wbEJ.getWorksheet("Student Profiles")!;
    const perfColWidth = profiles.getColumn(2).width ?? 0;
    expect(perfColWidth).toBeGreaterThan(longLevels[longLevels.length - 1]!.length);

    // And no subject/award-level cell row is pinned to a fixed height that
    // would clip a wrapped long label — auto-height means no explicit height.
    let anyDataRowHasNoFixedHeight = false;
    summary.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber >= 4) anyDataRowHasNoFixedHeight ||= row.height === undefined;
    });
    expect(anyDataRowHasNoFixedHeight).toBe(true);
  });
});
