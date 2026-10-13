/**
 * Overall over REAL sittings (the live provider), per the confirmed business rules:
 *   - best performance level per student and subject across sittings;
 *   - ties go to the LATEST sitting;
 *   - students matched by email (qm_participant_id);
 *   - ONLY sittings whose grades are LOCKED count;
 *   - nothing is fabricated (no synthetic February in live mode).
 *
 * Default levels for a 4-mark paper: 0-1 → Doesn't yet meet, 2 → Meets, 3 → Exceeds, 4 → Outstanding.
 */
import { describe, it, expect, vi } from "vitest";
import { liveProvider } from "@/tests/helpers/fake-supabase-live";
import { buildDb, YEAR } from "@/tests/helpers/multi-cycle-db";
import type { OverallGradeRow, OverallGradesModel } from "@/lib/data/types";

vi.mock("server-only", () => ({}));

const FEB = "cyc-feb";
const MAY = "cyc-may";
const OUTSTANDING = "Outstanding performance";
const EXCEEDS = "Exceeds expectations";
const MEETS = "Meets expectations";
const NOT_YET = "Doesn't yet meet expectations";

const db = (opts: { febStatus?: string; mayStatus?: string } = {}) =>
  buildDb([
    { id: FEB, name: "February 2026", sitting: "february", status: opts.febStatus ?? "locked", age: 10,
      students: {
        "amal@s.edu": [1, 1, 1, 0], //  Exceeds  → May Outstanding: May better
        "bilal@s.edu": [1, 1, 0, 0], // Meets    → May Exceeds:     May better
        "carla@s.edu": [1, 1, 0, 0], // Meets    → (not in May):    February stands
        "dina@s.edu": [1, 1, 1, 1], //  Outstanding → May Doesn't: February stands (later sitting is WORSE)
        "frank@s.edu": [1, 1, 0, 0], // Meets    → May Meets:       TIE → latest (May)
        "tom@s.edu": [1, 0, 0, 0], //   Doesn't  → May Doesn't:     TIE → latest (May)
      } },
    { id: MAY, name: "May 2026", sitting: "may", status: opts.mayStatus ?? "locked", age: 20,
      students: {
        "amal@s.edu": [1, 1, 1, 1],
        "bilal@s.edu": [1, 1, 1, 0],
        "dina@s.edu": [1, 0, 0, 0],
        "frank@s.edu": [1, 1, 0, 0],
        "tom@s.edu": [0, 0, 0, 0],
        "eve@s.edu": [1, 1, 0, 0], //   (not in February):          May stands
      } },
  ]);

const rawRow = (m: OverallGradesModel, email: string): OverallGradeRow => m.rows.find((r) => r.studentId === email)!;
// Per-period views of the generic shapes, so the assertions read as the two real sittings.
const row = (m: OverallGradesModel, email: string) => {
  const r = rawRow(m, email);
  return { ...r, inFebruary: r.presentIn.includes("february"), inMay: r.presentIn.includes("may") };
};
const cell = (m: OverallGradesModel, email: string) => {
  const c = Object.values(rawRow(m, email).grades)[0]!;
  const at = (k: string) => c.levels.find((l) => l.key === k)?.level ?? null;
  return { ...c, februaryLevel: at("february"), mayLevel: at("may") };
};

async function overall(opts?: Parameters<typeof db>[0]) {
  const { provider, fake } = await liveProvider(db(opts));
  await provider.ensureYearLoaded(YEAR);
  return { provider, fake, model: provider.getOverallGrades(YEAR)! };
}

describe("Overall over two real LOCKED sittings", () => {
  it("takes the best level per student and subject, with provenance", async () => {
    const { model } = await overall();
    expect(cell(model, "amal@s.edu")).toMatchObject({ level: OUTSTANDING, source: "may", februaryLevel: EXCEEDS, mayLevel: OUTSTANDING });
    expect(cell(model, "bilal@s.edu")).toMatchObject({ level: EXCEEDS, source: "may", februaryLevel: MEETS });
    // the later sitting is WORSE → the better, earlier result stands
    expect(cell(model, "dina@s.edu")).toMatchObject({ level: OUTSTANDING, source: "february", februaryLevel: OUTSTANDING, mayLevel: NOT_YET });
  });

  it("ties go to the LATEST sitting", async () => {
    const { model } = await overall();
    expect(cell(model, "frank@s.edu")).toMatchObject({ level: MEETS, source: "may", februaryLevel: MEETS, mayLevel: MEETS });
    expect(cell(model, "tom@s.edu")).toMatchObject({ level: NOT_YET, source: "may" });
  });

  it("a student in only one sitting uses that sitting; students match on email", async () => {
    const { model } = await overall();
    expect(cell(model, "carla@s.edu")).toMatchObject({ source: "february", mayLevel: null });
    expect(row(model, "carla@s.edu")).toMatchObject({ inFebruary: true, inMay: false });
    expect(cell(model, "eve@s.edu")).toMatchObject({ source: "may", februaryLevel: null });
    expect(row(model, "eve@s.edu")).toMatchObject({ inFebruary: false, inMay: true });
    // six February students + eve = 7 distinct people, matched on email across two sets of rows
    expect(model.rows.map((r) => r.studentId).sort()).toEqual(
      ["amal@s.edu", "bilal@s.edu", "carla@s.edu", "dina@s.edu", "eve@s.edu", "frank@s.edu", "tom@s.edu"],
    );
  });

  it("lines up the SAME subject across sittings even though each sitting has its own assessment rows", async () => {
    const { model, provider } = await overall();
    // different assessment uuids per sitting…
    expect(provider.getCycle(FEB)!.assessments[0]!.id).not.toBe(provider.getCycle(MAY)!.assessments[0]!.id);
    // …but ONE Overall subject, with both sittings' levels in the same cell
    expect(model.assessments).toHaveLength(1);
    expect(cell(model, "amal@s.edu").levels.map((l) => l.key)).toEqual(["february", "may"]);
    for (const l of cell(model, "amal@s.edu").levels) expect(l.level).not.toBeNull();
  });

  it("is final (ready) when every sitting is locked, and nothing is synthetic", async () => {
    const { model } = await overall();
    expect(model).toMatchObject({ ready: true, locked: true, demo: false });
    expect(model.sittings!.map((s) => s.status)).toEqual(["counted", "counted"]);
  });

  it("is the same for a read-only viewer as for an admin", async () => {
    const admin = await overall();
    const { provider } = await liveProvider(db(), { role: "viewer" });
    await provider.ensureYearLoaded(YEAR);
    expect(JSON.stringify(provider.getOverallGrades(YEAR)!.rows)).toBe(JSON.stringify(admin.model.rows));
  });

  it("the year resolves by its real exam_years id and certificates build from the same rows", async () => {
    const { provider, model } = await overall();
    expect(model.yearId).toBe(YEAR);
    const docs = provider.getOverallDocuments(YEAR)!;
    expect(docs.students).toHaveLength(model.rows.length);
  });
});

