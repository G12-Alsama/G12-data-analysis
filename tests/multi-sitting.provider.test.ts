/**
 * The live provider holds EVERY sitting, not just the newest.
 *
 * Drives the real SupabaseDataProvider over a stateful fake backend
 * (tests/helpers/fake-supabase-live.ts). Covers:
 *   a) two sittings with different data in one provider — reads/writes for A never touch
 *      B, and opening B does not change A;
 *   b) creating a sitting does not change which sitting the user is looking at;
 *   d) lock state survives a reload (stored in exam_cycles.status, NOT in grades rows);
 *   e) the Years page never hydrates every sitting's responses;
 * plus the non-live sitting being a real, usable sitting (no forced mock / locked).
 */
import { describe, it, expect, vi } from "vitest";
import { liveProvider } from "@/tests/helpers/fake-supabase-live";
import { buildDb, CENTRE, YEAR } from "@/tests/helpers/multi-cycle-db";

vi.mock("server-only", () => ({}));

const FEB = "cyc-feb";
const MAY = "cyc-may";
const FACT_TABLES = ["responses", "items", "item_stats", "item_reviews", "sittings", "essay_marks", "alterations", "clean_exclusions"];

const twoSittings = () =>
  buildDb([
    { id: FEB, name: "February 2026", sitting: "february", status: "in_review", age: 10,
      students: { "amal@s.edu": [1, 1, 1, 0], "bilal@s.edu": [1, 0, 0, 0], "carla@s.edu": [1, 1, 0, 0] } },
    { id: MAY, name: "May 2026", sitting: "may", status: "in_review", age: 20,
      students: { "amal@s.edu": [1, 1, 1, 1], "bilal@s.edu": [1, 1, 0, 0] } },
  ]);

describe("every sitting is a real, usable sitting (not a stub)", () => {
  it("lists ALL sittings with real counts, real lock state and mock:false — before any is opened", async () => {
    const db = twoSittings();
    db.exam_cycles!.find((c) => c.id === FEB)!.status = "locked";
    const { provider } = await liveProvider(db);
    const by = Object.fromEntries(provider.listCycles().map((c) => [c.id, c]));
    expect(by[MAY]).toMatchObject({ mock: false, locked: false, participants: 2, assessments: 1, live: false });
    expect(by[FEB]).toMatchObject({ mock: false, locked: true, participants: 3, assessments: 1, live: false });
  });

  it("an unopened sitting's detail is its REAL summary (not locked/mock/empty by force)", async () => {
    const { provider } = await liveProvider(twoSittings());
    const d = provider.getCycle(FEB)!;
    expect(d).toMatchObject({ mock: false, locked: false, loaded: false, participants: 3, assessmentCount: 1 });
    expect(d.doNext.href.startsWith(`/cycles/${FEB}/`)).toBe(true); // lands on ITS OWN pipeline step
  });

  it("LockStatus's source (getCycle.locked) shows the real lock for both loaded and unloaded sittings", async () => {
    const db = twoSittings();
    db.exam_cycles!.find((c) => c.id === FEB)!.status = "locked";
    const { provider } = await liveProvider(db);
    expect(provider.getCycle(FEB)!.locked).toBe(true); // summary only
    expect(provider.getCycle(MAY)!.locked).toBe(false);
    await provider.ensureCycleLoaded(FEB);
    expect(provider.getCycle(FEB)!).toMatchObject({ locked: true, loaded: true });
  });

  it("the OLDER sitting is fully usable once opened (it used to be a mock stub)", async () => {
    const { provider } = await liveProvider(twoSittings());
    expect(provider.getCycleLoadState(FEB)).toBe("loading");
    await provider.ensureCycleLoaded(FEB);
    expect(provider.getCycleLoadState(FEB)).toBe("ready");
    const d = provider.getCycle(FEB)!;
    expect(d.assessments).toHaveLength(1);
    const a = d.assessments[0]!.id;
    expect(provider.getIngest(FEB)).not.toBeNull();
    expect(provider.getNaiveScores(FEB, a)).not.toBeNull();
    expect(provider.getReview(FEB, a)).not.toBeNull();
    expect(provider.getGrades(FEB)!.rows).toHaveLength(3);
  });

  it("an unknown sitting is 'missing', and a sitting is 'loading' until its data arrives", async () => {
    const { provider } = await liveProvider(twoSittings());
    expect(provider.getCycleLoadState("nope")).toBe("missing");
    expect(provider.getCycle("nope")).toBeNull();
    const p = provider.ensureCycleLoaded(MAY);
    expect(provider.getCycleLoadState(MAY)).toBe("loading");
    await p;
    expect(provider.getCycleLoadState(MAY)).toBe("ready");
  });
});

