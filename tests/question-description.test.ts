/**
 * QuestionDescription — persisted per item (migration 0048), following the
 * QuestionPresentedNumber (0047) pattern end-to-end:
 *   ingest payload → items.description → buildLiveCycleData → hydrate → SeedItem.
 *
 * `QuestionDescription` was always PARSED at ingest (CleanResponse.description)
 * but never persisted, so live / DB-hydrated items carried no description. It is
 * a per-QUESTION constant, so (unlike the per-response presented number) it lives
 * on `items`, beside `wording`.
 *
 * Strictly additive: existing cycles keep a null description until re-ingested,
 * and a pre-0048 `items` row (no `description` key at all) must hydrate to null.
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

/** The fixture's own descriptions are redacted, so stamp a distinct, per-question one. */
const descOf = (qid: string) => `DESC-${qid}`;
function withDescriptions() {
  const { cleanedResponses, canonical } = ingestThreeExports(files());
  return { clean: cleanedResponses.map((r) => ({ ...r, description: descOf(r.qmQuestionId) })), canonical };
}

describe("ingestCleanResponses — persists items.description", () => {
  it("carries the per-question description into the items payload", async () => {
    const { ingestCleanResponses } = await import("@/lib/server/ingest-write");
    const { makeRpcAdmin } = await import("@/tests/helpers/mock-rpc-admin");
    const { clean, canonical } = withDescriptions();

    const calls: any[] = [];
    await ingestCleanResponses(makeRpcAdmin(calls) as any, "cycle-desc", clean, { createdBy: "u1", canonical });
    const items = calls[0].args.p_payload.items as Record<string, unknown>[];

    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.description).toBe(descOf(String(it.qm_question_id)));
  });

  it("writes null (not a placeholder) when the export carries no description", async () => {
    const { ingestCleanResponses } = await import("@/lib/server/ingest-write");
    const { makeRpcAdmin } = await import("@/tests/helpers/mock-rpc-admin");
    const { cleanedResponses, canonical } = ingestThreeExports(files());
    const blank = cleanedResponses.map((r) => ({ ...r, description: null }));

    const calls: any[] = [];
    await ingestCleanResponses(makeRpcAdmin(calls) as any, "cycle-desc", blank, { createdBy: "u1", canonical });
    const items = calls[0].args.p_payload.items as Record<string, unknown>[];
    for (const it of items) expect(it.description).toBeNull();
  });
});

describe("buildLiveCycleData — SeedItem.description", () => {
  it("carries the description for every item", () => {
    const { clean } = withDescriptions();
    const built = buildLiveCycleData(clean);
    const items = built.assessments.flatMap((a) => a.items);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.description).toBe(descOf(it.id));
  });

  it("is null when the export has no description", () => {
    const { cleanedResponses } = ingestThreeExports(files());
    const built = buildLiveCycleData(cleanedResponses.map((r) => ({ ...r, description: null })));
    for (const it of built.assessments.flatMap((a) => a.items)) expect(it.description).toBeNull();
  });
});

describe("supabase-hydrate — SeedItem.description", () => {
  async function hydrateWith(transformItem: (it: any) => any) {
    const { ingestCleanResponses } = await import("@/lib/server/ingest-write");
    const { makeRpcAdmin } = await import("@/tests/helpers/mock-rpc-admin");
    const { clean, canonical } = withDescriptions();
    const calls: any[] = [];
    await ingestCleanResponses(makeRpcAdmin(calls) as any, "cycle-desc", clean, { createdBy: "u1", canonical });
    const p = calls[0].args.p_payload;
    const stamp = (rows: any[]) =>
      rows.map((r: any, i: number) => ({ created_at: new Date(1700000000000 + i * 1000).toISOString(), ...r }));
    const db: MockDb = {
      exam_cycles: [
        { id: "cycle-desc", name: "G12++ May 2026", status: "scored", region: "eu-west", year_id: null, sitting: "may", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z" },
      ],
      test_centres: [], exam_years: [],
      assessments: p.assessments.map((a: any) => ({ status: "scored", created_at: "2026-05-01T00:00:00Z", ...a })),
      items: p.items.map((it: any) => transformItem({ status: "active", created_at: "2026-05-01T00:00:00Z", ...it })),
      participants: stamp(p.participants),
      responses: stamp(p.responses).map((r: any, i: number) => ({ id: `resp-${i}`, ...r })),
      item_stats: [], item_reviews: [], grade_schemes: [], grades: [], essay_marks: [],
      incidents: [], alterations: [], distinction_overrides: [], workspace_settings: [],
      element_labels: [], clean_exclusions: [], distinction_state: [], document_settings: [], import_batches: [],
    } as MockDb;
    const h = await hydrate(makeSupabaseReadClient(db) as any);
    return { hydrated: h!, payload: p };
  }

  it("carries items.description onto SeedItem.description", async () => {
    const { hydrated, payload } = await hydrateWith((it) => it);
    const items = hydrated.seed.liveCycle.assessments.flatMap((a) => a.items);
    expect(items.length).toBeGreaterThan(0);
    const qidById = new Map<string, string>(payload.items.map((i: any) => [i.id, i.qm_question_id]));
    for (const it of items) expect(it.description).toBe(descOf(qidById.get(it.id)!));
  });

  it("a pre-0048 items row (no `description` key at all) hydrates to null — existing cycles stay empty", async () => {
    const { hydrated } = await hydrateWith((it) => {
      const { description: _omit, ...rest } = it;
      return rest;
    });
    const items = hydrated.seed.liveCycle.assessments.flatMap((a) => a.items);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.description).toBeNull();
  });
});

describe("migration 0048_question_description", () => {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const up = readFileSync(path.join(dir, "0048_question_description.sql"), "utf8");
  const down = readFileSync(path.join(dir, "0048_question_description.rollback.sql"), "utf8");
  const prev = readFileSync(path.join(dir, "0047_question_presented_number.sql"), "utf8");
  const fn = (sql: string) => sql.slice(sql.indexOf("create or replace function public.ingest_persist("), sql.indexOf("grant execute on function public.ingest_persist"));

  it("adds a nullable text column (additive)", () => {
    expect(up).toMatch(/alter table public\.items\s+add column if not exists description text;/);
    expect(up).not.toMatch(/description text not null/i);
    expect(up).not.toMatch(/\bdrop (table|column)\b|\btruncate\b|\bdelete from\b/i);
  });

  it("threads description through the items insert and is otherwise identical to 0047's ingest_persist", () => {
    const upFn = fn(up);
    expect(upFn).toMatch(/insert into items \(id, cycle_id, assessment_id, qm_question_id, wording, description,/);
    expect(upFn).toMatch(/select id, cycle_id, assessment_id, qm_question_id, wording, description,/);
    // Strip the only intended differences and the bodies must match exactly.
    const normalised = upFn
      .replace("  -- 0048: description (QuestionDescription) threaded through (additive column).\n", "")
      .replace("wording, description,", "wording,")
      .replace("wording, description,", "wording,");
    expect(normalised).toBe(fn(prev));
  });

  it("rollback restores the exact 0047 function body and drops the column", () => {
    expect(fn(down)).toBe(fn(prev));
    expect(down).toMatch(/alter table public\.items drop column if exists description;/);
  });
});
