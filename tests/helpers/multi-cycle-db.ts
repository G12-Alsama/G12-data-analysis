/**
 * A tiny multi-sitting database in the row shapes the live hydrate path reads, for
 * tests that need SEVERAL real sittings with DIFFERENT data (the multi-sitting
 * provider tests).
 *
 * Each sitting gets its own assessment uuid (as in production — assessments are
 * per-cycle), 4 one-mark items, and per-student item scores, so the engine yields real,
 * different results per sitting. Students are identified across sittings by their
 * `qm_participant_id` (email), exactly like production.
 */
import type { MockDb } from "./mock-supabase-read";

export const CENTRE = "11111111-0000-0000-0000-000000000001";
export const YEAR = "yyyyyyyy-0000-0000-0000-000000002026";
export const USER = "99999999-0000-0000-0000-000000000001";

export interface SittingSpec {
  /** exam_cycles.id */
  id: string;
  name: string;
  /** Stored period. */
  sitting: "february" | "may";
  /** exam_cycles.status (default "in_review"). 'locked' = grades locked. */
  status?: string;
  /** created_at offset in minutes — larger = newer. */
  age?: number;
  /** email → the four item scores (0/1), e.g. [1, 1, 0, 1]. */
  students: Record<string, number[]>;
  /** Assessment name (default the maths subject). */
  subject?: string;
  /** Optional extra participant rows that sit nothing (e.g. staff). */
  staff?: string[];
}

const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (n: number) => new Date(T0 + n * 60_000).toISOString();
const nameOf = (email: string) => email.split("@")[0]!.replace(/\./g, " ");

export function buildDb(specs: SittingSpec[], extra: Partial<MockDb> = {}): MockDb {
  const db: MockDb = {
    test_centres: [{ id: CENTRE, name: "Shatila 1", code: "SHA1", slug: "shatila-1", active: true, created_at: iso(0) }],
    exam_years: [{ id: YEAR, name: "2026", region: "eu-west", test_centre_id: CENTRE }],
    exam_cycles: [],
    assessments: [],
    items: [],
    participants: [],
    responses: [],
    sittings: [],
    cohort_exclusions: [],
  };
  for (const [i, s] of specs.entries()) {
    const age = s.age ?? 10 + i * 10;
    db.exam_cycles!.push({
      id: s.id, name: s.name, status: s.status ?? "in_review", region: "eu-west",
      year_id: YEAR, sitting: s.sitting, sitting_date: null,
      created_by: USER, created_at: iso(age), updated_at: iso(age),
    });
    const a = `a-${s.id}`;
    db.assessments!.push({ id: a, cycle_id: s.id, name: s.subject ?? "Applicable Maths", item_count: 4, status: "pending" });
    const itemIds = [0, 1, 2, 3].map((n) => `i${n}-${s.id}`);
    for (const [n, id] of itemIds.entries()) {
      db.items!.push({
        id, cycle_id: s.id, assessment_id: a, qm_question_id: `q${n}`, wording: `Question ${n}`,
        major_element: "Number", sub_element: "Arithmetic", demand_level: "Medium", item_set: null,
        max_score: 1, status: "active", description: null,
      });
    }
    for (const email of [...Object.keys(s.students), ...(s.staff ?? [])]) {
      db.participants!.push({
        id: `p-${s.id}-${email}`, cycle_id: s.id, qm_participant_id: email, pseudonym_id: null,
        full_name: nameOf(email), email,
      });
    }
    for (const [email, scores] of Object.entries(s.students)) {
      const pid = `p-${s.id}-${email}`;
      db.sittings!.push({
        cycle_id: s.id, qm_result_id: `r-${s.id}-${email}`, participant_id: pid, assessment_id: a,
        participant_email: email,
      });
      for (const [n, id] of itemIds.entries()) {
        db.responses!.push({
          id: `resp-${s.id}-${email}-${n}`, cycle_id: s.id, qm_result_id: `r-${s.id}-${email}`,
          question_id: `q${n}`, participant_id: pid, item_id: id, answer_score: scores[n] ?? 0,
          answer_given: "x", answer_given_choice_number: 1, question_presented_number: n + 1,
          response_time: 10, result_status: "Finished", created_at: iso(age),
        });
      }
    }
  }
  for (const [table, rows] of Object.entries(extra)) if (rows) db[table] = rows;
  return db;
}
