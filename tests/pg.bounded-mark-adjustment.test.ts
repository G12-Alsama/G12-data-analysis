/**
 * OPT-IN: runs the real SQL of migration 0052 on a throwaway LOCAL PostgreSQL.
 * Skipped unless G12_TEST_PG_ADMIN_URL points at a local server (see
 * tests/helpers/scratch-pg.ts — it refuses non-local hosts and only touches its own
 * scratch database).
 *
 *   G12_TEST_PG_ADMIN_URL='postgresql://postgres@/postgres?host=/var/tmp/g12-pg' npx vitest run tests/pg.bounded-mark-adjustment.test.ts
 *
 * Proves, against the real functions:
 *   1. BEFORE 0052 the stale-base defect stores a wrong delta on a re-adjustment;
 *   2. AFTER 0052 the base is derived live (re-adjusting never compounds, no
 *      participant_scores snapshot is needed);
 *   3. the ±5 cap is enforced by adjust_participant_mark_bounded and NOT by
 *      adjust_participant_mark; the 0..max range is enforced by both;
 *   4. the engine's other inputs (incident alterations, item exclusions, cohort
 *      exclusions, essay subjects) are honoured by the base/max;
 *   5. permission, undo and audit behave.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PG_AVAILABLE, createScratchDb, type ScratchDb } from "@/tests/helpers/scratch-pg";

const ADMIN = "99999999-0000-0000-0000-000000000001";
const NOPE = "99999999-0000-0000-0000-000000000002"; // a member WITHOUT grades.adjust

/** Seeds one sitting: a maths subject with 10 one-mark items and four students scoring 4 / 7 / 10 / 0. */
const SEED = (tag: string, subject = "G12++ Applicable Maths") => `
  select set_config('request.jwt.claim.sub','${ADMIN}', false);
  insert into auth.users (id, email) values ('${NOPE}', 'nope@example.test') on conflict do nothing;
  insert into test_centres (name, code, slug) values ('Test Centre', 'TC1', 'tc1') on conflict do nothing;
  insert into exam_years (name, region, test_centre_id, created_by)
    select '${tag}', 'eu-west', id, '${ADMIN}' from test_centres where code = 'TC1';
  insert into exam_cycles (name, region, created_by, year_id, sitting)
    select '${tag}', 'eu-west', '${ADMIN}', y.id, 'may' from exam_years y where y.name = '${tag}' returning id as cyc \\gset
  insert into assessments (cycle_id, name, item_count) values (:'cyc', '${subject}', 10) returning id as asm \\gset
  insert into items (cycle_id, assessment_id, qm_question_id, max_score)
    select :'cyc', :'asm', '${tag}-q' || n, 1 from generate_series(1, 10) n;
  insert into participants (cycle_id, qm_participant_id, pseudonym_id, full_name, email)
    select :'cyc', '${tag}-' || l || '@x', 'ps-${tag}-' || l, 'Student ' || l, '${tag}-' || l || '@x' from unnest(array['a','b','c','d']) l;
  insert into sittings (cycle_id, qm_result_id, participant_email, participant_id, assessment_id)
    select :'cyc', 'r-' || p.qm_participant_id, p.email, p.id, :'asm' from participants p where p.cycle_id = :'cyc';
  insert into responses (cycle_id, qm_result_id, question_id, participant_email, participant_id, item_id, answer_score)
    select :'cyc', 'r-' || p.qm_participant_id, i.qm_question_id, p.email, p.id, i.id,
           case when substring(p.qm_participant_id from '-(.)@') = 'a' and i.qm_question_id ~ '-q([1-4])$' then 1
                when substring(p.qm_participant_id from '-(.)@') = 'b' and i.qm_question_id ~ '-q([1-7])$' then 1
                when substring(p.qm_participant_id from '-(.)@') = 'c' then 1 else 0 end
      from participants p cross join items i where p.cycle_id = :'cyc' and i.cycle_id = :'cyc';
  insert into memberships (user_id, cycle_id, role_id) select '${ADMIN}', null, id from roles where is_system limit 1
    on conflict do nothing;
`;
const who = (tag: string, l: string) => `(select id from participants where qm_participant_id = '${tag}-${l}@x')`;
const cyc = (tag: string) => `(select id from exam_cycles where name = '${tag}')`;
const asm = (tag: string) => `(select id from assessments where cycle_id = ${cyc(tag)})`;
const as = (uid: string) => `select set_config('request.jwt.claim.sub','${uid}', false);`;

