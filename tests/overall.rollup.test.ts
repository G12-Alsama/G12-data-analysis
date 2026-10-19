/**
 * Overall best-of-two rollup tests (lib/data/overall.ts).
 *
 * Locks the year-level aggregation contract: per student × subject, take the
 * HIGHER of the two sittings' performance levels (by rank, not raw score) with
 * Feb/May provenance; a subject present in only one sitting uses that sitting; and
 * the overall award is DERIVED from the rolled-up levels via the existing award
 * rule (no safeguard re-run). Comparison/aggregation only — no scoring change.
 */
import { describe, it, expect } from "vitest";
import { rollupOverall } from "@/lib/data/overall";
import {
  DEFAULT_SCORING_CONFIG,
  performanceLabels,
  awardLabels,
  starMapOf,
} from "@/lib/engine";
import type { AssessmentRef, GradeMatrixRow, GradesModel } from "@/lib/data/types";

const LEVELS = performanceLabels(DEFAULT_SCORING_CONFIG); // [Outstanding, Exceeds, Meets, Doesn't-yet-meet]
const AWARDS = awardLabels(DEFAULT_SCORING_CONFIG); // [Distinction, Advanced, Secondary, No Award]
const STARS = starMapOf(DEFAULT_SCORING_CONFIG);
const [OUT, EXC, MEET, NONE] = LEVELS as [string, string, string, string];
const [DISTINCTION, ADVANCED, SECONDARY] = AWARDS as [string, string, string, string];

const FIVE = ["M", "S", "A", "E", "L"];

function refs(ids: string[]): AssessmentRef[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    shortName: id,
    rtl: false,
    itemCount: 10,
    excludedCount: 0,
    stageIndex: i,
  }));
}

/** Build a GradesModel for one student from a {subjectId: level} map ("" = absent). */
function model(studentId: string, levels: Record<string, string>, ids = FIVE): GradesModel {
  const grades: GradeMatrixRow["grades"] = {};
  for (const id of ids) {
    const level = levels[id] ?? "";
    grades[id] = { level, stars: level ? STARS[level] ?? "" : "" };
  }
  const row: GradeMatrixRow = {
    id: `row-${studentId}`,
    studentId,
    label: `Student ${studentId}`,
    grades,
    award: "",
    distinctionCap: null,
    overallRaw: 0,
    overallMax: 0,
    overallPct: 0,
  };
  return {
    cycleId: "fixture",
    assessments: refs(ids),
    rows: [row],
    distribution: [],
    awardLevels: AWARDS,
    starMap: STARS,
    performanceLevels: LEVELS,
    locked: true,
    canLock: false,
  };
}

function rollOne(feb: GradesModel | null, may: GradesModel | null, ids = FIVE) {
  const rows = rollupOverall({
    sittings: [
      { key: "february", grades: feb },
      { key: "may", grades: may },
    ],
    assessments: refs(ids),
    performanceLevels: LEVELS,
    awardLevels: AWARDS,
    starMap: STARS,
  });
  return rows;
}