describe("(a) two sittings with different data in one provider", () => {
  it("each sitting serves its own data, and opening B does not change A", async () => {
    const { provider } = await liveProvider(twoSittings());
    await provider.ensureCycleLoaded(FEB);
    const febBefore = JSON.stringify(provider.getGrades(FEB));
    const febRefBefore = provider.getCycle(FEB);

    await provider.ensureCycleLoaded(MAY);

    expect(provider.getGrades(MAY)!.rows.map((r) => r.studentId).sort()).toEqual(["amal@s.edu", "bilal@s.edu"]);
    expect(provider.getGrades(FEB)!.rows.map((r) => r.studentId).sort()).toEqual(["amal@s.edu", "bilal@s.edu", "carla@s.edu"]);
    expect(JSON.stringify(provider.getGrades(FEB))).toBe(febBefore); // A byte-identical after opening B
    expect(provider.getCycle(FEB)).toEqual(febRefBefore);
    // the same student has a DIFFERENT result in each sitting (amal: 3/4 vs 4/4)
    const amal = (id: string) => provider.getGrades(id)!.rows.find((r) => r.studentId === "amal@s.edu")!;
    expect(amal(FEB).overallRaw).not.toBe(amal(MAY).overallRaw);
  });

  it("a WRITE to A changes A and never touches B", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    await provider.ensureCycleLoaded(FEB);
    await provider.ensureCycleLoaded(MAY);
    const aFeb = provider.getCycle(FEB)!.assessments[0]!.id;
    const aMay = provider.getCycle(MAY)!.assessments[0]!.id;
    const mayBefore = JSON.stringify([provider.getReview(MAY, aMay), provider.getGrades(MAY), provider.getBoundaries(MAY, aMay)]);
    const febItems = provider.getReview(FEB, aFeb)!.items;
    const febBefore = JSON.stringify(provider.getGrades(FEB));

    provider.setItemExcluded(FEB, aFeb, febItems[0]!.id, true, "ambiguous wording");

    expect(provider.getReview(FEB, aFeb)!.items.find((i) => i.id === febItems[0]!.id)!.excluded).toBe(true);
    expect(JSON.stringify(provider.getGrades(FEB))).not.toBe(febBefore); // A recomputed
    expect(JSON.stringify([provider.getReview(MAY, aMay), provider.getGrades(MAY), provider.getBoundaries(MAY, aMay)])).toBe(mayBefore);
    // …and the RPC carried A's item id
    expect(fake.calls.filter((c) => c.name === "decide_item_exclusion").map((c) => c.args.p_item)).toEqual([febItems[0]!.id]);
  });

  it("a write addressed to a sitting that isn't loaded is dropped, not applied to another sitting", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    await provider.ensureCycleLoaded(MAY);
    const aMay = provider.getCycle(MAY)!.assessments[0]!.id;
    const mayBefore = JSON.stringify(provider.getReview(MAY, aMay));
    // FEB was never opened: there is nothing to write to.
    provider.setItemExcluded(FEB, "a-cyc-feb", "i0-cyc-feb", true, "x");
    expect(JSON.stringify(provider.getReview(MAY, aMay))).toBe(mayBefore);
    expect(fake.calls.some((c) => c.name === "decide_item_exclusion")).toBe(false);
  });

  it("id lookups are per sitting: a cohort exclusion in A resolves A's participant key", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    await provider.ensureCycleLoaded(FEB);
    await provider.ensureCycleLoaded(MAY);
    const bilalFeb = provider.getCycle(FEB) && provider.getRawData(FEB, provider.getCycle(FEB)!.assessments[0]!.id)!;
    void bilalFeb;
    provider.excludeParticipantFromCohort(FEB, `p-${FEB}-bilal@s.edu`, true, "staff");
    const call = fake.calls.find((c) => c.name === "set_cohort_exclusion")!;
    expect(call.args).toMatchObject({ p_cycle: FEB, p_key: "bilal@s.edu", p_remove: true });
    expect(provider.getCycle(MAY)!.participants).toBe(2); // B untouched
  });

  it("concurrent opens share ONE load", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    fake.clearLog();
    await Promise.all([provider.ensureCycleLoaded(FEB), provider.ensureCycleLoaded(FEB), provider.ensureCycleLoaded(FEB)]);
    expect(fake.log.filter((q) => q.table === "responses" && q.eq.cycle_id === FEB).length).toBe(2); // one paged read + its empty terminator
  });
});

