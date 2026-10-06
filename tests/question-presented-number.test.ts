/**
 * QuestionPresentedNumber — real per-sitting item order, replacing the
 * first-appearance-order proxy for Assessment Health's "presentation order".
 *
 * `DiagResponse.order` (feeding the Speededness Index, omission-by-position and
 * the Pearson/Spearman timing correlation) used to be derived as first-appearance
 * order in the cleaned response rows — a proxy, never QM's real
 * `QuestionPresentedNumber` column, which was never captured anywhere in this
 * pipeline.
 *
 * Checked against the real 700435 fixture (tests/fixtures/qm/Items.csv):
 * QuestionPresentedNumber VARIES per participant even for the SAME question
 * within the SAME assessment — e.g. QuestionId 100002805839 (Multiple Choice,
 * assessment 138080000138080, "G12++ اللّغة العربيّة") was presented at position 4
 * to ResultId 111295300 and position 3 to ResultId 1966292168. So this is a
 * genuine per-response value and must be tracked on `responses`/`SeedResponse`,
 * never collapsed to a single value per item.
 *
 * These tests pin the fix end-to-end — ingest → normalise → persist → both
 * hydration paths — against that real fixture.
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
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import type { Seed } from "@/lib/data/seed-types";
import type { ValidationReport } from "@/lib/ingest/types";

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

// A genuine Multiple Choice item in the 700435 fixture whose QuestionPresentedNumber
// VARIES across two participants' sittings of the SAME assessment (Arabic 1st
// Language, 138080000138080): position 4 for ResultId 111295300, position 3 for
// ResultId 1966292168.
const TARGET_QUESTION_ID = "100002805839";
const RESULT_A = "111295300"; // presented at position 4
const RESULT_B = "1966292168"; // presented at position 3

describe("normalizeResponses — QuestionPresentedNumber parsing", () => {
  const { cleanedResponses } = ingestThreeExports(files());

  it("parses the real per-participant values for the same question, confirming they VARY", () => {
    const a = cleanedResponses.find((r) => r.qmResultId === RESULT_A && r.qmQuestionId === TARGET_QUESTION_ID);
    const b = cleanedResponses.find((r) => r.qmResultId === RESULT_B && r.qmQuestionId === TARGET_QUESTION_ID);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a!.questionPresentedNumber).toBe(4);
    expect(b!.questionPresentedNumber).toBe(3);
    // Same question, same assessment, genuinely different presented order —
    // this is why the value must live on the response, never the item.
    expect(a!.questionPresentedNumber).not.toBe(b!.questionPresentedNumber);
  });

  it("a synthetic row proves the exact parsing rule: numeric -> preserved, blank/non-numeric -> null", () => {
    const rows: RawExportRow[] = [
      {
        AssessmentName: "Subj", ResultId: "R1", QuestionId: "Q1", QuestionType: "Multiple Choice",
        AnswerGiven: "Paris", AnswerGivenChoiceNumber: "2", AnswerScore: "1", QuestionPresentedNumber: "5",
        ResultParticipantName: "a@x.edu",
      },
      {
        AssessmentName: "Subj", ResultId: "R2", QuestionId: "Q2", QuestionType: "Multiple Choice",
        AnswerGiven: "London", AnswerGivenChoiceNumber: "1", AnswerScore: "1", QuestionPresentedNumber: "",
        ResultParticipantName: "b@x.edu",
      },
    ];
    const { clean } = normalizeResponses(rows);
    expect(clean[0]!.questionPresentedNumber).toBe(5);
    expect(clean[1]!.questionPresentedNumber).toBeNull();
  });
});

describe("ingestCleanResponses — persists question_presented_number", () => {
  it("carries the raw per-response value into the responses payload", async () => {
    const { ingestCleanResponses } = await import("@/lib/server/ingest-write");
    const { makeRpcAdmin } = await import("@/tests/helpers/mock-rpc-admin");
    const { cleanedResponses, canonical } = ingestThreeExports(files());

    const calls: any[] = [];
    await ingestCleanResponses(makeRpcAdmin(calls) as any, "cycle-1", cleanedResponses, {
      createdBy: "user-1",
      canonical,
    });
    const responses = calls[0].args.p_payload.responses as Record<string, unknown>[];

    const rowA = responses.find((r) => r.qm_result_id === RESULT_A && r.question_id === TARGET_QUESTION_ID);
    const rowB = responses.find((r) => r.qm_result_id === RESULT_B && r.question_id === TARGET_QUESTION_ID);
    expect(rowA).toBeTruthy();
    expect(rowB).toBeTruthy();
    expect(rowA!.question_presented_number).toBe(4);
    expect(rowB!.question_presented_number).toBe(3);
  });
});

describe("build-live-cycle.ts — presentation order uses the real QuestionPresentedNumber", () => {
  const { cleanedResponses } = ingestThreeExports(files());
  const targetA = cleanedResponses.find((r) => r.qmResultId === RESULT_A && r.qmQuestionId === TARGET_QUESTION_ID)!;
  const targetB = cleanedResponses.find((r) => r.qmResultId === RESULT_B && r.qmQuestionId === TARGET_QUESTION_ID)!;
  const built = buildLiveCycleData(cleanedResponses);
  const seedAssessment = built.assessments.find((a) => a.name === targetA.assessmentName)!;

  it("SeedResponse.questionPresentedNumber carries the real per-participant value, not a first-appearance proxy", () => {
    const respA = seedAssessment.responses.find(
      (r) => r.i === targetA.qmQuestionId && r.p === targetA.participantPseudonym,
    )!;
    const respB = seedAssessment.responses.find(
      (r) => r.i === targetB.qmQuestionId && r.p === targetB.participantPseudonym,
    )!;
    expect(respA).toBeTruthy();
    expect(respB).toBeTruthy();
    // Same item (same qmQuestionId/i), two participants — the presented order
    // genuinely differs, and both values survive distinctly (not collapsed to a
    // single per-item order the way first-appearance-order proxy would).
    expect(respA.questionPresentedNumber).toBe(4);
    expect(respB.questionPresentedNumber).toBe(3);
    expect(respA.questionPresentedNumber).not.toBe(respB.questionPresentedNumber);
  });

  it("falls back to first-appearance order (and logs it) only when QuestionPresentedNumber is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const synthetic: CleanResponse[] = [
      {
        assessmentName: "Fallback Subj", qmQuestionId: "q1", qmResultId: "R1", qmParticipantId: "a@x.edu",
        participantPseudonym: "P0001", wording: null, description: null, parentWording: null,
        majorElement: null, subElement: null, demandLevel: null, itemSet: null,
        questionType: "Multiple Choice", maxScore: 1, answerGiven: "A", answerGivenChoiceNumber: "1",
        questionPresentedNumber: null, answerScore: 1, responseTime: 10, resultStatus: null,
      },
      {
        assessmentName: "Fallback Subj", qmQuestionId: "q2", qmResultId: "R1", qmParticipantId: "a@x.edu",
        participantPseudonym: "P0001", wording: null, description: null, parentWording: null,
        majorElement: null, subElement: null, demandLevel: null, itemSet: null,
        questionType: "Multiple Choice", maxScore: 1, answerGiven: "B", answerGivenChoiceNumber: "2",
        questionPresentedNumber: null, answerScore: 0, responseTime: 12, resultStatus: null,
      },
    ];
    const fallbackBuilt = buildLiveCycleData(synthetic);
    // Neither response supplied a real value, so both fell back — the omission
    // rate/completion/speededness computation still runs (proxy order, same as
    // the pre-fix behaviour) rather than throwing or silently mis-ordering.
    const diag = fallbackBuilt.diagnostics.find((d) => d.assessmentName === "Fallback Subj");
    expect(diag).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fell back to first-appearance-order proxy"));
    warn.mockRestore();
  });
});

describe("supabase-hydrate.ts — presentation order uses the real question_presented_number", () => {
  async function hydrateFixture() {
    const { ingestCleanResponses } = await import("@/lib/server/ingest-write");
    const { makeRpcAdmin } = await import("@/tests/helpers/mock-rpc-admin");
    const { cleanedResponses: clean, canonical } = ingestThreeExports(files());

    const calls: any[] = [];
    await ingestCleanResponses(makeRpcAdmin(calls) as any, "cycle-qpn", clean, { createdBy: "u1", canonical });
    const p = calls[0].args.p_payload;

    const stamp = (rows: any[]) =>
      rows.map((r: any, i: number) => ({ created_at: new Date(1700000000000 + i * 1000).toISOString(), ...r }));
    const db: MockDb = {
      exam_cycles: [
        { id: "cycle-qpn", name: "G12++ May 2026", status: "scored", region: "eu-west", year_id: null, sitting: "may", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z" },
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

  it("SeedResponse.questionPresentedNumber carries the real per-participant value for both sittings of the same item", async () => {
    const { hydrated, clean, payload } = await hydrateFixture();
    const targetA = clean.find((r) => r.qmResultId === RESULT_A && r.qmQuestionId === TARGET_QUESTION_ID)!;
    const targetB = clean.find((r) => r.qmResultId === RESULT_B && r.qmQuestionId === TARGET_QUESTION_ID)!;

    const itemRow = payload.items.find((it: any) => it.qm_question_id === TARGET_QUESTION_ID);
    const partRowA = payload.participants.find((pt: any) => pt.qm_participant_id === targetA.qmParticipantId);
    const partRowB = payload.participants.find((pt: any) => pt.qm_participant_id === targetB.qmParticipantId);
    expect(itemRow).toBeTruthy();
    expect(partRowA).toBeTruthy();
    expect(partRowB).toBeTruthy();

    const seedAssessment = hydrated.seed.liveCycle.assessments.find((a) => a.name === targetA.assessmentName)!;
    const respA = seedAssessment.responses.find((r) => r.i === itemRow.id && r.p === partRowA.id);
    const respB = seedAssessment.responses.find((r) => r.i === itemRow.id && r.p === partRowB.id);
    expect(respA).toBeTruthy();
    expect(respB).toBeTruthy();
    expect(respA!.questionPresentedNumber).toBe(4);
    expect(respB!.questionPresentedNumber).toBe(3);
    expect(respA!.questionPresentedNumber).not.toBe(respB!.questionPresentedNumber);
  });
});

describe("in-memory-provider.ts — live diagnostics recompute (getDiagnostics) uses real order", () => {
  const EMPTY_VALIDATION = {
    passed: true,
    checks: [],
    stats: { rawRows: 0, mcqRows: 0, droppedSurveyRows: 0, droppedNonMcqRows: 0, assessments: 0, participants: 0, items: 0 },
  } as unknown as ValidationReport;

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
        validation: EMPTY_VALIDATION as unknown as Seed["liveCycle"]["validation"],
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
      assessmentName: "Order Test",
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
      responseTime: 10,
      resultStatus: null,
      ...over,
    };
  }

  // Two participants, four items, each answered by both — but presented in a
  // DIFFERENT order per participant (a cyclic shift), exactly the kind of
  // per-participant variation confirmed in the 700435 fixture. The old
  // first-appearance-order proxy would assign every item the SAME order for both
  // participants (their position in `a.items`, fixed at ingest) and always mark
  // q4 (last inserted) as the "late" item. Using the real QuestionPresentedNumber
  // per response instead makes q3 the late item (see earliest-order derivation
  // below) — a directly observable difference that proves the live recompute
  // reads the real per-response value, not item position.
  function buildClean(): CleanResponse[] {
    const participants: [string, string, Record<string, number>][] = [
      ["a@x.edu", "P0001", { q1: 1, q2: 2, q3: 3, q4: 4 }],
      ["b@x.edu", "P0002", { q1: 2, q2: 3, q3: 4, q4: 1 }],
    ];
    const recs: CleanResponse[] = [];
    for (const [qmParticipantId, participantPseudonym, order] of participants) {
      for (const qmQuestionId of ["q1", "q2", "q3", "q4"]) {
        recs.push(
          resp({
            qmParticipantId,
            participantPseudonym,
            qmQuestionId,
            qmResultId: `R-${participantPseudonym}`,
            questionPresentedNumber: order[qmQuestionId]!,
          }),
        );
      }
    }
    return recs;
  }

  it("getDiagnostics' omissionByPosition follows the real per-response order, not item-array position", async () => {
    const p = new InMemoryDataProvider(emptySeed());
    await p.ingestRawExport("new-cycle", { name: "export.csv", sizeMB: 0.1 }, buildClean(), EMPTY_VALIDATION);

    const assessmentId = (p as unknown as { seed: Seed }).seed.liveCycle.assessments[0]!.id;
    const diag = p.getDiagnostics("new-cycle")!.assessments.find((a) => a.assessmentId === assessmentId)!;

    expect(diag.omissionByPosition).toHaveLength(4);
    // Earliest-order derivation over the REAL per-response values: q1 earliest=1,
    // q2=2, q3=3, q4=1 (tie with q1, but q1 was inserted first) → ordered
    // [q1, q4, q2, q3], so position 4 (the last/"late" item) is q3 — NOT q4, which
    // is what the old first-appearance-order proxy (fixed item-array position,
    // identical for every participant) would always have produced.
    expect(diag.omissionByPosition[3]!.itemId).toBe("q3");
    expect(diag.omissionByPosition[3]!.itemId).not.toBe("q4");
  });

  it("falls back to item-array position (and logs it) when questionPresentedNumber is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = new InMemoryDataProvider(emptySeed());
    const clean = buildClean().map((r) => ({ ...r, questionPresentedNumber: null }));
    await p.ingestRawExport("new-cycle", { name: "export.csv", sizeMB: 0.1 }, clean, EMPTY_VALIDATION);

    const assessmentId = (p as unknown as { seed: Seed }).seed.liveCycle.assessments[0]!.id;
    // Reading getDiagnostics (not ingestRawExport) is what triggers the live
    // diagResponsesFor recompute, so the fallback warning fires here.
    const diag = p.getDiagnostics("new-cycle")!.assessments.find((a) => a.assessmentId === assessmentId)!;
    expect(diag.omissionByPosition).toHaveLength(4);
    // Every response fell back to item-array position, so it is identical for
    // both participants and q4 (last inserted) is the late item again.
    expect(diag.omissionByPosition[3]!.itemId).toBe("q4");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fell back to item-array-position proxy"));
    warn.mockRestore();
  });
});
