/**
 * buildLiveCycleData invariants (root cause D — participant collapse guard).
 *
 * The per-student aggregation must key on a GUARANTEED-UNIQUE participant key.
 * These tests pin the two invariants that make a silent overwrite (the "fewer
 * output participants than input results, plus a survivor holding a tiny value"
 * signature) fail loudly instead of corrupting scores.
 */
import { describe, it, expect } from "vitest";
import { buildLiveCycleData } from "@/lib/data/build-live-cycle";
import type { CleanResponse } from "@/lib/ingest/types";

function resp(over: Partial<CleanResponse>): CleanResponse {
  return {
    assessmentName: "Subj",
    qmQuestionId: "q1",
    qmResultId: "R0001",
    qmParticipantId: "a@x.edu",
    participantPseudonym: "P0001",
    wording: null,
    description: null,
    parentWording: null,
    majorElement: null,
    subElement: null,
    demandLevel: null,
    itemSet: null,
    questionType: "Multiple Choice",
    maxScore: 1,
    answerGiven: "A",
    answerGivenChoiceNumber: "1",
    questionPresentedNumber: null,
    answerScore: 1,
    responseTime: null,
    resultStatus: null,
    ...over,
  };
}

describe("buildLiveCycleData participant-key invariants", () => {
  it("preserves every distinct participant (no collapse) on a clean two-student set", () => {
    const clean: CleanResponse[] = [
      resp({ qmParticipantId: "a@x.edu", participantPseudonym: "P0001", qmQuestionId: "q1", answerScore: 1 }),
      resp({ qmParticipantId: "a@x.edu", participantPseudonym: "P0001", qmQuestionId: "q2", answerScore: 0 }),
      resp({ qmParticipantId: "b@x.edu", participantPseudonym: "P0002", qmQuestionId: "q1", answerScore: 1 }),
      resp({ qmParticipantId: "b@x.edu", participantPseudonym: "P0002", qmQuestionId: "q2", answerScore: 1 }),
    ];
    const built = buildLiveCycleData(clean);
    expect(built.participants).toHaveLength(2);
    const subj = built.assessments[0]!;
    expect(new Set(subj.responses.map((r) => r.p)).size).toBe(2);
  });

  it("throws when two distinct participant ids share one pseudonym (non-unique key)", () => {
    // Two different real ids mapped to the SAME pseudonym → would overwrite.
    const clean: CleanResponse[] = [
      resp({ qmParticipantId: "a@x.edu", participantPseudonym: "P0001", qmQuestionId: "q1" }),
      resp({ qmParticipantId: "b@x.edu", participantPseudonym: "P0001", qmQuestionId: "q1" }),
    ];
    expect(() => buildLiveCycleData(clean)).toThrowError(/non-unique participant key/i);
  });

  it("throws when one participant id maps to two pseudonyms (non-bijective key)", () => {
    const clean: CleanResponse[] = [
      resp({ qmParticipantId: "a@x.edu", participantPseudonym: "P0001", qmQuestionId: "q1" }),
      resp({ qmParticipantId: "a@x.edu", participantPseudonym: "P0002", qmQuestionId: "q2" }),
    ];
    expect(() => buildLiveCycleData(clean)).toThrowError(/non-unique participant key/i);
  });
});
