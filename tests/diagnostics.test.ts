/**
 * Speededness & timing diagnostics (Part 5) — pinned against hand-computed
 * values so the in-app numbers match the team's notebook definitions.
 */
import { describe, it, expect } from "vitest";
import {
  speededness,
  timingPerformance,
  lateItemIds,
  pearson,
  spearman,
  correlationStrength,
  speededByDemand,
  speededByItemSet,
  timingByDemand,
  omissionByPosition,
  buildAssessmentDiagnostics,
  cleanDiagResponses,
  type DiagResponse,
} from "@/lib/diagnostics";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";

function r(participantId: string, itemId: string, order: number, answered: boolean, correct: boolean, responseTime: number | null, demandLevel: string | null = null, itemSet: string | null = null): DiagResponse {
  return { participantId, itemId, demandLevel, itemSet, order, answered, correct, responseTime };
}

describe("late-item selection", () => {
  it("takes the final 25% of unique items by earliest order (ceil, min 1)", () => {
    // 4 items → ceil(0.25*4)=1 late item (the last by order)
    const recs = [r("a", "Q1", 0, true, true, 10), r("a", "Q2", 1, true, true, 10), r("a", "Q3", 2, true, true, 10), r("a", "Q4", 3, true, true, 10)];
    expect([...lateItemIds(recs)]).toEqual(["Q4"]);
    // 1 item → min 1 late item
    expect([...lateItemIds([r("a", "Q1", 0, true, true, 5)])]).toEqual(["Q1"]);
  });
});

describe("speededness index", () => {
  it("is 0 when omission and accuracy are flat across early/late", () => {
    // 4 items, 2 students, everyone answers all correctly → no omission, no accuracy drop
    const recs: DiagResponse[] = [];
    for (const p of ["s1", "s2"]) for (let q = 1; q <= 4; q++) recs.push(r(p, `Q${q}`, q - 1, true, true, 20));
    const res = speededness(recs);
    expect(res.omissionRate).toBe(0);
    expect(res.completion).toBe(1);
    expect(res.speedednessIndex).toBe(0);
    expect(res.speededStatus).toBe("Good");
    expect(res.completionStatus).toBe("Good");
  });

  it("captures late omission + a late accuracy drop", () => {
    // 4 items (Q4 is the late quarter). Early (Q1-3): all answered & correct.
    // Late (Q4): both students omit it → lateOmission 1, earlyOmission 0.
    // earlyAccuracy = 1 (all early attempts correct); lateAccuracy = 0 (no late
    // attempts → accuracy 0). Index = (max(0,1-0) + max(0,1-0))/2 = 1.
    const recs: DiagResponse[] = [];
    for (const p of ["s1", "s2"]) {
      for (let q = 1; q <= 3; q++) recs.push(r(p, `Q${q}`, q - 1, true, true, 20));
      recs.push(r(p, "Q4", 3, false, false, null)); // omitted late item
    }
    const res = speededness(recs);
    expect(res.earlyOmission).toBe(0);
    expect(res.lateOmission).toBe(1);
    expect(res.earlyAccuracy).toBe(1);
    expect(res.lateAccuracy).toBe(0);
    expect(res.speedednessIndex).toBe(1);
    expect(res.speededStatus).toBe("Flag");
    // 2 students × 1 omitted of 4 items = 8 presentations, 2 omitted → 0.25
    expect(res.omissionRate).toBe(0.25);
    expect(res.omissionStatus).toBe("Flag");
  });
});

describe("correlations", () => {
  it("pearson is exact on a perfect positive line", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10);
  });
  it("spearman handles ties via average ranks", () => {
    expect(spearman([1, 2, 2, 3], [1, 2, 2, 3])).toBeCloseTo(1, 10);
  });
  it("labels correlation strength with direction", () => {
    expect(correlationStrength(0.62)).toBe("Strong positive");
    expect(correlationStrength(-0.2)).toBe("Weak negative");
    expect(correlationStrength(0.02)).toBe("Negligible");
    expect(correlationStrength(null)).toBe("Undefined");
  });

  it("timing–performance correlates student median time with score %", () => {
    // 3 students, 2 items each. Slower students score higher → positive corr.
    const recs: DiagResponse[] = [
      r("s1", "Q1", 0, true, false, 10), r("s1", "Q2", 1, true, false, 10), // 0% , med 10
      r("s2", "Q1", 0, true, true, 20), r("s2", "Q2", 1, true, false, 20), // 50%, med 20
      r("s3", "Q1", 0, true, true, 30), r("s3", "Q2", 1, true, true, 30), // 100%, med 30
    ];
    const res = timingPerformance(recs);
    expect(res.nStudents).toBe(3);
    expect(res.pearson).toBeCloseTo(1, 4);
    expect(res.spearman).toBeCloseTo(1, 4);
    expect(res.pearsonStrength).toBe("Very strong positive");
  });
});

