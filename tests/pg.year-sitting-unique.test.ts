/**
 * OPT-IN: replays the 0050 runbook on a throwaway LOCAL PostgreSQL (see
 * tests/helpers/scratch-pg.ts; skipped unless G12_TEST_PG_ADMIN_URL is set):
 *   diagnose → draft refuses & changes nothing → resolve by hand → draft applies →
 *   database enforces one sitting per (year, period) → rollback.
 *
 *   G12_TEST_PG_ADMIN_URL='postgresql://postgres@/postgres?host=/var/tmp/g12-pg' npx vitest run tests/pg.year-sitting-unique.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PG_AVAILABLE, createScratchDb, type ScratchDb } from "@/tests/helpers/scratch-pg";

const DRAFTS = path.resolve(__dirname, "../supabase/drafts");
const USER = "99999999-0000-0000-0000-000000000001";

/** The pre-flight file split into its statements (comments stripped; the only `;`
 *  followed by a newline are statement ends). */
const PREFLIGHT = readFileSync(path.join(DRAFTS, "0050_year_sitting_preflight.sql"), "utf8")
  .replace(/--[^\n]*/g, "")
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean);
const [Q_OVERVIEW, Q_DUPES, Q_MISMATCH, Q_NULLS] = PREFLIGHT as [string, string, string, string];

const lines = (out: string) => out.split("\n").filter(Boolean);

const MESSY = `
  select set_config('request.jwt.claim.sub','${USER}', false);
  insert into test_centres (name, code, slug) values ('Test Centre','TC1','tc1');
  insert into exam_years (name, region, test_centre_id, created_by)
    select y, 'eu-west', (select id from test_centres where code='TC1'), '${USER}'
      from unnest(array['2026','2027','2028','2029','2030']) y;
  create function pg_temp.yr(n text) returns uuid language sql as
    $$ select id from exam_years where name = n and test_centre_id = (select id from test_centres where code='TC1') $$;
  insert into exam_cycles (name, region, created_by, year_id, sitting) values
    ('February 2026',        'eu-west','${USER}', pg_temp.yr('2026'),'may'),
    ('Feb 2027 sitting',     'eu-west','${USER}', pg_temp.yr('2027'),'may'),
    ('May 2027',             'eu-west','${USER}', pg_temp.yr('2027'),'may'),
    ('May 2028',             'eu-west','${USER}', pg_temp.yr('2028'),'may'),
    ('May 2028 (copy)',      'eu-west','${USER}', pg_temp.yr('2028'),'may'),
    ('February 2029 A',      'eu-west','${USER}', pg_temp.yr('2029'),'may'),
    ('February 2029 B',      'eu-west','${USER}', pg_temp.yr('2029'),'may'),
    ('Marketing batch 2030', 'eu-west','${USER}', pg_temp.yr('2030'),'may');
  select create_cycle('Legacy no-year cycle');
`;

