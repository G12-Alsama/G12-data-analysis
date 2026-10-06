/**
 * A sitting's PERIOD (february | may) and YEAR are explicit, stored choices — never
 * guessed from its name.
 *
 * Before: the create form had no period/year, `createCycle` sent neither
 * `p_sitting` nor `p_year_id`, so the RPC stored every UI-created sitting as the
 * default 'may' (a sitting called "February 2026" became 'may'), and the Years UI
 * then re-guessed the slot from the NAME — disagreeing with the stored column that
 * Overall analytics reads.
 *
 * Covers: the RPC contract (pure helpers), the real `SupabaseDataProvider.createCycle`
 * against a fake client that — like the RPC — stores exactly `p_sitting`, the
 * hydrate → Years-UI path reading the stored column, and the create-form model.
 */
import { describe, it, expect, vi } from "vitest";
import { SupabaseDataProvider } from "@/lib/data/supabase-provider";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { hydrate } from "@/lib/data/supabase-hydrate";
import { makeSupabaseReadClient, type MockDb } from "@/tests/helpers/mock-supabase-read";
import {
  buildCreateCycleArgs,
  findPeriodConflict,
  isoDateOrNull,
  normalizeYearName,
} from "@/lib/data/create-cycle";
import type { YearSummary } from "@/lib/data/types";
import { slotOf } from "./helpers/year-slots";

vi.mock("server-only", () => ({}));

const CENTRE_1 = "11111111-0000-0000-0000-000000000001";
const CENTRE_2 = "22222222-0000-0000-0000-000000000002";
const YEAR_2026 = "yyyyyyyy-0000-0000-0000-000000002026";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (n: number) => new Date(T0 + n * 60_000).toISOString();

function baseDb(): MockDb {
  return {
    test_centres: [
      { id: CENTRE_1, name: "Shatila 1", code: "SHA1", slug: "shatila-1", active: true, created_at: iso(0) },
      { id: CENTRE_2, name: "Shatila 2", code: "SHA2", slug: "shatila-2", active: true, created_at: iso(1) },
    ],
    exam_years: [{ id: YEAR_2026, name: "2026", region: "eu-west", test_centre_id: CENTRE_1 }],
    exam_cycles: [
      { id: "c-may", name: "May 2026", status: "draft", region: "eu-west", year_id: YEAR_2026, sitting: "may", sitting_date: null, created_at: iso(10), updated_at: iso(10) },
    ],
  };
}

interface RpcCall { name: string; args: Record<string, unknown> }

/**
 * Fake client: reads come from `db`; `rpc` records every call and, like the real
 * SECURITY DEFINER functions, inserts the row it was asked to create — taking the
 * period ONLY from `p_sitting` (the real RPC has no name-based logic either).
 */
function makeClient(db: MockDb) {
  const calls: RpcCall[] = [];
  let seq = 0;
  const reads = makeSupabaseReadClient(db);
  const client = {
    from: reads.from,
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "create_exam_year") {
        const existing = (db.exam_years ?? []).find(
          (y) => y.name === args.p_name && y.test_centre_id === args.p_test_centre_id,
        );
        if (existing) return { data: existing, error: null };
        const row = { id: `year-new-${++seq}`, name: args.p_name, region: args.p_region, test_centre_id: args.p_test_centre_id };
        (db.exam_years ??= []).push(row);
        return { data: row, error: null };
      }
      if (name === "create_cycle_with_assessments") {
        const id = `cycle-new-${++seq}`;
        (db.exam_cycles ??= []).push({
          id, name: args.p_name, status: "draft", region: args.p_region,
          year_id: args.p_year_id, sitting: args.p_sitting, sitting_date: args.p_sitting_date,
          created_at: iso(100 + seq), updated_at: iso(100 + seq),
        });
        return { data: id, error: null };
      }
      return { data: null, error: null };
    },
  };
  return { client, calls };
}

/** A provider that has completed its initial hydrate, as it always has by the time
 *  the create-sitting page renders (the guards read its hydrated years). */
const newProvider = async (db: MockDb) => {
  const { client, calls } = makeClient(db);
  const provider = new SupabaseDataProvider(client as never);
  await (provider as unknown as { refreshWorkspace(): Promise<void> }).refreshWorkspace();
  calls.length = 0; // only count what createCycle itself sends
  return { provider, calls, db };
};

