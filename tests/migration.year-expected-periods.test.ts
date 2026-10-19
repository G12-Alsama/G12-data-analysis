/**
 * Migration 0051 (exam_years.expected_periods + set_year_expected_periods) — structural
 * guards on the SQL text (a human applies it in the Supabase editor), plus an opt-in run
 * against a scratch Postgres (tests/pg.year-expected-periods.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(__dirname, "../supabase/migrations");
const files = readdirSync(dir);
const SQL = readFileSync(resolve(dir, "0051_year_expected_periods.sql"), "utf8");
const ROLLBACK = readFileSync(resolve(dir, "0051_year_expected_periods.rollback.sql"), "utf8");
const code = (s: string) => s.replace(/--[^\n]*/g, "");

describe("0051 sits in an unbroken chain", () => {
  it("is the one 0051 migration, right after 0050, with a rollback", () => {
    expect(files.filter((f) => f.startsWith("0051") && !f.endsWith(".rollback.sql"))).toEqual(["0051_year_expected_periods.sql"]);
    expect(files).toContain("0051_year_expected_periods.rollback.sql");
    const numbers = [...new Set(files.map((f) => f.slice(0, 4)))].sort();
    expect(numbers[numbers.indexOf("0051") - 1]).toBe("0050");
  });
});

describe("0051 migration", () => {
  const c = code(SQL);
  it("is one transaction with a lock timeout", () => {
    expect(c).toMatch(/\bbegin;/i);
    expect(c).toMatch(/set local lock_timeout/i);
    expect(c).toMatch(/\bcommit;/i);
  });
  it("adds a NOT NULL column defaulting to February + May (existing years unchanged)", () => {
    expect(c).toMatch(/add column if not exists expected_periods public\.sitting_period\[\] not null default '\{february,may\}'/i);
  });
  it("requires at least one expected period", () => {
    expect(c).toMatch(/check \(cardinality\(expected_periods\) >= 1\)/i);
  });
  it("is idempotent (guarded column + constraint)", () => {
    expect(c).toMatch(/if not exists \(\s*select 1 from pg_constraint/i);
  });
  it("the setter is definer-only-by-gate: manage_centres, authenticated, never PUBLIC", () => {
    expect(c).toMatch(/app\.can_do\(null, 'general\.manage_centres'\)/);
    expect(c).toMatch(/revoke execute on function public\.set_year_expected_periods\(uuid, public\.sitting_period\[\]\) from public/i);
    expect(c).toMatch(/grant\s+execute on function public\.set_year_expected_periods\(uuid, public\.sitting_period\[\]\) to authenticated/i);
    expect(c).toMatch(/security definer set search_path = public, app/i);
  });
  it("audits a change, and is a no-op when nothing changes", () => {
    expect(c).toMatch(/app\.audit\(null, 'set_expected_periods'/);
    expect(c).toMatch(/if y_before\.expected_periods = v_list then\s+return y_before/i);
  });
  it("touches no fact table", () => {
    expect(c).not.toMatch(/\b(participants|responses|items|grades|score_runs|participant_scores|assessments)\b/i);
  });
});

describe("0051 rollback", () => {
  const c = code(ROLLBACK);
  it("drops the function, the constraint and the column", () => {
    expect(c).toMatch(/drop function if exists public\.set_year_expected_periods/i);
    expect(c).toMatch(/drop constraint if exists exam_years_expected_periods_nonempty/i);
    expect(c).toMatch(/drop column if exists expected_periods/i);
    expect(c).toMatch(/\bbegin;/i);
    expect(c).toMatch(/\bcommit;/i);
  });
});
