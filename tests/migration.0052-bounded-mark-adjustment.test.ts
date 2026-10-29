/**
 * Migration 0052_bounded_mark_adjustment.sql — structural safety guard.
 *
 * Locks the contract the Score page relies on: one shared core with an optional cap;
 * the uncapped public RPC unchanged in behaviour; the new bounded RPC capped at 5; the
 * base derived LIVE (never from the stale participant_scores snapshot); the 0..max
 * range enforced server-side; no table-level cap on the shared `alterations` table;
 * remove_mark_adjustment untouched; and the private helpers kept out of API roles'
 * reach. (The behaviour itself is exercised on a real Postgres in
 * tests/pg.bounded-mark-adjustment.test.ts, opt-in.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ESSAY_MAX_RESERVED } from "@/lib/data/essays";

const SQL = readFileSync(resolve(__dirname, "../supabase/migrations/0052_bounded_mark_adjustment.sql"), "utf8");
const ROLLBACK = readFileSync(resolve(__dirname, "../supabase/migrations/0052_bounded_mark_adjustment.rollback.sql"), "utf8");

/** The body of `create or replace function <name>` up to its closing `$$;` (comments kept). */
function fnBody(sql: string, name: string): string {
  const start = sql.search(new RegExp(`create or replace function ${name.replace(/\./g, "\\.")}\\b`, "i"));
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = sql.indexOf("$$;", sql.indexOf("$$", start) + 2);
  return sql.slice(start, end);
}
/** SQL with `--` comments stripped, so a comment mentioning a table can't satisfy/violate a check. */
const code = (s: string) => s.replace(/--[^\n]*/g, "");

describe("0052 — shared core", () => {
  const core = code(fnBody(SQL, "app.adjust_participant_mark_core"));

  it("takes an optional cap (default null) and refuses a delta beyond it", () => {
    expect(core).toMatch(/p_max_delta numeric default null/i);
    expect(core).toMatch(/p_max_delta is not null and abs\(v_delta\) > p_max_delta/i);
  });

  it("is itself gated on grades.adjust and needs a signed-in actor and a reason", () => {
    expect(core).toMatch(/app\.can_do\(p_cycle, 'grades\.adjust'\)/);
    expect(core).toMatch(/auth\.uid\(\)/);
    expect(core).toMatch(/a reason is required/);
  });

  it("derives the base LIVE from app.subject_mark_inputs — never from participant_scores / score_runs", () => {
    expect(core).toMatch(/app\.subject_mark_inputs\(/);
    expect(core).not.toMatch(/participant_scores/i);
    expect(core).not.toMatch(/score_runs/i);
  });

  it("enforces 0 <= new mark <= subject max server-side, against the derived max", () => {
    expect(core).toMatch(/p_new_mark < 0 or p_new_mark > v_max/);
    expect(core).toMatch(/v_max/);
    expect(core).not.toMatch(/> 40\b|> 50\b|> 100\b/); // no hard-coded subject max
  });

  it("supersedes the cell's manual row (incident_id is null) and writes the delta + audit", () => {
    expect(core).toMatch(/delete from alterations[\s\S]*incident_id is null/i);
    expect(core).toMatch(/insert into alterations/i);
    expect(core).toMatch(/app\.audit\(/);
  });
});

describe("0052 — live base mirrors the engine inputs (lib/server/engine-write.ts)", () => {
  const inputs = code(fnBody(SQL, "app.subject_mark_inputs"));
  const excluded = code(fnBody(SQL, "app.excluded_participants"));

  it("sums MCQ over retained items, essay for essay subjects, and INCIDENT alterations only", () => {
    expect(inputs).toMatch(/from responses r[\s\S]*i\.status <> 'excluded'/i);
    expect(inputs).toMatch(/from essay_marks/i);
    expect(inputs).toMatch(/al\.incident_id is not null/i);
    expect(inputs).toMatch(/al\.apply_to <> 'none'/i);
    expect(inputs).toMatch(/al\.apply_to = 'subject' or al\.participant_id = p_participant/i);
  });

  it("never reads the stale participant_scores snapshot", () => {
    expect(inputs).not.toMatch(/participant_scores/i);
    expect(inputs).not.toMatch(/score_runs/i);
  });

  it("honours cohort and Clean-row exclusions the way engine-write does", () => {
    expect(excluded).toMatch(/cohort_exclusions/);
    expect(excluded).toMatch(/clean_exclusions/);
    expect(excluded).toMatch(/kind = 'row'/);
    expect(excluded).toMatch(/target_key/);
  });

  it("detects essay subjects script-aware (Latin name or Arabic block) or by an item beyond max 1", () => {
    expect(inputs).toMatch(/max_score > 1/);
    expect(inputs).toMatch(/arabic\|english/);
    expect(inputs).toMatch(/chr\(1536\)[\s\S]*chr\(1791\)/);
  });

  it("the reserved essay max equals lib/data/essays ESSAY_MAX_RESERVED (what engine-write passes the engine)", () => {
    const m = /c_essay_max constant numeric := (\d+)/.exec(inputs);
    expect(m, "c_essay_max not found").not.toBeNull();
    expect(Number(m![1])).toBe(ESSAY_MAX_RESERVED);
  });
});

describe("0052 — public RPCs", () => {
  const plain = code(fnBody(SQL, "public.adjust_participant_mark"));
  const bounded = code(fnBody(SQL, "public.adjust_participant_mark_bounded"));

  it("adjust_participant_mark keeps its signature and calls the core UNCAPPED (null)", () => {
    expect(plain).toMatch(/adjust_participant_mark\(\s*p_cycle uuid, p_participant uuid, p_assessment uuid,\s*p_new_mark numeric, p_reason text\)/);
    expect(plain).toMatch(/app\.adjust_participant_mark_core\([^)]*,\s*null\)/);
    expect(plain).not.toMatch(/,\s*5\)/);
  });

  it("adjust_participant_mark_bounded calls the core with a cap of exactly 5", () => {
    expect(bounded).toMatch(/app\.adjust_participant_mark_core\([^)]*,\s*5\)/);
  });

  it("both are gated on grades.adjust and return the adjustment id", () => {
    for (const body of [plain, bounded]) {
      expect(body).toMatch(/app\.can_do\(p_cycle, 'grades\.adjust'\)/);
      expect(body).toMatch(/returns uuid/i);
      expect(body).toMatch(/security definer/i);
    }
  });
});

