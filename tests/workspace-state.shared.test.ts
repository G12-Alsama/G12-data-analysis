/**
 * Workspace-level state is SHARED BY REFERENCE across provider instances, while
 * cycle-level decision state stays private to each instance.
 *
 * This is the foundation of the multi-sitting provider: one WorkspaceState is handed to
 * the directory and to every per-sitting provider, so an edit made through any of them
 * (grading config, roles, centres, labels, audit, the signed-in user) is seen by all,
 * and nothing is copied or broadcast.
 */
import { describe, it, expect } from "vitest";
import seedJson from "@/lib/data/seed.generated.json";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { WorkspaceState } from "@/lib/data/workspace-state";
import type { Seed } from "@/lib/data/seed-types";

const clone = (): Seed => JSON.parse(JSON.stringify(seedJson)) as Seed;

/** Two providers over two different cycles, sharing one workspace. */
function pair() {
  const a = new InMemoryDataProvider(clone());
  const seedB = clone();
  seedB.liveCycle = { ...seedB.liveCycle, id: "cycle-B", name: "February 2026" };
  const b = new InMemoryDataProvider(seedB, undefined, true, a.getWorkspaceState());
  return { a, b, idA: a.listCycles()[0]!.id };
}

describe("shared workspace state", () => {
  it("is literally the same object", () => {
    const { a, b } = pair();
    expect(b.getWorkspaceState()).toBe(a.getWorkspaceState());
    expect(b.getWorkspaceState()).toBeInstanceOf(WorkspaceState);
  });

  it("roles created through one provider appear in the other", () => {
    const { a, b } = pair();
    a.createRole("Moderator");
    expect(b.getRoles().map((r) => r.name)).toContain("Moderator");
  });

  it("test centres created through one provider appear in the other", () => {
    const { a, b } = pair();
    a.createTestCentre({ name: "Shatila 9", code: "SH9" });
    expect(b.listTestCentres().map((c) => c.name)).toContain("Shatila 9");
  });

  it("grading config edited through one provider is what the other reads", () => {
    const { a, b } = pair();
    const before = b.getGradingDefaults().performanceLevels.length;
    a.setGradingDefaults({ performanceLevels: ["Top", "Mid", "Low"] } as never);
    expect(b.getGradingDefaults().performanceLevels).toEqual(a.getGradingDefaults().performanceLevels);
    expect(b.getGradingDefaults().performanceLevels.length).not.toBe(before);
  });

  it("the audit trail is shared, and entries keep their own cycle id", () => {
    const { a, b, idA } = pair();
    a.recordExport(idA, "scores.xlsx");
    const seen = b.getAuditLog(null, "all", "").entries.find((e) => !e.seeded && e.cycleId === idA);
    expect(seen).toBeDefined();
  });

  it("the signed-in user is shared", () => {
    const { a, b } = pair();
    a.setCurrentUser({ id: "u2", name: "Second", initials: "S", role: "viewer" });
    expect(b.getCurrentUser().id).toBe("u2");
  });

  it("cycle-level decisions are NOT shared: B's lock/exclusions never touch A", () => {
    const { a, b, idA } = pair();
    b.lockCycle("cycle-B");
    expect(b.getGrades("cycle-B")?.locked ?? true).toBe(true);
    expect(a.getGrades(idA)?.locked).toBe(false);
  });

  it("an instance with no workspace passed owns a fresh one (demo / tests unchanged)", () => {
    const x = new InMemoryDataProvider();
    const y = new InMemoryDataProvider();
    expect(x.getWorkspaceState()).not.toBe(y.getWorkspaceState());
    x.createRole("Only in x");
    expect(y.getRoles().map((r) => r.name)).not.toContain("Only in x");
  });
});
