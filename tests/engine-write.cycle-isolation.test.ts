/**
 * Multi-sitting safety: `recomputeAndWrite` for one cycle must never touch another
 * cycle's persisted scores.
 *
 * `participant_scores` has no cycle_id — it belongs to a cycle through its
 * score_run. The recompute used to clear it with an UNFILTERED delete
 * (`.delete()` with no predicate), which PostgREST accepts as "delete every row",
 * wiping every sitting's scores on each recompute. This drives the real function
 * through a stateful in-memory admin that implements real delete semantics
 * (predicates, unfiltered = all rows) and the FK cascade
 * score_runs → participant_scores, then asserts cycle B is left untouched.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

interface DeleteCall { table: string; filters: string[] }

/** Stateful Supabase admin stand-in with real filter/delete/cascade semantics. */
function makeAdmin(store: Store) {
  const deletes: DeleteCall[] = [];
  let runSeq = 0;

  const rows = (name: string) => (store[name] ??= []);

  class Filterable {
    protected preds: ((r: Row) => boolean)[] = [];
    protected labels: string[] = [];
    eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); this.labels.push(`eq:${col}`); return this; }
    in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); this.labels.push(`in:${col}`); return this; }
    protected matches(r: Row) { return this.preds.every((p) => p(r)); }
  }

  class ReadQuery extends Filterable implements PromiseLike<{ data: Row[]; error: null }> {
    constructor(private name: string) { super(); }
    select() { return this; }
    then<T>(onf?: ((v: { data: Row[]; error: null }) => T | PromiseLike<T>) | null) {
      return Promise.resolve({ data: rows(this.name).filter((r) => this.matches(r)), error: null }).then(onf);
    }
  }

  class DeleteQuery extends Filterable implements PromiseLike<{ error: null }> {
    constructor(private name: string) { super(); }
    then<T>(onf?: ((v: { error: null }) => T | PromiseLike<T>) | null) {
      deletes.push({ table: this.name, filters: [...this.labels] });
      // No predicate = every row, exactly like an unfiltered PostgREST DELETE.
      store[this.name] = rows(this.name).filter((r) => !this.matches(r));
      if (this.name === "score_runs") {
        // FK: participant_scores.score_run_id → score_runs(id) ON DELETE CASCADE
        const live = new Set(rows("score_runs").map((r) => r.id));
        store.participant_scores = rows("participant_scores").filter((r) => live.has(r.score_run_id));
      }
      return Promise.resolve({ error: null as null }).then(onf);
    }
  }

  const from = (name: string) => ({
    select: (_c?: string) => new ReadQuery(name),
    upsert: (r: unknown) => {
      rows(name).push(...((Array.isArray(r) ? r : [r]) as Row[]));
      return Promise.resolve({ error: null, data: null });
    },
    insert: (r: unknown) => {
      const list = (Array.isArray(r) ? r : [r]) as Row[];
      const inserted = list.map((x) => (name === "score_runs" ? { id: `run-new-${++runSeq}`, ...x } : x));
      rows(name).push(...inserted);
      return Object.assign(Promise.resolve({ error: null as null, data: null as unknown }), {
        select: (_c: string) => Promise.resolve({ data: inserted.map((x) => ({ id: x.id })), error: null }),
      });
    },
    delete: () => new DeleteQuery(name),
  });

  return { admin: { from } as any, deletes };
}

/** One sitting's source data: a two-item Math subject sat by two participants. */
function cycleData(cycle: string, tag: string): Store {
  const a = `a-${tag}`;
  const parts = [`p1-${tag}`, `p2-${tag}`];
  return {
    assessments: [{ id: a, cycle_id: cycle, name: "Math" }],
    items: ["i1", "i2"].map((i) => ({
      id: `${i}-${tag}`, cycle_id: cycle, assessment_id: a, max_score: 1, status: "active",
      wording: null, major_element: null, sub_element: null, demand_level: null,
    })),
    participants: parts.map((p) => ({ id: p, cycle_id: cycle, qm_participant_id: `${p}@s.edu`, pseudonym_id: p, email: `${p}@s.edu` })),
    responses: parts.flatMap((p) => [
      { cycle_id: cycle, participant_id: p, item_id: `i1-${tag}`, answer_score: 1 },
      { cycle_id: cycle, participant_id: p, item_id: `i2-${tag}`, answer_score: 0 },
    ]),
  };
}

function merge(...stores: Store[]): Store {
  const out: Store = {};
  for (const s of stores) for (const [k, v] of Object.entries(s)) (out[k] ??= []).push(...v);
  return out;
}

