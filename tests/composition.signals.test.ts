/**
 * Per-student display-only signals on the score-composition read-model:
 *  - D3 answered: of all the top-difficulty (D3) questions across a student's
 *    exams, the share they attempted (answered, not necessarily correct).
 *  - Technical incidents: how many of the student's sittings carried a technical
 *    result-status flag ('Finished Abnormally', 'Time Limit Exceeded').
 * Both are aggregations of data already held — they must never change scoring.
 */
import { describe, it, expect } from "vitest";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import seed from "@/lib/data/seed.generated.json";
import { isTechnicalIncidentStatus } from "@/lib/data/result-status";

describe("per-student score signals (D3 answered + technical incidents)", () => {
  const provider = new InMemoryDataProvider();
  const cycleId = provider.listCycles()[0]!.id;
  const comp = provider.getComposition(cycleId)!;

  it("every student carries D3-answered and incident signals", () => {
    expect(comp.students.length).toBeGreaterThan(0);
    for (const st of comp.students) {
      expect(st.signals).toBeTruthy();
      const d3 = st.signals.d3;
      expect(d3.attempted).toBeGreaterThanOrEqual(0);
      expect(d3.attempted).toBeLessThanOrEqual(d3.available);
      if (d3.available === 0) {
        expect(d3.pct).toBeNull();
      } else {
        // d3.pct is rounded to 1 dp for display (see in-memory-provider.ts), so
        // compare at that same precision rather than the exact unrounded ratio.
        expect(d3.pct).toBeCloseTo((d3.attempted / d3.available) * 100, 1);
        expect(d3.pct!).toBeGreaterThanOrEqual(0);
        expect(d3.pct!).toBeLessThanOrEqual(100);
      }
      expect(Number.isInteger(st.signals.incidents)).toBe(true);
      expect(st.signals.incidents).toBeGreaterThanOrEqual(0);
    }
  });

  it("the incident count reconciles with the result-status flags in the seed", () => {
    // Count, per participant, the sittings with a technical result status.
    const expected = new Map<string, number>();
    for (const a of (seed as { liveCycle: { assessments: { technicalIncidents?: { p: string; status: string }[] }[] } }).liveCycle.assessments) {
      for (const inc of a.technicalIncidents ?? []) {
        expect(isTechnicalIncidentStatus(inc.status)).toBe(true);
        expected.set(inc.p, (expected.get(inc.p) ?? 0) + 1);
      }
    }
    for (const st of comp.students) {
      expect(st.signals.incidents).toBe(expected.get(st.participantId) ?? 0);
    }
    // The sample data is known to contain technical incidents.
    const total = comp.students.reduce((t, s) => t + s.signals.incidents, 0);
    expect(total).toBeGreaterThan(0);
  });
});
