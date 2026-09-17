/**
 * Server-side ingest write path — audit column (`import_batches.created_by`).
 *
 * The persist runs through the secret-key admin client, which has no session, so
 * the DB's `auth.uid()` default for `created_by` is always null and would violate
 * the NOT NULL constraint. Since 0007 the persist is one atomic `ingest_persist`
 * rpc; the resolved user is passed as `p_actor` (the SQL function stamps it onto
 * the import_batches row + audit). These tests prove the write path sends the
 * authenticated user explicitly, and refuses (clear error, no rpc) when none is
 * resolved — rather than ever relying on a null default.
 */
import { describe, it, expect, vi } from "vitest";
import type { CleanResponse } from "@/lib/ingest/types";
import { makeRpcAdmin, type RpcCall } from "./helpers/mock-rpc-admin";

// The write path is a server module (`import "server-only"`), which throws when
// loaded outside a server component. Stub it so we can exercise the pure logic.
vi.mock("server-only", () => ({}));

const { ingestCleanResponses } = await import("@/lib/server/ingest-write");

function sampleRecs(): CleanResponse[] {
  const mk = (q: string, p: string): CleanResponse => ({
    assessmentName: "Applicable Mathematics",
    qmQuestionId: q,
    qmResultId: `R-${p}`,
    qmParticipantId: p,
    participantPseudonym: `pseudo-${p}`,
    wording: null,
    description: null,
    parentWording: null,
    majorElement: null,
    subElement: null,
    demandLevel: null,
    itemSet: null,
    questionType: "MCQ",
    maxScore: 1,
    answerGiven: "A",
    answerGivenChoiceNumber: "1",
    answerScore: 1,
    responseTime: null,
    resultStatus: null,
  });
  return [mk("Q1", "P1"), mk("Q2", "P1"), mk("Q1", "P2")];
}

describe("ingestCleanResponses — created_by / actor", () => {
  it("passes the authenticated user as p_actor and onto the import batch (never null)", async () => {
    const calls: RpcCall[] = [];
    await ingestCleanResponses(makeRpcAdmin(calls) as never, "cycle-1", sampleRecs(), {
      fileRef: "export.xlsx",
      createdBy: "user-123",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("ingest_persist");
    expect(calls[0]!.args.p_actor).toBe("user-123");
    // The import_batch in the payload carries the file ref; created_by is stamped
    // server-side from p_actor (the SQL function), never sent as null here.
    expect(calls[0]!.args.p_payload.import_batch.file_ref).toBe("export.xlsx");
  });

  it("throws a clear 'must be signed in' error and makes no rpc call when no user is present", async () => {
    const calls: RpcCall[] = [];
    await expect(
      ingestCleanResponses(makeRpcAdmin(calls) as never, "cycle-1", sampleRecs(), {
        createdBy: "",
        fileRef: "export.xlsx",
      }),
    ).rejects.toThrow(/signed in/i);

    // Guard against a partial write: nothing should have been persisted.
    expect(calls).toHaveLength(0);
  });
});
