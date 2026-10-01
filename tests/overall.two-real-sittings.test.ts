/**
 * O9 — the year's Overall from TWO REAL, LOCKED sittings, end to end through the
 * production read path: real Questionmark 3-CSV fixture → the exact
 * `ingest_persist` payload → a mock Supabase database → the real
 * `SupabaseDataProvider` (hydrate → replay → lazy load of the other sitting) →
 * `getOverallGrades`. Nothing is synthesised.
 *
 * The database holds, for one centre's 2026 year:
 *   * February 2026 — locked; its own cycle/assessment/item/participant UUIDs
 *     (as in production), scores perturbed per student × subject so February is
 *     sometimes better, sometimes worse, sometimes equal; one student absent.
 *   * May 2026 — locked; the fixture as exported; a different student absent.
 * plus a 0043-style synthetic "△ Sample" centre/year/cycle created AFTER May with
 * persisted grades — it must never become the live cycle, never list, and never
 * reach the Overall or the analytics.
 *
 * Expected values are computed independently here: each sitting is hydrated on its
 * own, graded, and the best-of-two is derived in the test by level rank with May
 * winning ties, and the award re-derived with `deriveAward(..., d3Pass: true)`.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ingestThreeExports } from "@/lib/ingest/qm";
import { makeSupabaseReadClient, type MockDb } from "@/tests/helpers/mock-supabase-read";
import { hydrate } from "@/lib/data/supabase-hydrate";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { SupabaseDataProvider } from "@/lib/data/supabase-provider";
import { subjectKeyOf } from "@/lib/data/overall-analytics";
import { deriveAward } from "@/lib/engine";
import type { GradesModel, OverallGradesModel } from "@/lib/data/types";

vi.mock("server-only", () => ({}));

const CENTRE = "11111111-1111-4111-8111-111111111111";
const SYN_CENTRE = "22222222-2222-4222-8222-222222222222";
const YEAR = "33333333-3333-4333-8333-333333333333";
const SYN_YEAR = "44444444-4444-4444-8444-444444444444";
const FEB = "55555555-5555-4555-8555-555555555555";
const MAY = "66666666-6666-4666-8666-666666666666";
const SYN = "77777777-7777-4777-8777-777777777777";

type Row = Record<string, any>;

/** The exact rows ingest_persist stores for the real fixture. */
async function ingestPayload(): Promise<Row> {
  const { ingestCleanResponses } = await import("@/lib/server/ingest-write");
  const { makeRpcAdmin } = await import("@/tests/helpers/mock-rpc-admin");
  const qmDir = path.join(process.cwd(), "tests", "fixtures", "qm");
  const read = (n: string) => readFileSync(path.join(qmDir, `${n}.csv`));
  const { cleanedResponses, canonical } = ingestThreeExports([
    { name: "Items.csv", data: read("Items") },
    { name: "Assessments.csv", data: read("Assessments") },
    { name: "Topics.csv", data: read("Topics") },
  ]);
  const calls: any[] = [];
  await ingestCleanResponses(makeRpcAdmin(calls) as any, "TEMPLATE", cleanedResponses, { createdBy: "u1", canonical });
  return calls[0].args.p_payload;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/**
 * One sitting's rows as a separate cycle: fresh UUIDs for assessments / items /
 * participants (each sitting is its own exam_cycle in production), the same
 * Questionmark participant ids (the cross-sitting student identity), an optional
 * score perturbation, and one participant dropped.
 */
function sittingRows(
  p: Row,
  cycleId: string,
  code: string,
  opts: { drop: string; perturb: boolean },
): { assessments: Row[]; items: Row[]; participants: Row[]; sittings: Row[]; responses: Row[] } {
  const ids = new Map<string, string>();
  const remap = (id: string | null | undefined) => {
    if (!id) return id;
    if (!ids.has(id)) ids.set(id, randomUUID());
    return ids.get(id)!;
  };
  const dropId = p.participants.find((x: Row) => x.qm_participant_id === opts.drop)!.id;
  const keep = (r: Row) => r.participant_id !== dropId;
  const itemMax = new Map<string, number>();
  for (const r of p.responses) itemMax.set(r.item_id, Math.max(itemMax.get(r.item_id) ?? 0, Number(r.answer_score) || 0));
  const qmOf = new Map<string, string>(p.participants.map((x: Row) => [x.id, x.qm_participant_id]));
  const rid = (r: string) => `${code}-${r}`;
  const at = cycleId === FEB ? "2026-02-10T00:00:00Z" : "2026-05-10T00:00:00Z";
  return {
    assessments: p.assessments.map((a: Row) => ({ ...a, id: remap(a.id), cycle_id: cycleId, sitting: code, status: "scored", created_at: at })),
    items: p.items.map((it: Row) => ({ ...it, id: remap(it.id), cycle_id: cycleId, assessment_id: remap(it.assessment_id), status: "active", created_at: at })),
    participants: p.participants
      .filter((x: Row) => x.id !== dropId)
      .map((x: Row, i: number) => ({ ...x, id: remap(x.id), cycle_id: cycleId, created_at: new Date(Date.parse(at) + i * 1000).toISOString() })),
    sittings: p.sittings.filter(keep).map((s: Row) => ({
      ...s, cycle_id: cycleId, qm_result_id: rid(s.qm_result_id), participant_id: remap(s.participant_id), assessment_id: remap(s.assessment_id), sitting: code,
    })),
    responses: p.responses.filter(keep).map((r: Row, i: number) => {
      let score = Number(r.answer_score) || 0;
      if (opts.perturb) {
        // Per student × subject: ~1/3 worse (0), ~1/3 better (full marks), ~1/3 as May.
        const b = hash(`${qmOf.get(r.participant_id)}|${r.assessment_id}`) % 3;
        if (b === 0) score = 0;
        else if (b === 1) score = itemMax.get(r.item_id) ?? score;
      }
      return {
        ...r, id: `${code}-resp-${i}`, cycle_id: cycleId, qm_result_id: rid(r.qm_result_id), participant_id: remap(r.participant_id),
        item_id: remap(r.item_id), assessment_id: remap(r.assessment_id), answer_score: score,
        created_at: new Date(1700000000000 + i * 1000).toISOString(),
      };
    }),
  };
}

function cycleRow(id: string, name: string, sitting: string, yearId: string, status: string, createdAt: string): Row {
  return { id, name, status, region: "eu-west", year_id: yearId, sitting, sitting_date: null, created_by: "u1", created_at: createdAt, updated_at: createdAt };
}

async function buildDb(opts: { mayStatus?: string } = {}) {
  const p = await ingestPayload();
  const students: string[] = p.participants.map((x: Row) => x.qm_participant_id);
  const mayOnly = students[0]!; // absent from February
  const febOnly = students[1]!; // absent from May
  const feb = sittingRows(p, FEB, "FEB2026", { drop: mayOnly, perturb: true });
  const may = sittingRows(p, MAY, "MAY2026", { drop: febOnly, perturb: false });

  // 0043-style synthetic sample: own centre/year, created AFTER the real May, with
  // persisted grades + a participant (what the analytics projection would read).
  const synAssessment = randomUUID();
  const synParticipant = randomUUID();
  const synth = {
    assessments: [{ id: synAssessment, cycle_id: SYN, name: "Applicable Mathematics", item_count: 0, status: "scored", created_at: "2026-06-01T00:00:00Z" }],
    participants: [{ id: synParticipant, cycle_id: SYN, qm_participant_id: "SOVNB-26-may-01", pseudonym_id: "SOVNB-26-may-01", full_name: "Sample Student 01", created_at: "2026-06-01T00:00:00Z" }],
    grades: [
      { cycle_id: SYN, participant_id: synParticipant, scope: synAssessment, grade_label: "Outstanding performance", locked: true },
      { cycle_id: SYN, participant_id: synParticipant, scope: "overall", grade_label: "Distinction award", locked: true },
    ],
  };

  const db: MockDb = {
    test_centres: [
      { id: CENTRE, name: "Shatila 1", code: "SHA1", slug: "shatila-1", region: "eu-west", active: true, created_at: "2025-01-01T00:00:00Z" },
      { id: SYN_CENTRE, name: "△ Sample — North Beacon", code: "SOVNB", slug: "seed-ov-north-beacon", region: "eu-west", active: true, is_synthetic: true, created_at: "2025-01-01T00:00:00Z" },
    ],
    exam_years: [
      { id: YEAR, name: "2026", region: "eu-west", test_centre_id: CENTRE, created_at: "2026-01-01T00:00:00Z" },
      { id: SYN_YEAR, name: "2026", region: "eu-west", test_centre_id: SYN_CENTRE, created_at: "2026-01-01T00:00:00Z" },
    ],
    exam_cycles: [
      // No month word in the name: the STORED sitting (0046, from the result
      // dates) must place it — name parsing alone would call it May.
      cycleRow(FEB, "G12++ 2026 Sitting 1", "february", YEAR, "locked", "2026-02-01T00:00:00Z"),
      cycleRow(MAY, "G12++ May 2026", "may", YEAR, opts.mayStatus ?? "locked", "2026-05-01T00:00:00Z"),
      cycleRow(SYN, "△ Sample SOVNB 2026 May", "may", SYN_YEAR, "locked", "2026-06-01T00:00:00Z"),
    ],
    assessments: [...feb.assessments, ...may.assessments, ...synth.assessments],
    items: [...feb.items, ...may.items],
    participants: [...feb.participants, ...may.participants, ...synth.participants],
    sittings: [...feb.sittings, ...may.sittings],
    responses: [...feb.responses, ...may.responses],
    grades: synth.grades,
    memberships: [{ user_id: "u1", cycle_id: null, role: "lead_admin", role_id: null }],
  };
  return { db, mayOnly, febOnly };
}

/** The mock read client + the slice of auth/rpc the live provider touches. */
function liveClient(db: MockDb) {
  const base = makeSupabaseReadClient(db);
  return {
    ...base,
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: "u1", email: "lead@alsama.test", user_metadata: {} } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  };
}

