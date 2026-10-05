/**
 * Hydration is split into a LIGHT workspace load (the list of ALL cycles + workspace
 * config) and a lazy per-cycle `hydrateCycle(cycleId)`.
 *
 *  - the light load reads NO per-cycle fact table (the Years page must never pull every
 *    cycle's responses);
 *  - `hydrateCycle(X)` reads only cycle X's data — cycle Y's rows are never touched and
 *    the two seeds are independent;
 *  - lock state comes from exam_cycles.status.
 */
import { describe, it, expect, vi } from "vitest";
import { makeSupabaseReadClient, type QueryLogEntry } from "@/tests/helpers/mock-supabase-read";
import { buildDb, YEAR } from "@/tests/helpers/multi-cycle-db";
import { hydrate, hydrateCycle, loadWorkspace, lightToSeedCycle } from "@/lib/data/supabase-hydrate";

vi.mock("server-only", () => ({}));

const FACT_TABLES = ["responses", "items", "item_stats", "item_reviews", "sittings", "grades", "score_runs", "participant_scores", "essay_marks", "alterations"];

function twoSittings() {
  return buildDb([
    { id: "cyc-feb", name: "February 2026", sitting: "february", status: "locked", age: 10,
      students: { "amal@s.edu": [1, 1, 1, 0], "bilal@s.edu": [1, 0, 0, 0], "carla@s.edu": [1, 1, 0, 0] } },
    { id: "cyc-may", name: "May 2026", sitting: "may", status: "in_review", age: 20,
      students: { "amal@s.edu": [1, 1, 1, 1], "bilal@s.edu": [1, 1, 0, 0] } },
  ]);
}

describe("loadWorkspace — the light load", () => {
  it("lists EVERY cycle (newest first) with stored period, year, status and lock", async () => {
    const ws = await loadWorkspace(makeSupabaseReadClient(twoSittings()) as never);
    expect(ws.cycles.map((c) => c.id)).toEqual(["cyc-may", "cyc-feb"]);
    const feb = ws.cycles.find((c) => c.id === "cyc-feb")!;
    expect(feb).toMatchObject({ sitting: "february", yearId: YEAR, yearName: "2026", status: "locked", locked: true });
    expect(ws.cycles.find((c) => c.id === "cyc-may")!.locked).toBe(false);
  });

  it("carries real summary counts for every cycle, not zeros", async () => {
    const ws = await loadWorkspace(makeSupabaseReadClient(twoSittings()) as never);
    const by = Object.fromEntries(ws.cycles.map((c) => [c.id, c]));
    expect(by["cyc-feb"]).toMatchObject({ participants: 3, assessments: 1 });
    expect(by["cyc-may"]).toMatchObject({ participants: 2, assessments: 1 });
  });

  it("reads NO per-cycle fact table", async () => {
    const log: QueryLogEntry[] = [];
    await loadWorkspace(makeSupabaseReadClient(twoSittings(), { log }) as never);
    const touched = new Set(log.map((q) => q.table));
    for (const t of FACT_TABLES) expect(touched.has(t), `light load read ${t}`).toBe(false);
    // …and the three small tables it uses for counts are read column-limited, unfiltered.
    expect(touched.has("participants") && touched.has("assessments") && touched.has("cohort_exclusions")).toBe(true);
  });

  it("subtracts cohort exclusions from the participant count, but never a dangling key", async () => {
    const db = twoSittings();
    db.cohort_exclusions = [
      { id: "x1", cycle_id: "cyc-feb", participant_key: "bilal@s.edu" },
      { id: "x2", cycle_id: "cyc-feb", participant_key: "ghost@gone.edu" }, // no such participant
    ];
    const ws = await loadWorkspace(makeSupabaseReadClient(db) as never);
    expect(ws.cycles.find((c) => c.id === "cyc-feb")!.participants).toBe(2);
    expect(ws.cycles.find((c) => c.id === "cyc-may")!.participants).toBe(2);
  });

  it("converts to a real (non-mock) directory entry with the stored lock", async () => {
    const ws = await loadWorkspace(makeSupabaseReadClient(twoSittings()) as never);
    const entry = lightToSeedCycle(ws.cycles.find((c) => c.id === "cyc-feb")!);
    expect(entry).toMatchObject({ id: "cyc-feb", mock: false, locked: true, sitting: "february", participants: 3 });
  });

  it("an empty database yields an empty list, not an error", async () => {
    const ws = await loadWorkspace(makeSupabaseReadClient({}) as never);
    expect(ws.cycles).toEqual([]);
  });
});