describe("speededness by demand level", () => {
  it("splits speededness by D1/D2/D3 in fixed order, only present levels", () => {
    // D1 items all answered; D3 items all omitted late → D3 should flag.
    const recs: DiagResponse[] = [];
    for (const p of ["s1", "s2"]) {
      recs.push(r(p, "Q1", 0, true, true, 20, "D1"));
      recs.push(r(p, "Q2", 1, true, true, 20, "D1"));
      recs.push(r(p, "Q3", 2, false, false, null, "D3")); // omitted
    }
    const byD = speededByDemand(recs);
    expect(byD.map((d) => d.demand)).toEqual(["D1", "D3"]); // D2 absent, fixed order
    const d1 = byD.find((d) => d.demand === "D1")!.speeded;
    const d3 = byD.find((d) => d.demand === "D3")!.speeded;
    expect(d1.omissionRate).toBe(0);
    expect(d3.omissionRate).toBe(1);
    expect(d3.omissionStatus).toBe("Flag");
  });
  it("ignores untagged (null demand) items entirely", () => {
    const recs = [r("s1", "Q1", 0, true, true, 10), r("s1", "Q2", 1, true, true, 10)];
    expect(speededByDemand(recs)).toEqual([]);
  });
});

describe("timing by demand level", () => {
  it("splits the timing correlation by D1/D2/D3 in fixed order, only present levels", () => {
    // Within each tier slower students score higher → positive correlation.
    const recs: DiagResponse[] = [];
    let order = 0;
    for (const [p, mult] of [["s1", 1], ["s2", 2], ["s3", 3]] as const) {
      recs.push(r(p, "Q1", order++, true, mult >= 2, 10 * mult, "D1"));
      recs.push(r(p, "Q2", order++, true, mult >= 3, 10 * mult, "D3"));
    }
    const byT = timingByDemand(recs);
    expect(byT.map((d) => d.demand)).toEqual(["D1", "D3"]); // D2 absent, fixed order
    for (const d of byT) {
      expect(d.timing.nStudents).toBe(3);
      expect(d.timing.pearson).not.toBeNull();
    }
  });
  it("ignores untagged (null demand) items entirely", () => {
    const recs = [r("s1", "Q1", 0, true, true, 10), r("s2", "Q1", 1, true, false, 20)];
    expect(timingByDemand(recs)).toEqual([]);
  });
});

describe("cleanDiagResponses (P-B matrix construction)", () => {
  it("dedupes (participant, item) keeping the last row and drops excluded participants", () => {
    const recs: DiagResponse[] = [
      r("s1", "Q1", 0, true, false, 5),
      r("s1", "Q1", 1, true, true, 9), // supersedes the earlier s1/Q1 row
      r("staff", "Q1", 2, true, true, 7),
    ];
    const clean = cleanDiagResponses(recs, { excludedParticipantIds: new Set(["staff"]) });
    expect(clean).toHaveLength(1);
    expect(clean[0]).toMatchObject({ participantId: "s1", itemId: "Q1", correct: true, responseTime: 9 });
  });
});

describe("speededness by item set", () => {
  it("splits speededness by shared-stimulus name, alphabetical, ignoring ungrouped items", () => {
    const recs: DiagResponse[] = [];
    for (const p of ["s1", "s2"]) {
      recs.push(r(p, "Q1", 0, true, true, 20, "D1", "Zebra passage"));
      recs.push(r(p, "Q2", 1, false, false, null, "D2", "Apple passage")); // omitted
      recs.push(r(p, "Q3", 2, true, true, 20, "D1", null)); // ungrouped — ignored
    }
    const sets = speededByItemSet(recs);
    expect(sets.map((s) => s.itemSet)).toEqual(["Apple passage", "Zebra passage"]); // alphabetical, no null
    expect(sets.find((s) => s.itemSet === "Apple passage")!.speeded.omissionRate).toBe(1);
    expect(sets.find((s) => s.itemSet === "Zebra passage")!.speeded.omissionRate).toBe(0);
  });
});

describe("omission rate by position", () => {
  it("orders items by earliest presented order, 1-based, carrying demand", () => {
    // Q1 (D1) answered by both; Q2 (D3) omitted by one of two.
    const recs: DiagResponse[] = [
      r("s1", "Q1", 0, true, true, 10, "D1"), r("s2", "Q1", 0, true, true, 10, "D1"),
      r("s1", "Q2", 1, false, false, null, "D3"), r("s2", "Q2", 1, true, false, 10, "D3"),
    ];
    const series = omissionByPosition(recs);
    expect(series.map((p) => p.position)).toEqual([1, 2]);
    expect(series[0]).toMatchObject({ itemId: "Q1", demandLevel: "D1", omissionRate: 0, nPresentations: 2, omitted: 0 });
    expect(series[1]).toMatchObject({ itemId: "Q2", demandLevel: "D3", omissionRate: 0.5, nPresentations: 2, omitted: 1 });
  });
});

