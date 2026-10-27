/**
 * Cut Scores page — saved cuts must survive a reload.
 *
 * Regression for: the page's auto-suggest effect was keyed on the in-memory
 * `suggestedCuts` snapshot, which is never persisted (`grade_schemes` stores only
 * `{scope, method, bands}`) and is therefore null on EVERY reload. So every page open
 * backsolved fresh cuts over the confirmed ones, re-saved them, and wrote an unprompted
 * `boundary_change` audit row. The fix keys the gate on a stored scheme existing
 * (`BoundaryModel.schemeStored`): the first view of a fresh scope still saves (and
 * audits) its suggestion once, and from then on the scope is stored and never touched.
 *
 * Drives the real SupabaseDataProvider over the stateful fake backend, so "saved" means a
 * `save_grade_scheme` RPC that upserted a `grade_schemes` row, and "reload" means a NEW
 * provider hydrating from that row — the production path end to end.
 */
import { describe, it, expect, vi } from "vitest";
import { liveProvider } from "@/tests/helpers/fake-supabase-live";
import { buildDb } from "@/tests/helpers/multi-cycle-db";
import { needsAutoSuggestion } from "@/lib/data/boundary-suggest";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";

vi.mock("server-only", () => ({}));

const CYC = "cyc-feb";
const db = () =>
  buildDb([
    {
      id: CYC, name: "February 2026", sitting: "february", status: "in_review",
      students: {
        "a@s.edu": [1, 1, 1, 1], "b@s.edu": [1, 1, 1, 0], "c@s.edu": [1, 1, 0, 0],
        "d@s.edu": [1, 0, 0, 0], "e@s.edu": [0, 0, 0, 0], "f@s.edu": [1, 1, 1, 0],
      },
    },
  ]);

const saves = (fake: { calls: { name: string }[] }) => fake.calls.filter((c) => c.name === "save_grade_scheme");
const boundaryAudit = (p: { getAuditLog: InMemoryDataProvider["getAuditLog"] }) =>
  p.getAuditLog(CYC, "all", "").entries.filter((e) => e.type === "boundary");

async function load(database = db()) {
  const { provider, fake } = await liveProvider(database);
  await provider.ensureCycleLoaded(CYC);
  const scope = provider.getCycle(CYC)!.assessments[0]!.id;
  return { provider, fake, scope };
}

/** What the page's effect does on open (page.tsx), verbatim. */
function runPageEffect(provider: { getBoundaries: Function; setBoundary: Function }, scope: string) {
  const model = provider.getBoundaries(CYC, scope);
  if (needsAutoSuggestion(model)) provider.setBoundary(CYC, scope, { suggest: true });
}

describe("never-opened scope", () => {
  it("stays on the workspace defaults with zero stored rows", async () => {
    const { provider, fake, scope } = await load();
    const m = provider.getBoundaries(CYC, scope)!;
    expect(m.schemeStored).toBe(false);
    expect(m.suggestedCuts).toBeNull();
    expect(fake.db.grade_schemes ?? []).toHaveLength(0);
    expect(saves(fake)).toHaveLength(0);
    expect(boundaryAudit(provider)).toHaveLength(0);
    // …and the page WOULD seed it on first view (the legitimate case):
    expect(needsAutoSuggestion(m)).toBe(true);
  });

  it("is left alone when there is nothing to backsolve, or the sitting is locked", () => {
    expect(needsAutoSuggestion({ locked: false, n: 0, suggestedCuts: null, schemeStored: false })).toBe(false);
    expect(needsAutoSuggestion({ locked: true, n: 5, suggestedCuts: null, schemeStored: false })).toBe(false);
    expect(needsAutoSuggestion(null)).toBe(false);
  });
});

describe("scope opened once, never edited", () => {
  it("saves + audits the suggestion on first view; a reload restores it and writes nothing", async () => {
    // First view: the page effect seeds the suggestion — saved and audited, once.
    const s1 = await load();
    runPageEffect(s1.provider, s1.scope);
    await vi.waitFor(() => expect(s1.provider.getBoundarySaveState(CYC, s1.scope).status).toBe("saved"));
    const m1 = s1.provider.getBoundaries(CYC, s1.scope)!;
    expect(m1.suggestedCuts).toEqual(m1.suggestion.cuts);
    expect(saves(s1.fake)).toHaveLength(1);
    expect(boundaryAudit(s1.provider)).toHaveLength(1);
    const row = s1.fake.db.grade_schemes!.find((r) => r.scope === s1.scope)!;
    expect((row.bands as { min: number }[]).slice(0, -1).map((b) => b.min)).toEqual(m1.cuts);

    // The effect cannot re-run in this session (no loop, no second save).
    runPageEffect(s1.provider, s1.scope);
    expect(saves(s1.fake)).toHaveLength(1);

    // Reload from the stored row — THE original bug: this must not overwrite or re-save.
    const s2 = await load(s1.fake.db);
    const m2 = s2.provider.getBoundaries(CYC, s2.scope)!;
    expect(m2.cuts).toEqual(m1.cuts); // same cuts
    expect(m2.schemeStored).toBe(true);
    expect(m2.suggestedCuts).toBeNull(); // the snapshot really is gone after a reload…
    expect(needsAutoSuggestion(m2)).toBe(false); // …and no longer triggers a suggestion
    runPageEffect(s2.provider, s2.scope);
    expect(s2.provider.getBoundaries(CYC, s2.scope)!.cuts).toEqual(m1.cuts);
    expect(saves(s2.fake)).toHaveLength(0); // no second save_grade_scheme call
    expect(boundaryAudit(s2.provider)).toHaveLength(0); // no new boundary_change audit row
    expect(s2.provider.getBoundarySaveState(CYC, s2.scope).status).toBe("idle");
  });
});