describe("0052 — what it must NOT do", () => {
  it("adds no table-level cap on alterations.marks (shared with incident triage)", () => {
    const c = code(SQL);
    expect(c).not.toMatch(/alter table[^;]*alterations/i);
    expect(c).not.toMatch(/\bcheck\s*\(/i);
    expect(c).not.toMatch(/add constraint/i);
  });

  it("does not redefine remove_mark_adjustment (any grades.adjust holder may undo — deliberate)", () => {
    expect(SQL).not.toMatch(/function public\.remove_mark_adjustment/i);
  });

  it("touches no engine/scoring table", () => {
    const c = code(SQL);
    expect(c).not.toMatch(/(insert into|update|delete from)\s+(participant_scores|score_runs|item_stats|grades)\b/i);
  });
});

describe("0052 — privileges", () => {
  it("keeps the private helpers away from every API role", () => {
    for (const fn of [
      "app.excluded_participants\\(uuid, uuid\\)",
      "app.subject_mark_inputs\\(uuid, uuid, uuid\\)",
      "app.adjust_participant_mark_core\\(uuid, uuid, uuid, numeric, text, numeric\\)",
    ]) {
      expect(SQL).toMatch(new RegExp(`revoke all on function ${fn} from public, anon, authenticated`));
    }
  });

  it("grants the bounded RPC to signed-in users only", () => {
    const sig = "public\\.adjust_participant_mark_bounded\\(uuid, uuid, uuid, numeric, text\\)";
    expect(SQL).toMatch(new RegExp(`revoke all\\s+on function ${sig} from public, anon`));
    expect(SQL).toMatch(new RegExp(`grant\\s+execute on function ${sig} to authenticated`));
  });

  it("runs in one transaction", () => {
    expect(SQL).toMatch(/^begin;/m);
    expect(SQL).toMatch(/^commit;/m);
  });
});

describe("0052 rollback", () => {
  it("drops the bounded RPC and the private helpers", () => {
    expect(ROLLBACK).toMatch(/drop function if exists public\.adjust_participant_mark_bounded\(uuid, uuid, uuid, numeric, text\)/);
    expect(ROLLBACK).toMatch(/drop function if exists app\.adjust_participant_mark_core\(/);
    expect(ROLLBACK).toMatch(/drop function if exists app\.subject_mark_inputs\(/);
    expect(ROLLBACK).toMatch(/drop function if exists app\.excluded_participants\(/);
  });

  it("restores adjust_participant_mark to its self-contained 0041 body (no reference to the dropped core)", () => {
    const body = fnBody(ROLLBACK, "public.adjust_participant_mark");
    expect(body).toMatch(/app\.can_do\(p_cycle, 'grades\.adjust'\)/);
    expect(body).toMatch(/participant_scores/);
    expect(body).not.toMatch(/adjust_participant_mark_core/);
    // the function is recreated BEFORE the core it used to call is dropped
    expect(ROLLBACK.indexOf("create or replace function public.adjust_participant_mark(")).toBeLessThan(
      ROLLBACK.indexOf("drop function if exists app.adjust_participant_mark_core"),
    );
  });
});
