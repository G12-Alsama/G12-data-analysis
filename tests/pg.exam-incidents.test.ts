/**
 * OPT-IN: runs the real SQL of migration 0049 on a throwaway LOCAL PostgreSQL.
 * Skipped unless G12_TEST_PG_ADMIN_URL points at a local server (see
 * tests/helpers/scratch-pg.ts — it refuses non-local hosts and only touches its own
 * scratch database).
 *
 *   G12_TEST_PG_ADMIN_URL='postgresql://postgres@/postgres?host=/var/tmp/g12-pg' npx vitest run tests/pg.exam-incidents.test.ts
 *
 * Proves the data-loss bug on the pre-0049 schema, then that 0049 fixes it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PG_AVAILABLE, createScratchDb, type ScratchDb } from "@/tests/helpers/scratch-pg";

const USER = "99999999-0000-0000-0000-000000000001";

/** Create two sittings of one year, import the SAME two-incident file into each,
 *  return "<sitting>|<count>" lines. `tag` keeps cycle names unique per scenario. */
function importSameFileIntoTwoSittings(db: ScratchDb, tag: string): Record<string, number> {
  const out = db.run(`
    select set_config('request.jwt.claim.sub','${USER}', false);
    select create_cycle_with_assessments('${tag} February 2026','eu-west','[]'::jsonb,null,'february') as feb \\gset
    select create_cycle_with_assessments('${tag} May 2026','eu-west','[]'::jsonb,null,'may') as may \\gset
    \\set rows '[{"reference":"INC-1","exam_cycle":"2026","subject_raw":"Math","student_email":"A@x.org","match_status":"matched"},{"reference":"INC-2","exam_cycle":"2026","subject_raw":"Math","student_email":"b@x.org","match_status":"unmatched_email"}]'
    select upsert_exam_incidents(:'feb', gen_random_uuid(), 'incidents.csv', :'rows'::jsonb) \\gset
    select upsert_exam_incidents(:'may', gen_random_uuid(), 'incidents.csv', :'rows'::jsonb) \\gset
    select c.name || '|' || count(*) from exam_incidents i join exam_cycles c on c.id = i.cycle_id
     where c.name like '${tag} %' group by c.name order by c.name;
  `);
  const counts: Record<string, number> = {};
  for (const line of out.split("\n").filter((l) => l.includes("|"))) {
    const [name, n] = line.split("|");
    counts[name!.replace(`${tag} `, "")] = Number(n);
  }
  return counts;
}

describe.skipIf(!PG_AVAILABLE)("exam_incidents on a real Postgres (opt-in)", () => {
  let db: ScratchDb;
  beforeAll(() => { db = createScratchDb("0048"); }, 180_000);
  afterAll(() => db?.dispose());

  it("BEFORE 0049: the same file imported into a second sitting steals the first sitting's rows", () => {
    const counts = importSameFileIntoTwoSittings(db, "before");
    expect(counts["February 2026"]).toBeUndefined(); // February lost everything
    expect(counts["May 2026"]).toBe(2);
  });

  it("AFTER 0049: both sittings keep their own full set", () => {
    db.apply("0049_exam_incidents_per_cycle_reference.sql");
    const counts = importSameFileIntoTwoSittings(db, "after");
    expect(counts).toEqual({ "February 2026": 2, "May 2026": 2 });
  });

  it("AFTER 0049: a corrected re-upload updates that sitting in place and cannot touch the other", () => {
    db.run(`
      select set_config('request.jwt.claim.sub','${USER}', false);
      select id as feb from exam_cycles where name = 'after February 2026' \\gset
      select upsert_exam_incidents(:'feb', gen_random_uuid(), 'fixed.csv',
        '[{"reference":"INC-1","exam_cycle":"2026","subject_raw":"Math","student_email":"a@x.org","match_status":"matched","issue":"CORRECTED"}]'::jsonb) \\gset
    `);
    const rows = db.run(`
      select c.name || '|' || i.reference || '|' || coalesce(i.issue, '-')
        from exam_incidents i join exam_cycles c on c.id = i.cycle_id
       where c.name like 'after %' order by 1;
    `).split("\n").filter(Boolean);
    expect(rows).toEqual([
      "after February 2026|INC-1|CORRECTED",
      "after February 2026|INC-2|-",
      "after May 2026|INC-1|-",
      "after May 2026|INC-2|-",
    ]);
  });

  it("is idempotent and leaves exactly the per-sitting unique key", () => {
    db.apply("0049_exam_incidents_per_cycle_reference.sql");
    const keys = db.run(`
      select conname from pg_constraint where conrelid = 'public.exam_incidents'::regclass and contype = 'u';
    `).split("\n").filter(Boolean);
    expect(keys).toEqual(["exam_incidents_cycle_reference_key"]);
  });
});
