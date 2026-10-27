/**
 * The Overall over THREE sittings — proving the rollup and the provider are not tied to a
 * pair of periods. The period registry is replaced here by one with a third period
 * (August), exactly the change adding a period is meant to need: nothing else is edited.
 *
 * Rules under test: best performance level per student and subject; a tie goes to the
 * latest sitting by PERIOD ORDER (not by when it was created, nor its date); only LOCKED
 * sittings count; a student present in only some sittings keeps what they have.
 *
 * Levels (best → lowest) for the 4-mark fixture paper: 4 → Outstanding, 3 → Exceeds,
 * 2 → Meets, 0–1 → Doesn't yet meet.
 */
import { describe, it, expect, vi } from "vitest";
import { liveProvider } from "@/tests/helpers/fake-supabase-live";
import { buildDb, YEAR } from "@/tests/helpers/multi-cycle-db";
import { rollupOverall } from "@/lib/data/overall";
import type { AssessmentRef, GradesModel, OverallGradeRow, OverallGradesModel } from "@/lib/data/types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data/periods", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/periods")>();
  const defs = [
    ...actual.PERIOD_DEFS.map((d) => ({ ...d, covers: d.key === "may" ? [5, 6, 7] : [...d.covers] })),
    { key: "august", label: "August", shortLabel: "Aug", month: 8, order: 3, covers: [8, 9, 10, 11, 12], expectedByDefault: false },
  ];
  return { ...actual, ...actual.createPeriodRegistry(defs) };
});

const LEVELS = ["Top", "Mid", "Low"];
const AWARDS = ["A", "B", "None"];
const STARS = { Top: "**", Mid: "*", Low: "" };
const ref = (id: string): AssessmentRef => ({ id, name: id, shortName: id, rtl: false, itemCount: 1, excludedCount: 0, stageIndex: 1 });
const model = (levels: Record<string, string>): GradesModel => ({
  cycleId: "c",
  assessments: [ref("maths")],
  rows: Object.entries(levels).map(([sid, level]) => ({
    id: sid, studentId: sid, label: sid, award: "None", distinctionCap: null, overallRaw: 0, overallMax: 0, overallPct: 0,
    grades: { maths: { level, stars: "" } },
  })),
  distribution: [], awardLevels: AWARDS, starMap: STARS, performanceLevels: LEVELS, locked: true, canLock: false,
});

const roll = (sittings: { key: string; grades: GradesModel | null }[]) =>
  rollupOverall({ sittings: sittings as never, assessments: [ref("maths")], performanceLevels: LEVELS, awardLevels: AWARDS, starMap: STARS });
const cellOf = (rows: OverallGradeRow[], sid: string) => rows.find((r) => r.studentId === sid)!.grades.maths!;

describe("rollupOverall — three sittings", () => {
  const feb = model({ best_early: "Top", best_mid: "Mid", best_late: "Low", tie_all: "Mid", tie_early_mid: "Mid", tie_mid_late: "Low", only_mid: "", only_feb: "Mid" });
  const may = model({ best_early: "Mid", best_mid: "Top", best_late: "Mid", tie_all: "Mid", tie_early_mid: "Mid", tie_mid_late: "Mid", only_mid: "Mid" });
  const aug = model({ best_early: "Low", best_mid: "Mid", best_late: "Top", tie_all: "Mid", tie_early_mid: "Low", tie_mid_late: "Mid", only_late: "Low" });
  const all = () => [
    { key: "february", grades: feb },
    { key: "may", grades: may },
    { key: "august", grades: aug },
  ];

  it("takes the best level from whichever sitting has it", () => {
    const rows = roll(all());
    expect(cellOf(rows, "best_early")).toMatchObject({ level: "Top", source: "february" });
    expect(cellOf(rows, "best_mid")).toMatchObject({ level: "Top", source: "may" });
    expect(cellOf(rows, "best_late")).toMatchObject({ level: "Top", source: "august" });
  });

  it("a tie goes to the LATEST sitting by period order", () => {
    const rows = roll(all());
    expect(cellOf(rows, "tie_all").source).toBe("august"); // three-way tie → latest
    expect(cellOf(rows, "tie_early_mid").source).toBe("may"); // feb = may > aug → may beats feb
    expect(cellOf(rows, "tie_mid_late").source).toBe("august"); // may = aug > feb → august
  });

  it("period order — not the order the sittings are passed in — decides the tie", () => {
    const shuffled = [all()[2]!, all()[0]!, all()[1]!];
    expect(roll(shuffled).map((r) => [r.studentId, r.grades.maths?.source])).toEqual(
      roll(all()).map((r) => [r.studentId, r.grades.maths?.source]),
    );
    // order of rows follows the NEWEST sitting first, whatever the input order
    expect(roll(shuffled).map((r) => r.studentId)).toEqual(roll(all()).map((r) => r.studentId));
  });

  it("every cell lists each sitting's level, oldest → newest (null = no result)", () => {
    const rows = roll(all());
    expect(cellOf(rows, "best_mid").levels).toEqual([
      { key: "february", level: "Mid" },
      { key: "may", level: "Top" },
      { key: "august", level: "Mid" },
    ]);
    expect(cellOf(rows, "only_late").levels).toEqual([
      { key: "february", level: null },
      { key: "may", level: null },
      { key: "august", level: "Low" },
    ]);
  });

  it("a student present in only some sittings keeps what they have", () => {
    const rows = roll(all());
    const by = (sid: string) => rows.find((r) => r.studentId === sid)!;
    expect(by("only_feb").presentIn).toEqual(["february"]);
    expect(cellOf(rows, "only_feb")).toMatchObject({ level: "Mid", source: "february" });
    expect(by("only_late").presentIn).toEqual(["august"]);
    expect(cellOf(rows, "only_late")).toMatchObject({ level: "Low", source: "august" });
    // present in may (a result) and february (a row with a blank level): still "present" in both rows
    expect(by("only_mid").presentIn).toEqual(["february", "may"]);
    expect(cellOf(rows, "only_mid")).toMatchObject({ level: "Mid", source: "may" });
  });

  it("a sitting that is not counted (null) contributes nothing", () => {
    const rows = roll([
      { key: "february", grades: feb },
      { key: "may", grades: may },
      { key: "august", grades: null },
    ]);
    expect(cellOf(rows, "best_late")).toMatchObject({ level: "Mid", source: "may" }); // august's Top ignored
    expect(rows.find((r) => r.studentId === "only_late")).toBeUndefined();
    expect(cellOf(rows, "tie_all").source).toBe("may");
  });

  it("refuses an unknown or a repeated period instead of guessing", () => {
    expect(() => roll([{ key: "december", grades: feb }])).toThrow(/unknown sitting period/);
    expect(() => roll([{ key: "may", grades: feb }, { key: "may", grades: may }])).toThrow(/given twice/);
  });
});