describe("buildAssessmentDiagnostics", () => {
  it("bundles whole-assessment speeded+timing, by-demand, by-item-set, and omission-by-position", () => {
    const recs: DiagResponse[] = [
      r("s1", "Q1", 0, true, true, 10, "D1", "Passage A"), r("s2", "Q1", 0, true, false, 20, "D1", "Passage A"),
      r("s1", "Q2", 1, true, true, 30, "D3", "Passage A"), r("s2", "Q2", 1, false, false, null, "D3", "Passage A"),
    ];
    const diag = buildAssessmentDiagnostics(recs);
    expect(diag.whole.speeded.nItems).toBe(2);
    expect(diag.whole.timing.nStudents).toBeGreaterThanOrEqual(0);
    expect(diag.byDemand.map((d) => d.demand)).toEqual(["D1", "D3"]);
    expect(diag.timingByDemand.map((d) => d.demand)).toEqual(["D1", "D3"]);
    expect(diag.byItemSet.map((s) => s.itemSet)).toEqual(["Passage A"]);
    expect(diag.omissionByPosition).toHaveLength(2);
  });
});

describe("diagnostics recompute live over Clean-stage removals", () => {
  it("a per-subject removal (setCleanRemoval) drops that participant's data from getDiagnostics", () => {
    const p = new InMemoryDataProvider();
    const cycleId = p.listCycles()[0]!.id;
    const assessmentId = p.getCycle(cycleId)!.assessments[0]!.id;
    const victim = p.getNaiveScores(cycleId, assessmentId)!.students[0]!.id;

    const before = p.getDiagnostics(cycleId)!.assessments.find((a) => a.assessmentId === assessmentId)!;

    p.setCleanRemoval(cycleId, assessmentId, { rows: [victim] }, true);
    const after = p.getDiagnostics(cycleId)!.assessments.find((a) => a.assessmentId === assessmentId)!;

    // Previously getDiagnostics() returned the static ingest-time snapshot, so a
    // Clean removal never showed up here — it now must recompute over the reduced
    // cohort, so presentations (and student counts feeding the timing corr.) drop.
    expect(after.whole.speeded.nPresentations).toBeLessThan(before.whole.speeded.nPresentations);
    expect(after.whole.timing.nStudents).toBeLessThanOrEqual(before.whole.timing.nStudents);
    expect(after).not.toEqual(before);

    // Reversible: restoring the row brings the figures back exactly.
    p.setCleanRemoval(cycleId, assessmentId, { rows: [victim] }, false);
    const restored = p.getDiagnostics(cycleId)!.assessments.find((a) => a.assessmentId === assessmentId)!;
    expect(restored).toEqual(before);
  });

  it("a cohort-wide removal (excludeParticipantFromCohort) drops that participant's data from every affected subject", () => {
    const p = new InMemoryDataProvider();
    const cycleId = p.listCycles()[0]!.id;
    const cyc = p.getCycle(cycleId)!;
    // A participant present in every subject, so the cohort exclusion is visible
    // in each subject's diagnostics, not just one.
    const present = cyc.assessments.map((a) => new Set(p.getNaiveScores(cycleId, a.id)!.students.map((s) => s.id)));
    const victim = [...present[0]!].find((id) => present.every((set) => set.has(id)))!;

    const before = p.getDiagnostics(cycleId)!;

    p.excludeParticipantFromCohort(cycleId, victim, true, "Staff / test account");
    const after = p.getDiagnostics(cycleId)!;

    for (const b of before.assessments) {
      const a = after.assessments.find((x) => x.assessmentId === b.assessmentId)!;
      expect(a.whole.speeded.nPresentations).toBeLessThan(b.whole.speeded.nPresentations);
    }

    // Reversible.
    p.excludeParticipantFromCohort(cycleId, victim, false);
    const restored = p.getDiagnostics(cycleId)!;
    expect(restored).toEqual(before);
  });
});

describe("provider diagnostics read-model", () => {
  it("exposes whole-assessment + demand + position diagnostics from the seed", () => {
    const p = new InMemoryDataProvider();
    const model = p.getDiagnostics("may-2026")!;
    expect(model.assessments.length).toBe(5);
    for (const a of model.assessments) {
      // whole-assessment speededness: valid band, rates in [0,1]
      const s = a.whole.speeded;
      expect(["Good", "Review", "Flag"]).toContain(s.speededStatus);
      expect(s.omissionRate).toBeGreaterThanOrEqual(0);
      expect(s.completion).toBeLessThanOrEqual(1);
      // whole-assessment timing correlation is in [-1, 1] or null
      const t = a.whole.timing;
      if (t.pearson !== null) {
        expect(t.pearson).toBeGreaterThanOrEqual(-1);
        expect(t.pearson).toBeLessThanOrEqual(1);
      }
      // demand lens uses only D1/D2/D3 in fixed order
      const demands = a.byDemand.map((d) => d.demand);
      expect(demands).toEqual([...demands].filter((d) => ["D1", "D2", "D3"].includes(d)));
      expect(demands).toEqual([...new Set(demands)]);
      // omission-by-position is 1-based and contiguous
      a.omissionByPosition.forEach((pt, i) => {
        expect(pt.position).toBe(i + 1);
        expect(pt.omissionRate).toBeGreaterThanOrEqual(0);
        expect(pt.omissionRate).toBeLessThanOrEqual(1);
      });
    }
  });
});
