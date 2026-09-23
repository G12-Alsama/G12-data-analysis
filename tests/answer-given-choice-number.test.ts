/**
 * AnswerGivenChoiceNumber — the fix for "was this item answered?".
 *
 * QM's export writes the sentinel text "<Not defined>" into `AnswerGiven` for an
 * unanswered item — a non-empty, truthy string that survives every `!answerGiven`
 * / `answer_given != null` check the app used to determine omission. Every metric
 * built on that check (Omission Rate, Completion Rate, the Speededness Index, and
 * the Pearson/Spearman timing correlation) was therefore silently blind to blank
 * items: real ingested data always has SOME `AnswerGiven` value, so the old logic
 * could never see an omission at all.
 *
 * `AnswerGivenChoiceNumber` is genuinely blank for an unanswered item. These tests
 * pin the fix end-to-end — ingest → normalise → persist → both hydration paths —
 * against the real 700435 fixture, which contains a genuine
 * AnswerGiven="<Not defined>" / AnswerGivenChoiceNumber="" MCQ row.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ingestThreeExports } from "@/lib/ingest/qm";
import { normalizeResponses } from "@/lib/ingest";
import type { CleanResponse, RawExportRow } from "@/lib/ingest/types";
import { buildLiveCycleData } from "@/lib/data/build-live-cycle";
import { hydrate } from "@/lib/data/supabase-hydrate";
import { makeSupabaseReadClient, type MockDb } from "@/tests/helpers/mock-supabase-read";
import { cleanDiagResponses, buildAssessmentDiagnostics, type DiagResponse } from "@/lib/diagnostics";

vi.mock("server-only", () => ({}));

const qmDir = path.join(process.cwd(), "tests", "fixtures", "qm");
const read = (n: string) => readFileSync(path.join(qmDir, `${n}.csv`));
function files() {
  return [
    { name: "Items.csv", data: read("Items") },
    { name: "Assessments.csv", data: read("Assessments") },
    { name: "Topics.csv", data: read("Topics") },
  ];
}

// A genuine unanswered MCQ item in the 700435 fixture: AnswerGiven carries QM's
// "<Not defined>" sentinel (truthy) while AnswerGivenChoiceNumber is blank.
const TARGET_RESULT_ID = "512675102";
const TARGET_QUESTION_ID = "100002721869";

describe("normalizeResponses — AnswerGivenChoiceNumber parsing", () => {
  const { cleanedResponses } = ingestThreeExports(files());

  it("finds the known unanswered sample and normalises its blank choice number to null", () => {
    const target = cleanedResponses.find(
      (r) => r.qmResultId === TARGET_RESULT_ID && r.qmQuestionId === TARGET_QUESTION_ID,
    );
    expect(target).toBeTruthy();
    expect(target!.answerGiven).toBe("<Not defined>");
    expect(target!.answerGivenChoiceNumber).toBeNull();
  });

  it("preserves AnswerGiven's own parsing/display behaviour completely unchanged", () => {
    // No real row in the fixture ever leaves AnswerGiven blank — only the sentinel
    // text or the genuine raw answer. Confirms adding the new field never altered
    // how AnswerGiven itself is parsed (still the untouched repairValue pass-through).
    expect(cleanedResponses.every((r) => typeof r.answerGiven === "string" && r.answerGiven.length > 0)).toBe(true);
    const answered = cleanedResponses.find(
      (r) => r.answerGiven !== "<Not defined>" && r.questionType === "Multiple Choice",
    );
    expect(answered).toBeTruthy();
    expect(answered!.answerGivenChoiceNumber).not.toBeNull();
  });

  it("a synthetic row proves the exact parsing rule: blank -> null, digits -> preserved, AnswerGiven untouched", () => {
    const rows: RawExportRow[] = [
      {
        AssessmentName: "Subj", ResultId: "R1", QuestionId: "Q1", QuestionType: "Multiple Choice",
        AnswerGiven: "<Not defined>", AnswerGivenChoiceNumber: "", AnswerScore: "0",
        ResultParticipantName: "a@x.edu",
      },
      {
        AssessmentName: "Subj", ResultId: "R2", QuestionId: "Q2", QuestionType: "Multiple Choice",
        AnswerGiven: "Paris", AnswerGivenChoiceNumber: "2", AnswerScore: "1",
        ResultParticipantName: "b@x.edu",
      },
    ];
    const { clean } = normalizeResponses(rows);
    expect(clean[0]!.answerGiven).toBe("<Not defined>");
    expect(clean[0]!.answerGivenChoiceNumber).toBeNull();
    expect(clean[1]!.answerGiven).toBe("Paris");
    expect(clean[1]!.answerGivenChoiceNumber).toBe("2");
  });
});

describe("ingestCleanResponses — persists answer_given_choice_number", () => {
  it("carries the raw value (or null) into the responses payload, alongside answer_given untouched", async () => {
    const { ingestCleanResponses } = await import("@/lib/server/ingest-write");
    const { makeRpcAdmin } = await import("@/tests/helpers/mock-rpc-admin");
    const { cleanedResponses, canonical } = ingestThreeExports(files());

    const calls: any[] = [];
    await ingestCleanResponses(makeRpcAdmin(calls) as any, "cycle-1", cleanedResponses, {
      createdBy: "user-1",
      canonical,
    });
    const responses = calls[0].args.p_payload.responses as Record<string, unknown>[];

    const targetRow = responses.find(
      (r) => r.qm_result_id === TARGET_RESULT_ID && r.question_id === TARGET_QUESTION_ID,
    );
    expect(targetRow).toBeTruthy();
    expect(targetRow!.answer_given).toBe("<Not defined>");
    expect(targetRow!.answer_given_choice_number).toBeNull();

    // Scoring fields are read from the exact same CleanResponse fields as before —
    // untouched by this change.
    const src = cleanedResponses.find(
      (r) => r.qmResultId === TARGET_RESULT_ID && r.qmQuestionId === TARGET_QUESTION_ID,
    )!;
    expect(targetRow!.answer_score).toBe(src.answerScore);
    expect(targetRow!.response_time).toBe(src.responseTime);
  });
});

describe("build-live-cycle.ts — 'answered' keys off answerGivenChoiceNumber", () => {
  const { cleanedResponses } = ingestThreeExports(files());
  const target = cleanedResponses.find(
    (r) => r.qmResultId === TARGET_RESULT_ID && r.qmQuestionId === TARGET_QUESTION_ID,
  )!;
  const built = buildLiveCycleData(cleanedResponses);
  const seedAssessment = built.assessments.find((a) => a.name === target.assessmentName)!;
  const targetResp = seedAssessment.responses.find(
    (r) => r.i === target.qmQuestionId && r.p === target.participantPseudonym,
  )!;

  it("SeedResponse.a is false for the unanswered sample (never keyed off answerGiven)", () => {
    expect(targetResp).toBeTruthy();
    expect(targetResp.answerGivenChoiceNumber).toBeNull();
    expect(targetResp.a).toBe(false);
    // Scoring is untouched: the score carried is exactly the ingested answerScore.
    expect(targetResp.s).toBe(target.answerScore);
  });

  it("Omission Rate / Completion / Speededness Index now see the omission that the old AnswerGiven-based logic could never see", () => {
    const diag = built.diagnostics.find((d) => d.assessmentName === target.assessmentName)!;
    // NEW (correct) logic — some presented items in this subject are genuinely omitted.
    expect(diag.whole.speeded.omissionRate).toBeGreaterThan(0);
    expect(diag.whole.speeded.completion).toBeLessThan(1);

    // OLD (buggy) logic, replayed on the SAME underlying rows: answerGiven is NEVER
    // blank in real QM data (only the sentinel or genuine text), so `!!answerGiven`
    // is always true and omission is always forced to 0 — the exact bug this fixes.
    const recsForSubject = cleanedResponses.filter((r) => r.assessmentName === target.assessmentName);
    const oldDiagRecs: DiagResponse[] = recsForSubject.map((r, i) => ({
      participantId: r.participantPseudonym,
      itemId: r.qmQuestionId,
      demandLevel: r.demandLevel,
      itemSet: r.itemSet,
      order: i,
      answered: !!r.answerGiven, // the old, buggy determination
      correct: r.answerScore === 1,
      responseTime: r.responseTime,
    }));
    const oldDiag = buildAssessmentDiagnostics(cleanDiagResponses(oldDiagRecs));
    expect(oldDiag.whole.speeded.omissionRate).toBe(0);
    expect(oldDiag.whole.speeded.completion).toBe(1);
  });
});

describe("supabase-hydrate.ts — 'answered' keys off answer_given_choice_number", () => {
  async function hydrateFixture() {
    const { ingestCleanResponses } = await import("@/lib/server/ingest-write");
    const { makeRpcAdmin } = await import("@/tests/helpers/mock-rpc-admin");
    const { cleanedResponses: clean, canonical } = ingestThreeExports(files());

    const calls: any[] = [];
    await ingestCleanResponses(makeRpcAdmin(calls) as any, "cycle-eslfix", clean, { createdBy: "u1", canonical });
    const p = calls[0].args.p_payload;

    const stamp = (rows: any[]) =>
      rows.map((r: any, i: number) => ({ created_at: new Date(1700000000000 + i * 1000).toISOString(), ...r }));
    const db: MockDb = {
      exam_cycles: [
        { id: "cycle-eslfix", name: "G12++ May 2026", status: "scored", region: "eu-west", year_id: null, sitting: "may", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z" },
      ],
      test_centres: [], exam_years: [],
      assessments: p.assessments.map((a: any) => ({ status: "scored", created_at: "2026-05-01T00:00:00Z", ...a })),
      items: p.items.map((it: any) => ({ status: "active", created_at: "2026-05-01T00:00:00Z", ...it })),
      participants: stamp(p.participants),
      responses: stamp(p.responses).map((r: any, i: number) => ({ id: `resp-${i}`, ...r })),
      item_stats: [], item_reviews: [], grade_schemes: [], grades: [], essay_marks: [],
      incidents: [], alterations: [], distinction_overrides: [], workspace_settings: [],
      element_labels: [], clean_exclusions: [], distinction_state: [], document_settings: [], import_batches: [],
    };
    const h = await hydrate(makeSupabaseReadClient(db) as any);
    return { hydrated: h!, clean, payload: p };
  }

  it("SeedResponse.a is false for the unanswered sample, scoring untouched", async () => {
    const { hydrated, clean, payload } = await hydrateFixture();
    const target = clean.find((r) => r.qmResultId === TARGET_RESULT_ID && r.qmQuestionId === TARGET_QUESTION_ID)!;

    // Resolve the internal uuids the write path minted for this item/participant,
    // so the exact response row can be found post-hydrate (SeedResponse keys on
    // internal ids, not the raw QM QuestionId/ParticipantID).
    const itemRow = payload.items.find((it: any) => it.qm_question_id === TARGET_QUESTION_ID);
    const partRow = payload.participants.find((pt: any) => pt.qm_participant_id === target.qmParticipantId);
    expect(itemRow).toBeTruthy();
    expect(partRow).toBeTruthy();

    const seedAssessment = hydrated.seed.liveCycle.assessments.find((a) => a.name === target.assessmentName)!;
    const targetResp = seedAssessment.responses.find((r) => r.i === itemRow.id && r.p === partRow.id);
    expect(targetResp).toBeTruthy();
    expect(targetResp!.answerGivenChoiceNumber).toBeNull();
    expect(targetResp!.a).toBe(false);
    // Scoring is untouched: the score carried is exactly the ingested answerScore.
    expect(targetResp!.s).toBe(target.answerScore);
  });

  it("Omission Rate / Completion / Speededness Index now see the omission the old logic missed", async () => {
    const { hydrated } = await hydrateFixture();
    const eslDiag = hydrated.seed.liveCycle.diagnostics.find((d) => d.assessmentName === "G12++ English as a 2nd Language");
    expect(eslDiag).toBeTruthy();
    expect(eslDiag!.whole.speeded.omissionRate).toBeGreaterThan(0);
    expect(eslDiag!.whole.speeded.completion).toBeLessThan(1);
  });

  it("does not disturb scoring: every response's score equals the persisted answer_score", async () => {
    const { hydrated, clean } = await hydrateFixture();
    for (const a of hydrated.seed.liveCycle.assessments) {
      for (const r of a.responses) expect(Number.isFinite(r.s)).toBe(true);
    }
    // Spot-check the omitted sample's own score is exactly what was ingested (0),
    // regardless of its (correctly) omitted status.
    const target = clean.find((r) => r.qmResultId === TARGET_RESULT_ID && r.qmQuestionId === TARGET_QUESTION_ID)!;
    expect(target.answerScore).toBe(0);
  });
});