describe("the live provider over three sittings (period 'august' added to the registry only)", () => {
  const FEB = "cyc-feb";
  const MAY = "cyc-may";
  const AUG = "cyc-aug";
  const OUTSTANDING = "Outstanding performance";
  const EXCEEDS = "Exceeds expectations";
  const MEETS = "Meets expectations";

  const mk = (augStatus: string) =>
    buildDb([
      // The AUGUST sitting is created FIRST (oldest created_at) — creation order must not matter.
      { id: AUG, name: "August 2026", sitting: "august", status: augStatus, age: 5, students: { "a@s.edu": [1, 1, 1, 1], "z@s.edu": [1, 1, 0, 0] } },
      { id: FEB, name: "February 2026", sitting: "february", status: "locked", age: 20, students: { "a@s.edu": [1, 1, 1, 0], "b@s.edu": [1, 1, 0, 0] } },
      { id: MAY, name: "May 2026", sitting: "may", status: "locked", age: 30, students: { "a@s.edu": [1, 1, 0, 0], "b@s.edu": [1, 1, 0, 0], "c@s.edu": [1, 1, 1, 0] } },
    ]);
  const cell = (m: OverallGradesModel, email: string) => Object.values(m.rows.find((r) => r.studentId === email)!.grades)[0]!;

  it("lists the periods in registry order, and an UNLOCKED August is excluded but does not block readiness", async () => {
    const { provider } = await liveProvider(mk("in_review"));
    await provider.ensureYearLoaded(YEAR);
    const model = provider.getOverallGrades(YEAR)!;
    expect(model.sittings!.map((s) => [s.key, s.status, s.expected])).toEqual([
      ["february", "counted", true],
      ["may", "counted", true],
      ["august", "not_locked", false], // exists, so listed; not expected, so it never blocks
    ]);
    expect(model.ready).toBe(true); // the year expects February + May, both locked
    expect(model.rows.map((r) => r.studentId)).not.toContain("z@s.edu"); // only in the unlocked sitting
    expect(cell(model, "a@s.edu")).toMatchObject({ level: EXCEEDS, source: "february" }); // Aug's Outstanding not counted
    expect(provider.getYear(YEAR)!.sittings.map((s) => s.sitting)).toEqual(["february", "may", "august"]);
  });

  it("once August is LOCKED it counts: best-of-three, ties to the latest period", async () => {
    const { provider } = await liveProvider(mk("locked"));
    await provider.ensureYearLoaded(YEAR);
    const model = provider.getOverallGrades(YEAR)!;
    expect(model.sittings!.map((s) => s.status)).toEqual(["counted", "counted", "counted"]);
    expect(cell(model, "a@s.edu")).toMatchObject({ level: OUTSTANDING, source: "august" });
    expect(cell(model, "b@s.edu")).toMatchObject({ level: MEETS, source: "may" }); // feb = may → latest of the two
    expect(cell(model, "c@s.edu")).toMatchObject({ level: EXCEEDS, source: "may" }); // only in may
    expect(cell(model, "z@s.edu")).toMatchObject({ level: MEETS, source: "august" }); // only in august
    expect(cell(model, "a@s.edu").levels.map((l) => l.key)).toEqual(["february", "may", "august"]);
  });
});
