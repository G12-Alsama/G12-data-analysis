/**
 * Score-page mark adjustment — the provider contract behind it.
 *
 * In-memory provider (the demo path and the optimistic layer of the live one):
 *   - the ±5 cap applies to the BOUNDED path and not to the Grades path;
 *   - the cap is measured from the base, so re-adjusting cannot ratchet past it;
 *   - 0 ≤ mark ≤ max applies to both;
 *   - re-adjusting a cell twice leaves ONE adjustment with the cumulative delta from
 *     the base (no compounding); Undo restores the original mark;
 *   - a user without `grades.adjust`, or a locked sitting, is refused with a reason and
 *     nothing changes.
 * Live provider (over a stateful fake backend):
 *   - the Score page calls adjust_participant_mark_bounded, the Grades view the
 *     uncapped RPC; Undo calls remove_mark_adjustment for the right cell;
 *   - a change the client already knows is refused sends NO RPC;
 *   - a SERVER refusal comes back as { ok: false, error } AND the sitting is re-read, so
 *     the screen shows what the database holds (rpcOrReconcile) instead of only logging.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import type { CurrentUser, SubjectComposition } from "@/lib/data/types";
import { liveProvider } from "@/tests/helpers/fake-supabase-live";
import { buildDb } from "@/tests/helpers/multi-cycle-db";

vi.mock("server-only", () => ({}));

const CYCLE = "may-2026";
const REVIEWER: CurrentUser = { id: "m-sami", name: "Omar Reviewer", initials: "OR", role: "reviewer" };

/** A (student, subject) mid-range enough to move ±8 without touching 0 or the max. */
function target(p: InMemoryDataProvider) {
  for (const s of p.getComposition(CYCLE)!.students) {
    for (const sj of s.subjects) {
      if (sj.total >= 10 && sj.total <= sj.max - 14) return { pid: s.participantId, aid: sj.assessmentId, total: sj.total, max: sj.max };
    }
  }
  throw new Error("no suitable target in the seed");
}
const cellOf = (p: InMemoryDataProvider, pid: string, aid: string): SubjectComposition =>
  p.getComposition(CYCLE)!.students.find((s) => s.participantId === pid)!.subjects.find((x) => x.assessmentId === aid)!;

describe("in-memory provider — bounded vs uncapped adjustment", () => {
  it("the bounded path accepts exactly ±5 from the current mark and refuses more, changing nothing", async () => {
    const p = new InMemoryDataProvider();
    const t = target(p);
    expect(await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 5, "appeal")).toEqual({ ok: true });
    expect(cellOf(p, t.pid, t.aid)).toMatchObject({ total: t.total + 5, adjustment: { delta: 5, oldMark: t.total, newMark: t.total + 5 } });

    const refused = await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 5.5, "appeal");
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { error: string }).error).toMatch(/±5/);
    expect(cellOf(p, t.pid, t.aid).total).toBe(t.total + 5); // untouched

    expect(await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total - 5, "appeal")).toEqual({ ok: true });
    expect(cellOf(p, t.pid, t.aid).total).toBe(t.total - 5);
    expect(await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total - 5.5, "appeal")).toMatchObject({ ok: false });
  });

  it("the cap is measured from the BASE, so re-adjusting cannot ratchet past ±5 in steps", async () => {
    const p = new InMemoryDataProvider();
    const t = target(p);
    expect(await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 3, "r1")).toEqual({ ok: true });
    expect(await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 5, "r2")).toEqual({ ok: true }); // +5 from base, not +2 from 3
    expect(await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 6, "r3")).toMatchObject({ ok: false });
    expect(cellOf(p, t.pid, t.aid).adjustment).toMatchObject({ delta: 5, oldMark: t.total });
  });

  it("the Grades path (adjustStudentMark) is NOT capped", async () => {
    const p = new InMemoryDataProvider();
    const t = target(p);
    expect(await p.adjustStudentMark(CYCLE, t.pid, t.aid, t.total + 8, "big remark")).toEqual({ ok: true });
    expect(cellOf(p, t.pid, t.aid)).toMatchObject({ total: t.total + 8, adjustment: { delta: 8 } });
  });

  it("both paths keep 0 ≤ mark ≤ the subject max", async () => {
    const p = new InMemoryDataProvider();
    const t = target(p);
    for (const fn of ["adjustStudentMark", "adjustStudentMarkBounded"] as const) {
      expect(await p[fn](CYCLE, t.pid, t.aid, t.max + 1, "x")).toMatchObject({ ok: false });
      expect(await p[fn](CYCLE, t.pid, t.aid, -1, "x")).toMatchObject({ ok: false });
      expect(await p[fn](CYCLE, t.pid, t.aid, Number.NaN, "x")).toMatchObject({ ok: false });
    }
    expect(cellOf(p, t.pid, t.aid).adjustment ?? null).toBeNull();
  });

  it("requires a reason", async () => {
    const p = new InMemoryDataProvider();
    const t = target(p);
    expect(await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 1, "   ")).toMatchObject({ ok: false, error: expect.stringMatching(/reason/i) });
  });
});