describe.skipIf(!PG_AVAILABLE)("0050 runbook on a real Postgres (opt-in)", () => {
  let db: ScratchDb;
  const period = (name: string) => db.run(`select sitting from exam_cycles where name = '${name}';`).trim();

  beforeAll(() => {
    db = createScratchDb("0049");
    db.run(MESSY);
  }, 180_000);
  afterAll(() => db?.dispose());

  it("the pre-flight finds the duplicates, the mismatches and the year-less cycle", () => {
    expect(lines(db.run(Q_OVERVIEW))[0]).toMatch(/\|1\|1$/); // 1 without year, 1 without period

    const dupes = lines(db.run(`select cycle_name from (${Q_DUPES}) d order by 1;`));
    expect(dupes).toEqual([
      "February 2029 A", "February 2029 B", "Feb 2027 sitting", "May 2027", "May 2028", "May 2028 (copy)",
    ].sort());

    const mismatch = lines(db.run(`select cycle_name || '|' || name_says || '|' || coalesce(suggested_fix is not null, false) from (${Q_MISMATCH}) m order by 1;`));
    expect(mismatch).toEqual([
      "Feb 2027 sitting|february|true",
      "February 2026|february|true",
      "February 2029 A|february|true",
      "February 2029 B|february|true",
      "Marketing batch 2030|february (weak)|false", // weak name match: never a suggested fix
    ]);

    expect(lines(db.run(`select cycle_name from (${Q_NULLS}) n;`))).toEqual(["Legacy no-year cycle"]);
  });

  it("the pre-flight changed nothing", () => {
    expect(period("February 2026")).toBe("may");
  });

  it("the draft REFUSES on the messy data and leaves everything unchanged (backfill rolled back too)", () => {
    expect(() => db.applyFile(path.join(DRAFTS, "0050_year_sitting_unique.sql"))).toThrow(/0050: cycles with no year or no period/);
    expect(period("February 2026")).toBe("may"); // the backfill ran, then the guard rolled it back
    expect(db.run(`select is_nullable from information_schema.columns where table_name='exam_cycles' and column_name='sitting';`).trim()).toBe("YES");
  });

  it("still refuses on duplicates once the year-less cycle is gone", () => {
    db.run(`delete from exam_cycles where name = 'Legacy no-year cycle';`);
    expect(() => db.applyFile(path.join(DRAFTS, "0050_year_sitting_unique.sql"))).toThrow(/several sittings share a \(year, period\)/);
  });

  it("after the duplicates are resolved by hand, it applies — fixing ONLY the unambiguous rows, with audit rows", () => {
    db.run(`
      delete from exam_cycles where name in ('May 2028 (copy)', 'February 2029 B');
      update exam_cycles set sitting = 'february' where name = 'February 2029 A';
    `);
    db.run(`select set_config('request.jwt.claim.sub','${USER}', false);\n` + readFileSync(path.join(DRAFTS, "0050_year_sitting_unique.sql"), "utf8"));

    expect(period("February 2026")).toBe("february");   // backfilled
    expect(period("Feb 2027 sitting")).toBe("february"); // backfilled (its year has a real May)
    expect(period("May 2027")).toBe("may");              // untouched
    expect(period("Marketing batch 2030")).toBe("may");  // weak name match: never auto-fixed
    expect(db.run(`select count(*) from audit_log where action = 'sitting_period_corrected';`).trim()).toBe("2");
  });

  it("the database now enforces one sitting per (year, period) and requires both columns", () => {
    const dup = `insert into exam_cycles (name, region, created_by, year_id, sitting)
                 select 'May 2027 again', 'eu-west', '${USER}', year_id, 'may' from exam_cycles where name = 'May 2027';`;
    expect(() => db.run(dup)).toThrow(/exam_cycles_year_sitting_key/);
    // the real create RPC hits the same constraint (what friendlyCreateCycleError maps)
    expect(() => db.run(`
      select set_config('request.jwt.claim.sub','${USER}', false);
      select year_id as yid from exam_cycles where name = 'May 2027' \\gset
      select create_cycle_with_assessments('Another May','eu-west','[]'::jsonb,:'yid','may');
    `)).toThrow(/exam_cycles_year_sitting_key/);
    expect(db.run(`select string_agg(is_nullable, ',') from information_schema.columns where table_name='exam_cycles' and column_name in ('year_id','sitting');`).trim()).toBe("NO,NO");
  });

  it("the legacy year-less create_cycle RPC is no longer callable by signed-in users", () => {
    expect(db.run(`select has_function_privilege('authenticated','public.create_cycle(text,text)','execute');`).trim()).toBe("f");
  });

  it("is idempotent", () => {
    expect(() => db.applyFile(path.join(DRAFTS, "0050_year_sitting_unique.sql"))).not.toThrow();
  });

  it("the rollback restores the constraint-free state but keeps the corrected periods", () => {
    db.applyFile(path.join(DRAFTS, "0050_year_sitting_unique.rollback.sql"));
    expect(db.run(`select count(*) from pg_constraint where conname = 'exam_cycles_year_sitting_key';`).trim()).toBe("0");
    expect(db.run(`select string_agg(is_nullable, ',') from information_schema.columns where table_name='exam_cycles' and column_name in ('year_id','sitting');`).trim()).toBe("YES,YES");
    expect(db.run(`select has_function_privilege('authenticated','public.create_cycle(text,text)','execute');`).trim()).toBe("t");
    expect(period("February 2026")).toBe("february");
  });
});
