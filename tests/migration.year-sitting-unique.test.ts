/**
 * Migration 0050 (one sitting per year+period) — structural guards. The SQL is applied
 * by a human in the Supabase editor, so CI can only assert on its text: these pin that
 * it is the next migration in an unbroken chain, that its read-only pre-flight stays
 * OUT of the chain and is strictly read-only, and that the migration keeps its safety
 * properties. (tests/pg.year-sitting-unique.test.ts executes it against a local
 * Postgres, opt-in.)
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { friendlyCreateCycleError } from "@/lib/data/create-cycle";

const root = resolve(__dirname, "../supabase");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
const PREFLIGHT = read("diagnostics/0050_year_sitting_preflight.sql");
const DRAFT = read("migrations/0050_year_sitting_unique.sql"); // (the migration under test)
const ROLLBACK = read("migrations/0050_year_sitting_unique.rollback.sql");

/** Executable SQL only: comments, then string literals, stripped. */
const code = (s: string) => s.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");

describe("0050 is the next migration; its pre-flight stays out of the chain", () => {
  const files = readdirSync(resolve(root, "migrations"));
  const numbers = [...new Set(files.map((f) => f.slice(0, 4)))].sort();

  it("0050 and its rollback are in supabase/migrations, directly after 0049", () => {
    expect(files).toContain("0050_year_sitting_unique.sql");
    expect(files).toContain("0050_year_sitting_unique.rollback.sql");
    expect(numbers.slice(-2)).toEqual(["0049", "0050"]);
  });
  it("there is exactly one 0050 migration (no number collision)", () => {
    expect(files.filter((f) => f.startsWith("0050") && !f.endsWith(".rollback.sql"))).toEqual(["0050_year_sitting_unique.sql"]);
  });
  it("the read-only pre-flight is NOT in the migration chain (nothing would apply it)", () => {
    expect(files.some((f) => /preflight/i.test(f))).toBe(false);
    expect(existsSync(resolve(root, "diagnostics", "0050_year_sitting_preflight.sql"))).toBe(true);
  });
  it("the old drafts folder is gone", () => {
    expect(existsSync(resolve(root, "drafts"))).toBe(false);
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

describe("0050 migration", () => {
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
