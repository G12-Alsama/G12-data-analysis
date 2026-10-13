/**
 * Sitting summary reset after clear / delete (Bug 2 — stale cycle summary).
 *
 * The Year/cycle card reads `participants` / `assessmentCount` off the in-memory
 * seed (cohortParticipantCount / assessmentRefs). `clearSittingData` and
 * `deleteSitting` emptied the fact tables (in the live Supabase provider) but the
 * demo provider left the seed populated, so the card kept showing the stale
 * ingested counts ("N Participants · M Assessments") after a clear/delete. These
 * pin that a cleared/deleted sitting reads 0 participants / 0 assessments — the
 * empty Upload baseline — everywhere the summary is derived.
 */
import { describe, it, expect } from "vitest";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { slotOf } from "./helpers/year-slots";

function setup() {
  const p = new InMemoryDataProvider();
  const cycleId = p.listCycles()[0]!.id;
  return { p, cycleId };
}

describe("clearSittingData resets the cached cycle summary to 0/0", () => {
  it("participants and assessmentCount read live from the (now-empty) seed", async () => {
    const { p, cycleId } = setup();
    const before = p.getCycle(cycleId)!;
    // Baseline: the seeded sitting has real participants + assessments.
    expect(before.participants).toBeGreaterThan(0);
    expect(before.assessmentCount).toBeGreaterThan(0);

    await p.clearSittingData(cycleId);

    const after = p.getCycle(cycleId)!;
    expect(after.participants).toBe(0);
    expect(after.assessmentCount).toBe(0);
    expect(after.assessments).toHaveLength(0);
    // Returned to the Upload step (stage 0), not stuck mid-pipeline.
    expect(after.stageIndex).toBe(0);
  });

  it("the cleared sitting's slot in the Year rollup reads 0 participants", async () => {
    const { p, cycleId } = setup();
    // The sitting ref for THIS cycle in the year grid (the card the user opened).
    const slotFor = () => {
      for (const y of p.listYears()) {
        for (const s of [slotOf(y, "february"), slotOf(y, "may")]) if (s.cycleId === cycleId) return s;
      }
      return null;
    };
    expect(slotFor()!.participants).toBeGreaterThan(0);

    await p.clearSittingData(cycleId);

    // Its own headcount is reset (sibling sittings are unaffected — not stale).
    expect(slotFor()!.participants).toBe(0);
    expect(slotFor()!.assessments).toBe(0);
  });
});

describe("deleteSitting resets the cached cycle summary to 0/0", () => {
  it("participants and assessmentCount are 0 after delete", async () => {
    const { p, cycleId } = setup();
    expect(p.getCycle(cycleId)!.participants).toBeGreaterThan(0);

    await p.deleteSitting(cycleId);

    const after = p.getCycle(cycleId)!;
    expect(after.participants).toBe(0);
    expect(after.assessmentCount).toBe(0);
  });
});
