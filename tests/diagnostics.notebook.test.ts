/**
 * P-C — timing/performance + speededness/omission reproduce the analyst's two
 * notebooks (the oracle), the same way P-B pinned item statistics.
 *
 * Three gates:
 *  1. REPRODUCED vs APP — the analyst notebooks' reference tables for Applicable
 *     Math (whole-assessment + per-demand speededness/omission, and per-demand
 *     timing↔performance) reproduced independently and matched to the engine to
 *     4 dp. The `REPRODUCED` block below is computed by a standalone reference
 *     implementation of the notebook formulae (see docs/diagnostics-parity.md and
 *     scripts/diagnostics-reproduce.mts); this test pins the app engine against it.
 *  2. KEYS ON P-A's UNIQUE ID — over the corrected Applicable Math matrix the
 *     per-assessment count is 15 students × 40 items (not the collapsed 7, nor a
 *     staff-inflated count): diagnostics build on the same matrix as item stats.
 *  3. cleanDiagResponses matches P-B's matrix construction — drops cohort-excluded
 *     (staff/test) participants and dedupes (participant, item) keeping the last row.
 */

import { describe, it, expect } from "vitest";
import {
  buildAssessmentDiagnostics,
  cleanDiagResponses,
  type DiagResponse,
} from "@/lib/diagnostics";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { loadParityFixtures } from "./fixtures";

const APPLICABLE = "Applicable Math";

/**
 * The analyst notebooks' reference tables for Applicable Math (demo sitting),
 * reproduced by an independent implementation of their formulae. Displayed
 * side-by-side with the app in docs/diagnostics-parity.md.
 */
const REPRODUCED = {
  whole: {
    speeded: { nItems: 40, nPresentations: 680, omissionRate: 0.0353, completion: 0.9647, speedednessIndex: 0.0498, earlyOmission: 0.0353, lateOmission: 0.0353, earlyAccuracy: 0.3679, lateAccuracy: 0.2683 },
    timing: { nStudents: 17, pearson: 0.0415, spearman: 0.0761 },
  },
  byDemand: {
    D1: { nItems: 15, nPresentations: 255, omissionRate: 0.0549, speedednessIndex: 0.025, earlyAccuracy: 0.4213, lateAccuracy: 0.3968 },
    D2: { nItems: 16, nPresentations: 272, omissionRate: 0.0184, speedednessIndex: 0.0477, earlyAccuracy: 0.3235, lateAccuracy: 0.3016 },
    D3: { nItems: 9, nPresentations: 153, omissionRate: 0.0327, speedednessIndex: 0.0566, earlyAccuracy: 0.3093, lateAccuracy: 0.1961 },
  },
  timingByDemand: {
    D1: { nStudents: 17, pearson: -0.2292, spearman: -0.1548 },
    D2: { nStudents: 17, pearson: 0.3105, spearman: 0.2803 },
    D3: { nStudents: 17, pearson: 0.5907, spearman: 0.5688 },
  },
} as const;

function applicableFromSeed() {
  const p = new InMemoryDataProvider();
  const cycleId = p.listCycles()[0]!.id;
  const model = p.getDiagnostics(cycleId)!;
  return model.assessments.find((a) => a.assessmentName.includes("Applicable"))!;
}

