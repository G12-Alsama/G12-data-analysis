/**
 * Cronbach's Alpha (reliability) tests. Additive engine output — these do not
 * affect the parity gate (which is asserted separately to stay byte-identical).
 *
 * Covers: binary items reduce to KR-20; the general formula is correct for mixed
 * MCQ + polytomous items; k < 2 → n/a; negative α surfaces (not clamped);
 * grouping by each construct tag returns the right item sets; and a real-data run
 * over a parity fixture reports k and n at every level.
 */
import { describe, it, expect } from "vitest";
import { getEngine, cronbachAlpha } from "@/lib/engine";
import type { ItemMeta, ResponseRecord } from "@/lib/engine";
import { loadParityFixtures } from "./fixtures";

const engine = getEngine();

/** Independent KR-20 for a binary matrix (population variances). */
function kr20(matrix: number[][]): number {
  const n = matrix.length;
  const k = matrix[0]!.length;
  const popVar = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length;
  };
  let sumPQ = 0;
  for (let j = 0; j < k; j++) {
    const col = matrix.map((r) => r[j]!);
    const p = col.reduce((a, b) => a + b, 0) / n;
    sumPQ += p * (1 - p);
  }
  const totals = matrix.map((r) => r.reduce((a, b) => a + b, 0));
  return (k / (k - 1)) * (1 - sumPQ / popVar(totals));
}

describe("cronbachAlpha — core", () => {
  it("for dichotomous items, equals KR-20 exactly", () => {
    const m = [
      [1, 1, 1, 0, 1],
      [1, 1, 0, 1, 1],
      [1, 0, 1, 1, 0],
      [0, 1, 1, 0, 1],
      [1, 1, 0, 1, 0],
      [0, 0, 1, 1, 1],
    ];
    const got = cronbachAlpha(m);
    expect(got.alpha).not.toBeNull();
    expect(got.alpha!).toBeCloseTo(kr20(m), 6);
    expect(got.k).toBe(5);
    expect(got.n).toBe(6);
  });

  it("uses the general (score-variance) formula for mixed MCQ + polytomous items", () => {
    // two 0/1 MCQs + one 0–20 essay item; hand-computed α = 0.385.
    const m = [
      [1, 0, 12],
      [1, 1, 15],
      [0, 1, 9],
      [1, 1, 18],
      [0, 0, 7],
    ];
    const got = cronbachAlpha(m);
    expect(got.alpha!).toBeCloseTo(0.385, 3);
    expect(got.k).toBe(3);
  });

  it("returns n/a (null) when there are fewer than 2 items", () => {
    const got = cronbachAlpha([[1], [0], [1]]);
    expect(got.alpha).toBeNull();
    expect(got.note).toMatch(/too few items/i);
    expect(got.k).toBe(1);
  });

  it("surfaces a negative α as-is — never clamped to zero", () => {
    // anti-consistent items with varying totals → genuinely negative α.
    const m = [
      [1, 1, 1, 0],
      [1, 1, 0, 0],
      [1, 0, 1, 1],
      [0, 1, 1, 0],
      [1, 1, 1, 1],
    ];
    const got = cronbachAlpha(m);
    expect(got.alpha).not.toBeNull();
    expect(got.alpha!).toBeLessThan(0);
  });

  it("returns n/a when the total score has no variance", () => {
    const got = cronbachAlpha([
      [1, 0],
      [0, 1],
      [1, 0],
    ]); // every total = 1
    expect(got.alpha).toBeNull();
    expect(got.note).toMatch(/no score variance/i);
  });
});

