/**
 * Upload mismatch warning — does the export belong to the sitting it is uploaded into?
 *
 * Real fixtures: `qm` is a May 2026 export WITH date columns (ResultStartLocal /
 * ResultFinishedLocal, 11–14 May 2026); `qm-attribution` is a May 2026 export with NO date
 * columns at all. Every case below runs the real canonical builder, then the pure comparison.
 * The comparison never blocks — a mismatch only holds the upload for confirmation
 * (`planUpload` → "confirm"), which the uploader page turns into a visible warning.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseCsv, buildCanonicalModelFromTables, type CsvTable } from "@/lib/ingest/qm";
import { isoDateOf } from "@/lib/ingest/qm/canonical";
import { compareExportToSitting, formatIsoDate, planUpload } from "@/lib/ingest/qm/sitting-match";
import { UploadMismatchWarning } from "@/components/import/UploadMismatchWarning";
import { UploadStatusLine } from "@/components/import/UploadFlow";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (dir: string) => {
  const read = (n: string) => readFileSync(path.join(here, "fixtures", dir, `${n}.csv`));
  return { items: parseCsv(read("Items")), assessments: parseCsv(read("Assessments")), topics: parseCsv(read("Topics")) };
};
const build = (t: { items: CsvTable; assessments: CsvTable; topics: CsvTable }) =>
  buildCanonicalModelFromTables(t.items, t.assessments, t.topics);

describe("the canonical model carries the export's date range", () => {
  it("real fixture: 11–14 May 2026", () => {
    const m = build(load("qm"));
    expect(m.dateRange).not.toBeNull();
    expect(m.dateRange!.from).toBe("2026-05-11");
    expect(m.dateRange!.to).toBe("2026-05-14");
    expect(m.dateRange!.datedResults).toBeGreaterThan(0);
  });

  it("an export without date columns has no range (the columns are optional)", () => {
    expect(build(load("qm-attribution")).dateRange).toBeNull();
  });

  it("blank / <Not defined> / garbage values are ignored, not parsed", () => {
    expect(isoDateOf("2026-05-12 11:32:23")).toBe("2026-05-12");
    expect(isoDateOf("2026-05-12")).toBe("2026-05-12");
    for (const bad of ["", "<Not defined>", "12/05/2026", "2026-13-01 00:00:00", "2026-00-10", "1850-01-01", undefined, null]) {
      expect(isoDateOf(bad as string)).toBeNull();
    }
  });

  it("only the dates that parse count (a column of garbage = no range)", () => {
    const t = load("qm");
    for (const r of t.assessments.rows) { r.ResultStartLocal = "<Not defined>"; r.ResultFinishedLocal = ""; }
    expect(build(t).dateRange).toBeNull();
  });
});

describe("compareExportToSitting", () => {
  const may = build(load("qm")); // tagged MAY2026, dated 11–14 May 2026
  const target = (yearName?: string, sitting?: string) => ({ yearName, sitting });

  it("the right sitting: a match, nothing held", () => {
    const r = compareExportToSitting(may, target("2026", "may"));
    expect(r.status).toBe("match");
    expect(r.issues).toEqual([]);
    expect(planUpload(r)).toBe("proceed");
  });

  it("wrong PERIOD: a May export into the February sitting", () => {
    const r = compareExportToSitting(may, target("2026", "february"));
    expect(r.status).toBe("mismatch");
    expect(r.issues.map((i) => i.kind).sort()).toEqual(["dates", "period"]); // the tag AND the dates disagree
    expect(r.issues.find((i) => i.kind === "period")!.message).toMatch(/tagged May 2026.*February sitting/);
    expect(r.issues.find((i) => i.kind === "dates")!.message).toMatch(/11 May 2026 – 14 May 2026.*May period.*February sitting/);
    expect(planUpload(r)).toBe("confirm");
  });

  it("wrong YEAR: a 2026 export into the 2025 year", () => {
    const r = compareExportToSitting(may, target("2025", "may"));
    expect(r.status).toBe("mismatch");
    expect(r.issues.map((i) => i.kind).sort()).toEqual(["dates", "year"]);
    expect(r.issues.find((i) => i.kind === "year")!.message).toMatch(/tagged May 2026.*year 2025/);
    expect(r.issues.find((i) => i.kind === "dates")!.message).toMatch(/outside the sitting's year \(2025\)/);
    expect(planUpload(r)).toBe("confirm");
  });

  it("only the DATES disagree (tag is right, dates are from another period): still held", () => {
    const t = load("qm");
    for (const r of t.assessments.rows) {
      if (r.ResultStartLocal) r.ResultStartLocal = r.ResultStartLocal.replace("2026-05-", "2026-02-");
      if (r.ResultFinishedLocal) r.ResultFinishedLocal = r.ResultFinishedLocal.replace("2026-05-", "2026-02-");
    }
    const r = compareExportToSitting(build(t), target("2026", "may"));
    expect(r.issues.map((i) => i.kind)).toEqual(["dates"]);
    expect(r.issues[0]!.message).toMatch(/February period.*May sitting/);
  });

  it("dates that straddle two periods are named as such", () => {
    const t = load("qm");
    const first = build(load("qm")).results[0]!.resultId; // a GRADED result (surveys are not in the model)
    t.assessments.rows.find((r) => r.ResultId === first)!.ResultStartLocal = "2026-04-28 09:00:00";
    const r = compareExportToSitting(build(t), target("2026", "may"));
    expect(r.issues[0]!.message).toMatch(/February and May periods/);
  });

  it("NO DATE INFORMATION: compares the tag alone — right tag matches, wrong tag still warns", () => {
    const noDates = build(load("qm-attribution")); // tagged MAY2026, no date columns
    expect(noDates.dateRange).toBeNull();
    expect(compareExportToSitting(noDates, target("2026", "may")).status).toBe("match");
    const wrong = compareExportToSitting(noDates, target("2026", "february"));
    expect(wrong.status).toBe("mismatch");
    expect(wrong.issues.map((i) => i.kind)).toEqual(["period"]); // no spurious date issue
  });

  it("NO DATES AND NO TAG: nothing to compare → unknown, no warning, upload proceeds", () => {
    const t = load("qm-attribution");
    for (const r of t.assessments.rows) r.ResultGroupName = "";
    const bare = build(t);
    expect(bare.sitting).toBeNull();
    expect(bare.dateRange).toBeNull();
    const r = compareExportToSitting(bare, target("2026", "may"));
    expect(r.status).toBe("unknown");
    expect(r.issues).toEqual([]);
    expect(planUpload(r)).toBe("proceed");
  });

  it("a sitting with no year/period recorded (demo / legacy) can't be compared → unknown", () => {
    expect(compareExportToSitting(may, target(undefined, undefined)).status).toBe("unknown");
    expect(compareExportToSitting(may, null).status).toBe("unknown");
    expect(planUpload(compareExportToSitting(may, null))).toBe("proceed");
  });

  it("a year-only or period-only target compares just that part", () => {
    expect(compareExportToSitting(may, target("2026", undefined)).status).toBe("match");
    expect(compareExportToSitting(may, target("2025", undefined)).issues.map((i) => i.kind).sort()).toEqual(["dates", "year"]);
    expect(compareExportToSitting(may, target(undefined, "may")).status).toBe("match");
  });

  it("a file mixing several sittings is reported on its own", () => {
    const t = load("qm");
    const first = build(load("qm")).results[0]!.resultId;
    const row = t.assessments.rows.find((r) => r.ResultId === first)!;
    row.ResultGroupName = row.ResultGroupName!.replace("MAY2026", "FEB2026");
    const r = compareExportToSitting(build(t), target("2026", "may"));
    expect(r.issues.map((i) => i.kind)).toContain("mixed");
    expect(r.issues.find((i) => i.kind === "mixed")!.message).toMatch(/FEB2026/);
  });

  it("the date helper reads like the UI", () => {
    expect(formatIsoDate("2026-05-14")).toBe("14 May 2026");
  });
});

describe("the held-upload warning", () => {
  const report = compareExportToSitting(build(load("qm")), { yearName: "2026", sitting: "february" });

  it("names the sitting, every issue and the file, and offers confirm / cancel — never a dead end", () => {
    const html = renderToStaticMarkup(createElement(UploadMismatchWarning, { report, fileName: "Assessments.csv", onConfirm: () => {}, onCancel: () => {} }));
    expect(html).toContain("February 2026 sitting");
    expect(html).toContain("tagged May 2026");
    expect(html).toContain("Assessments.csv");
    expect(html).toContain("Upload anyway");
    expect(html).toContain("Cancel");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Nothing has been uploaded yet");
  });

  it("the status line shows nothing while a file is held (the warning speaks for itself)", () => {
    expect(renderToStaticMarkup(createElement(UploadStatusLine, { stage: "confirm" }))).toBe("");
  });
});