describe("timing/speededness reproduce the analyst notebooks", () => {
  describe("reproduced reference table (Applicable Math) matched to the app to 4 dp", () => {
    const a = applicableFromSeed();

    it("whole-assessment speededness / omission / completion", () => {
      const s = a.whole.speeded;
      const r = REPRODUCED.whole.speeded;
      expect(s.nItems).toBe(r.nItems);
      expect(s.nPresentations).toBe(r.nPresentations);
      expect(s.omissionRate).toBeCloseTo(r.omissionRate, 4);
      expect(s.completion).toBeCloseTo(r.completion, 4);
      expect(s.speedednessIndex).toBeCloseTo(r.speedednessIndex, 4);
      expect(s.earlyOmission).toBeCloseTo(r.earlyOmission, 4);
      expect(s.lateOmission).toBeCloseTo(r.lateOmission, 4);
      expect(s.earlyAccuracy).toBeCloseTo(r.earlyAccuracy, 4);
      expect(s.lateAccuracy).toBeCloseTo(r.lateAccuracy, 4);
    });

    it("whole-assessment timing ↔ performance", () => {
      const t = a.whole.timing;
      const r = REPRODUCED.whole.timing;
      expect(t.nStudents).toBe(r.nStudents);
      expect(t.pearson).toBeCloseTo(r.pearson, 4);
      expect(t.spearman).toBeCloseTo(r.spearman, 4);
    });

    it("speededness/omission by demand level (D1/D2/D3)", () => {
      expect(a.byDemand.map((d) => d.demand)).toEqual(["D1", "D2", "D3"]);
      for (const d of a.byDemand) {
        const r = REPRODUCED.byDemand[d.demand as keyof typeof REPRODUCED.byDemand];
        expect(d.speeded.nItems).toBe(r.nItems);
        expect(d.speeded.nPresentations).toBe(r.nPresentations);
        expect(d.speeded.omissionRate).toBeCloseTo(r.omissionRate, 4);
        expect(d.speeded.speedednessIndex).toBeCloseTo(r.speedednessIndex, 4);
        expect(d.speeded.earlyAccuracy).toBeCloseTo(r.earlyAccuracy, 4);
        expect(d.speeded.lateAccuracy).toBeCloseTo(r.lateAccuracy, 4);
      }
    });

    it("timing ↔ performance by demand level (D1/D2/D3)", () => {
      expect(a.timingByDemand.map((d) => d.demand)).toEqual(["D1", "D2", "D3"]);
      for (const d of a.timingByDemand) {
        const r = REPRODUCED.timingByDemand[d.demand as keyof typeof REPRODUCED.timingByDemand];
        expect(d.timing.nStudents).toBe(r.nStudents);
        expect(d.timing.pearson).toBeCloseTo(r.pearson, 4);
        expect(d.timing.spearman).toBeCloseTo(r.spearman, 4);
      }
    });
  });

  describe("keys on P-A's unique participant id — the corrected 15×40 matrix", () => {
    // Build diagnostics records straight off P-B's oracle matrix (the parity
    // fixtures): one row per (student, item), keyed on the unique student id.
    const fx = loadParityFixtures()[APPLICABLE]!;
    const records: DiagResponse[] = fx.responses.map((r, i) => ({
      participantId: r.student,
      itemId: String(r.qid),
      demandLevel: null,
      itemSet: null,
      order: i,
      answered: true,
      correct: r.score === 1,
      responseTime: null,
    }));

    it("cohort is the corrected 15 students × 40 items (not the collapsed 7)", () => {
      const clean = cleanDiagResponses(records);
      const students = new Set(clean.map((r) => r.participantId));
      const items = new Set(clean.map((r) => r.itemId));
      expect(students.size).toBe(15);
      expect(students.size).toBe(fx.participants);
      expect(items.size).toBe(40);
      // whole-assessment speededness counts the same 40 items / 600 cells.
      const diag = buildAssessmentDiagnostics(clean);
      expect(diag.whole.speeded.nItems).toBe(40);
      expect(diag.whole.speeded.nPresentations).toBe(600);
    });
  });

  describe("cleanDiagResponses builds P-B's matrix (dedupe last + drop excluded)", () => {
    const base = (over: Partial<DiagResponse> = {}): DiagResponse => ({
      participantId: "S1", itemId: "Q1", demandLevel: null, itemSet: null, order: 0, answered: true, correct: true, responseTime: 10, ...over,
    });

    it("dedupes (participant, item) keeping the LAST row", () => {
      const recs = [
        base({ participantId: "S1", itemId: "Q1", correct: false, responseTime: 5 }),
        base({ participantId: "S1", itemId: "Q1", correct: true, responseTime: 9 }), // supersedes
        base({ participantId: "S1", itemId: "Q2" }),
      ];
      const clean = cleanDiagResponses(recs);
      expect(clean).toHaveLength(2);
      const q1 = clean.find((r) => r.itemId === "Q1")!;
      expect(q1.correct).toBe(true); // last row won
      expect(q1.responseTime).toBe(9);
    });

    it("drops cohort-excluded (staff/test) participants, keeping the corrected count", () => {
      const recs = [
        base({ participantId: "S1", itemId: "Q1" }),
        base({ participantId: "S2", itemId: "Q1" }),
        base({ participantId: "STAFF", itemId: "Q1" }),
      ];
      const clean = cleanDiagResponses(recs, { excludedParticipantIds: new Set(["STAFF"]) });
      expect(new Set(clean.map((r) => r.participantId))).toEqual(new Set(["S1", "S2"]));
    });
  });
});
