/**
 * Manual mark adjustments survive a reload.
 *
 * A manual adjustment is an `alterations` row with `incident_id IS NULL` (migration
 * 0008). Hydration used to replay only incident-linked alterations, so after a page
 * refresh the adjustment — its badge, its undo and its effect on the score — vanished
 * from the client even though the row was still in the database. These tests nudge a
 * cell through one provider, then "reload" by building a FRESH provider over the same
 * database and check that `subject.adjustment` (and the score) come back.
 */
import { describe, it, expect, vi } from "vitest";
import { liveProvider } from "@/tests/helpers/fake-supabase-live";
import { buildDb, USER } from "@/tests/helpers/multi-cycle-db";

vi.mock("server-only", () => ({}));

const FEB = "cyc-feb";
const A = `a-${FEB}`;
const AMAL = `p-${FEB}-amal@s.edu`;

function db() {
  return buildDb([
    { id: FEB, name: "February 2026", sitting: "february", students: { "amal@s.edu": [1, 1, 0, 0], "bilal@s.edu": [1, 0, 0, 0] } },
  ]);
}

async function load(database: ReturnType<typeof db>, role = "lead_admin") {
  const { provider, fake } = await liveProvider(database, { role });
  await provider.ensureCycleLoaded(FEB);
  return { provider, fake };
}

const cell = (p: Awaited<ReturnType<typeof load>>["provider"], pid = AMAL) =>
  p.getComposition(FEB)!.students.find((s) => s.participantId === pid)!.subjects.find((s) => s.assessmentId === A)!;

describe("manual adjustments rehydrate after a reload", () => {
  it("a nudge made in one session is still on the cell (badge data + score) in a fresh session", async () => {
    const database = db();
    const first = await load(database);
    expect(cell(first.provider).total).toBe(2);
    first.provider.adjustStudentMark(FEB, AMAL, A, 4, "Remarked Q3 after appeal");
    expect(cell(first.provider).adjustment).toMatchObject({ delta: 2, newMark: 4, oldMark: 2 });
    await vi.waitFor(() => expect(first.fake.calls.some((c) => c.name === "adjust_participant_mark")).toBe(true));
    expect(database.alterations).toHaveLength(1);

    // ── page refresh: a brand-new provider over the same database ──
    const second = await load(database);
    const c = cell(second.provider);
    expect(c.adjustment).toMatchObject({ participantId: AMAL, assessmentId: A, oldMark: 2, newMark: 4, delta: 2, reason: "Remarked Q3 after appeal" });
    expect(c.adjustment?.ts).toBe("2026-02-01T10:00:00.000Z");
    expect(c.total).toBe(4); // the delta is folded back into the score, not just the badge
    expect(c.alterations).toBe(2);
  });

  it("only the adjusted cell carries the adjustment", async () => {
    const database = db();
    const first = await load(database);
    first.provider.adjustStudentMark(FEB, AMAL, A, 4, "r");
    await vi.waitFor(() => expect(database.alterations).toHaveLength(1));
    const second = await load(database);
    expect(cell(second.provider, `p-${FEB}-bilal@s.edu`).adjustment ?? null).toBeNull();
  });

  it("an adjustment rehydrated after a reload can be undone and the score reverts", async () => {
    const database = db();
    const first = await load(database);
    first.provider.adjustStudentMark(FEB, AMAL, A, 4, "r");
    await vi.waitFor(() => expect(database.alterations).toHaveLength(1));

    const second = await load(database);
    const adj = cell(second.provider).adjustment!;
    expect(adj).toBeTruthy();
    second.provider.removeStudentMarkAdjustment(FEB, adj.id);
    expect(cell(second.provider).total).toBe(2);
    expect(cell(second.provider).adjustment ?? null).toBeNull();
    await vi.waitFor(() => expect(database.alterations).toHaveLength(0));
    expect(second.fake.calls.some((c) => c.name === "remove_mark_adjustment" && c.args.p_participant === AMAL)).toBe(true);
  });

  it("re-adjusting a rehydrated cell supersedes it (deltas never compound)", async () => {
    const database = db();
    const first = await load(database);
    first.provider.adjustStudentMark(FEB, AMAL, A, 4, "r1");
    await vi.waitFor(() => expect(database.alterations).toHaveLength(1));

    const second = await load(database);
    second.provider.adjustStudentMark(FEB, AMAL, A, 3, "r2");
    expect(cell(second.provider)).toMatchObject({ total: 3, adjustment: { oldMark: 2, newMark: 3, delta: 1, reason: "r2" } });
    await vi.waitFor(() => expect(database.alterations!.map((a) => a.marks)).toEqual([1]));
  });

  it("a viewer (no grades.adjust) still SEES a rehydrated adjustment", async () => {
    const database = db();
    const first = await load(database);
    first.provider.adjustStudentMark(FEB, AMAL, A, 4, "r");
    await vi.waitFor(() => expect(database.alterations).toHaveLength(1));
    const viewer = await load(database, "viewer");
    expect(cell(viewer.provider).adjustment).toMatchObject({ delta: 2 });
    expect(cell(viewer.provider).total).toBe(4);
  });

  it("does not disturb incident-derived alterations (still applied once, not as manual)", async () => {
    const database = db();
    database.alterations = [
      { id: "alt-inc", cycle_id: FEB, incident_id: "inc-db-1", apply_to: "student", participant_id: AMAL, assessment_id: A, marks: 1, reason: "tech", decided_by: USER, decided_at: "2026-02-01T09:00:00.000Z" },
    ];
    database.incidents = [
      { id: "inc-db-1", cycle_id: FEB, source: "incident_log", student_name: "amal", exam: "x", issue_type: "t", created_at: "2026-02-01T08:00:00.000Z" },
    ];
    const p = await load(database);
    expect(cell(p.provider).adjustment ?? null).toBeNull();
    expect(cell(p.provider).alterations).toBe(1);
  });
});
