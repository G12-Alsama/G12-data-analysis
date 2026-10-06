/**
 * Route on the year's STABLE DB id, never a name/label (task 23 — id-not-label routing).
 *
 * The year route id used to be DERIVED from the cycle name (`year-${YYYY}`, with a
 * literal "Unknown" fallback when the name carried no year), so a null/blank/
 * unparseable year NAME leaked a label into the URL, and any name change (e.g. after
 * clearing a sitting) shifted the year's identity and broke its route (`/years/
 * year-Unknown` → 404). Now, when a real `exam_years` row exists, its UUID IS the
 * canonical year id — carried unchanged, the name display-only. These pin that a
 * null/"Unknown"-named year still resolves and loads, keyed on the id not the label.
 */
import { describe, it, expect } from "vitest";
import seedJson from "@/lib/data/seed.generated.json";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import type { Seed } from "@/lib/data/seed-types";
import { slotOf } from "./helpers/year-slots";

// A real exam_years.id shape (the DB-side canonical year id).
const REAL_YEAR_UUID = "11111111-2222-3333-4444-555555555555";

/** The default seed with the live cycle's name (and optional real year id) overridden. */
function seedWith(name: string, yearId?: string): Seed {
  const seed = JSON.parse(JSON.stringify(seedJson)) as Seed;
  seed.liveCycle.name = name;
  seed.liveCycle.yearId = yearId; // undefined → demo (no DB year row); set → live UUID
  return seed;
}

describe("year routes on the stable DB id, not the name label", () => {
  it("a live year with an UNPARSEABLE (→ 'Unknown') name routes on its real UUID and still loads", () => {
    const p = new InMemoryDataProvider(seedWith("Shatila spring intake", REAL_YEAR_UUID));
    const y = p.listYears()[0]!; // the live cycle's year (live is first)

    // The id is the real UUID — NOT a label like "year-Unknown".
    expect(y.id).toBe(REAL_YEAR_UUID);
    expect(y.id).not.toContain("Unknown");
    // The name is display-only and may legitimately be "Unknown".
    expect(y.name).toBe("Unknown");

    // Routing on that id resolves and loads the year (no 404).
    const detail = p.getYear(y.id);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(REAL_YEAR_UUID);
    expect(detail!.name).toBe("Unknown");
  });

  it("a demo year with no DB row falls back to the derived label-key and still resolves", () => {
    const p = new InMemoryDataProvider(seedWith("Shatila spring intake")); // no yearId
    const y = p.listYears()[0]!;
    expect(y.id).toBe("year-Unknown"); // derived, but still a working route key
    expect(p.getYear("year-Unknown")).not.toBeNull();
  });

  it("the year's identity does not depend on a parseable year in the name", () => {
    // Same live UUID under two very different names → same canonical id, both load.
    const blank = new InMemoryDataProvider(seedWith("", REAL_YEAR_UUID));
    const named = new InMemoryDataProvider(seedWith("May 2026 sitting", REAL_YEAR_UUID));
    expect(blank.listYears()[0]!.id).toBe(REAL_YEAR_UUID);
    expect(named.listYears()[0]!.id).toBe(REAL_YEAR_UUID);
    expect(blank.getYear(REAL_YEAR_UUID)).not.toBeNull();
    expect(named.getYear(REAL_YEAR_UUID)).not.toBeNull();
  });
});

// The decisive case: LIVE data (hydrated provider) where a legacy cycle has NO year
// row (year_id NULL) and NO parseable year in its name. This is exactly the state
// that produced /years/year-Unknown → 404. The route id must be the sitting's REAL
// cycle id — never the "year-Unknown" label — and the year must still open by that id.
describe("live data with no year row still routes on a real id (year-Unknown impossible)", () => {
  const live = (name: string) => new InMemoryDataProvider(seedWith(name), undefined, true);

  it("a live cycle with a blank/nameless year routes on its real cycle id, not year-Unknown", () => {
    const p = live("Resit batch A"); // no year in the name, no year_id
    const cycleId = p.listCycles()[0]!.id;
    const y = p.listYears()[0]!;

    // NEVER a label — the route param is the sitting's real cycle id.
    expect(y.id).toBe(cycleId);
    expect(y.id).not.toContain("Unknown");
    expect(y.id).not.toMatch(/^year-/);
    // Display name may be "Unknown"; it is not the key.
    expect(y.name).toBe("Unknown");

    // The year opens by that id (no 404), and its sitting card carries the real cycle
    // id so "Open pipeline" (/cycles/<id>) resolves.
    const detail = p.getYear(y.id);
    expect(detail).not.toBeNull();
    const opened = slotOf(detail!, "february").cycleId ?? slotOf(detail!, "may").cycleId;
    expect(opened).toBe(cycleId);
    expect(p.getCycle(opened!)).not.toBeNull();
  });

  it("clearing a sitting's data leaves the year reachable by the same real id", async () => {
    const p = live("Resit batch A");
    const yearIdBefore = p.listYears()[0]!.id;
    await p.clearSittingData(p.listCycles()[0]!.id);
    const yearIdAfter = p.listYears()[0]!.id;
    // Identity is stable across a clear (clearing only empties ingested data).
    expect(yearIdAfter).toBe(yearIdBefore);
    expect(yearIdAfter).not.toContain("Unknown");
    expect(p.getYear(yearIdAfter)).not.toBeNull();
  });
});
