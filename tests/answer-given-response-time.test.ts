/**
 * Regression test for the AnswerGiven / AnswerResponseTimeSeconds data-loss bug.
 *
 * Both hydration paths that produce SeedResponse[] — the Supabase-backed
 * `hydrate()` (production) and `buildLiveCycleData()` (local/demo ingest) — used
 * to read `answer_given`/`response_time` only to compute the boolean `a`
 * (answered) flag, never copying the values onto the SeedResponse. Since
 * `InMemoryDataProvider.getCleanedData` builds every export row purely from
 * SeedResponse[], the two cleaned-export columns were always blank regardless of
 * what the source held. This test exercises BOTH paths end-to-end into
 * getCleanedData and pins the fix; it also confirms the exam-security
 * (Question/Answer-key) and PII (participant DOB/gender) columns stay blank.
 */
import { describe, it, expect, vi } from "vitest";
import { hydrate } from "@/lib/data/supabase-hydrate";
import { buildLiveCycleData } from "@/lib/data/build-live-cycle";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { makeSupabaseReadClient, type MockDb } from "@/tests/helpers/mock-supabase-read";
import { CLEANED_DATA_COLUMNS } from "@/lib/data/cleaned-schema";
import type { CleanResponse } from "@/lib/ingest/types";
import type { Seed } from "@/lib/data/seed-types";

// The write path is a server module (`import "server-only"`); hydrate() does not
// import it, but keep parity with the other hydrate tests in case that changes.
vi.mock("server-only", () => ({}));

const col = (name: string) => CLEANED_DATA_COLUMNS.indexOf(name as never);

const ALWAYS_BLANK = [
  "QuestionCorrectAnswers",
  "QuestionCorrectAnswersChoiceNumber",
  "QuestionPossibleAnswers",
  "QuestionPossibleAnswersCount",
  "ParticipantDateOfBirth",
  "ParticipantGender",
];