describe("(b) creating a sitting does not change what the user is looking at", () => {
  it("the open sitting keeps its provider, data and edits; the new one appears unloaded", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    await provider.ensureCycleLoaded(MAY);
    const aMay = provider.getCycle(MAY)!.assessments[0]!.id;
    const item = provider.getReview(MAY, aMay)!.items[0]!;
    provider.setItemExcluded(MAY, aMay, item.id, true, "edit in progress"); // an edit the user has made
    const before = JSON.stringify([provider.getCycle(MAY), provider.getReview(MAY, aMay), provider.getGrades(MAY)]);
    fake.clearLog();

    const id = await provider.createCycle({
      name: "Resit", sittingDate: "2026-09-01", assessmentIds: [], testCentreId: CENTRE,
      sitting: "february", examYearId: YEAR, // Feb already exists → refused; use a fresh year below
    }).catch((e) => e as Error);
    expect(id).toBeInstanceOf(Error); // one sitting per (year, period)

    const created = await provider.createCycle({
      name: "Autumn", sittingDate: "2026-09-01", assessmentIds: [], testCentreId: CENTRE,
      sitting: "may", yearName: "2027",
    });

    // the sitting being viewed is untouched, edits included — same data, not reloaded
    expect(JSON.stringify([provider.getCycle(MAY), provider.getReview(MAY, aMay), provider.getGrades(MAY)])).toBe(before);
    expect(provider.getReview(MAY, aMay)!.items.find((i) => i.id === item.id)!.excluded).toBe(true);
    // no fact table was read for any existing sitting, and the new one was not opened either
    expect(fake.log.filter((q) => FACT_TABLES.includes(q.table))).toEqual([]);
    // the new sitting is listed, real, empty and not loaded
    expect(provider.listCycles().find((c) => c.id === created)).toMatchObject({ mock: false, locked: false, participants: 0 });
    expect(provider.getCycleLoadState(created)).toBe("loading");
    expect(provider.getCycle(created)!.loaded).toBe(false);
  });

  it("creating a sitting in a previously empty workspace works and leaves it unopened", async () => {
    const db = buildDb([]);
    const { provider } = await liveProvider(db);
    expect(provider.getAccessStatus()).toBe("no-cycle");
    const id = await provider.createCycle({ name: "May 2026", sittingDate: "2026-05-14", assessmentIds: [], testCentreId: CENTRE, sitting: "may", examYearId: YEAR });
    expect(provider.getAccessStatus()).toBe("ok");
    expect(provider.listCycles().map((c) => c.id)).toEqual([id]);
  });
});

