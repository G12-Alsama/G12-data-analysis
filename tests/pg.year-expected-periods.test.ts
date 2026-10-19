/**
 * OPT-IN: migration 0051 on a throwaway LOCAL PostgreSQL (see tests/helpers/scratch-pg.ts;
 * skipped unless G12_TEST_PG_ADMIN_URL is set):
 *   existing years get {february,may} (behaviour unchanged) → the setter gates, validates,
 *   de-duplicates, audits and is idempotent → rollback.
 *
 *   G12_TEST_PG_ADMIN_URL='postgresql://postgres@/postgres?host=/var/tmp/g12-pg' npx vitest run tests/pg.year-expected-periods.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PG_AVAILABLE, createScratchDb, type ScratchDb } from "@/tests/helpers/scratch-pg";

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const USER = "99999999-0000-0000-0000-000000000001";

describe.skipIf(!PG_AVAILABLE)("0051 expected periods on a real Postgres (opt-in)", () => {
  let db: ScratchDb;
  const yr = (n: string) => `(select id from exam_years where name='${n}' and test_centre_id=(select id from test_centres where code='TC1'))`;
  const expected = (n: string) => db.run(`select expected_periods from exam_years where id = ${yr(n)};`).trim();

  beforeAll(() => {
    db = createScratchDb("0050");
    db.run(`
      insert into test_centres (name, code, slug) values ('Test Centre','TC1','tc1');
      insert into exam_years (name, region, test_centre_id, created_by)
        select y, 'eu-west', (select id from test_centres where code='TC1'), '${USER}' from unnest(array['2026','2027']) y;
    `);
    db.apply("0051_year_expected_periods.sql");
  }, 180_000);
  afterAll(() => db?.dispose());

  it("every existing year expects February + May (what the app required before)", () => {
    expect(expected("2026")).toBe("{february,may}");
    expect(db.run("select count(*) from exam_years where expected_periods <> '{february,may}';").trim()).toBe("0");
  });

  it("a new year gets the default too", () => {
    db.run(`insert into exam_years (name, region, test_centre_id, created_by)
            values ('2031','eu-west',(select id from test_centres where code='TC1'),'${USER}');`);
    expect(expected("2031")).toBe("{february,may}");
  });

  it("the column refuses an empty list", () => {
    expect(() => db.run(`update exam_years set expected_periods = '{}' where id = ${yr("2026")};`)).toThrow(/exam_years_expected_periods_nonempty/);
  });

  it("the setter refuses a caller without the gate", () => {
    // No signed-in user in this session → app.can_do is false.
    expect(() => db.run(`select set_year_expected_periods(${yr("2026")}, '{february}');`)).toThrow(/not authorized/);
    expect(expected("2026")).toBe("{february,may}");
  });

  it("an authorised admin can set, de-duplicate and re-set (idempotent), with an audit row", () => {
    // Make this session a workspace admin: workspace-scope membership with the seeded Admin role.
    db.run(`
      insert into auth.users (id) values ('${USER}') on conflict do nothing;
      insert into memberships (user_id, cycle_id, role, role_id)
        values ('${USER}', null, 'lead_admin', (select id from roles where name = 'Admin')) on conflict do nothing;
    `);
    const as = `select set_config('request.jwt.claim.sub','${USER}', false);`;
    db.run(`${as} select set_year_expected_periods(${yr("2027")}, '{may,february,may}');`);
    expect(expected("2027")).toBe("{february,may}");
    db.run(`${as} select set_year_expected_periods(${yr("2027")}, '{may}');`);
    expect(expected("2027")).toBe("{may}");
    const audits = () => Number(db.run("select count(*) from audit_log where action = 'set_expected_periods';").trim());
    const n = audits();
    db.run(`${as} select set_year_expected_periods(${yr("2027")}, '{may}');`); // unchanged → no audit row
    expect(audits()).toBe(n);
    expect(() => db.run(`${as} select set_year_expected_periods(${yr("2027")}, '{}');`)).toThrow(/at least one period/);
  });

  it("rollback removes the column and the function", () => {
    db.applyFile(path.join(MIGRATIONS, "0051_year_expected_periods.rollback.sql"));
    expect(db.run("select count(*) from information_schema.columns where table_name='exam_years' and column_name='expected_periods';").trim()).toBe("0");
    expect(db.run("select count(*) from pg_proc where proname='set_year_expected_periods';").trim()).toBe("0");
    // and it re-applies cleanly
    db.apply("0051_year_expected_periods.sql");
    expect(expected("2026")).toBe("{february,may}");
  });
});
