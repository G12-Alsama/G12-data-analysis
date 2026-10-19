/**
 * Migration 0049_exam_incidents_per_cycle_reference.sql — structural safety guard
 * (the SQL is applied by a human in the Supabase editor, so it can't run in CI; the
 * opt-in tests/pg.exam-incidents.test.ts executes it against a local Postgres).
 *
 * Locks the fix for the cross-sitting data loss: `reference` was GLOBALLY unique and
 * the upsert did `on conflict (reference) do update set cycle_id = excluded.cycle_id`,
 * so importing a file that reused a reference in a second sitting MOVED the first
 * sitting's rows into it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(__dirname, "../supabase/migrations");
const SQL = readFileSync(resolve(dir, "0049_exam_incidents_per_cycle_reference.sql"), "utf8");
const ROLLBACK = readFileSync(resolve(dir, "0049_exam_incidents_per_cycle_reference.rollback.sql"), "utf8");
const ORIGINAL = readFileSync(resolve(dir, "0044_exam_incidents.sql"), "utf8");

/** Executable SQL only (comments stripped) so prose can't satisfy/violate a match. */
const code = (s: string) => s.replace(/--[^\n]*/g, "");

describe("0049 — uniqueness is per sitting", () => {
  it("adds unique (cycle_id, reference) and drops the global unique (reference)", () => {
    expect(code(SQL)).toMatch(/add constraint exam_incidents_cycle_reference_key unique \(cycle_id, reference\)/i);
    expect(code(SQL)).toMatch(/drop constraint if exists exam_incidents_reference_key/i);
  });

  it("creates the new constraint BEFORE dropping the old one (never unguarded)", () => {
    const sql = code(SQL);
    expect(sql.search(/add constraint exam_incidents_cycle_reference_key/i)).toBeLessThan(
      sql.search(/drop constraint if exists exam_incidents_reference_key/i),
    );
  });

  it("is idempotent: the add is guarded and the drop is `if exists`", () => {
    expect(code(SQL)).toMatch(/if not exists \(\s*select 1 from pg_constraint/i);
  });

  it("the original 0044 really had the global key this migration replaces", () => {
    expect(ORIGINAL).toMatch(/constraint exam_incidents_reference_key unique \(reference\)/i);
    expect(ORIGINAL).toMatch(/on conflict \(reference\) do update set\s+cycle_id = excluded\.cycle_id/i);
  });
});

describe("0049 — upsert never moves a row between sittings", () => {
  const sql = code(SQL);

  it("conflicts on (cycle_id, reference)", () => {
    expect(sql).toMatch(/on conflict \(cycle_id, reference\) do update set/i);
    expect(sql).not.toMatch(/on conflict \(reference\)/i);
  });

  it("does NOT reassign cycle_id on update", () => {
    const update = sql.slice(sql.search(/do update set/i));
    expect(update).not.toMatch(/cycle_id\s*=\s*excluded\.cycle_id/i);
  });

  it("keeps the 0044 signature, role gate, audit and grant", () => {
    expect(sql).toMatch(/function public\.upsert_exam_incidents\(\s*p_cycle uuid, p_batch uuid, p_file_name text, p_rows jsonb\)/i);
    expect(sql).toMatch(/app\.has_role\(p_cycle, array\['lead_admin','reviewer'\]::member_role\[\]\)/i);
    expect(sql).toMatch(/app\.audit\(p_cycle, 'upsert_exam_incidents'/i);
    expect(sql).toMatch(/grant execute on function public\.upsert_exam_incidents\(uuid, uuid, text, jsonb\) to authenticated/i);
  });

  it("stays STAGING ONLY — never writes adjustment_* columns", () => {
    const update = sql.slice(sql.search(/do update set/i));
    expect(update).not.toMatch(/adjustment_(type|magnitude|notes)\s*=/i);
  });

  it("runs in one transaction", () => {
    expect(sql).toMatch(/^\s*begin;/im);
    expect(sql).toMatch(/^\s*commit;/im);
  });
});

describe("0049 rollback", () => {
  it("refuses to run when a reference exists in several sittings (never deletes data)", () => {
    expect(code(ROLLBACK)).toMatch(/group by reference having count\(\*\) > 1/i);
    expect(code(ROLLBACK)).toMatch(/raise exception/i);
    expect(code(ROLLBACK)).not.toMatch(/delete from/i);
  });

  it("restores the global unique key and the 0044 conflict target", () => {
    expect(code(ROLLBACK)).toMatch(/add constraint exam_incidents_reference_key unique \(reference\)/i);
    expect(code(ROLLBACK)).toMatch(/drop constraint if exists exam_incidents_cycle_reference_key/i);
    expect(code(ROLLBACK)).toMatch(/on conflict \(reference\) do update set\s+cycle_id = excluded\.cycle_id/i);
  });
});