async function liveProvider(db: MockDb): Promise<SupabaseDataProvider> {
  const provider = new SupabaseDataProvider(liveClient(db) as any);
  await vi.waitFor(() => expect(provider.getAccessStatus()).toBe("ok"), { timeout: 20000, interval: 20 });
  return provider;
}

/** Wait until the lazily-loaded other sitting has arrived (or the Overall settled). */
async function settledOverall(provider: SupabaseDataProvider, yearId: string): Promise<OverallGradesModel> {
  let model = provider.getOverallGrades(yearId)!;
  await vi.waitFor(
    () => {
      model = provider.getOverallGrades(yearId)!;
      expect(model.blocked ?? "").not.toMatch(/still loading/);
    },
    { timeout: 20000, interval: 20 },
  );
  return model;
}

/** One sitting graded on its own — the independent expectation. */
async function gradesOf(db: MockDb, cycleId: string): Promise<GradesModel> {
  const h = await hydrate(makeSupabaseReadClient(db) as any, { cycleId });
  return new InMemoryDataProvider(h!.seed, undefined, true).getGrades(cycleId)!;
}

/** studentId → subject key → level ("" = no result). */
function levelsByStudent(g: GradesModel): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const r of g.rows) {
    const m = new Map<string, string>();
    for (const a of g.assessments) m.set(subjectKeyOf(a.name), r.grades[a.id]?.level ?? "");
    out.set(r.studentId, m);
  }
  return out;
}