describe("only LOCKED sittings count", () => {
  it("an unlocked sitting is excluded from the rollup and listed as 'not counted yet'", async () => {
    const { model } = await overall({ mayStatus: "in_review" });
    // May is ignored entirely: every row is February's, eve (May-only) is absent
    expect(model.rows.map((r) => r.studentId)).not.toContain("eve@s.edu");
    expect(cell(model, "amal@s.edu")).toMatchObject({ source: "february", level: EXCEEDS, mayLevel: null });
    const may = model.sittings!.find((s) => s.cycleId === MAY)!;
    expect(may).toMatchObject({ status: "not_locked", locked: false });
    expect(may.note).toMatch(/not counted yet.*grades not locked/i);
    expect(model.ready).toBe(false);
    expect(model.note).toMatch(/not counted yet/i);
  });

  it("with NO sitting locked nothing is counted (and nothing is invented)", async () => {
    const { model } = await overall({ febStatus: "in_review", mayStatus: "in_review" });
    expect(model.rows).toEqual([]);
    expect(model.sittings!.every((s) => s.status === "not_locked")).toBe(true);
    expect(model.demo).toBe(false);
  });

  it("an unlocked sitting's data is never even loaded for the rollup", async () => {
    const { provider, fake } = await liveProvider(db({ mayStatus: "in_review" }));
    fake.clearLog();
    await provider.ensureYearLoaded(YEAR);
    expect(fake.log.some((q) => q.table === "responses" && q.eq.cycle_id === MAY)).toBe(false);
    expect(fake.log.some((q) => q.table === "responses" && q.eq.cycle_id === FEB)).toBe(true);
  });

  it("a locked sitting reads as 'loading' until its data arrives, then counts", async () => {
    const { provider } = await liveProvider(db());
    expect(provider.getOverallGrades(YEAR)!.sittings!.map((s) => s.status)).toEqual(["loading", "loading"]);
    await provider.ensureYearLoaded(YEAR);
    expect(provider.getOverallGrades(YEAR)!.sittings!.map((s) => s.status)).toEqual(["counted", "counted"]);
  });

  it("locking a sitting brings it into the Overall immediately; re-opening takes it out", async () => {
    const { provider } = await liveProvider(db({ mayStatus: "in_review" }));
    await provider.ensureYearLoaded(YEAR);
    await provider.ensureCycleLoaded(MAY);
    expect(provider.getOverallGrades(YEAR)!.rows.map((r) => r.studentId)).not.toContain("eve@s.edu");

    provider.lockCycle(MAY);
    expect(provider.getOverallGrades(YEAR)!.rows.map((r) => r.studentId)).toContain("eve@s.edu");
    expect(cell(provider.getOverallGrades(YEAR)!, "amal@s.edu").source).toBe("may");

    provider.unlockCycle(MAY);
    expect(provider.getOverallGrades(YEAR)!.rows.map((r) => r.studentId)).not.toContain("eve@s.edu");
  });
});

describe("no fabricated sittings in live mode", () => {
  it("a year with only a May sitting does NOT get a synthetic February", async () => {
    const only = buildDb([
      { id: MAY, name: "May 2026", sitting: "may", status: "locked", students: { "amal@s.edu": [1, 1, 1, 1] } },
    ]);
    const { provider } = await liveProvider(only);
    await provider.ensureYearLoaded(YEAR);
    const model = provider.getOverallGrades(YEAR)!;
    expect(model.demo).toBe(false);
    expect(cell(model, "amal@s.edu")).toMatchObject({ source: "may", februaryLevel: null });
    expect(model.sittings!.find((s) => s.key === "february")!.status).toBe("not_started");
  });

  it("an unknown year is still null", async () => {
    const { provider } = await liveProvider(db());
    expect(provider.getOverallGrades("no-such-year")).toBeNull();
  });
});
