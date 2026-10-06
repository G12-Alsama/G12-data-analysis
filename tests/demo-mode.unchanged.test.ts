/**
 * Demo mode (the in-memory provider with no database) must read exactly as before the period
 * registry / N-sitting rollup. The strings and slots below were captured from the code as it
 * was BEFORE Phase 2 (a before/after fingerprint of every year, Overall and document read
 * was byte-identical), so a wording or ordering drift in the demo fails here.
 */
import { describe, it, expect } from "vitest";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";

describe("demo mode is unchanged", () => {
  const p = new InMemoryDataProvider();

  it("the demo year shows February then May, with the same states", () => {
    const y = p.listYears().find((x) => x.id === "year-2026")!;
    expect(y.sittings.map((s) => [s.sitting, s.label, s.cycleId, s.started, s.locked, s.live])).toEqual([
      ["february", "February", "jan-2026", true, true, false],
      ["may", "May", "may-2026", true, false, true],
    ]);
    expect(y.participants).toBe(4503);
    expect(y.lastActivity).toBe("2h ago");
  });

  it("the year and Overall notes read as before", () => {
    expect(p.getYear("year-2026")!.overall.note).toBe("Overall becomes available once both the February and May sittings are locked.");
    expect(p.getYear("year-2026")!.overall.ready).toBe(false);
    const o = p.getOverallGrades("year-2026")!;
    expect(o.note).toBe("Overall is provisional until both the February and May sittings are locked; figures shown are the current best-of-two.");
    expect(o.demo).toBe(true);
    expect(o.sittings).toBeUndefined(); // the demo has no per-sitting "counted" list
  });

  it("the new-sitting form still defaults to May", () => {
    expect(p.getNewCycle().defaultSitting).toBe("may");
  });
});
