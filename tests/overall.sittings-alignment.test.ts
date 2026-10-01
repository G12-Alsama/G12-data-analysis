/**
 * Units for the O9 plumbing around the (unchanged) Overall rollup: aligning two
 * real sittings' per-cycle assessment ids, the synthetic-centre guard, and the
 * sitting designated at create time.
 */
import { describe, it, expect } from "vitest";
import { canonicalSubjects, rekeyGrades } from "@/lib/data/overall-sittings";
import { isSyntheticCentre } from "@/lib/data/synthetic";
import { sittingForCreate } from "@/lib/data/supabase-provider";
import { rollupOverall } from "@/lib/data/overall";
import { PERFORMANCE_LEVELS, AWARD_LEVELS, DEFAULT_STAR_MAP } from "@/lib/data/grading";
import type { AssessmentRef, GradesModel } from "@/lib/data/types";

const ref = (id: string, name: string): AssessmentRef => ({ id, name, shortName: name, rtl: false, itemCount: 0, excludedCount: 0, stageIndex: 0 });
const [OUT, EXC, MEETS] = PERFORMANCE_LEVELS as [string, string, string];

function sitting(cycleId: string, refs: AssessmentRef[], rows: { sid: string; levels: Record<string, string> }[]): GradesModel {
  return {
    cycleId,
    assessments: refs,
    rows: rows.map((r) => ({
      id: `${cycleId}-${r.sid}`,
      studentId: r.sid,
      label: r.sid,
      grades: Object.fromEntries(Object.entries(r.levels).map(([id, level]) => [id, { level, stars: "" }])),
      award: "",
      distinctionCap: null,
      overallRaw: 0,
      overallMax: 0,
      overallPct: 0,
    })),
    distribution: [],
    awardLevels: [...AWARD_LEVELS],
    starMap: DEFAULT_STAR_MAP,
    performanceLevels: [...PERFORMANCE_LEVELS],
    locked: true,
    canLock: false,
  };
}

describe("canonicalSubjects + rekeyGrades", () => {
  const febRefs = [ref("f-math", "G12++ Applicable Mathematics"), ref("f-eng", "G12++ English 2nd Language")];
  const mayRefs = [ref("m-eng", "G12++ English 2nd Language"), ref("m-math", "G12++ Applicable Mathematics"), ref("m-life", "G12++ Life Skills")];
  const feb = sitting("feb", febRefs, [{ sid: "S1", levels: { "f-math": OUT, "f-eng": MEETS } }]);
  const may = sitting("may", mayRefs, [{ sid: "S1", levels: { "m-math": EXC, "m-eng": EXC, "m-life": MEETS } }]);

  it("maps each sitting's own assessment ids onto one subject key (May order first)", () => {
    const s = canonicalSubjects([may, feb]);
    expect(s.refs.map((r) => r.id)).toEqual(["esl", "am", "ls"]);
    expect(s.keyOf.get("f-math")).toBe("am");
    expect(s.keyOf.get("m-math")).toBe("am");
    expect(s.collision).toBeNull();
  });

  it("without re-keying the rollup cannot see February; with it, best-of-two is per subject", () => {
    const s = canonicalSubjects([may, feb]);
    const args = { assessments: s.refs, performanceLevels: PERFORMANCE_LEVELS, awardLevels: AWARD_LEVELS, starMap: DEFAULT_STAR_MAP };
    // Raw per-cycle ids: February's cells never line up (the pre-O9 defect).
    const raw = rollupOverall({ ...args, february: feb, may })[0]!;
    expect(Object.values(raw.grades).every((c) => c.februaryLevel === null)).toBe(true);
    // Aligned: Math February Outstanding beats May Exceeds; English May wins.
    const row = rollupOverall({ ...args, february: rekeyGrades(feb, s.keyOf), may: rekeyGrades(may, s.keyOf) })[0]!;
    expect(row.grades.am).toMatchObject({ level: OUT, source: "february", februaryLevel: OUT, mayLevel: EXC });
    expect(row.grades.esl).toMatchObject({ level: EXC, source: "may", februaryLevel: MEETS, mayLevel: EXC });
    expect(row.grades.ls).toMatchObject({ level: MEETS, source: "may", februaryLevel: null });
  });

  it("flags two subjects of one sitting that collapse onto the same key", () => {
    const bad = sitting("x", [ref("a", "Applicable Mathematics"), ref("b", "Applicable Maths")], []);
    expect(canonicalSubjects([bad]).collision).toMatch(/am/);
  });
});

describe("isSyntheticCentre", () => {
  it("recognises the 0043 seed by slug or the 0046 flag, and nothing else", () => {
    expect(isSyntheticCentre({ slug: "seed-ov-north-beacon" })).toBe(true);
    expect(isSyntheticCentre({ slug: "anything", is_synthetic: true })).toBe(true);
    expect(isSyntheticCentre({ slug: "shatila-1", is_synthetic: false })).toBe(false);
    expect(isSyntheticCentre({ slug: "shatila-seed-ov-1" })).toBe(false);
    expect(isSyntheticCentre(null)).toBe(false);
  });
});

describe("sittingForCreate (Jan–Apr → February, else May)", () => {
  it("uses the picked date first", () => {
    expect(sittingForCreate("G12++ May 2026", "2026-02-14")).toBe("february");
    expect(sittingForCreate("G12++ 2026", "2026-04-30")).toBe("february");
    expect(sittingForCreate("G12++ February 2026", "2026-05-01")).toBe("may");
  });
  it("falls back to a month word in the name, else May", () => {
    expect(sittingForCreate("G12++ February 2026", "")).toBe("february");
    expect(sittingForCreate("G12++ March 2026", null)).toBe("february");
    expect(sittingForCreate("G12++ 2026", undefined)).toBe("may");
  });
});