describe("in-memory provider — re-adjusting and Undo", () => {
  it("adjusting the same cell twice leaves ONE adjustment with the cumulative delta from the base", async () => {
    const p = new InMemoryDataProvider();
    const t = target(p);
    await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 2, "first");
    await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 3, "second");
    const c = cellOf(p, t.pid, t.aid);
    expect(c.total).toBe(t.total + 3); // not +2 then +3 on top (+5)
    expect(c.alterations).toBe(3);
    expect(c.adjustment).toMatchObject({ oldMark: t.total, newMark: t.total + 3, delta: 3, reason: "second" });
  });

  it("Undo restores the ORIGINAL mark (also after a re-adjustment) and clears the badge data", async () => {
    const p = new InMemoryDataProvider();
    const t = target(p);
    await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 2, "first");
    await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total - 4, "second");
    const id = cellOf(p, t.pid, t.aid).adjustment!.id;
    expect(await p.removeStudentMarkAdjustment(CYCLE, id)).toEqual({ ok: true });
    const c = cellOf(p, t.pid, t.aid);
    expect(c.total).toBe(t.total);
    expect(c.adjustment ?? null).toBeNull();
    // a second undo of the same id says so instead of silently succeeding
    expect(await p.removeStudentMarkAdjustment(CYCLE, id)).toMatchObject({ ok: false });
  });

  it("adjusting back to the original mark leaves no adjustment", async () => {
    const p = new InMemoryDataProvider();
    const t = target(p);
    await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 2, "first");
    await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total, "back");
    expect(cellOf(p, t.pid, t.aid).adjustment ?? null).toBeNull();
    expect(cellOf(p, t.pid, t.aid).total).toBe(t.total);
  });
});

describe("in-memory provider — who may, and when", () => {
  it("a user whose role lacks grades.adjust is refused with a reason and nothing changes (adjust AND undo)", async () => {
    const p = new InMemoryDataProvider();
    const t = target(p);
    await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 2, "by admin");
    const id = cellOf(p, t.pid, t.aid).adjustment!.id;

    p.setRoleAction("team_member", "grades.adjust", false); // admin edits the grid…
    p.setCurrentUser(REVIEWER); // …then a team member acts
    expect(await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 4, "x")).toMatchObject({ ok: false, error: expect.stringMatching(/permission/i) });
    expect(await p.removeStudentMarkAdjustment(CYCLE, id)).toMatchObject({ ok: false, error: expect.stringMatching(/permission/i) });
    expect(cellOf(p, t.pid, t.aid)).toMatchObject({ total: t.total + 2, adjustment: { id } }); // intact, still visible
  });

  it("a locked sitting refuses adjust and undo", async () => {
    const p = new InMemoryDataProvider();
    const t = target(p);
    await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 2, "before lock");
    const id = cellOf(p, t.pid, t.aid).adjustment!.id;
    p.lockCycle(CYCLE);
    expect(await p.adjustStudentMarkBounded(CYCLE, t.pid, t.aid, t.total + 3, "x")).toMatchObject({ ok: false, error: expect.stringMatching(/locked/i) });
    expect(await p.removeStudentMarkAdjustment(CYCLE, id)).toMatchObject({ ok: false, error: expect.stringMatching(/locked/i) });
    expect(cellOf(p, t.pid, t.aid).total).toBe(t.total + 2);
  });
});

// ── live provider over the stateful fake backend ────────────────────────────
const FEB = "cyc-feb";
const A = `a-${FEB}`;
const AMAL = `p-${FEB}-amal@s.edu`;
const liveDb = () => buildDb([{ id: FEB, name: "February 2026", sitting: "february", students: { "amal@s.edu": [1, 1, 0, 0], "bilal@s.edu": [1, 0, 0, 0] } }]);
async function live() {
  const { provider, fake } = await liveProvider(liveDb());
  await provider.ensureCycleLoaded(FEB);
  const cell = () => provider.getComposition(FEB)!.students.find((s) => s.participantId === AMAL)!.subjects.find((s) => s.assessmentId === A)!;
  const rpcs = (name: string) => fake.calls.filter((c) => c.name === name);
  return { provider, fake, cell, rpcs };
}