describe("Overall from two REAL locked sittings (live provider, real fixture)", () => {
  it("lists exactly one real 2026 year — the synthetic sample is never live, never listed", async () => {
    const { db } = await buildDb();
    const provider = await liveProvider(db);
    const years = provider.listYears();
    expect(years).toHaveLength(1);
    const y = years[0]!;
    expect(y.id).toBe(YEAR);
    expect(y.february.cycleId).toBe(FEB);
    expect(y.may.cycleId).toBe(MAY);
    // The real May (not the newer synthetic cycle) is the live cycle.
    expect(provider.listCycles().find((c) => c.live)?.id).toBe(MAY);
    expect(provider.listCycles().some((c) => c.id === SYN)).toBe(false);
    expect(provider.listTestCentres().map((c) => c.id)).toEqual([CENTRE]);
    // Both sittings re-hydrate as LOCKED from exam_cycles.status (no grades rows).
    expect(y.february.locked).toBe(true);
    expect(y.may.locked).toBe(true);
    expect(y.february.mock).toBe(false);
    expect(provider.getYear(YEAR)!.overall.ready).toBe(true);
  });

  it("every student × all five subjects: February level, May level, the higher of the two, and the derived award", async () => {
    const { db, mayOnly, febOnly } = await buildDb();
    const provider = await liveProvider(db);
    const overall = await settledOverall(provider, YEAR);

    expect(overall.blocked).toBeNull();
    expect(overall.demo).toBe(false);
    expect(overall.ready).toBe(true);
    expect(overall.assessments.map((a) => a.id).sort()).toEqual(["afl", "am", "esl", "ls", "st"]);

    const feb = levelsByStudent(await gradesOf(db, FEB));
    const may = levelsByStudent(await gradesOf(db, MAY));
    const levels = overall.performanceLevels;
    const rank = (l: string) => (l && levels.includes(l) ? levels.indexOf(l) : Infinity);

    // Every student of either sitting has exactly one Overall row.
    const students = new Set([...feb.keys(), ...may.keys()]);
    expect(overall.rows).toHaveLength(students.size);
    expect(new Set(overall.rows.map((r) => r.studentId))).toEqual(students);

    let febWins = 0;
    let mayWins = 0;
    let ties = 0;
    for (const row of overall.rows) {
      const subjectLevels: string[] = [];
      for (const subject of overall.assessments) {
        const f = feb.get(row.studentId)?.get(subject.id) ?? "";
        const m = may.get(row.studentId)?.get(subject.id) ?? "";
        const cell = row.grades[subject.id];
        if (!f && !m) {
          expect(cell, `${row.studentId} ${subject.id} has no result in either sitting`).toBeUndefined();
          subjectLevels.push("");
          continue;
        }
        expect(cell!.februaryLevel).toBe(f || null);
        expect(cell!.mayLevel).toBe(m || null);
        // Higher by RANK; May supplies ties and May-only results.
        const expectSource = rank(m) <= rank(f) ? "may" : "february";
        expect(cell!.source, `${row.studentId} ${subject.id}`).toBe(expectSource);
        expect(cell!.level).toBe(expectSource === "may" ? m : f);
        if (f && m) {
          if (rank(f) < rank(m)) febWins++;
          else if (rank(m) < rank(f)) mayWins++;
          else ties++;
        }
        subjectLevels.push(cell!.level);
      }
      const { award } = deriveAward(
        { subjectLevels, d3Pass: true },
        { performanceLevels: levels, awardLevels: overall.awardLevels },
      );
      expect(row.award, `${row.studentId} award`).toBe(award);
    }
    // The fixture genuinely exercises all three outcomes.
    expect(febWins).toBeGreaterThan(0);
    expect(mayWins).toBeGreaterThan(0);
    expect(ties).toBeGreaterThan(0);

    // A student with only one sitting falls back to that sitting.
    const onlyMay = overall.rows.find((r) => r.studentId === mayOnly)!;
    expect(onlyMay.inFebruary).toBe(false);
    expect(onlyMay.inMay).toBe(true);
    for (const c of Object.values(onlyMay.grades)) {
      expect(c.source).toBe("may");
      expect(c.februaryLevel).toBeNull();
    }
    const onlyFeb = overall.rows.find((r) => r.studentId === febOnly)!;
    expect(onlyFeb.inFebruary).toBe(true);
    expect(onlyFeb.inMay).toBe(false);
    for (const c of Object.values(onlyFeb.grades)) {
      expect(c.source).toBe("february");
      expect(c.mayLevel).toBeNull();
    }

    // Certificates read the same rows; the "real data" issuance gate is met.
    const docs = provider.getOverallDocuments(YEAR)!;
    expect(docs.students).toHaveLength(overall.rows.length);
    expect(docs.readiness!.gates.find((g) => g.id === "live")!.met).toBe(true);
    expect(docs.readiness!.gates.find((g) => g.id === "locked")!.met).toBe(true);
  });

  it("the synthetic sample never reaches the real Overall or the analytics", async () => {
    const { db } = await buildDb();
    const provider = await liveProvider(db);
    const overall = await settledOverall(provider, YEAR);
    for (const r of overall.rows) {
      expect(r.label).not.toMatch(/sample/i);
      expect(r.studentId.startsWith("SOV")).toBe(false);
    }
    const analytics = provider.getOverallAnalytics();
    expect(analytics.centres.some((c) => /sample/i.test(c))).toBe(false);
    // The synthetic year cannot be opened as an Overall either.
    expect(provider.getOverallGrades(SYN_YEAR)).toBeNull();
  });

  it("is withheld — no rows, nothing synthesised — while May is not locked", async () => {
    const { db } = await buildDb({ mayStatus: "graded" });
    const provider = await liveProvider(db);
    const overall = provider.getOverallGrades(YEAR)!;
    expect(overall.ready).toBe(false);
    expect(overall.demo).toBe(false);
    expect(overall.rows).toHaveLength(0);
    expect(overall.blocked).toMatch(/May: .*not locked/);
    expect(provider.getOverallDocuments(YEAR)!.students).toHaveLength(0);
  });
});
