/**
 * Draft 0050 (one sitting per year+period) — structural guards. The drafts live in
 * supabase/drafts/ and are NOT applied by anything; these tests pin that they stay
 * out of the migration chain, that the pre-flight is strictly READ-ONLY, and that the
 * draft migration keeps its safety properties. (tests/pg.year-sitting-unique.test.ts
 * executes them against a local Postgres, opt-in.)
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { friendlyCreateCycleError } from "@/lib/data/create-cycle";

const root = resolve(__dirname, "../supabase");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
const PREFLIGHT = read("drafts/0050_year_sitting_preflight.sql");
const DRAFT = read("drafts/0050_year_sitting_unique.sql");
const ROLLBACK = read("drafts/0050_year_sitting_unique.rollback.sql");

/** Executable SQL only: comments, then string literals, stripped. */
const code = (s: string) => s.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");

describe("0050 is a draft: not in the migration chain", () => {
  it("no 0050 migration exists under supabase/migrations", () => {
    expect(readdirSync(resolve(root, "migrations")).filter((f) => f.startsWith("0050"))).toEqual([]);
  });
  it("the drafts and their README exist", () => {
    for (const f of ["README.md", "0050_year_sitting_preflight.sql", "0050_year_sitting_unique.sql", "0050_year_sitting_unique.rollback.sql"]) {
      expect(existsSync(resolve(root, "drafts", f)), f).toBe(true);
    }
  });
});

describe("0050 pre-flight is strictly read-only", () => {
  it("contains no DML/DDL/grant statements (string literals and comments excluded)", () => {
    expect(code(PREFLIGHT)).not.toMatch(/\b(insert|update|delete|alter|drop|create|truncate|grant|revoke|set\s+role)\b/i);
  });
  it("covers duplicates, name-vs-period mismatches and missing year/period", () => {
    expect(PREFLIGHT).toMatch(/partition by c\.year_id, c\.sitting/);
    expect(PREFLIGHT).toMatch(/name_says/);
    expect(PREFLIGHT).toMatch(/year_id is null or c\.sitting is null/);
  });
  it("only suggests a fix as TEXT, and only when the target period is free", () => {
    expect(PREFLIGHT).toMatch(/format\('update exam_cycles set sitting = %L where id = %L;'/);
    expect(PREFLIGHT).toMatch(/not exists \(select 1 from exam_cycles o/);
  });
});

describe("0050 draft migration", () => {
  const sql = code(DRAFT);

  it("runs in a single transaction", () => {
    expect(sql).toMatch(/^\s*begin;/im);
    expect(sql).toMatch(/^\s*commit;/im);
  });

  it("backfills conservatively: only whole-word Jan–Apr names stored as 'may', never 'may'-named, one free candidate per year", () => {
    expect(DRAFT).toMatch(/c\.sitting = 'may'/);
    expect(DRAFT).toMatch(/\\m\(january\|february\|march\|april\|jan\|feb\|mar\|apr\)\\M/);
    expect(DRAFT).toMatch(/c\.name !~\* '\\mmay\\M'/);
    expect(DRAFT).toMatch(/not exists \(select 1 from exam_cycles o\s+where o\.year_id = c\.year_id and o\.sitting = 'february'\)/i);
    expect(sql).toMatch(/having count\(\*\) = 1/i);
  });

  it("only audits when a user id is set (audit_log.actor_id is NOT NULL), and always raises a notice", () => {
    expect(sql).toMatch(/if auth\.uid\(\) is not null then\s+perform app\.audit/i);
    expect(sql).toMatch(/raise notice/i);
  });

  it("stops (changing nothing) on remaining NULL year/period or duplicate slots, before enforcing", () => {
    const guard = sql.search(/raise exception/i);
    const enforce = sql.search(/set not null/i);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(enforce);
    expect(sql).toMatch(/having count\(\*\) > 1/i);
  });

  it("enforces NOT NULL on both columns and unique (year_id, sitting), idempotently", () => {
    expect(sql).toMatch(/alter column year_id set not null/i);
    expect(sql).toMatch(/alter column sitting set not null/i);
    expect(sql).toMatch(/add constraint exam_cycles_year_sitting_key unique \(year_id, sitting\)/i);
    expect(sql).toMatch(/if not exists \(\s*select 1 from pg_constraint/i);
  });

  it("retires the legacy year-less create_cycle RPC", () => {
    expect(sql).toMatch(/revoke execute on function public\.create_cycle\(text, text\) from public, anon, authenticated/i);
  });

  it("never deletes or rewrites anything beyond the backfilled period", () => {
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    const updates = sql.match(/\bupdate\s+\w+/gi) ?? [];
    expect(updates.map((u) => u.toLowerCase())).toEqual(["update exam_cycles"]);
  });
});

describe("0050 rollback", () => {
  it("drops the key, relaxes NOT NULL and restores the legacy RPC", () => {
    const sql = code(ROLLBACK);
    expect(sql).toMatch(/drop constraint if exists exam_cycles_year_sitting_key/i);
    expect(sql).toMatch(/alter column year_id drop not null/i);
    expect(sql).toMatch(/alter column sitting drop not null/i);
    expect(sql).toMatch(/grant execute on function public\.create_cycle\(text, text\) to public, authenticated/i);
  });
});

describe("friendlyCreateCycleError", () => {
  it("turns the constraint violation into a plain message naming the period", () => {
    const raw = 'duplicate key value violates unique constraint "exam_cycles_year_sitting_key"';
    expect(friendlyCreateCycleError(raw, { sitting: "february" })).toBe("A February sitting already exists for this year at this centre.");
    expect(friendlyCreateCycleError(raw, { sitting: "may" })).toMatch(/^A May sitting already exists/);
  });
  it("passes any other error through, with a fallback", () => {
    expect(friendlyCreateCycleError("permission denied", { sitting: "may" })).toBe("permission denied");
    expect(friendlyCreateCycleError(undefined, { sitting: "may" })).toBe("Could not create the cycle.");
  });
});
