/**
 * Migration 0046_real_two_sitting_overall.sql — structural safety guard.
 *
 * The SQL is applied by a human in the Supabase editor, so it can't run in CI.
 * (It was exercised against PostgreSQL 16 over the full 0001→0046 chain, with
 * the real `ingest_persist`, `lock_grades` and the 0043 seed + rollback.) This
 * test pins the properties that make it production-safe so a careless edit
 * can't drop them.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(__dirname, "../supabase/migrations");
const SQL = readFileSync(resolve(dir, "0046_real_two_sitting_overall.sql"), "utf8");
const ROLLBACK = readFileSync(resolve(dir, "0046_real_two_sitting_overall.rollback.sql"), "utf8");
const M0031 = readFileSync(resolve(dir, "0031_sitting_date.sql"), "utf8");

/** Strip `--` comments so assertions only see executable SQL. */
const code = (s: string) => s.replace(/--.*$/gm, "");

/** The create_cycle_with_assessments body from a migration file. */
function createRpc(s: string): string {
  const m = /create or replace function public\.create_cycle_with_assessments\([\s\S]*?^end \$\$;/m.exec(s);
  if (!m) throw new Error("create_cycle_with_assessments not found");
  return m[0];
}

describe("0046 — forward", () => {
  it("is one transaction", () => {
    expect(code(SQL)).toMatch(/^\s*begin;/m);
    expect(code(SQL)).toMatch(/^\s*commit;\s*$/m);
  });

  it("marks synthetic centres by the 0043 slug prefix without deleting anything", () => {
    expect(SQL).toMatch(/add column if not exists is_synthetic boolean not null default false/i);
    expect(SQL).toMatch(/set is_synthetic = true\s+where slug like 'seed-ov-%'/i);
    expect(code(SQL)).not.toMatch(/\bdelete\s+from\b/i);
    expect(code(SQL)).not.toMatch(/\btruncate\b/i);
    expect(code(SQL)).not.toMatch(/\bdrop\s+table\b/i);
  });

  it("derives the sitting Jan–Apr → february, May–Dec → may, and abstains on a tie", () => {
    expect(SQL).toMatch(/\^\(JAN\|FEB\|MAR\|APR\)[^']*'\s*then 'february'/);
    expect(SQL).toMatch(/\^\(MAY\|JUN\|JUL\|AUG\|SEP\|OCT\|NOV\|DEC\)[^']*'\s*then 'may'/);
    expect(SQL).toMatch(/where r = 1\) = 1/); // a unique top period only
  });

  it("the ingest trigger never changes a LOCKED cycle", () => {
    const fn = /create or replace function app\.sync_cycle_sitting[\s\S]*?end \$\$;/.exec(SQL)![0];
    expect(fn).toMatch(/c\.status = 'locked'[\s\S]*return false/);
  });

  it("hooks every ingest via a statement-level trigger on sittings (ingest_persist untouched)", () => {
    expect(SQL).toMatch(/after insert on public\.sittings\s+referencing new table as new_rows\s+for each statement/i);
    expect(code(SQL)).not.toMatch(/function public\.ingest_persist/i);
  });

  it("touches no score, grade, response or lock data", () => {
    const c = code(SQL);
    for (const t of ["grades", "participant_scores", "item_stats", "responses", "score_runs", "items"]) {
      expect(c).not.toMatch(new RegExp(`\\b(update|delete from|insert into)\\s+(public\\.)?${t}\\b`, "i"));
    }
    expect(c).not.toMatch(/set\s+status\s*=/i);
    expect(c).not.toMatch(/\block_grades\b|\bunlock_grades\b/i);
  });

  it("audit_log is append-only: only INSERTs, with a non-null actor", () => {
    const c = code(SQL);
    expect(c).not.toMatch(/(update|delete from)\s+(public\.)?audit_log/i);
    expect(c).toMatch(/insert into audit_log/i);
    expect(c).toMatch(/coalesce\(auth\.uid\(\), c\.created_by\)/);
  });

  it("backs up every backfilled value before changing it, real centres only", () => {
    expect(SQL).toMatch(/create table if not exists app\.sitting_backfill_0046/i);
    const bf = /do \$backfill\$[\s\S]*?\$backfill\$;/.exec(SQL)![0];
    expect(bf).toMatch(/coalesce\(t\.is_synthetic, false\) = false/);
    expect(bf.search(/insert into app\.sitting_backfill_0046/)).toBeLessThan(bf.search(/update exam_cycles set sitting/));
  });

  it("keeps the 0031 create RPC signature/defaults (grant stands) and only adds date-derivation", () => {
    const sig = (s: string) => /create or replace function public\.create_cycle_with_assessments\(([\s\S]*?)\)\s*returns uuid/.exec(s)![1]!.replace(/\s+/g, " ");
    expect(sig(SQL)).toBe(sig(M0031));
    expect(code(SQL)).not.toMatch(/drop function if exists public\.create_cycle_with_assessments/i);
    expect(createRpc(SQL)).toMatch(/extract\(month from p_sitting_date\) between 1 and 4 then 'february'/);
    expect(createRpc(SQL)).toMatch(/to_char\(p_sitting_date, 'YYYY'\)/);
  });
});

describe("0046 — rollback", () => {
  it("restores backfilled sittings from the backup, audited, then drops the backup", () => {
    expect(ROLLBACK).toMatch(/for b in select \* from app\.sitting_backfill_0046/);
    expect(ROLLBACK).toMatch(/update exam_cycles set sitting = b\.old_sitting/);
    expect(ROLLBACK).toMatch(/'source', 'migration_0046_rollback'/);
    expect(ROLLBACK.search(/update exam_cycles set sitting = b\.old_sitting/)).toBeLessThan(
      ROLLBACK.search(/drop table if exists app\.sitting_backfill_0046/),
    );
  });

  it("never edits or deletes audit rows", () => {
    expect(code(ROLLBACK)).not.toMatch(/(update|delete from)\s+(public\.)?audit_log/i);
  });

  it("drops the trigger, the helpers and the marker column", () => {
    expect(ROLLBACK).toMatch(/drop trigger if exists sittings_sync_cycle_sitting on public\.sittings/);
    for (const fn of ["trg_sittings_sync_cycle_sitting", "sync_cycle_sitting", "derive_cycle_sitting", "sitting_period_of"]) {
      expect(ROLLBACK).toMatch(new RegExp(`drop function if exists app\\.${fn}\\(`));
    }
    expect(ROLLBACK).toMatch(/alter table public\.test_centres drop column if exists is_synthetic/);
  });

  it("restores create_cycle_with_assessments to the exact 0031 body", () => {
    expect(createRpc(ROLLBACK)).toBe(createRpc(M0031));
  });
});