describe("scope with an explicit user edit", () => {
  it("saves the edit, and a reload never auto-overwrites it", async () => {
    const s1 = await load();
    runPageEffect(s1.provider, s1.scope);
    const suggested = [...s1.provider.getBoundaries(CYC, s1.scope)!.cuts];
    const typed = [suggested[0]! + 5, ...suggested.slice(1)];
    s1.provider.setBoundary(CYC, s1.scope, { cutIndex: 0, cutValue: typed[0]! }); // CutInput Enter/blur
    await vi.waitFor(() => expect(s1.provider.getBoundarySaveState(CYC, s1.scope).status).toBe("saved"));
    const row = s1.fake.db.grade_schemes!.find((r) => r.scope === s1.scope)!;
    expect((row.bands as { min: number }[]).slice(0, -1).map((b) => b.min)).toEqual(typed);

    const s2 = await load(s1.fake.db);
    const m = s2.provider.getBoundaries(CYC, s2.scope)!;
    expect(m.cuts).toEqual(typed);
    expect(needsAutoSuggestion(m)).toBe(false);
    runPageEffect(s2.provider, s2.scope);
    expect(s2.provider.getBoundaries(CYC, s2.scope)!.cuts).toEqual(typed);
    expect(saves(s2.fake)).toHaveLength(0);
    expect(boundaryAudit(s2.provider)).toHaveLength(0);
  });
});

describe("explicit Re-suggest on an already-stored scope", () => {
  it("still saves and audits — a deliberate action, regardless of schemeStored", async () => {
    const s1 = await load();
    s1.provider.setBoundary(CYC, s1.scope, { cutIndex: 0, cutValue: 60 });
    await vi.waitFor(() => expect(s1.provider.getBoundarySaveState(CYC, s1.scope).status).toBe("saved"));

    const s2 = await load(s1.fake.db);
    expect(s2.provider.getBoundaries(CYC, s2.scope)!.schemeStored).toBe(true);
    const auditBefore = boundaryAudit(s2.provider).length;
    s2.provider.setBoundary(CYC, s2.scope, { suggest: true }); // user clicked Re-suggest
    expect(saves(s2.fake)).toHaveLength(1);
    expect(s2.provider.getBoundaries(CYC, s2.scope)!.suggestedCuts).not.toBeNull();
    expect(boundaryAudit(s2.provider).length).toBe(auditBefore + 1);
    await vi.waitFor(() => expect(s2.provider.getBoundarySaveState(CYC, s2.scope).status).toBe("saved"));
    const row = s2.fake.db.grade_schemes!.find((r) => r.scope === s2.scope)!;
    expect((row.bands as { min: number }[]).slice(0, -1).map((b) => b.min)).toEqual(s2.provider.getBoundaries(CYC, s2.scope)!.cuts);
  });
});

describe("save state is visible (a rejected save is not silent)", () => {
  it("goes saving → saved, and surfaces the server's refusal as error", async () => {
    const { provider, fake, scope } = await load();
    expect(provider.getBoundarySaveState(CYC, scope).status).toBe("idle");

    provider.setBoundary(CYC, scope, { cutIndex: 0, cutValue: 70 });
    expect(provider.getBoundarySaveState(CYC, scope).status).toBe("saving");
    await vi.waitFor(() => expect(provider.getBoundarySaveState(CYC, scope).status).toBe("saved"));

    fake.failRpc("save_grade_scheme", "not authorized");
    provider.setBoundary(CYC, scope, { cutIndex: 0, cutValue: 72 });
    await vi.waitFor(() => expect(provider.getBoundarySaveState(CYC, scope)).toEqual({ status: "error", message: "not authorized" }));
  });

  it("a rejected first-view save is surfaced too, not swallowed (e.g. a non-lead_admin)", async () => {
    const { provider, fake, scope } = await load();
    fake.failRpc("save_grade_scheme", "not authorized");
    runPageEffect(provider, scope);
    await vi.waitFor(() => expect(provider.getBoundarySaveState(CYC, scope)).toEqual({ status: "error", message: "not authorized" }));
  });
});
