/**
 * Overall provider tests — getOverallGrades / getOverallDocuments on the
 * in-memory provider. Verifies the year-level best-of-two rollup is wired to the
 * sittings' signed-off grades, that provenance is present, that the demo February
 * baseline kicks in (fixtures-only build), and that certificates issue from the
 * Overall result (not a single sitting). Parity is unaffected — this is
 * aggregation over already-computed awards.
 */
import { describe, it, expect } from "vitest";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";

const YEAR = "year-2026";
const MAY = "may-2026";

function fresh() {
  return new InMemoryDataProvider();
}

/** The demo year with both sittings locked (February is a locked mock prior). */
function signedOff() {
  const p = fresh();
  p.lockCycle(MAY);
  return p;
}

describe("getOverallGrades — year best-of-two", () => {
  it("rolls up the year's sittings into a per-student best-of-two table", () => {
    const p = signedOff();
    const overall = p.getOverallGrades(YEAR)!;
    expect(overall).toBeTruthy();
    expect(overall.yearName).toBe("2026");
    expect(overall.rows.length).toBeGreaterThan(0);
    expect(overall.assessments.length).toBe(5);
    // award distribution sums to the cohort.
    const distTotal = overall.distribution.reduce((s, d) => s + d.count, 0);
    expect(distTotal).toBe(overall.rows.length);
  });

  it("flags the synthesized February baseline (fixtures-only demo build, no database)", () => {
    expect(signedOff().getOverallGrades(YEAR)!.demo).toBe(true);
  });

  it("every cell carries Feb/May provenance and is the higher of the two sittings' levels", () => {
    const p = signedOff();
    const overall = p.getOverallGrades(YEAR)!;
    const levels = overall.performanceLevels; // best → lowest
    const rank = (l: string | null) => (l ? (levels.indexOf(l) < 0 ? Infinity : levels.indexOf(l)) : Infinity);
    let feb = 0;
    let may = 0;
    for (const r of overall.rows) {
      for (const cell of Object.values(r.grades)) {
        expect(["february", "may"]).toContain(cell.source);
        // chosen level is at least as good as each sitting's recorded level
        expect(rank(cell.level)).toBeLessThanOrEqual(rank(cell.februaryLevel));
        expect(rank(cell.level)).toBeLessThanOrEqual(rank(cell.mayLevel));
        // chosen level matches its claimed source
        const src = cell.source === "february" ? cell.februaryLevel : cell.mayLevel;
        expect(cell.level).toBe(src);
        if (cell.source === "february") feb++;
        else may++;
      }
    }
    // The demo baseline produces a genuine mix of both provenances.
    expect(feb).toBeGreaterThan(0);
    expect(may).toBeGreaterThan(0);
  });

  it("withholds every row until both sittings are locked, then shows them", () => {
    const p = fresh();
    const before = p.getOverallGrades(YEAR)!;
    expect(before.ready).toBe(false); // May not locked yet
    expect(before.rows).toHaveLength(0);
    expect(before.blocked).toMatch(/both sittings are locked/i);
    expect(before.blocked).toMatch(/May: .*not locked/);
    p.lockCycle(MAY);
    const after = p.getOverallGrades(YEAR)!;
    expect(after.ready).toBe(true); // February (mock) is locked; May now locked
    expect(after.blocked).toBeNull();
    expect(after.rows.length).toBeGreaterThan(0);
  });

  it("returns null for an unknown year", () => {
    expect(fresh().getOverallGrades("year-1999")).toBeNull();
  });
});

describe("getOverallDocuments — certificates issue from Overall", () => {
  it("has no students (nothing to proof or issue) until both sittings are locked", () => {
    const p = fresh();
    const docs = p.getOverallDocuments(YEAR)!;
    expect(docs.locked).toBe(false);
    expect(docs.students).toHaveLength(0);
    expect(docs.readiness!.gates.find((g) => g.id === "locked")!.met).toBe(false);
    expect(docs.readiness!.officialAllowed).toBe(false);
  });

  it("reads the Overall best-of-two awards once signed off — not a single sitting", () => {
    const p = fresh();
    p.lockCycle(MAY);
    const overall = p.getOverallGrades(YEAR)!;
    const docs = p.getOverallDocuments(YEAR)!;
    expect(docs.locked).toBe(true);
    expect(docs.students.length).toBe(overall.rows.length);
    // Every certificate's award equals the rolled-up overall award for that student.
    const awardByStudent = new Map(overall.rows.map((r) => [r.id, r.award]));
    for (const s of docs.students) {
      expect(s.award).toBe(awardByStudent.get(s.participantId));
    }
    // The Overall documents are labelled as the year's Overall, not a sitting.
    expect(docs.settings.cycleName).toContain("Overall");
  });

  it("each subject carries Feb/May best-of-two provenance for the performance report (P5)", () => {
    const p = fresh();
    p.lockCycle(MAY);
    const docs = p.getOverallDocuments(YEAR)!;
    let sawFeb = false;
    let sawMay = false;
    for (const s of docs.students) {
      for (const subj of s.subjects) {
        if (subj.level) expect(["february", "may"]).toContain(subj.source);
        if (subj.source === "february") sawFeb = true;
        if (subj.source === "may") sawMay = true;
      }
    }
    // The best-of-two genuinely draws from both sittings.
    expect(sawFeb).toBe(true);
    expect(sawMay).toBe(true);
  });

  it("carries the O1/O2 pre-issue sign-off, defaulting to NOT cleared (real issuance gated)", () => {
    const p = fresh();
    // Present whether or not the Overall is locked — the gate is independent of locking.
    for (const docs of [p.getOverallDocuments(YEAR)!, (p.lockCycle(MAY), p.getOverallDocuments(YEAR)!)]) {
      const signOff = docs.signOff!;
      expect(signOff).toBeTruthy();
      const ids = signOff.decisions.map((d) => d.id);
      expect(ids).toContain("O1");
      expect(ids).toContain("O2");
      // Both decisions are open in this build, so real (non-draft) issuance is blocked.
      expect(signOff.decisions.every((d) => d.confirmed === false)).toBe(true);
      expect(signOff.cleared).toBe(false);
    }
  });

  it("blocks official issuance via the hard gates (P5): O1/O2 unsigned + synthetic Feb data", () => {
    const p = fresh();
    p.lockCycle(MAY); // both sittings locked, but Feb is the demo baseline
    const r = p.getOverallDocuments(YEAR)!.readiness!;
    expect(r).toBeTruthy();
    const gate = (id: string) => r.gates.find((g) => g.id === id)!;
    // Locked gate is met once both sittings are locked…
    expect(gate("locked").met).toBe(true);
    // …but O1/O2 are unsigned and the February baseline is synthetic, so:
    expect(gate("signoff").met).toBe(false);
    expect(gate("live").met).toBe(false);
    // Therefore official issuance is NOT allowed and a reason is surfaced.
    expect(r.officialAllowed).toBe(false);
    expect(r.blockedReason).toBeTruthy();
  });
});