describe("computeReliability — grouping by construct tag", () => {
  // Two subjects; subject S1 carries major/sub/demand and a context tag on some
  // items; subject S2 carries only demand. Three students, all complete.
  const items: ItemMeta[] = [
    { itemId: "i1", assessmentId: "S1", majorElement: "Number", subElement: "Add", demandLevel: "D1", context: "Bio" },
    { itemId: "i2", assessmentId: "S1", majorElement: "Number", subElement: "Add", demandLevel: "D2", context: "Bio" },
    { itemId: "i3", assessmentId: "S1", majorElement: "Number", subElement: "Mul", demandLevel: "D1" },
    { itemId: "i4", assessmentId: "S2", demandLevel: "D1" },
    { itemId: "i5", assessmentId: "S2", demandLevel: "D3" },
  ];
  const students = [
    { id: "p1", scores: [1, 0, 1, 1, 0] },
    { id: "p2", scores: [1, 1, 0, 0, 1] },
    { id: "p3", scores: [0, 1, 1, 1, 1] },
  ];
  const responses: ResponseRecord[] = students.flatMap((s) =>
    items.map((it, j) => ({ participantId: s.id, itemId: it.itemId, assessmentId: it.assessmentId, score: s.scores[j]! })),
  );
  const result = engine.computeReliability({ responses, items });
  const g = (pred: (x: (typeof result.groups)[number]) => boolean) => result.groups.filter(pred);

  it("tags the engine version on the result", () => {
    expect(result.engineVersion).toBe(engine.version);
  });

  it("produces one overall-exam group spanning all items", () => {
    const overall = g((x) => x.level === "overall");
    expect(overall).toHaveLength(1);
    expect(overall[0]!.k).toBe(5);
    expect(overall[0]!.assessmentId).toBeNull();
  });

  it("produces a per-subject group for each subject with the right item counts", () => {
    const subjects = g((x) => x.level === "subject");
    expect(subjects.map((s) => s.assessmentId).sort()).toEqual(["S1", "S2"]);
    expect(subjects.find((s) => s.assessmentId === "S1")!.k).toBe(3);
    expect(subjects.find((s) => s.assessmentId === "S2")!.k).toBe(2);
  });

  it("groups by major element from the tags present, but not sub-element (removed as noise)", () => {
    const majors = g((x) => x.level === "majorElement");
    expect(majors).toHaveLength(1); // only S1 has majors
    expect(majors[0]!.k).toBe(3); // i1,i2,i3
    // sub-element α was removed as non-actionable — no subElement groups are produced
    expect(g((x) => x.level === "subElement")).toHaveLength(0);
  });

  it("groups by demand level within each subject, excluding untagged items", () => {
    const demand = g((x) => x.level === "demandLevel");
    // S1: D1 (i1,i3), D2 (i2); S2: D1 (i4), D3 (i5)
    expect(demand.find((d) => d.assessmentId === "S1" && d.label === "D1")!.k).toBe(2);
    expect(demand.find((d) => d.assessmentId === "S2" && d.label === "D3")!.k).toBe(1);
  });

  it("also produces a cross-subject group per demand tag (assessmentId null), spanning every subject that carries it", () => {
    const demandAll = g((x) => x.level === "demandLevel" && x.assessmentId === null);
    // D1 spans S1 (i1,i3) + S2 (i4); D2 is S1-only (i2); D3 is S2-only (i5).
    expect(demandAll.find((d) => d.label === "D1")!.k).toBe(3);
    expect(demandAll.find((d) => d.label === "D2")!.k).toBe(1);
    expect(demandAll.find((d) => d.label === "D3")!.k).toBe(1);
  });

  it("only produces context groups where a context tag exists", () => {
    const ctx = g((x) => x.level === "context");
    expect(ctx).toHaveLength(1); // only S1's Bio
    expect(ctx[0]!.label).toBe("Bio");
    expect(ctx[0]!.k).toBe(2); // i1,i2
    // S2 has no context tag → no context group for it
    expect(ctx.some((c) => c.assessmentId === "S2")).toBe(false);
  });
});

describe("computeReliability — real fixture reports k and n at every level", () => {
  const fixtures = loadParityFixtures();
  const ASSESSMENT = "Applicable Math";
  const a = fixtures[ASSESSMENT]!;
  const responses: ResponseRecord[] = a.responses.map((r) => ({
    participantId: r.student,
    itemId: String(r.qid),
    assessmentId: ASSESSMENT,
    score: r.score,
  }));
  const items: ItemMeta[] = a.items.map((it) => ({
    itemId: String(it.qid),
    assessmentId: ASSESSMENT,
    majorElement: it.major,
    subElement: it.sub,
    demandLevel: it.demand,
  }));

  it("computes overall + per-subject α with k and n, flags small samples", () => {
    const { groups } = engine.computeReliability({ responses, items });
    const overall = groups.find((x) => x.level === "overall")!;
    expect(overall.k).toBe(a.items.length);
    expect(overall.n).toBeGreaterThan(0);
    expect(overall.smallSample).toBe(true); // n ≈ 18 at this scale
    // every group reports k and n, and either a numeric α or an n/a note
    for (const grp of groups) {
      expect(grp.k).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(grp.n)).toBe(true);
      if (grp.alpha === null) expect(grp.note).toBeTruthy();
      else expect(grp.note).toBeNull();
      if (grp.k < 2) expect(grp.alpha).toBeNull();
    }
  });

  it("does not change the existing item statistics (additive only)", () => {
    // computeItemStats output is unchanged by the presence of reliability.
    const stats = engine.computeItemStats({ responses, items });
    expect(stats).toHaveLength(a.items.length);
    // parity gate is asserted in engine.parity.test.ts; here we just confirm the
    // two outputs are independent and both available.
    expect(engine.computeReliability({ responses, items }).groups.length).toBeGreaterThan(0);
  });
});
