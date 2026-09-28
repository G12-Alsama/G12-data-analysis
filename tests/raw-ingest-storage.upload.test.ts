/**
 * Raw-ingest Storage upload — proves the payload Blob actually carries
 * `application/gzip`, not the browser's default `application/octet-stream`.
 *
 * Root cause (found live): @supabase/storage-js uploads a Blob body via
 * FormData and labels that multipart part from the Blob's OWN `.type` — the
 * `contentType` upload option is only read for a non-Blob/non-FormData body, so
 * it's silently ignored here. `gzipText`'s `Response.blob()` had no type set,
 * which the runtime defaults to `application/octet-stream` on upload — which
 * the `raw-ingest` bucket's `allowed_mime_types` (migration 0046) then rejects
 * with a 400. Asserting only on the `contentType` OPTION passed to `.upload()`
 * would not have caught this; the fix (and this test) is on the Blob's own type.
 */
import { describe, it, expect, vi } from "vitest";
import { SupabaseDataProvider } from "@/lib/data/supabase-provider";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";
import type { ValidationReport } from "@/lib/ingest/types";

// Hydration is exercised elsewhere (this provider is never unit-tested against a
// real Supabase backend — see supabase-hydrate.ts's own tests); stub it to the
// "no cycle yet" fast path so this test stays scoped to the upload call.
vi.mock("@/lib/data/supabase-hydrate", () => ({
  hydrate: vi.fn().mockResolvedValue(null),
  fetchSeedTestCentres: vi.fn().mockResolvedValue([]),
  fetchSessionUser: vi.fn().mockResolvedValue({
    status: "ok",
    user: { id: "user-1", name: "Test Admin", initials: "TA", role: "lead_admin" },
  }),
  fetchOverallAnalytics: vi.fn().mockResolvedValue({ cells: [], subjects: [], years: [] }),
}));

describe("SupabaseDataProvider.ingestRawExport → Storage upload", () => {
  it("uploads a Blob whose own type is application/gzip, not the contentType option alone", async () => {
    const uploadCalls: Array<{ path: string; body: unknown; options: unknown }> = [];
    const upload = vi.fn(async (path: string, body: unknown, options: unknown) => {
      uploadCalls.push({ path, body, options });
      return { data: { path, id: "obj-1", fullPath: path }, error: null };
    });

    const supabase = {
      auth: { onAuthStateChange: vi.fn() },
      storage: { from: vi.fn().mockReturnValue({ upload }) },
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as unknown as SupabaseBrowserClient;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ingest: {}, compute: {} }) }),
    );

    try {
      const provider = new SupabaseDataProvider(supabase);
      const report = {
        passed: true,
        checks: [],
        stats: { rawRows: 0, mcqRows: 0, droppedSurveyRows: 0, droppedNonMcqRows: 0, assessments: 0, participants: 0, items: 0 },
      } satisfies ValidationReport;
      await provider.ingestRawExport("cycle-1", { name: "Assessments.csv", sizeMB: 0.01 }, [], report);

      expect(upload).toHaveBeenCalledTimes(1);
      expect(uploadCalls).toHaveLength(1);

      const { path, body, options } = uploadCalls[0]!;
      expect(path).toMatch(/^cycle-1\/[0-9a-f-]{36}\.json\.gz$/);

      // The actual point of truth for a Blob-bodied upload: storage-js reads the
      // Blob's OWN type when wrapping it in FormData, never the `contentType`
      // option below — this is what a fix that only set the option would miss.
      expect(body).toBeInstanceOf(Blob);
      expect((body as Blob).type).toBe("application/gzip");

      // The option is still passed (documented intent / safety net — see the
      // comment at the call site) but is NOT what makes this pass.
      expect(options).toMatchObject({ contentType: "application/gzip" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