describe("(d) lock state survives a reload", () => {
  it("locking stores status='locked' (no grades rows exist) and a FRESH provider shows it locked — before and after opening", async () => {
    const db = twoSittings();
    const first = await liveProvider(db);
    await first.provider.ensureCycleLoaded(FEB);
    first.provider.lockCycle(FEB);
    expect(first.provider.getCycle(FEB)!.locked).toBe(true);
    await vi.waitFor(() => expect(first.fake.calls.some((c) => c.name === "lock_grades")).toBe(true));
    expect(db.grades ?? []).toHaveLength(0); // lock_grades had no grades rows to flip
    expect(db.exam_cycles!.find((c) => c.id === FEB)!.status).toBe("locked");

    // "reload": a brand-new provider over the same database
    const second = await liveProvider(db);
    expect(second.provider.listCycles().find((c) => c.id === FEB)!.locked).toBe(true); // from the light list
    expect(second.provider.getCycle(FEB)!.locked).toBe(true);
    await second.provider.ensureCycleLoaded(FEB);
    expect(second.provider.getCycle(FEB)!.locked).toBe(true);
    expect(second.provider.getGrades(FEB)!.locked).toBe(true);
    // the other sitting is unaffected
    expect(second.provider.getCycle(MAY)!.locked).toBe(false);
  });

  it("a READ-ONLY viewer sees a locked sitting as locked (restored ungated)", async () => {
    const db = twoSittings();
    db.exam_cycles!.find((c) => c.id === FEB)!.status = "locked";
    const { provider } = await liveProvider(db, { role: "viewer" });
    await provider.ensureCycleLoaded(FEB);
    expect(provider.getGrades(FEB)!.locked).toBe(true);
  });

  it("unlock reopens it, and that also survives a reload", async () => {
    const db = twoSittings();
    db.exam_cycles!.find((c) => c.id === FEB)!.status = "locked";
    const first = await liveProvider(db);
    await first.provider.ensureCycleLoaded(FEB);
    first.provider.unlockCycle(FEB);
    expect(first.provider.getCycle(FEB)!.locked).toBe(false);
    await vi.waitFor(() => expect(db.exam_cycles!.find((c) => c.id === FEB)!.status).not.toBe("locked"));
    const second = await liveProvider(db);
    expect(second.provider.getCycle(FEB)!.locked).toBe(false);
  });

  it("a lock the local gate REFUSES sends no RPC (memory and database cannot diverge)", async () => {
    const db = twoSittings();
    const { provider, fake } = await liveProvider(db, { role: "viewer" });
    await provider.ensureCycleLoaded(MAY);
    provider.lockCycle(MAY);
    expect(provider.getCycle(MAY)!.locked).toBe(false);
    expect(fake.calls.some((c) => c.name === "lock_grades")).toBe(false);
    expect(db.exam_cycles!.find((c) => c.id === MAY)!.status).toBe("in_review");
  });

  it("locking an already-locked sitting is a no-op (no second RPC)", async () => {
    const db = twoSittings();
    db.exam_cycles!.find((c) => c.id === FEB)!.status = "locked";
    const { provider, fake } = await liveProvider(db);
    await provider.ensureCycleLoaded(FEB);
    provider.lockCycle(FEB);
    expect(fake.calls.some((c) => c.name === "lock_grades")).toBe(false);
  });

  it("if the server REFUSES the lock, the screen reverts to what the database holds", async () => {
    const db = twoSittings();
    const { provider, fake } = await liveProvider(db);
    await provider.ensureCycleLoaded(MAY);
    fake.failRpc("lock_grades", "not authorized");
    provider.lockCycle(MAY);
    expect(provider.getCycle(MAY)!.locked).toBe(true); // optimistic
    await vi.waitFor(() => expect(provider.getCycle(MAY)!.locked).toBe(false)); // reconciled from the DB
  });
});