describe("hydrateCycle — one cycle at a time", () => {
  it("returns null for an unknown cycle", async () => {
    expect(await hydrateCycle(makeSupabaseReadClient(twoSittings()) as never, "nope")).toBeNull();
  });

  it("loads exactly that cycle's data", async () => {
    const h = (await hydrateCycle(makeSupabaseReadClient(twoSittings()) as never, "cyc-feb"))!;
    expect(h.seed.liveCycle.id).toBe("cyc-feb");
    expect(h.seed.liveCycle.participants).toHaveLength(3);
    expect(h.seed.liveCycle.assessments).toHaveLength(1);
    expect(h.seed.liveCycle.assessments[0]!.id).toBe("a-cyc-feb");
    expect(h.seed.priorCycles).toEqual([]); // a cycle's seed hosts only itself
  });

  it("two cycles hydrate independently with different data", async () => {
    const client = makeSupabaseReadClient(twoSittings()) as never;
    const feb = (await hydrateCycle(client, "cyc-feb"))!;
    const may = (await hydrateCycle(client, "cyc-may"))!;
    expect(feb.seed.liveCycle.participants.map((p) => p.studentId).sort()).toEqual(["amal@s.edu", "bilal@s.edu", "carla@s.edu"]);
    expect(may.seed.liveCycle.participants.map((p) => p.studentId).sort()).toEqual(["amal@s.edu", "bilal@s.edu"]);
    // distinct row ids per cycle (participants/assessments are per-cycle rows)
    const febIds = new Set(feb.seed.liveCycle.participants.map((p) => p.id));
    expect(may.seed.liveCycle.participants.some((p) => febIds.has(p.id))).toBe(false);
  });

  it("only ever reads ITS cycle's rows from the per-cycle tables", async () => {
    const log: QueryLogEntry[] = [];
    await hydrateCycle(makeSupabaseReadClient(twoSittings(), { log }) as never, "cyc-may");
    const perCycle = log.filter((q) => FACT_TABLES.includes(q.table) && q.table !== "item_stats" && q.table !== "item_reviews");
    expect(perCycle.length).toBeGreaterThan(0);
    for (const q of perCycle) expect(q.eq.cycle_id, `${q.table} was read without the cycle filter`).toBe("cyc-may");
  });

  it("does not read the workspace-only tables (roles, labels, settings)", async () => {
    const log: QueryLogEntry[] = [];
    await hydrateCycle(makeSupabaseReadClient(twoSittings(), { log }) as never, "cyc-may");
    const touched = new Set(log.map((q) => q.table));
    for (const t of ["roles", "role_actions", "element_labels", "workspace_settings"]) {
      expect(touched.has(t), `hydrateCycle read ${t}`).toBe(false);
    }
  });

  it("lock state comes from exam_cycles.status — even with NO grades rows", async () => {
    const client = makeSupabaseReadClient(twoSittings()) as never; // db has no `grades` rows at all
    expect((await hydrateCycle(client, "cyc-feb"))!.decisions.locked).toBe(true);
    expect((await hydrateCycle(client, "cyc-may"))!.decisions.locked).toBe(false);
  });

  it("the cycle's seed carries its stored period and year name", async () => {
    const h = (await hydrateCycle(makeSupabaseReadClient(twoSittings()) as never, "cyc-feb"))!;
    expect(h.seed.liveCycle).toMatchObject({ sitting: "february", yearName: "2026", yearId: YEAR });
  });
});

describe("legacy hydrate() — newest cycle in full + the rest as light summaries", () => {
  it("is built from the two parts and still returns the newest as the live cycle", async () => {
    const h = (await hydrate(makeSupabaseReadClient(twoSittings()) as never))!;
    expect(h.seed.liveCycle.id).toBe("cyc-may");
    expect(h.seed.priorCycles.map((p) => p.id)).toEqual(["cyc-feb"]);
    // the other sitting now carries REAL counts + lock, not the old 0 / forced values
    expect(h.seed.priorCycles[0]).toMatchObject({ participants: 3, assessments: 1, locked: true, mock: false });
    expect(h.decisions.locked).toBe(false);
  });
});