const baseInput = {
  name: "Catch-up",
  sittingDate: "2026-02-10",
  assessmentIds: [] as string[],
  testCentreId: CENTRE_1,
};

describe("create-sitting RPC contract (pure)", () => {
  it("always sends p_sitting and p_year_id explicitly, and no separate centre", () => {
    const args = buildCreateCycleArgs({ ...baseInput, sitting: "february" }, YEAR_2026, ["Applicable Mathematics"]);
    expect(args.p_sitting).toBe("february");
    expect(args.p_year_id).toBe(YEAR_2026);
    expect(args.p_test_centre_id).toBeNull(); // the year decides the centre
    expect(args.p_sitting_date).toBe("2026-02-10");
    expect(args.p_assessments).toEqual([{ name: "Applicable Mathematics" }]);
  });

  it("the period is never derived from the name", () => {
    const may = buildCreateCycleArgs({ ...baseInput, name: "February 2026 (really May)", sitting: "may" }, YEAR_2026, []);
    const feb = buildCreateCycleArgs({ ...baseInput, name: "May 2026 resit", sitting: "february" }, YEAR_2026, []);
    expect(may.p_sitting).toBe("may");
    expect(feb.p_sitting).toBe("february");
  });

  it("validates year names and dates", () => {
    expect(normalizeYearName(" 2027 ")).toBe("2027");
    for (const bad of ["", "27", "20x7", "May 2026", "20267", undefined]) expect(normalizeYearName(bad)).toBeNull();
    expect(isoDateOrNull("2026-02-10")).toBe("2026-02-10");
    expect(isoDateOrNull("14 May 2026")).toBeNull();
  });

  it("findPeriodConflict reports an occupied period only", () => {
    const slot = (started: boolean, cycleName: string | null) => ({ started, cycleName });
    const years = [
      { id: "y", examYearId: YEAR_2026, name: "2026", testCentreName: "Shatila 1", sittings: [{ sitting: "february", ...slot(false, null) }, { sitting: "may", ...slot(true, "May 2026") }] },
    ] as unknown as YearSummary[];
    expect(findPeriodConflict(years, YEAR_2026, "may")).toMatchObject({ yearName: "2026", cycleName: "May 2026" });
    expect(findPeriodConflict(years, YEAR_2026, "february")).toBeNull();
    expect(findPeriodConflict(years, "unknown-year", "may")).toBeNull();
  });
});

