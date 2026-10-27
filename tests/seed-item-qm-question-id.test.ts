/**
 * SeedItem.qmQuestionId — QM's real QuestionId on the item model.
 *
 * On the live-ingest path `SeedItem.id` already IS the QM QuestionId, but on the
 * DB-hydrate path `id` is the `items` row UUID and the QM id sits in
 * `items.qm_question_id`, which was never loaded. Exports that must show the real
 * 12-digit QuestionId (per-item Speededness/Omission/Completion) therefore need it
 * carried explicitly. Additive: optional field, no schema change.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ingestThreeExports } from "@/lib/ingest/qm";
import { buildLiveCycleData } from "@/lib/data/build-live-cycle";
import { hydrate } from "@/lib/data/supabase-hydrate";
import { makeSupabaseReadClient, type MockDb } from "@/tests/helpers/mock-supabase-read";

vi.mock("server-only", () => ({}));

const qmDir = path.join(process.cwd(), "tests", "fixtures", "qm");
const read = (n: string) => readFileSync(path.join(qmDir, `${n}.csv`));
const files = () => [
  { name: "Items.csv", data: read("Items") },
  { name: "Assessments.csv", data: read("Assessments") },
  { name: "Topics.csv", data: read("Topics") },
];

describe("SeedItem.qmQuestionId", () => {
  it("live ingest: carries the QM QuestionId", () => {
    const { cleanedResponses } = ingestThreeExports(files());
    const items = buildLiveCycleData(cleanedResponses).assessments.flatMap((a) => a.items);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.qmQuestionId).toBe(it.id);
  });

  it("DB hydrate: carries items.qm_question_id, distinct from the UUID item id", async () => {
    const { ingestCleanResponses } = await import("@/lib/server/ingest-write");
    const { makeRpcAdmin } = await import("@/tests/helpers/mock-rpc-admin");
    const { cleanedResponses, canonical } = ingestThreeExports(files());
    const calls: any[] = [];
    await ingestCleanResponses(makeRpcAdmin(calls) as any, "cycle-qid", cleanedResponses, { createdBy: "u1", canonical });
    const p = calls[0].args.p_payload;
    const stamp = (rows: any[]) =>
      rows.map((r: any, i: number) => ({ created_at: new Date(1700000000000 + i * 1000).toISOString(), ...r }));
    const db: MockDb = {
      exam_cycles: [
        { id: "cycle-qid", name: "G12++ May 2026", status: "scored", region: "eu-west", year_id: null, sitting: "may", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z" },
      ],
      test_centres: [], exam_years: [],
      assessments: p.assessments.map((a: any) => ({ status: "scored", created_at: "2026-05-01T00:00:00Z", ...a })),
      items: p.items.map((it: any) => ({ status: "active", created_at: "2026-05-01T00:00:00Z", ...it })),
      participants: stamp(p.participants),
      responses: stamp(p.responses).map((r: any, i: number) => ({ id: `resp-${i}`, ...r })),
      item_stats: [], item_reviews: [], grade_schemes: [], grades: [], essay_marks: [],
      incidents: [], alterations: [], distinction_overrides: [], workspace_settings: [],
      element_labels: [], clean_exclusions: [], distinction_state: [], document_settings: [], import_batches: [],
    } as MockDb;
    const hydrated = (await hydrate(makeSupabaseReadClient(db) as any))!;
    const qidByRowId = new Map<string, string>(p.items.map((i: any) => [i.id, i.qm_question_id]));
    const items = hydrated.seed.liveCycle.assessments.flatMap((a) => a.items);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.qmQuestionId).toBe(qidByRowId.get(it.id));
      expect(it.qmQuestionId).toMatch(/^\d+$/); // the real numeric QM id, not the row UUID
      expect(it.qmQuestionId).not.toBe(it.id);
    }
  });
});