describe("rollupOverall — best-of-two by award level", () => {
  it("picks the higher per-subject level from whichever sitting it came from", () => {
    const feb = model("s1", { M: EXC, S: OUT, A: MEET, E: NONE, L: MEET });
    const may = model("s1", { M: OUT, S: MEET, A: MEET, E: EXC, L: NONE });
    const [r] = rollOne(feb, may);
    expect(r!.grades.M).toMatchObject({ level: OUT, source: "may" }); // OUT(may) > EXC(feb)
    expect(r!.grades.S).toMatchObject({ level: OUT, source: "february" }); // OUT(feb) > MEET(may)
    expect(r!.grades.A).toMatchObject({ level: MEET, source: "may" }); // tie → May (latest)
    expect(r!.grades.E).toMatchObject({ level: EXC, source: "may" }); // EXC(may) > none(feb)
    expect(r!.grades.L).toMatchObject({ level: MEET, source: "february" }); // MEET(feb) > none(may)
  });

  it("records both sittings' raw levels on every cell for transparency", () => {
    const feb = model("s1", { M: EXC });
    const may = model("s1", { M: OUT });
    const [r] = rollOne(feb, may);
    expect(r!.grades.M!.levels).toEqual([
      { key: "february", level: EXC },
      { key: "may", level: OUT },
    ]);
  });

  it("uses the only sitting present when a subject has just one result", () => {
    // M sat only in February; E sat only in May.
    const feb = model("s1", { M: OUT, S: "", A: "", E: "", L: "" });
    const may = model("s1", { M: "", S: "", A: "", E: EXC, L: "" });
    const [r] = rollOne(feb, may);
    expect(r!.grades.M).toMatchObject({ level: OUT, source: "february" });
    expect(r!.grades.M!.levels[1]).toEqual({ key: "may", level: null });
    expect(r!.grades.E).toMatchObject({ level: EXC, source: "may" });
    expect(r!.grades.E!.levels[0]).toEqual({ key: "february", level: null });
    expect(r!.grades.S).toBeUndefined(); // no result either sitting
  });

  it("keeps the February award when a student did not retake in May at all", () => {
    const feb = model("s2", { M: OUT, S: OUT, A: OUT, E: MEET, L: MEET });
    const may = model("s1", { M: MEET, S: MEET, A: MEET, E: MEET, L: MEET });
    const rows = rollOne(feb, may);
    const s2 = rows.find((r) => r.studentId === "s2")!;
    expect(s2.presentIn).toEqual(["february"]);
    // every cell from February
    for (const id of FIVE) expect(s2.grades[id]!.source).toBe("february");
  });
});

describe("rollupOverall — overall award derived from the rolled-up levels", () => {
  it("derives Distinction from a best-of-two ≥3 Outstanding + ≥Meets pattern", () => {
    // Neither sitting alone has 3 Outstanding, but the best-of-two does.
    const feb = model("s1", { M: OUT, S: OUT, A: MEET, E: MEET, L: MEET });
    const may = model("s1", { M: MEET, S: MEET, A: OUT, E: MEET, L: MEET });
    const [r] = rollOne(feb, may);
    // best-of: M OUT, S OUT, A OUT, E MEET, L MEET → Distinction pattern
    expect(r!.award).toBe(DISTINCTION);
  });

  it("derives Advanced from ≥3 Exceeds-or-better best-of-two", () => {
    const feb = model("s1", { M: EXC, S: EXC, A: MEET, E: MEET, L: NONE });
    const may = model("s1", { M: MEET, S: MEET, A: EXC, E: MEET, L: NONE });
    const [r] = rollOne(feb, may);
    expect(r!.award).toBe(ADVANCED); // M,S,A all ≥ Exceeds
  });

  it("derives Secondary from ≥4 Meets-or-better best-of-two", () => {
    const feb = model("s1", { M: MEET, S: MEET, A: NONE, E: NONE, L: NONE });
    const may = model("s1", { M: NONE, S: NONE, A: MEET, E: MEET, L: NONE });
    const [r] = rollOne(feb, may);
    expect(r!.award).toBe(SECONDARY); // M,S,A,E ≥ Meets
  });
});

describe("rollupOverall — single sitting populated", () => {
  it("equals the May sitting when February has no results", () => {
    const may = model("s1", { M: OUT, S: EXC, A: MEET, E: MEET, L: MEET });
    const [r] = rollOne(null, may);
    expect(r!.presentIn).toEqual(["may"]);
    for (const id of FIVE) expect(r!.grades[id]!.source).toBe("may");
    // 1 Outstanding + 1 Exceeds (only 2 ≥Exceeds) but 5 ≥Meets → Secondary.
    expect(r!.award).toBe(SECONDARY);
  });
});
