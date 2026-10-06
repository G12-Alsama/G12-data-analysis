/**
 * The Overall documents model must point at a REAL sitting, never at the year.
 *
 * It used to return `cycleId: yearId`, and the documents page sent that to
 * `record_documents(p_cycle)` — whose membership check is on a SITTING id — so in the live
 * app the "documents generated" audit event was silently dropped (the provider found no
 * sitting called by that id and sent nothing). The model now carries the sitting the
 * Overall-level records belong to (`recordCycleId`), and every year lookup accepts either
 * id form (the derived `y.id` or the real `exam_years.id`).
 */
import { describe, it, expect, vi } from "vitest";
import { liveProvider } from "@/tests/helpers/fake-supabase-live";
import { buildDb, YEAR, type SittingSpec } from "@/tests/helpers/multi-cycle-db";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";

vi.mock("server-only", () => ({}));

const FEB = "cyc-feb";
const MAY = "cyc-may";
const spec = (id: string, key: string, status: string, age: number): SittingSpec => ({
  id, name: `${key} 2026`, sitting: key, status, age, students: { "a@s.edu": [1, 1, 1, 0] },
});

async function open(specs: SittingSpec[]) {
  const { provider, fake } = await liveProvider(buildDb(specs));
  await provider.ensureYearLoaded(YEAR);
  return { provider, fake };
}

describe("getOverallDocuments → a real sitting, not the year", () => {
  it("both sittings locked: records against the LATEST counted sitting (May), and names the year", async () => {
    const { provider } = await open([spec(FEB, "february", "locked", 10), spec(MAY, "may", "locked", 20)]);
    const docs = provider.getOverallDocuments(YEAR)!;
    expect(docs.cycleId).toBe(MAY);
    expect(docs.cycleId).not.toBe(YEAR);
    expect(docs.yearId).toBe(YEAR);
    expect(docs.settings.cycleName).toBe("2026 · Overall");
  });

  it("only February locked: the latest COUNTED sitting is February", async () => {
    const { provider } = await open([spec(FEB, "february", "locked", 10), spec(MAY, "may", "in_review", 20)]);
    expect(provider.getOverallDocuments(YEAR)!.cycleId).toBe(FEB);
  });

  it("nothing locked: falls back to the latest STARTED sitting (still a real cycle id)", async () => {
    const { provider } = await open([spec(FEB, "february", "in_review", 10), spec(MAY, "may", "in_review", 20)]);
    const docs = provider.getOverallDocuments(YEAR)!;
    expect(docs.cycleId).toBe(MAY);
    expect(docs.locked).toBe(false);
  });

  it("the id is an exam_cycles row of that year", async () => {
    const { provider, fake } = await open([spec(FEB, "february", "locked", 10), spec(MAY, "may", "locked", 20)]);
    const id = provider.getOverallDocuments(YEAR)!.cycleId;
    expect(fake.db.exam_cycles!.find((c) => c.id === id)!.year_id).toBe(YEAR);
  });
});

describe("recording the document-issue event", () => {
  it("sends record_documents for the real sitting — even one that was never loaded", async () => {
    // An UNLOCKED sitting is never loaded for the Overall, yet it is where the event is recorded.
    const { provider, fake } = await open([spec(FEB, "february", "in_review", 10), spec(MAY, "may", "in_review", 20)]);
    const docs = provider.getOverallDocuments(YEAR)!;
    expect(provider.getCycleLoadState(docs.cycleId)).not.toBe("ready"); // not opened
    provider.recordDocuments(docs.cycleId, "DRAFT proof: 3 Overall .pptx");
    expect(fake.calls.filter((c) => c.name === "record_documents")).toEqual([
      { name: "record_documents", args: { p_cycle: MAY, p_detail: "DRAFT proof: 3 Overall .pptx" } },
    ]);
  });

  it("sends it for a loaded sitting too, once", async () => {
    const { provider, fake } = await open([spec(FEB, "february", "locked", 10), spec(MAY, "may", "locked", 20)]);
    provider.recordDocuments(provider.getOverallDocuments(YEAR)!.cycleId, "OFFICIAL issue");
    expect(fake.calls.filter((c) => c.name === "record_documents")).toHaveLength(1);
  });

  it("an id that is not a sitting (a year id) records nothing — it can no longer reach the RPC as p_cycle", async () => {
    const { provider, fake } = await open([spec(MAY, "may", "locked", 20)]);
    provider.recordDocuments(YEAR, "should not be sent");
    expect(fake.calls.some((c) => c.name === "record_documents")).toBe(false);
  });
});

describe("a year is found by either id form, everywhere", () => {
  it("live: getYear / getOverallGrades / getOverallDocuments / ensureYearLoaded accept y.id and the real exam_years.id", async () => {
    const { provider } = await open([spec(FEB, "february", "locked", 10), spec(MAY, "may", "locked", 20)]);
    const y = provider.listYears()[0]!;
    for (const id of new Set([y.id, y.examYearId!])) {
      expect(provider.getYear(id)?.id).toBe(y.id);
      expect(provider.getOverallGrades(id)?.yearId).toBe(y.id);
      expect(provider.getOverallDocuments(id)?.yearId).toBe(y.id);
      await expect(provider.ensureYearLoaded(id)).resolves.toBeUndefined();
    }
    expect(provider.getYear("nope")).toBeNull();
    expect(provider.getOverallGrades("nope")).toBeNull();
    expect(provider.getOverallDocuments("nope")).toBeNull();
  });

  it("live: moveExamYearToCentre and setYearExpectedPeriods resolve the year by either id", async () => {
    const { provider, fake } = await open([spec(MAY, "may", "locked", 20)]);
    const y = provider.listYears()[0]!;
    await provider.setYearExpectedPeriods(y.id, ["may"]);
    await provider.setYearExpectedPeriods(y.examYearId!, ["may"]);
    expect(fake.calls.filter((c) => c.name === "set_year_expected_periods").map((c) => c.args.p_year_id)).toEqual([YEAR, YEAR]);
    await provider.moveExamYearToCentre(y.examYearId!, y.testCentreId); // same centre: idempotent, but must find the year
    expect(fake.calls.some((c) => c.name === "move_exam_year_to_centre")).toBe(true);
  });

  it("demo: the demo year's labelled id still resolves, and its Overall document model names the live sitting", () => {
    const p = new InMemoryDataProvider();
    const y = p.listYears()[0]!;
    expect(p.getYear(y.id)).not.toBeNull();
    const docs = p.getOverallDocuments(y.id)!;
    expect(docs.cycleId).toBe("may-2026"); // the demo's real (live) sitting, not "year-2026"
    expect(docs.yearId).toBe(y.id);
  });
});
