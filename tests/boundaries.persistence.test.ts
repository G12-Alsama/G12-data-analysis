/**
 * Cut Scores page — saved cuts must survive a reload.
 *
 * Regression for: the page's auto-suggest effect was keyed on the in-memory
 * `suggestedCuts` snapshot, which is never persisted (`grade_schemes` stores only
 * `{scope, method, bands}`) and is therefore null on EVERY reload. So every page open
 * backsolved fresh cuts over the confirmed ones, re-saved them, and wrote an unprompted
 * `boundary_change` audit row. The fix keys the gate on a stored scheme existing
 * (`BoundaryModel.schemeStored`) and makes the automatic seed in-memory only.
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
  if (needsAutoSuggestion(model)) provider.setBoundary(CYC, scope, { suggest: true, auto: true });
}

describe("a stored scheme is never overwritten on load", () => {
  it("restores the saved cuts after a reload and sends no auto-suggest write or audit row", async () => {
    // 1. Open a fresh scope (auto-suggest), then a person types a cut → saved.
    const s1 = await load();
    runPageEffect(s1.provider, s1.scope);
    const suggested = [...s1.provider.getBoundaries(CYC, s1.scope)!.cuts];
    const typed = [suggested[0]! + 5, ...suggested.slice(1)];
    s1.provider.setBoundary(CYC, s1.scope, { cutIndex: 0, cutValue: typed[0]! });
    await vi.waitFor(() => expect(s1.provider.getBoundarySaveState(CYC, s1.scope).status).toBe("saved"));

    expect(saves(s1.fake)).toHaveLength(1); // only the explicit edit — the auto seed saved nothing
    const row = s1.fake.db.grade_schemes!.find((r) => r.scope === s1.scope)!;
    expect(row).toBeTruthy(); // grade_schemes row written
    expect((row.bands as { min: number }[]).slice(0, -1).map((b) => b.min)).toEqual(typed);

    // 2. Fresh load / replay from the stored row, as production does on reload.
    const s2 = await load(s1.fake.db);
    const m = s2.provider.getBoundaries(CYC, s2.scope)!;
    expect(m.cuts).toEqual(typed); // restored == saved
    expect(m.schemeStored).toBe(true);
    expect(m.suggestedCuts).toBeNull(); // the snapshot really is gone after a reload…
    expect(needsAutoSuggestion(m)).toBe(false); // …and that no longer triggers a suggestion

    // 3. Run the page effect: no write, no audit, cuts untouched.
    const auditBefore = boundaryAudit(s2.provider).length;
    runPageEffect(s2.provider, s2.scope);
    expect(s2.provider.getBoundaries(CYC, s2.scope)!.cuts).toEqual(typed);
    expect(saves(s2.fake)).toHaveLength(0);
    expect(boundaryAudit(s2.provider).length).toBe(auditBefore);
    expect(s2.provider.getBoundarySaveState(CYC, s2.scope).status).toBe("idle");
  });

  it("even a direct auto-suggest call cannot overwrite a stored scope (defence in depth)", async () => {
    const s1 = await load();
    s1.provider.setBoundary(CYC, s1.scope, { cutIndex: 0, cutValue: 60 });
    await vi.waitFor(() => expect(s1.provider.getBoundarySaveState(CYC, s1.scope).status).toBe("saved"));

    const s2 = await load(s1.fake.db);
    const before = [...s2.provider.getBoundaries(CYC, s2.scope)!.cuts];
    s2.provider.setBoundary(CYC, s2.scope, { suggest: true, auto: true });
    expect(s2.provider.getBoundaries(CYC, s2.scope)!.cuts).toEqual(before);
    expect(saves(s2.fake)).toHaveLength(0);
  });

  it("an EXPLICIT Suggest click on a stored scope still works, and is saved + audited", async () => {
    const s1 = await load();
    s1.provider.setBoundary(CYC, s1.scope, { cutIndex: 0, cutValue: 60 });
    await vi.waitFor(() => expect(s1.provider.getBoundarySaveState(CYC, s1.scope).status).toBe("saved"));
    const s2 = await load(s1.fake.db);
    const auditBefore = boundaryAudit(s2.provider).length;
    s2.provider.setBoundary(CYC, s2.scope, { suggest: true }); // user clicked Re-suggest
    expect(saves(s2.fake)).toHaveLength(1);
    expect(s2.provider.getBoundaries(CYC, s2.scope)!.suggestedCuts).not.toBeNull();
    expect(boundaryAudit(s2.provider).length).toBe(auditBefore + 1);
  });
});

describe("a scope with no stored scheme still gets its auto-suggestion", () => {
  it("seeds the backsolved suggestion in memory — no RPC, no audit row — and only once", async () => {
    const { provider, fake, scope } = await load();
    const m0 = provider.getBoundaries(CYC, scope)!;
    expect(m0.schemeStored).toBe(false);
    expect(needsAutoSuggestion(m0)).toBe(true);
    const auditBefore = boundaryAudit(provider).length;

    runPageEffect(provider, scope);

    const m1 = provider.getBoundaries(CYC, scope)!;
    expect(m1.suggestedCuts).toEqual(m1.suggestion.cuts); // adopted as the editable start
    expect(m1.cuts).toEqual(m1.suggestion.cuts);
    expect(m1.mode).toBe("cuts");
    expect(needsAutoSuggestion(m1)).toBe(false); // no loop
    expect(saves(fake)).toHaveLength(0); // unprompted seed is not persisted…
    expect(boundaryAudit(provider).length).toBe(auditBefore); // …nor audited
  });

  it("an unseeded scope with no data to backsolve, or a locked one, is left alone", () => {
    expect(needsAutoSuggestion({ locked: false, n: 0, suggestedCuts: null, schemeStored: false })).toBe(false);
    expect(needsAutoSuggestion({ locked: true, n: 5, suggestedCuts: null, schemeStored: false })).toBe(false);
    expect(needsAutoSuggestion(null)).toBe(false);
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
});
