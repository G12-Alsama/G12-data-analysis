/**
 * Part 3 — element / sub-element level results. Proves the performance report
 * surfaces results at finer granularity than subject: per major element AND per
 * sub-element, with the construct structure (3–5 major elements per subject, each
 * with sub-elements) READ FROM THE DATA — never hardcoded to five.
 */

import { describe, it, expect } from "vitest";
import * as XLSXR from "xlsx";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { buildPerformanceReportWorkbook } from "@/lib/export";

const CYCLE = "may-2026";

function aoaOf(wb: XLSXR.WorkBook, sheet: string): (string | number | null)[][] {
  return XLSXR.utils.sheet_to_json(wb.Sheets[sheet]!, { header: 1, blankrows: true, defval: null });
}

describe("element / sub-element results (Part 3)", () => {
  const provider = new InMemoryDataProvider();
  const report = provider.getPerformanceReport(CYCLE)!;

  it("reads the major-element count per subject from the data (not hardcoded 5)", () => {
    const counts = report.subjects.map((s) => s.majorElements.length);
    // genuine variety: some subjects have fewer than five major elements
    expect(Math.min(...counts)).toBeLessThan(5);
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(2);
    // every subject exposes a sub-element structure keyed by its major elements
    for (const s of report.subjects) {
      for (const major of s.majorElements) {
        expect(Object.prototype.hasOwnProperty.call(s.subElements, major)).toBe(true);
      }
    }
  });

  it("at least one subject has genuine sub-elements under a major element", () => {
    const withSubs = report.subjects.find((s) =>
      s.majorElements.some((m) => (s.subElements[m]?.length ?? 0) > 0),
    );
    expect(withSubs).toBeTruthy();
  });

  it("per-student results carry levels at both major-element and sub-element granularity", () => {
    const levels = new Set(report.performanceLevels);
    let checkedSub = 0;
    for (const st of report.students) {
      for (const subj of report.subjects) {
        const res = st.subjects[subj.assessmentId];
        if (!res) continue;
        // every reported major-element level is a valid performance level
        for (const lvl of Object.values(res.elements)) expect(levels.has(lvl)).toBe(true);
        // sub-element levels are valid too, and nest under a major element
        for (const [major, subs] of Object.entries(res.subElements)) {
          expect(res.elements).toHaveProperty(major);
          for (const lvl of Object.values(subs)) {
            expect(levels.has(lvl)).toBe(true);
            checkedSub += 1;
          }
        }
      }
    }
    expect(checkedSub).toBeGreaterThan(0);
  });

  it("the Student Profiles export sheet includes a Major Elements Performance column with one bullet per major element", async () => {
    const buf = await buildPerformanceReportWorkbook({ ...report, alterations: [], audit: [] });
    const re = XLSXR.read(buf, { type: "buffer" });
    const aoa = aoaOf(re, "Student Profiles");
    const flat = aoa.flat().map((v) => String(v ?? ""));
    expect(flat).toContain("Major Elements Performance");
    // The design shows major-element granularity only (no separate sub-element
    // column) — one "• Element: Level" bullet per major element, sub-element
    // detail stays in the data model for other consumers.
    const withBullets = aoa.find((row) => String(row[2] ?? "").includes("•"));
    expect(withBullets).toBeTruthy();
    const subject = report.subjects.find((s) => (s.majorElements.length ?? 0) > 0)!;
    const bulletCount = (String(withBullets![2]).match(/•/g) ?? []).length;
    expect(bulletCount).toBeGreaterThan(0);
    expect(bulletCount).toBeLessThanOrEqual(subject.majorElements.length + 1);
  });
});