describe("live provider — RPC routing and reconciliation", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => errSpy.mockRestore());

  it("the Score-page path calls the BOUNDED rpc; the Grades path calls the uncapped one", async () => {
    const { provider, rpcs } = await live();
    expect(await provider.adjustStudentMarkBounded(FEB, AMAL, A, 4, "score page")).toEqual({ ok: true });
    expect(rpcs("adjust_participant_mark_bounded")).toHaveLength(1);
    expect(rpcs("adjust_participant_mark")).toHaveLength(0);
    expect(rpcs("adjust_participant_mark_bounded")[0]!.args).toMatchObject({ p_cycle: FEB, p_participant: AMAL, p_assessment: A, p_new_mark: 4, p_reason: "score page" });

    expect(await provider.adjustStudentMark(FEB, AMAL, A, 3, "grades view")).toEqual({ ok: true });
    expect(rpcs("adjust_participant_mark")).toHaveLength(1);
  });

  it("a change the client already knows is out of bounds sends NO rpc", async () => {
    const { provider, fake, cell } = await live();
    // (this subject has four one-mark items, so its max is 4)
    const r = await provider.adjustStudentMarkBounded(FEB, AMAL, A, 9, "too far");
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/between 0 and 4/) });
    expect(fake.calls.filter((c) => c.name.startsWith("adjust_participant_mark"))).toHaveLength(0);
    expect(cell().adjustment ?? null).toBeNull();
  });

  it("Undo calls remove_mark_adjustment for the right cell and the score reverts", async () => {
    const { provider, fake, cell, rpcs } = await live();
    await provider.adjustStudentMarkBounded(FEB, AMAL, A, 4, "r");
    expect(cell().total).toBe(4);
    expect(await provider.removeStudentMarkAdjustment(FEB, cell().adjustment!.id)).toEqual({ ok: true });
    expect(rpcs("remove_mark_adjustment")[0]!.args).toEqual({ p_cycle: FEB, p_participant: AMAL, p_assessment: A });
    expect(cell().total).toBe(2);
    expect(fake.db.alterations).toHaveLength(0);
  });

  it("a SERVER refusal is returned with its reason AND the sitting is reconciled to what the database holds", async () => {
    const { provider, fake, cell } = await live();
    fake.failRpc("adjust_participant_mark_bounded", "not authorized");
    const r = await provider.adjustStudentMarkBounded(FEB, AMAL, A, 4, "r");
    expect(r).toEqual({ ok: false, error: "You don’t have permission to adjust marks." });
    // the optimistic +2 was rolled back by the re-read — the database never accepted it
    expect(cell().total).toBe(2);
    expect(cell().adjustment ?? null).toBeNull();
    expect(errSpy).toHaveBeenCalled(); // still logged for diagnostics
  });

  it("the server's own wording passes through (e.g. the ±5 cap)", async () => {
    const { provider, fake } = await live();
    const msg = "a mark adjustment of 6 exceeds the allowed +/-5 marks (current mark 2, requested 8)";
    fake.failRpc("adjust_participant_mark_bounded", msg);
    const r = await provider.adjustStudentMarkBounded(FEB, AMAL, A, 4, "r");
    expect(r).toEqual({ ok: false, error: msg.charAt(0).toUpperCase() + msg.slice(1) });
  });

  it("explains an un-applied migration instead of a raw 'function not found'", async () => {
    const { provider, fake } = await live();
    fake.failRpc("adjust_participant_mark_bounded", "Could not find the function public.adjust_participant_mark_bounded(p_assessment, p_cycle) in the schema cache");
    const r = await provider.adjustStudentMarkBounded(FEB, AMAL, A, 4, "r");
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/migration 0052/) });
  });

  it("a refused Undo reconciles: the adjustment the database still holds comes back", async () => {
    const { provider, fake, cell } = await live();
    await provider.adjustStudentMarkBounded(FEB, AMAL, A, 4, "r");
    expect(fake.db.alterations).toHaveLength(1);
    fake.failRpc("remove_mark_adjustment", "not authorized");
    const r = await provider.removeStudentMarkAdjustment(FEB, cell().adjustment!.id);
    expect(r).toMatchObject({ ok: false });
    expect(fake.db.alterations).toHaveLength(1);
    // optimistic removal was undone by the re-read (the row is rehydrated)
    expect(cell()).toMatchObject({ total: 4, adjustment: { delta: 2, reason: "r" } });
  });
});
