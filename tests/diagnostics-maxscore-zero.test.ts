/**
 * Regression: Assessment Health (Omission Rate, Completion Rate, Pearson,
 * Spearman) and Cronbach's α must be computed only from SCORED (Max Score >= 1)
 * items. A Max Score = 0 item — an instruction/stimulus row that was never
 * scored to begin with — must not leak into either figure's input, in EITHER
 * hydration path: the in-memory `buildLiveCycleData` path and the production
 * `supabase-hydrate` path.
 *
 * Fixture: 4 participants × 3 items. q0 carries Max Score = 0 (instruction /
 * stimulus) and is never answered by anyone — if it leaked into the diagnostics
 * input it would inflate the omission rate and drag completion below 1 even
 * though the two REAL items (q1/q2) are fully answered. q1/q2 carry varied
 * scores and response times so Pearson/Spearman are real, non-degenerate
 * correlations, not vacuous nulls.
 */
import { describe, it, expect, vi } from "vitest";
import { buildLiveCycleData } from "@/lib/data/build-live-cycle";
import { hydrate } from "@/lib/data/supabase-hydrate";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { makeSupabaseReadClient, type MockDb } from "@/tests/helpers/mock-supabase-read";
import { ENGINE_VERSION } from "@/lib/engine";
import type { CleanResponse } from "@/lib/ingest/types";
import type { Seed } from "@/lib/data/seed-types";

// The hydrate module is client-safe, but its sibling write path is server-only;
// neutralise `server-only` so the test bundle imports cleanly.
vi.mock("server-only", () => ({}));

const CYCLE = "cycle-maxscore-zero";
const PARTICIPANTS = ["p1", "p2", "p3", "p4"];
const Q1_SCORES = [1, 1, 0, 0];
const Q2_SCORES = [1, 0, 1, 0];
const Q1_TIMES = [10, 15, 25, 30];
const Q2_TIMES = [12, 20, 18, 35];

const EMPTY_VALIDATION = {
  passed: true,
  checks: [],
  stats: { rawRows: 0, mcqRows: 0, droppedSurveyRows: 0, droppedNonMcqRows: 0, assessments: 0, participants: 0, items: 0 },
};

// ── Path A: in-memory (buildLiveCycleData) ──────────────────────────────────

function cleanResp(over: Partial<CleanResponse>): CleanResponse {
  return {
    assessmentName: "Math",
    qmQuestionId: "q1",
    qmResultId: "R1",
    qmParticipantId: "p1@x.edu",
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
    responseTime: 10,
    resultStatus: null,
    ...over,
  };
}

function buildCleanResponses(): CleanResponse[] {
  const recs: CleanResponse[] = [];
  PARTICIPANTS.forEach((p, i) => {
    const participantPseudonym = `P000${i + 1}`;
    const qmParticipantId = `${p}@x.edu`;
    // q0: Max Score = 0 instruction/stimulus item — never answered by anyone.
    recs.push(
      cleanResp({ qmQuestionId: "q0", qmParticipantId, participantPseudonym, maxScore: 0, answerGiven: null, answerGivenChoiceNumber: null, answerScore: 0, responseTime: null }),
    );
    recs.push(
      cleanResp({ qmQuestionId: "q1", qmParticipantId, participantPseudonym, maxScore: 1, answerScore: Q1_SCORES[i]!, responseTime: Q1_TIMES[i]! }),
    );
    recs.push(
      cleanResp({ qmQuestionId: "q2", qmParticipantId, participantPseudonym, maxScore: 1, answerScore: Q2_SCORES[i]!, responseTime: Q2_TIMES[i]! }),
    );
  });
  return recs;
}

function providerFromInMemoryPath(): InMemoryDataProvider {
  const built = buildLiveCycleData(buildCleanResponses());
  const seed: Seed = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    engineVersion: ENGINE_VERSION,
    liveCycle: {
      id: CYCLE,
      name: "Math",
      region: "EU",
      startedAt: "x",
      lastActivity: "x",
      stageIndex: 1,
      fileName: "qm",
      fileSizeMB: 1,
      uploadedAgo: "now",
      validation: EMPTY_VALIDATION,
      preview: built.preview,
      duplicates: 0,
      participants: built.participants,
      assessments: built.assessments,
      diagnostics: built.diagnostics,
      sittings: built.sittings,
    },
    priorCycles: [],
  };
  return new InMemoryDataProvider(seed);
}

// ── Path B: production (supabase-hydrate) ───────────────────────────────────