describe("AnswerGiven / AnswerResponseTimeSeconds reach the cleaned export", () => {
  describe("production path: supabase-hydrate.ts → InMemoryDataProvider", () => {
    const CYCLE = "cycle-agr-1";

    const db: MockDb = {
      exam_cycles: [
        { id: CYCLE, name: "Test Cycle", status: "scored", region: "eu-west", year_id: null, sitting: "may", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z" },
      ],
      test_centres: [],
      exam_years: [],
      assessments: [{ id: "a1", cycle_id: CYCLE, name: "Math", item_count: 1, status: "scored", created_at: "2026-05-01T00:00:00Z" }],
      items: [{ id: "i1", cycle_id: CYCLE, assessment_id: "a1", qm_question_id: "q1", wording: "2+2?", major_element: null, sub_element: null, demand_level: null, item_set: null, max_score: 1, status: "active", created_at: "2026-05-01T00:00:00Z" }],
      participants: [
        { id: "u1", cycle_id: CYCLE, qm_participant_id: "p1@x.edu", pseudonym_id: "P0001", full_name: "Alpha", created_at: "2026-05-01T00:00:01Z" },
        { id: "u2", cycle_id: CYCLE, qm_participant_id: "p2@x.edu", pseudonym_id: "P0002", full_name: "Beta", created_at: "2026-05-01T00:00:02Z" },
      ],
      responses: [
        { id: "r1", cycle_id: CYCLE, qm_result_id: "R0001", question_id: "q1", participant_email: "p1@x.edu", participant_id: "u1", item_id: "i1", assessment_id: "a1", answer_given: "4", answer_score: 1, response_time: 12.5, result_status: null, question_type: "Multiple Choice", question_status: "Normal", created_at: "2026-05-01T00:00:03Z" },
        { id: "r2", cycle_id: CYCLE, qm_result_id: "R0002", question_id: "q1", participant_email: "p2@x.edu", participant_id: "u2", item_id: "i1", assessment_id: "a1", answer_given: "3", answer_score: 0, response_time: 7, result_status: null, question_type: "Multiple Choice", question_status: "Normal", created_at: "2026-05-01T00:00:04Z" },
      ],
      item_stats: [], item_reviews: [], grade_schemes: [], grades: [], essay_marks: [],
      incidents: [], alterations: [], distinction_overrides: [], workspace_settings: [],
      element_labels: [], clean_exclusions: [], distinction_state: [], document_settings: [], import_batches: [],
    };

    it("carries answer_given/response_time from `responses` through to the cleaned export unchanged", async () => {
      const hydrated = await hydrate(makeSupabaseReadClient(db) as any);
      expect(hydrated).not.toBeNull();

      const provider = new InMemoryDataProvider(hydrated!.seed);
      const cycleId = hydrated!.seed.liveCycle.id;
      const assessmentId = hydrated!.seed.liveCycle.assessments[0]!.id;
      const model = provider.getCleanedData(cycleId, assessmentId)!;
      expect(model).not.toBeNull();
      expect(model.rows.length).toBe(2);

      const byScore = new Map(model.rows.map((r) => [r[col("AnswerScore")], r]));
      expect(byScore.get("1")![col("AnswerGiven")]).toBe("4");
      expect(byScore.get("1")![col("AnswerResponseTimeSeconds")]).toBe("12.5");
      expect(byScore.get("0")![col("AnswerGiven")]).toBe("3");
      expect(byScore.get("0")![col("AnswerResponseTimeSeconds")]).toBe("7");
    });

    it("keeps the exam-security and PII columns blank", async () => {
      const hydrated = await hydrate(makeSupabaseReadClient(db) as any);
      const provider = new InMemoryDataProvider(hydrated!.seed);
      const cycleId = hydrated!.seed.liveCycle.id;
      const assessmentId = hydrated!.seed.liveCycle.assessments[0]!.id;
      const model = provider.getCleanedData(cycleId, assessmentId)!;
      for (const name of ALWAYS_BLANK) {
        for (const row of model.rows) expect(row[col(name)]).toBe("");
      }
    });
  });

  describe("local/demo path: build-live-cycle.ts → InMemoryDataProvider", () => {
    const EMPTY_VALIDATION = {
      passed: true,
      checks: [],
      stats: { rawRows: 0, mcqRows: 0, droppedSurveyRows: 0, droppedNonMcqRows: 0, assessments: 0, participants: 0, items: 0 },
    } as unknown as Seed["liveCycle"]["validation"];

    function emptySeed(): Seed {
      return {
        generatedAt: new Date().toISOString(),
        engineVersion: "test",
        liveCycle: {
          id: "new-cycle",
          name: "Fresh cycle",
          region: "eu-west",
          startedAt: "today",
          lastActivity: "today",
          stageIndex: 0,
          fileName: "",
          fileSizeMB: 0,
          uploadedAgo: "",
          validation: EMPTY_VALIDATION,
          preview: { headers: [], rows: [] },
          duplicates: 0,
          participants: [],
          assessments: [],
          diagnostics: [],
        },
        priorCycles: [],
      };
    }

    function resp(over: Partial<CleanResponse>): CleanResponse {
      return {
        assessmentName: "Math",
        qmQuestionId: "q1",
        qmResultId: "R0001",
        qmParticipantId: "a@x.edu",
        participantPseudonym: "P0001",
        wording: "2+2?",
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
        answerScore: 1,
        responseTime: null,
        resultStatus: null,
        ...over,
      };
    }

    it("carries answerGiven/responseTime from the cleaned rows through to the cleaned export unchanged", async () => {
      const clean: CleanResponse[] = [
        resp({ qmParticipantId: "a@x.edu", participantPseudonym: "P0001", answerGiven: "4", answerScore: 1, responseTime: 12.5 }),
        resp({ qmParticipantId: "b@x.edu", participantPseudonym: "P0002", answerGiven: "3", answerScore: 0, responseTime: 7 }),
      ];

      const p = new InMemoryDataProvider(emptySeed());
      await p.ingestRawExport("new-cycle", { name: "export.csv", sizeMB: 0.1 }, clean, EMPTY_VALIDATION);

      const assessmentId = (p as unknown as { seed: Seed }).seed.liveCycle.assessments[0]!.id;
      const model = p.getCleanedData("new-cycle", assessmentId)!;
      expect(model).not.toBeNull();
      expect(model.rows.length).toBe(2);

      const byScore = new Map(model.rows.map((r) => [r[col("AnswerScore")], r]));
      expect(byScore.get("1")![col("AnswerGiven")]).toBe("4");
      expect(byScore.get("1")![col("AnswerResponseTimeSeconds")]).toBe("12.5");
      expect(byScore.get("0")![col("AnswerGiven")]).toBe("3");
      expect(byScore.get("0")![col("AnswerResponseTimeSeconds")]).toBe("7");
    });

    it("keeps the exam-security and PII columns blank", async () => {
      const clean: CleanResponse[] = [
        resp({ qmParticipantId: "a@x.edu", participantPseudonym: "P0001", answerGiven: "4", answerScore: 1, responseTime: 12.5 }),
      ];
      const p = new InMemoryDataProvider(emptySeed());
      await p.ingestRawExport("new-cycle", { name: "export.csv", sizeMB: 0.1 }, clean, EMPTY_VALIDATION);
      const assessmentId = (p as unknown as { seed: Seed }).seed.liveCycle.assessments[0]!.id;
      const model = p.getCleanedData("new-cycle", assessmentId)!;
      for (const name of ALWAYS_BLANK) {
        for (const row of model.rows) expect(row[col(name)]).toBe("");
      }
    });

    it("buildLiveCycleData itself carries answerGiven/responseTime onto SeedResponse", () => {
      const clean: CleanResponse[] = [
        resp({ qmParticipantId: "a@x.edu", participantPseudonym: "P0001", answerGiven: "4", answerScore: 1, responseTime: 12.5 }),
      ];
      const built = buildLiveCycleData(clean);
      const r = built.assessments[0]!.responses[0]!;
      expect(r.answerGiven).toBe("4");
      expect(r.responseTime).toBe(12.5);
    });
  });
});
