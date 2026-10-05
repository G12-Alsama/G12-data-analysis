/**
 * A STATEFUL fake of the live Supabase backend for SupabaseDataProvider tests.
 *
 * Reads come from an in-memory table map (so a re-read sees whatever the fake "database"
 * now holds), every executed read is logged (table + `.eq` filters), and the RPCs that
 * matter mutate the tables the way the REAL functions do — in particular `lock_grades`
 * flips `exam_cycles.status` and touches `grades` rows only if they exist (there are none
 * in this fixture, exactly like production), so a lock that is only stored in `grades`
 * would be lost, and one stored in `status` survives.
 *
 * Every RPC call is recorded in `calls`, so a test can assert what was (and wasn't) sent.
 */
import { vi } from "vitest";
import { SupabaseDataProvider } from "@/lib/data/supabase-provider";
import { makeSupabaseReadClient, type MockDb, type QueryLogEntry } from "./mock-supabase-read";
import { USER } from "./multi-cycle-db";

export interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

export interface LiveFake {
  db: MockDb;
  calls: RpcCall[];
  /** Every executed read since the last `clearLog()`. */
  log: QueryLogEntry[];
  clearLog(): void;
  /** Make the named RPC fail with this message. */
  failRpc(name: string, message: string): void;
  client: unknown;
}

export interface LiveFakeOptions {
  /** The signed-in user's membership role (default "lead_admin"). */
  role?: string;
}

export function makeLiveFake(db: MockDb, opts: LiveFakeOptions = {}): LiveFake {
  const calls: RpcCall[] = [];
  const log: QueryLogEntry[] = [];
  const failing = new Map<string, string>();
  let seq = 0;

  db.memberships = [{ user_id: USER, role: opts.role ?? "lead_admin", role_id: null, cycle_id: null }];

  const reads = makeSupabaseReadClient(db, { log });
  const rows = (t: string) => (db[t] ??= []);
  const cycleOf = (id: unknown) => rows("exam_cycles").find((c) => c.id === id);

  const removeCycleData = (cycleId: string, includeCycle: boolean): number => {
    let n = 0;
    const del = (table: string) => {
      const before = rows(table).length;
      db[table] = rows(table).filter((r) => r.cycle_id !== cycleId);
      n += before - db[table]!.length;
    };
    for (const t of ["responses", "sittings", "items", "participants", "assessments", "cohort_exclusions", "clean_exclusions"]) del(t);
    if (includeCycle) {
      const before = rows("exam_cycles").length;
      db.exam_cycles = rows("exam_cycles").filter((c) => c.id !== cycleId);
      n += before - db.exam_cycles.length;
    }
    return n;
  };

  const client = {
    from: reads.from,
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: USER, email: "tester@example.test", user_metadata: {} } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const fail = failing.get(name);
      if (fail) return { data: null, error: { message: fail } };
      switch (name) {
        case "create_exam_year": {
          const found = rows("exam_years").find((y) => y.name === args.p_name && y.test_centre_id === args.p_test_centre_id);
          if (found) return { data: found, error: null };
          const y = { id: `year-new-${++seq}`, name: args.p_name, region: args.p_region, test_centre_id: args.p_test_centre_id };
          rows("exam_years").push(y);
          return { data: y, error: null };
        }
        case "create_cycle_with_assessments": {
          const id = `cycle-new-${++seq}`;
          const t = new Date(Date.parse("2026-06-01T00:00:00Z") + seq * 60_000).toISOString();
          rows("exam_cycles").push({
            id, name: args.p_name, status: "draft", region: args.p_region, year_id: args.p_year_id,
            sitting: args.p_sitting, sitting_date: args.p_sitting_date, created_by: USER, created_at: t, updated_at: t,
          });
          return { data: id, error: null };
        }
        // The real lock_grades: updates `grades` rows (none here) and sets the cycle status.
        case "lock_grades": {
          const c = cycleOf(args.p_cycle);
          if (c) c.status = "locked";
          return { data: null, error: null };
        }
        case "unlock_grades": {
          const c = cycleOf(args.p_cycle);
          if (c) c.status = "graded";
          return { data: null, error: null };
        }
        case "delete_sitting":
        case "delete_cycle":
          return { data: removeCycleData(String(args.p_cycle), true), error: null };
        case "clear_sitting_data": {
          const n = removeCycleData(String(args.p_cycle), false);
          const c = cycleOf(args.p_cycle);
          if (c) c.status = "draft";
          return { data: n, error: null };
        }
        case "list_members":
          return { data: [], error: null };
        default:
          return { data: null, error: null };
      }
    },
  };

  return {
    db,
    calls,
    log,
    clearLog: () => void (log.length = 0),
    failRpc: (name, message) => void failing.set(name, message),
    client,
  };
}

/** A provider over the fake, fully past its initial (light) load. */
export async function liveProvider(db: MockDb, opts?: LiveFakeOptions) {
  const fake = makeLiveFake(db, opts);
  const provider = new SupabaseDataProvider(fake.client as never);
  await vi.waitFor(() => {
    const s = provider.getAccessStatus();
    if (s !== "ok" && s !== "no-cycle") throw new Error(`provider still ${s}`);
  });
  return { provider, fake };
}