describe("(e) the Years page does not hydrate every sitting", () => {
  it("loading the app + rendering the Years data reads no per-cycle fact table", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    // everything the Years page and sitting tiles read:
    const years = provider.listYears();
    provider.getYear(years[0]!.id);
    provider.listCycles();
    const touched = new Set(fake.log.map((q) => q.table));
    for (const t of FACT_TABLES) expect(touched.has(t), `the initial load read ${t}`).toBe(false);
    // …and the tiles still show real stats for BOTH sittings
    expect(years[0]).toMatchObject({ february: { participants: 3, assessments: 1 }, may: { participants: 2, assessments: 1 } });
  });

  it("opening ONE sitting reads only that sitting's responses", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    fake.clearLog();
    await provider.ensureCycleLoaded(FEB);
    const resp = fake.log.filter((q) => q.table === "responses");
    expect(resp.length).toBeGreaterThan(0);
    expect(resp.every((q) => q.eq.cycle_id === FEB)).toBe(true);
    expect(fake.log.some((q) => FACT_TABLES.includes(q.table) && q.eq.cycle_id === MAY)).toBe(false);
  });
});

describe("(step 5) a write refreshes only what it affects", () => {
  it("ingest reloads ONLY the ingested sitting", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    await provider.ensureCycleLoaded(FEB);
    await provider.ensureCycleLoaded(MAY);
    const mayInstanceData = JSON.stringify(provider.getGrades(MAY));
    fake.clearLog();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    try {
      await provider.ingestRawExport(FEB, { name: "f.csv", sizeMB: 1 }, [], { passed: true, checks: [], stats: { rawRows: 0, mcqRows: 0, droppedSurveyRows: 0, droppedNonMcqRows: 0, assessments: 0, participants: 0, items: 0 } } as never);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fake.log.some((q) => q.table === "responses" && q.eq.cycle_id === FEB)).toBe(true);
    expect(fake.log.some((q) => FACT_TABLES.includes(q.table) && q.eq.cycle_id === MAY)).toBe(false);
    expect(JSON.stringify(provider.getGrades(MAY))).toBe(mayInstanceData);
  });

  it("clear reloads ONLY the cleared sitting, which then reads as empty", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    await provider.ensureCycleLoaded(FEB);
    await provider.ensureCycleLoaded(MAY);
    fake.clearLog();
    await provider.clearSittingData(FEB);
    expect(provider.getCycle(FEB)).toMatchObject({ participants: 0, assessmentCount: 0 });
    expect(provider.getCycle(MAY)!.participants).toBe(2);
    expect(fake.log.some((q) => FACT_TABLES.includes(q.table) && q.eq.cycle_id === MAY)).toBe(false);
  });

  it("delete drops that sitting only; the other stays loaded and intact", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    await provider.ensureCycleLoaded(FEB);
    await provider.ensureCycleLoaded(MAY);
    const may = JSON.stringify(provider.getGrades(MAY));
    fake.clearLog();
    await provider.deleteSitting(FEB);
    expect(provider.listCycles().map((c) => c.id)).toEqual([MAY]);
    expect(provider.getCycleLoadState(FEB)).toBe("missing");
    expect(provider.getCycleLoadState(MAY)).toBe("ready");
    expect(JSON.stringify(provider.getGrades(MAY))).toBe(may);
    expect(fake.log.some((q) => FACT_TABLES.includes(q.table))).toBe(false);
  });

  it("a workspace change (new test centre) re-reads the workspace, not any sitting", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    await provider.ensureCycleLoaded(MAY);
    const before = JSON.stringify(provider.getGrades(MAY));
    fake.clearLog();
    provider.createTestCentre({ name: "Shatila 9", code: "SH9" });
    await vi.waitFor(() => expect(fake.log.some((q) => q.table === "test_centres")).toBe(true));
    expect(fake.log.some((q) => FACT_TABLES.includes(q.table))).toBe(false);
    expect(JSON.stringify(provider.getGrades(MAY))).toBe(before);
  });
});