describe("SupabaseDataProvider.createCycle stores the chosen period and year", () => {
  it("a February sitting is sent — and stored — as 'february', whatever its name says", async () => {
    const { provider, calls, db } = await newProvider(baseDb());

    // The name deliberately says "May": it must be ignored.
    const id = await provider.createCycle({ ...baseInput, name: "May 2026 catch-up", sitting: "february", examYearId: YEAR_2026 });

    const create = calls.find((c) => c.name === "create_cycle_with_assessments")!;
    expect(create.args.p_sitting).toBe("february");
    expect(create.args.p_year_id).toBe(YEAR_2026);
    const stored = db.exam_cycles!.find((c) => c.id === id)!;
    expect(stored.sitting).toBe("february");
    expect(stored.year_id).toBe(YEAR_2026);

    // …and the Years UI slots it as February, with the existing May sitting in May.
    const year = provider.listYears().find((y) => y.examYearId === YEAR_2026)!;
    expect(slotOf(year, "february").started).toBe(true);
    expect(slotOf(year, "february").cycleName).toBe("May 2026 catch-up");
    expect(slotOf(year, "may").started).toBe(true);
    expect(slotOf(year, "may").cycleName).toBe("May 2026");
  });

  it("a new year is find-or-created through create_exam_year, then its id is attached", async () => {
    const { provider, calls, db } = await newProvider(baseDb());

    const id = await provider.createCycle({ ...baseInput, name: "Feb sitting", sitting: "february", yearName: "2027" });

    const yearCall = calls.find((c) => c.name === "create_exam_year")!;
    expect(yearCall.args).toMatchObject({ p_name: "2027", p_test_centre_id: CENTRE_1 });
    const newYear = db.exam_years!.find((y) => y.name === "2027")!;
    const create = calls.find((c) => c.name === "create_cycle_with_assessments")!;
    expect(create.args.p_year_id).toBe(newYear.id);
    expect(db.exam_cycles!.find((c) => c.id === id)!.sitting).toBe("february");
    expect(calls.map((c) => c.name).indexOf("create_exam_year")).toBeLessThan(
      calls.map((c) => c.name).indexOf("create_cycle_with_assessments"),
    );
  });

  it("refuses a second sitting for an occupied (year, period) before calling the RPC", async () => {
    const { provider, calls } = await newProvider(baseDb());
    await expect(
      provider.createCycle({ ...baseInput, sitting: "may", examYearId: YEAR_2026 }),
    ).rejects.toThrow(/May sitting already exists for 2026/);
    expect(calls.some((c) => c.name === "create_cycle_with_assessments")).toBe(false);
  });

  it("typing an already-existing year name resolves to that year and still guards the period", async () => {
    const { provider, calls } = await newProvider(baseDb());
    await expect(
      provider.createCycle({ ...baseInput, sitting: "may", yearName: "2026" }),
    ).rejects.toThrow(/already exists/);
    expect(calls.some((c) => c.name === "create_cycle_with_assessments")).toBe(false);
  });

  it("refuses a year that belongs to a different centre than the one chosen", async () => {
    const { provider, calls } = await newProvider(baseDb());
    await expect(
      provider.createCycle({ ...baseInput, testCentreId: CENTRE_2, sitting: "february", examYearId: YEAR_2026 }),
    ).rejects.toThrow(/belongs to Shatila 1/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing/invalid year without touching the database", async () => {
    const { provider, calls } = await newProvider(baseDb());
    await expect(provider.createCycle({ ...baseInput, sitting: "february" })).rejects.toThrow(/4-digit year/);
    await expect(provider.createCycle({ ...baseInput, sitting: "february", yearName: "twenty" })).rejects.toThrow(/4-digit year/);
    expect(calls).toHaveLength(0);
  });
});

describe("the Years UI reads the stored period and year, not the name", () => {
  async function yearsFrom(db: MockDb) {
    const h = (await hydrate(makeSupabaseReadClient(db) as never))!;
    return new InMemoryDataProvider(h.seed, undefined, true);
  }

  it("slots by exam_cycles.sitting even when the name says otherwise", async () => {
    const db = baseDb();
    db.exam_cycles = [
      // newest → live. Name says May, stored period is february.
      { id: "c1", name: "May 2026 resit", status: "draft", region: "eu-west", year_id: YEAR_2026, sitting: "february", created_at: iso(20), updated_at: iso(20) },
      // Name says February, stored period is may.
      { id: "c2", name: "February 2026 catch-up", status: "draft", region: "eu-west", year_id: YEAR_2026, sitting: "may", created_at: iso(10), updated_at: iso(10) },
    ];
    const years = (await yearsFrom(db)).listYears();
    expect(years).toHaveLength(1);
    expect(slotOf(years[0]!, "february").cycleName).toBe("May 2026 resit");
    expect(slotOf(years[0]!, "may").cycleName).toBe("February 2026 catch-up");
  });

  it("takes the year label from exam_years.name, not from the sitting name", async () => {
    const db = baseDb();
    db.exam_cycles = [
      { id: "c1", name: "Alpha batch", status: "draft", region: "eu-west", year_id: YEAR_2026, sitting: "february", created_at: iso(20), updated_at: iso(20) },
    ];
    const y = (await yearsFrom(db)).listYears()[0]!;
    expect(y.name).toBe("2026"); // not "Unknown"
    expect(slotOf(y, "february").started).toBe(true);
  });

  it("legacy fallback: a row with NO stored period still falls back to its name", async () => {
    const db = baseDb();
    db.exam_cycles = [
      { id: "c1", name: "February 2026", status: "draft", region: "eu-west", year_id: YEAR_2026, sitting: null, created_at: iso(20), updated_at: iso(20) },
    ];
    const y = (await yearsFrom(db)).listYears()[0]!;
    expect(slotOf(y, "february").cycleName).toBe("February 2026");
  });

  it("the create form offers real years with the periods they already have", async () => {
    const model = (await yearsFrom(baseDb())).getNewCycle();
    expect(model.defaultSitting).toBe("may");
    expect(model.years).toEqual([
      { examYearId: YEAR_2026, name: "2026", testCentreId: CENTRE_1, takenSittings: ["may"] },
    ]);
  });
});
