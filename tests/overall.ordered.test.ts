/**
 * `rollupOrdered` / `canonicalizeSubjects` — the pure adapters that let the Overall take
 * sittings as an ordered list (oldest → newest) and match subjects across sittings that
 * each have their own assessment rows, without naming any period.
 */
import { describe, it, expect } from "vitest";
import { rollupOrdered, canonicalizeSubjects } from "@/lib/data/overall";
import type { AssessmentRef, GradesModel } from "@/lib/data/types";

const LEVELS = ["Top", "Mid", "Low"];
const AWARDS = ["A", "B", "None"];
const STARS = { Top: "**", Mid: "*", Low: "" };

const ref = (id: string, name: string): AssessmentRef => ({ id, name, shortName: name, rtl: false, itemCount: 1, excludedCount: 0, stageIndex: 1 });
const model = (assessmentId: string, subject: string, levels: Record<string, string>): GradesModel => ({
  cycleId: "c",
  assessments: [ref(assessmentId, subject)],
  rows: Object.entries(levels).map(([sid, level]) => ({
    id: sid, studentId: sid, label: sid, award: "None", distinctionCap: null, overallRaw: 0, overallMax: 0, overallPct: 0,
    grades: { [assessmentId]: { level, stars: "" } },
  })),
  distribution: [], awardLevels: AWARDS, starMap: STARS, performanceLevels: LEVELS, locked: true, canLock: false,
});
const key = (a: AssessmentRef) => a.name.toLowerCase();

describe("canonicalizeSubjects", () => {
  it("re-keys assessments and every row's grades by the canonical subject key", () => {
    const m = canonicalizeSubjects(model("uuid-1", "Maths", { s1: "Top" }), key);
    expect(m.assessments.map((a) => a.id)).toEqual(["maths"]);
    expect(m.assessments[0]!.name).toBe("Maths"); // only the id changes
    expect(m.rows[0]!.grades).toEqual({ maths: { level: "Top", stars: "" } });
  });
  it("does not mutate its input", () => {
    const input = model("uuid-1", "Maths", { s1: "Top" });
    canonicalizeSubjects(input, key);
    expect(input.assessments[0]!.id).toBe("uuid-1");
  });
});

describe("rollupOrdered", () => {
  const run = (sittings: (GradesModel | null)[]) =>
    rollupOrdered({ sittings, assessments: [ref("maths", "Maths")], performanceLevels: LEVELS, awardLevels: AWARDS, starMap: STARS });
  const old = () => canonicalizeSubjects(model("uuid-old", "Maths", { a: "Mid", b: "Top", c: "Mid" }), key);
  const recent = () => canonicalizeSubjects(model("uuid-new", "Maths", { a: "Top", b: "Low", c: "Mid" }), key);

  it("best level wins; a tie goes to the NEWER (later in the list) sitting", () => {
    const rows = run([old(), recent()]);
    const cell = (s: string) => rows.find((r) => r.studentId === s)!.grades.maths!;
    expect(cell("a")).toMatchObject({ level: "Top", source: "may" }); // newer better
    expect(cell("b")).toMatchObject({ level: "Top", source: "february" }); // older better
    expect(cell("c")).toMatchObject({ level: "Mid", source: "may" }); // tie → newer
  });

  it("accepts a single sitting, or none, without inventing the other", () => {
    expect(run([old()]).map((r) => r.studentId).sort()).toEqual(["a", "b", "c"]);
    expect(run([null, recent()]).every((r) => r.inFebruary === false)).toBe(true);
    expect(run([null, null])).toEqual([]);
  });

  it("refuses more than two sittings loudly instead of silently dropping one", () => {
    expect(() => run([old(), recent(), old()])).toThrow(/at most two/);
  });
});