describe("workspace state is shared by every sitting's provider", () => {
  it("a grading change made once is what BOTH sittings grade with", async () => {
    const { provider } = await liveProvider(twoSittings());
    await provider.ensureCycleLoaded(FEB);
    await provider.ensureCycleLoaded(MAY);
    provider.setGradingDefaults({ performanceLevels: ["Top", "Mid", "Low"], starMap: { Top: "**", Mid: "*", Low: "" } } as never);
    for (const id of [FEB, MAY]) {
      const g = provider.getGrades(id)!;
      expect(g.performanceLevels).toEqual(["Top", "Mid", "Low"]);
      expect(g.rows.every((r) => Object.values(r.grades).every((c) => ["Top", "Mid", "Low", ""].includes(c.level)))).toBe(true);
    }
  });
});

describe("failure handling", () => {
  it("a failed load shows 'error' for that sitting only, and a retry recovers", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    await provider.ensureCycleLoaded(MAY);
    fake.breakTable("items");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await provider.ensureCycleLoaded(FEB); // swallowed into state, never thrown at the page
    expect(provider.getCycleLoadState(FEB)).toBe("error");
    expect(provider.getCycleLoadState(MAY)).toBe("ready"); // the other sitting is unaffected
    expect(provider.getGrades(MAY)).not.toBeNull();

    fake.mend();
    await provider.ensureCycleLoaded(FEB); // the Retry button
    expect(provider.getCycleLoadState(FEB)).toBe("ready");
    expect(provider.getGrades(FEB)!.rows).toHaveLength(3);
    vi.restoreAllMocks();
  });

  it("a failed REFRESH keeps the sitting's previous data instead of blanking it", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    await provider.ensureCycleLoaded(FEB);
    const before = JSON.stringify(provider.getGrades(FEB));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    fake.breakTable("items");
    try {
      await provider.ingestRawExport(FEB, { name: "f.csv", sizeMB: 1 }, [], { passed: true, checks: [], stats: { rawRows: 0, mcqRows: 0, droppedSurveyRows: 0, droppedNonMcqRows: 0, assessments: 0, participants: 0, items: 0 } } as never);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
    expect(provider.getCycleLoadState(FEB)).toBe("ready");
    expect(JSON.stringify(provider.getGrades(FEB))).toBe(before);
  });
});

describe("workspace-level reads work with no sitting hosted by the directory", () => {
  it("every directory read is safe — with sittings, and in an empty workspace", async () => {
    for (const database of [twoSittings(), buildDb([])]) {
      const { provider } = await liveProvider(database);
      expect(() => {
        provider.listYears();
        provider.listCycles();
        provider.getConfig();
        provider.getScoringConfig();
        provider.getMembers();
        provider.getNewCycle();
        provider.getRoles();
        provider.getRoleActions();
        provider.getAuditLog(null, "all", "");
        provider.getAnalyticsTrends();
        provider.getOverallAnalytics();
        provider.getGradingDefaults();
        provider.getElementLabels();
        provider.getIncidentConfig();
        provider.listTestCentres();
      }).not.toThrow();
    }
  });

  it("the placeholder directory cycle never appears in the cycle list", async () => {
    const { provider } = await liveProvider(buildDb([]));
    expect(provider.listCycles()).toEqual([]);
    expect(provider.listYears()).toEqual([]);
    expect(provider.getCycle("")).toBeNull();
  });
});

describe("the heavy analytics projection loads on demand, not at sign-in", () => {
  it("is not read by the initial load, and is read once /analytics asks", async () => {
    const { provider, fake } = await liveProvider(twoSittings());
    const heavy = ["grades", "score_runs", "participant_scores"];
    expect(fake.log.some((q) => heavy.includes(q.table))).toBe(false);
    provider.getOverallAnalytics();
    await vi.waitFor(() => expect(fake.log.some((q) => q.table === "grades")).toBe(true));
    const reads = fake.log.filter((q) => q.table === "grades").length;
    provider.getOverallAnalytics(); // idempotent — does not refetch
    await Promise.resolve();
    expect(fake.log.filter((q) => q.table === "grades").length).toBe(reads);
  });
});