describe.skipIf(!PG_AVAILABLE)("0052 bounded mark adjustment on a real Postgres (opt-in)", () => {
  let db: ScratchDb;
  const marks = (tag: string, l: string): number[] =>
    db.run(`select marks from alterations where incident_id is null and participant_id = ${who(tag, l)} order by decided_at;`)
      .split("\n").filter(Boolean).map(Number);
  const fails = (sql: string): string => {
    try { db.run(sql); } catch (e) { return (e as Error).message; }
    return "";
  };
  const adjust = (tag: string, l: string, mark: number, fn = "adjust_participant_mark", reason = "r") =>
    `${as(ADMIN)} select public.${fn}(${cyc(tag)}, ${who(tag, l)}, ${asm(tag)}, ${mark}, '${reason}');`;

  beforeAll(() => { db = createScratchDb("0051"); }, 240_000);
  afterAll(() => db?.dispose());

  describe("BEFORE 0052 — the stale-base defect", () => {
    it("a stored participant_scores snapshot that does not yet include the first nudge makes the second delta wrong", () => {
      db.run(SEED("old"));
      // The last /recompute ran before any nudge: the snapshot says raw = 4 for student a.
      db.run(`
        insert into score_runs (cycle_id, assessment_id, engine_version) values (${cyc("old")}, ${asm("old")}, 'test') returning id as run \\gset
        insert into participant_scores (score_run_id, participant_id, assessment_id, raw, pct, items_seen)
          values (:'run', ${who("old", "a")}, ${asm("old")}, 4, 40, 10);
      `);
      db.run(adjust("old", "a", 6)); // +2 (correct: base 4)
      expect(marks("old", "a")).toEqual([2]);
      db.run(adjust("old", "a", 7)); // correct delta is +3 against base 4
      expect(marks("old", "a")).toEqual([5]); // BUG: 7 − (4 − 2) = 5
    });
  });

  describe("AFTER 0052", () => {
    beforeAll(() => {
      db.apply("0052_bounded_mark_adjustment.sql");
      db.run(SEED("new"));
    });

    it("re-adjusting a cell twice stores the correct delta — no compounding, and no snapshot required", () => {
      // NOTE: no score_runs / participant_scores exist for this sitting at all.
      db.run(adjust("new", "a", 6));
      expect(marks("new", "a")).toEqual([2]);
      db.run(adjust("new", "a", 7));
      expect(marks("new", "a")).toEqual([3]); // 7 − base 4, superseding the first row
      db.run(adjust("new", "a", 3));
      expect(marks("new", "a")).toEqual([-1]);
    });

    it("adjusting back to the base removes the manual row (delta 0 stores nothing)", () => {
      db.run(adjust("new", "a", 4));
      expect(marks("new", "a")).toEqual([]);
    });

    it("Undo (remove_mark_adjustment) reverts to the original base for the next adjustment", () => {
      db.run(adjust("new", "b", 9));
      expect(marks("new", "b")).toEqual([2]);
      db.run(`${as(ADMIN)} select public.remove_mark_adjustment(${cyc("new")}, ${who("new", "b")}, ${asm("new")});`);
      expect(marks("new", "b")).toEqual([]);
      db.run(adjust("new", "b", 8, "adjust_participant_mark_bounded")); // base is 7 again, not 7+2
      expect(marks("new", "b")).toEqual([1]);
    });

    it("works on decimals", () => {
      db.run(adjust("new", "b", 8.5, "adjust_participant_mark_bounded"));
      expect(marks("new", "b")).toEqual([1.5]);
    });

    describe("the ±5 cap", () => {
      it("adjust_participant_mark_bounded accepts exactly ±5 from the base and refuses more", () => {
        db.run(adjust("new", "a", 9, "adjust_participant_mark_bounded")); // +5
        expect(marks("new", "a")).toEqual([5]);
        db.run(adjust("new", "b", 2, "adjust_participant_mark_bounded")); // −5 from 7
        expect(marks("new", "b")).toEqual([-5]);
        expect(fails(adjust("new", "a", 9.5, "adjust_participant_mark_bounded"))).toMatch(/exceeds the allowed \+\/-5 marks/);
        expect(fails(adjust("new", "b", 1.5, "adjust_participant_mark_bounded"))).toMatch(/exceeds the allowed \+\/-5 marks/);
        // a refused call changes nothing
        expect(marks("new", "a")).toEqual([5]);
      });

      it("the cap is measured from the BASE, so re-adjusting cannot ratchet past ±5 in steps", () => {
        db.run(adjust("new", "a", 7, "adjust_participant_mark_bounded")); // +3
        db.run(adjust("new", "a", 9, "adjust_participant_mark_bounded")); // +5 from base, not +2 from 7
        expect(fails(adjust("new", "a", 10, "adjust_participant_mark_bounded"))).toMatch(/exceeds/);
        expect(marks("new", "a")).toEqual([5]);
      });

      it("adjust_participant_mark (Grades view) is NOT capped", () => {
        db.run(adjust("new", "a", 10)); // +6
        expect(marks("new", "a")).toEqual([6]);
        db.run(adjust("new", "d", 10)); // +10 from 0
        expect(marks("new", "d")).toEqual([10]);
      });

      it("adds no constraint to alterations.marks (incident triage may exceed 5)", () => {
        db.run(`
          insert into incidents (cycle_id, source) values (${cyc("new")}, 'incident_log') returning id as inc \\gset
          insert into alterations (cycle_id, incident_id, apply_to, participant_id, assessment_id, marks, reason)
            values (${cyc("new")}, :'inc', 'student', ${who("new", "c")}, ${asm("new")}, -8, 'triage');
        `);
        expect(db.run(`select marks from alterations where reason = 'triage';`).trim()).toBe("-8");
      });
    });

    describe("the 0 <= mark <= max range (both RPCs)", () => {
      it("refuses a mark below 0 or above the subject max", () => {
        for (const fn of ["adjust_participant_mark", "adjust_participant_mark_bounded"]) {
          expect(fails(adjust("new", "c", 10.5, fn))).toMatch(/outside the valid range 0 to 10/);
          expect(fails(adjust("new", "d", -1, fn))).toMatch(/outside the valid range 0 to 10/);
        }
      });
      it("accepts the boundaries 0 and max", () => {
        db.run(adjust("new", "c", 10.0 - 0, "adjust_participant_mark")); // delta 0 → no row, but valid
        db.run(adjust("new", "a", 0)); // 0 is valid (uncapped path)
        expect(marks("new", "a")).toEqual([-4]);
      });
      it("the max follows retained items (an excluded item lowers it) — nothing is hard-coded", () => {
        db.run(SEED("exc"));
        db.run(`update items set status = 'excluded' where qm_question_id in ('exc-q9','exc-q10');`); // max 10 → 8
        expect(fails(adjust("exc", "c", 9))).toMatch(/outside the valid range 0 to 8/);
        // c scored 8 on the retained items; an excluded item's mark is not part of the base
        db.run(adjust("exc", "a", 6)); // a: 4 → +2
        expect(marks("exc", "a")).toEqual([2]);
      });
    });

    describe("the base mirrors the engine's inputs", () => {
      it("includes INCIDENT alterations (student and whole-subject) but not manual ones", () => {
        db.run(SEED("inc"));
        db.run(`
          insert into incidents (cycle_id, source) values (${cyc("inc")}, 'incident_log') returning id as i1 \\gset
          insert into incidents (cycle_id, source) values (${cyc("inc")}, 'incident_log') returning id as i2 \\gset
          insert into alterations (cycle_id, incident_id, apply_to, participant_id, assessment_id, marks, reason)
            values (${cyc("inc")}, :'i1', 'student', ${who("inc", "a")}, ${asm("inc")}, 1, 'tech');
          insert into alterations (cycle_id, incident_id, apply_to, participant_id, assessment_id, marks, reason)
            values (${cyc("inc")}, :'i2', 'subject', null, ${asm("inc")}, 2, 'whole subject');
        `);
        // a: mcq 4 + 1 (student) + 2 (subject) = 7 → asking for 9 is +2
        db.run(adjust("inc", "a", 9));
        expect(marks("inc", "a")).toEqual([2]);
        // and again — the manual row is excluded from the base, so it does not compound
        db.run(adjust("inc", "a", 9));
        expect(marks("inc", "a")).toEqual([2]);
      });

      it("adds the essay mark for an essay subject, and the reserved essay max to the range", () => {
        db.run(SEED("essay", "G12++ English 1st Lang"));
        db.run(`insert into essay_marks (cycle_id, participant_id, assessment_id, mark)
                  values (${cyc("essay")}, ${who("essay", "a")}, ${asm("essay")}, 15);`);
        // a: mcq 4 + essay 15 = 19; max = 10 + 20 = 30
        db.run(adjust("essay", "a", 24, "adjust_participant_mark_bounded")); // +5
        expect(marks("essay", "a")).toEqual([5]);
        expect(fails(adjust("essay", "a", 25, "adjust_participant_mark_bounded"))).toMatch(/exceeds/);
        expect(fails(adjust("essay", "c", 31))).toMatch(/outside the valid range 0 to 30/);
      });

      it("recognises the Arabic-script subject name as an essay subject", () => {
        db.run(SEED("arab", "G12++ اللغة العربية"));
        expect(fails(adjust("arab", "c", 31))).toMatch(/0 to 30/);
      });

      it("refuses a participant the engine would not score (cohort-excluded)", () => {
        db.run(SEED("coh"));
        db.run(`insert into cohort_exclusions (cycle_id, participant_key) values (${cyc("coh")}, 'coh-a@x');`);
        expect(fails(adjust("coh", "a", 5))).toMatch(/no score in this subject/);
        db.run(adjust("coh", "b", 8));
        expect(marks("coh", "b")).toEqual([1]);
      });

      it("refuses a participant removed from THIS subject at Clean (row exclusion)", () => {
        db.run(SEED("cln"));
        db.run(`insert into clean_exclusions (cycle_id, assessment_id, kind, target_id, target_key, decided_by)
                  values (${cyc("cln")}, ${asm("cln")}, 'row', ${who("cln", "a")}, 'cln-a@x', '${ADMIN}');`);
        expect(fails(adjust("cln", "a", 5))).toMatch(/no score in this subject/);
      });
    });

    describe("permission, audit and privileges", () => {
      it("both RPCs refuse a member without grades.adjust", () => {
        db.run(`
          insert into roles (name, is_system, sort) values ('Read only', false, 99);
          insert into memberships (user_id, cycle_id, role_id) select '${NOPE}', null, id from roles where name = 'Read only';
        `);
        for (const fn of ["adjust_participant_mark", "adjust_participant_mark_bounded"]) {
          const sql = `${as(NOPE)} select public.${fn}(${cyc("new")}, ${who("new", "c")}, ${asm("new")}, 9, 'x');`;
          expect(fails(sql)).toMatch(/not authorized/);
        }
      });

      it("requires a reason", () => {
        expect(fails(adjust("new", "c", 9, "adjust_participant_mark_bounded", "   "))).toMatch(/reason is required/);
      });

      it("audits an adjustment with its base, new mark, delta and reason", () => {
        db.run(adjust("new", "b", 8, "adjust_participant_mark_bounded", "audited reason")); // b: base 7
        const row = db.run(`select action || '|' || (before->>'mark') || '|' || (after->>'mark') || '|' || (after->>'delta') || '|' || (after->>'reason')
                              from audit_log where action = 'adjust_mark' and after->>'reason' = 'audited reason';`).trim();
        expect(row).toBe("adjust_mark|7|8|1|audited reason");
      });

      it("grants the bounded RPC to signed-in users only, and keeps the private helpers out of API roles' reach", () => {
        const can = (role: string, fn: string) =>
          db.run(`select has_function_privilege('${role}', '${fn}', 'execute');`).trim() === "t";
        const bounded = "public.adjust_participant_mark_bounded(uuid,uuid,uuid,numeric,text)";
        expect(can("authenticated", bounded)).toBe(true);
        expect(can("anon", bounded)).toBe(false);
        for (const fn of [
          "app.adjust_participant_mark_core(uuid,uuid,uuid,numeric,text,numeric)",
          "app.subject_mark_inputs(uuid,uuid,uuid)",
          "app.excluded_participants(uuid,uuid)",
        ]) {
          expect(can("authenticated", fn), fn).toBe(false);
          expect(can("anon", fn), fn).toBe(false);
        }
        // the unchanged public RPC keeps its 0008 grant
        expect(can("authenticated", "public.adjust_participant_mark(uuid,uuid,uuid,numeric,text)")).toBe(true);
      });
    });

    it("the rollback restores the 0041 behaviour and removes everything 0052 added", () => {
      db.applyFile(new URL("../supabase/migrations/0052_bounded_mark_adjustment.rollback.sql", `file://${__dirname}/`).pathname);
      const left = db.run(`select count(*) from pg_proc where proname in
        ('adjust_participant_mark_bounded','adjust_participant_mark_core','subject_mark_inputs','excluded_participants');`).trim();
      expect(left).toBe("0");
      // adjust_participant_mark is back and works (stale-base body)
      db.run(SEED("rb"));
      db.run(adjust("rb", "a", 6));
      expect(marks("rb", "a")).toEqual([6]); // no snapshot → base 0, the old behaviour
      // and re-applying 0052 is clean
      db.apply("0052_bounded_mark_adjustment.sql");
    });
  });
});