function makeDb(): MockDb {
  const participants = PARTICIPANTS.map((p, i) => ({
    id: `u${i + 1}`,
    cycle_id: CYCLE,
    qm_participant_id: `${p}@x.edu`,
    pseudonym_id: `P000${i + 1}`,
    full_name: null,
    created_at: `2026-05-01T00:00:0${i + 1}Z`,
  }));
  const items = [
    { id: "q0", cycle_id: CYCLE, assessment_id: "a1", qm_question_id: "q0", wording: null, major_element: null, sub_element: null, demand_level: null, item_set: null, max_score: 0, status: "active", created_at: "2026-05-01T00:00:00Z" },
    { id: "q1", cycle_id: CYCLE, assessment_id: "a1", qm_question_id: "q1", wording: null, major_element: null, sub_element: null, demand_level: null, item_set: null, max_score: 1, status: "active", created_at: "2026-05-01T00:00:00Z" },
    { id: "q2", cycle_id: CYCLE, assessment_id: "a1", qm_question_id: "q2", wording: null, major_element: null, sub_element: null, demand_level: null, item_set: null, max_score: 1, status: "active", created_at: "2026-05-01T00:00:00Z" },
  ];
  const responses: Record<string, unknown>[] = [];
  PARTICIPANTS.forEach((_, i) => {
    const pid = `u${i + 1}`;
    responses.push({ id: `r${i}-0`, cycle_id: CYCLE, participant_id: pid, item_id: "q0", answer_given: null, answer_given_choice_number: null, answer_score: 0, response_time: null, result_status: null, created_at: `2026-05-01T00:01:0${i}Z` });
    responses.push({ id: `r${i}-1`, cycle_id: CYCLE, participant_id: pid, item_id: "q1", answer_given: "A", answer_given_choice_number: "1", answer_score: Q1_SCORES[i], response_time: Q1_TIMES[i], result_status: null, created_at: `2026-05-01T00:02:0${i}Z` });
    responses.push({ id: `r${i}-2`, cycle_id: CYCLE, participant_id: pid, item_id: "q2", answer_given: "A", answer_given_choice_number: "1", answer_score: Q2_SCORES[i], response_time: Q2_TIMES[i], result_status: null, created_at: `2026-05-01T00:03:0${i}Z` });
  });
  return {
    exam_cycles: [{ id: CYCLE, name: "May", status: "scored", region: "eu-west", year_id: null, sitting: "may", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z" }],
    test_centres: [],
    exam_years: [],
    assessments: [{ id: "a1", cycle_id: CYCLE, name: "Math", item_count: 3, status: "scored", created_at: "2026-05-01T00:00:00Z" }],
    items,
    participants,
    responses,
    item_stats: [], item_reviews: [], grade_schemes: [], grades: [], essay_marks: [],
    incidents: [], alterations: [], distinction_overrides: [], workspace_settings: [],
    element_labels: [], clean_exclusions: [], distinction_state: [], document_settings: [], import_batches: [],
  };
}

async function providerFromHydratePath(): Promise<InMemoryDataProvider> {
  const h = await hydrate(makeSupabaseReadClient(makeDb()) as any);
  expect(h).not.toBeNull();
  return new InMemoryDataProvider(h!.seed);
}

// ── Assertions, run identically over both paths ─────────────────────────────

describe.each([
  ["in-memory path (buildLiveCycleData)", providerFromInMemoryPath],
  ["production path (supabase-hydrate)", providerFromHydratePath],
] as const)("Max Score = 0 items excluded from Assessment Health — %s", (_label, getProvider) => {
  it("getReliability computes k (and alpha) from the 2 scored items only, not all 3", async () => {
    const provider = await getProvider();
    const model = provider.getReliability(CYCLE)!;
    expect(model).not.toBeNull();
    expect(model.overall.k).toBe(2);
  });

  it("getDiagnostics omission/completion/timing-correlation inputs exclude q0's never-answered responses", async () => {
    const provider = await getProvider();
    const diag = provider.getDiagnostics(CYCLE)!.assessments[0]!;
    // q0 was "presented but never answered" for every participant. If it leaked
    // into the diagnostics input, omission rate would be > 0 (2 omitted item
    // presentations out of 12) and completion would drop below 1, even though
    // the two real items are fully answered by everyone.
    expect(diag.whole.speeded.omissionRate).toBe(0);
    expect(diag.whole.speeded.completion).toBe(1);
    // Pearson/Spearman computed over the 2 scored items' real, varied scores and
    // response times — non-null, and over all 4 students (q0's null response
    // times never entered the per-student median-time aggregation).
    expect(diag.whole.timing.nStudents).toBe(4);
    expect(diag.whole.timing.pearson).not.toBeNull();
    expect(diag.whole.timing.spearman).not.toBeNull();
  });
});