const A = "cycle-A";
const B = "cycle-B";

function seeded(): Store {
  return merge(
    cycleData(A, "A"),
    cycleData(B, "B"),
    {
      essay_marks: [], alterations: [], clean_exclusions: [], cohort_exclusions: [],
      // Pre-existing persisted scores for BOTH sittings (a prior recompute of each).
      score_runs: [
        { id: "run-A-old", cycle_id: A, assessment_id: "a-A" },
        { id: "run-B-old", cycle_id: B, assessment_id: "a-B" },
      ],
      participant_scores: [
        { id: "ps-A1", score_run_id: "run-A-old", participant_id: "p1-A", assessment_id: "a-A", raw: 9, pct: 90, items_seen: 2 },
        { id: "ps-B1", score_run_id: "run-B-old", participant_id: "p1-B", assessment_id: "a-B", raw: 7, pct: 70, items_seen: 2 },
        { id: "ps-B2", score_run_id: "run-B-old", participant_id: "p2-B", assessment_id: "a-B", raw: 5, pct: 50, items_seen: 2 },
      ],
    },
  );
}

describe("recomputeAndWrite is cycle-scoped (multi-sitting safety)", () => {
  it("a recompute for cycle A leaves cycle B's participant_scores and score_runs untouched", async () => {
    const { recomputeAndWrite } = await import("@/lib/server/engine-write");
    const store = seeded();
    const bScoresBefore = JSON.parse(JSON.stringify(store.participant_scores!.filter((r) => r.score_run_id === "run-B-old")));
    const { admin } = makeAdmin(store);

    const result = await recomputeAndWrite(admin, A);

    // B: byte-identical scores, and its run still exists.
    expect(store.participant_scores!.filter((r) => r.score_run_id === "run-B-old")).toEqual(bScoresBefore);
    expect(store.score_runs!.some((r) => r.id === "run-B-old" && r.cycle_id === B)).toBe(true);

    // A: the stale snapshot is replaced by a fresh one (both A participants scored).
    expect(store.score_runs!.some((r) => r.id === "run-A-old")).toBe(false);
    const aRuns = store.score_runs!.filter((r) => r.cycle_id === A);
    expect(aRuns).toHaveLength(1);
    const aScores = store.participant_scores!.filter((r) => r.score_run_id === aRuns[0]!.id);
    expect(new Set(aScores.map((r) => r.participant_id))).toEqual(new Set(["p1-A", "p2-A"]));
    expect(store.participant_scores!.some((r) => r.id === "ps-A1")).toBe(false);
    expect(result.scores).toBe(2);
  });

  it("never issues an unfiltered delete (every delete carries a predicate)", async () => {
    const { recomputeAndWrite } = await import("@/lib/server/engine-write");
    const { admin, deletes } = makeAdmin(seeded());

    await recomputeAndWrite(admin, A);

    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) expect(d.filters, `unfiltered DELETE on ${d.table}`).not.toHaveLength(0);
    // participant_scores specifically is cleared by score_run ownership, never wholesale.
    expect(deletes.find((d) => d.table === "participant_scores")?.filters).toEqual(["in:score_run_id"]);
  });

  it("recomputing both sittings in turn preserves each other's scores", async () => {
    const { recomputeAndWrite } = await import("@/lib/server/engine-write");
    const store = seeded();
    const { admin } = makeAdmin(store);

    await recomputeAndWrite(admin, A);
    await recomputeAndWrite(admin, B);

    const owners = (cycle: string) => {
      const runs = new Set(store.score_runs!.filter((r) => r.cycle_id === cycle).map((r) => r.id));
      return store.participant_scores!.filter((r) => runs.has(r.score_run_id));
    };
    expect(new Set(owners(A).map((r) => r.participant_id))).toEqual(new Set(["p1-A", "p2-A"]));
    expect(new Set(owners(B).map((r) => r.participant_id))).toEqual(new Set(["p1-B", "p2-B"]));
  });

  it("a first-ever recompute (no prior runs) still writes scores and skips the participant_scores delete", async () => {
    const { recomputeAndWrite } = await import("@/lib/server/engine-write");
    const store = merge(cycleData(A, "A"), { essay_marks: [], alterations: [], clean_exclusions: [], cohort_exclusions: [] });
    const { admin, deletes } = makeAdmin(store);

    const result = await recomputeAndWrite(admin, A);

    expect(result.scores).toBe(2);
    expect(deletes.some((d) => d.table === "participant_scores")).toBe(false);
  });
});
