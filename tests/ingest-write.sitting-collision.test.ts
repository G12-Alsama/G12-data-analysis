/**
 * Whole-sitting collision guard (task 21b) — the responses write must be fully
 * SITTING-QUALIFIED so two sittings of the SAME subject (identical shared items,
 * different ResultId) both persist EVERY response row. The intermittent 15→6 score
 * matrix collapse was distinct sittings colliding on write; this locks it out at the
 * payload grain the DB persists.
 */
import { describe, it, expect, vi } from "vitest";
import { makeRpcAdmin, type RpcCall } from "./helpers/mock-rpc-admin";
import type { CleanResponse } from "@/lib/ingest/types";

vi.mock("server-only", () => ({}));
const { ingestCleanResponses } = await import("@/lib/server/ingest-write");

const CYCLE = "00000000-0000-0000-0000-0000000000cc";

/** One MCQ response, defaulting the boilerplate fields. */
function resp(over: Partial<CleanResponse>): CleanResponse {
  return {
    assessmentName: "G12++ Applicable Math",
    qmQuestionId: "Q1",
    qmResultId: "R1",
    qmParticipantId: "p1@example.edu",
    participantPseudonym: "P0001",
    wording: null,
    description: null,
    parentWording: null,
    majorElement: "Number",
    subElement: null,
    demandLevel: null,
    itemSet: null,
    questionType: "Multiple Choice",
    maxScore: 1,
    answerGiven: "A",
    answerGivenChoiceNumber: "1",
    answerScore: 1,
    responseTime: 10,
    resultStatus: "Finished",
    ...over,
  };
}

/** Two full sittings of the SAME subject: identical shared questions (→ shared
 *  item_ids), different ResultId + participant. */
function twoSittings(): CleanResponse[] {
  const questions = ["Q1", "Q2", "Q3"];
  const rows: CleanResponse[] = [];
  for (const q of questions) {
    rows.push(resp({ qmQuestionId: q, qmResultId: "R-alice", qmParticipantId: "alice@example.edu", participantPseudonym: "P0001" }));
    rows.push(resp({ qmQuestionId: q, qmResultId: "R-bob", qmParticipantId: "bob@example.edu", participantPseudonym: "P0002" }));
  }
  return rows;
}

async function persist(recs: CleanResponse[]): Promise<Record<string, unknown[]>> {
  const calls: RpcCall[] = [];
  await ingestCleanResponses(makeRpcAdmin(calls) as never, CYCLE, recs, { createdBy: "user-1" });
  return calls[0]!.args.p_payload as unknown as Record<string, unknown[]>;
}

describe("responses write is sitting-qualified — two sittings of one subject both survive", () => {
  it("keeps every response row of BOTH sittings (no whole-sitting collapse)", async () => {
    const payload = await persist(twoSittings());
    const responses = payload.responses as Record<string, unknown>[];

    // Both sittings survive at the sitting grain.
    const bySitting = new Set(responses.map((r) => r.qm_result_id));
    expect(bySitting).toEqual(new Set(["R-alice", "R-bob"]));

    // Each sitting keeps all 3 of its question rows.
    for (const rid of ["R-alice", "R-bob"]) {
      const rows = responses.filter((r) => r.qm_result_id === rid);
      expect(rows.map((r) => r.question_id).sort()).toEqual(["Q1", "Q2", "Q3"]);
    }

    // The shared item_id is REUSED across sittings (proving the collision surface),
    // yet the rows stay distinct on BOTH the natural key and the surrogate pair.
    const itemIdByQ = new Map(responses.map((r) => [`${r.qm_result_id}|${r.question_id}`, r.item_id]));
    expect(itemIdByQ.get("R-alice|Q1")).toBe(itemIdByQ.get("R-bob|Q1")); // same item_id
    expect(new Set(responses.map((r) => `${r.item_id}|${r.qm_result_id}`)).size).toBe(responses.length);
    expect(new Set(responses.map((r) => `${r.qm_result_id}|${r.question_id}`)).size).toBe(responses.length);
    expect(responses.length).toBe(6); // 2 sittings × 3 questions, none dropped
  });

  it("genuine duplicate (same sitting × question) is deduped, not the second sitting", async () => {
    const recs = twoSittings();
    // Duplicate Alice's Q1 exactly (a repeated source row for ONE sitting×question).
    recs.push(resp({ qmQuestionId: "Q1", qmResultId: "R-alice", qmParticipantId: "alice@example.edu", participantPseudonym: "P0001", answerScore: 0 }));
    const payload = await persist(recs);
    const responses = payload.responses as Record<string, unknown>[];
    // Still exactly 6 rows — the duplicate collapsed, both sittings intact.
    expect(responses.length).toBe(6);
    expect(responses.filter((r) => r.qm_result_id === "R-alice")).toHaveLength(3);
    expect(responses.filter((r) => r.qm_result_id === "R-bob")).toHaveLength(3);
  });

  it("surfaces a response with no ResultId as an ERROR — never a silent collapse", async () => {
    const recs = twoSittings();
    // A row that cannot be sitting-qualified (blank ResultId) — the exact silent-drop
    // path: its dedup key would be `|Q1` and collapse distinct sittings.
    recs.push(resp({ qmQuestionId: "Q1", qmResultId: "", qmParticipantId: "carol@example.edu", participantPseudonym: "P0003" }));
    await expect(persist(recs)).rejects.toThrow(/no ResultId|cannot be attached|would silently collapse|collapse into one another/i);
  });
});
