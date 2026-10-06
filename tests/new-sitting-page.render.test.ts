/**
 * The create-sitting form exposes the period and year as explicit choices.
 * Static render against a provider hydrated from real-shaped rows.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement as e } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { hydrate } from "@/lib/data/supabase-hydrate";
import { makeSupabaseReadClient, type MockDb } from "@/tests/helpers/mock-supabase-read";
import type { DataProvider } from "@/lib/data/provider";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  usePathname: () => "/cycles/new",
  useSearchParams: () => new URLSearchParams(),
}));

let active: DataProvider = new InMemoryDataProvider();
vi.mock("@/lib/data/context", () => ({
  useProvider: () => active,
  useProviderData: <T,>(selector: (p: DataProvider) => T) => selector(active),
}));

const CENTRE = "11111111-0000-0000-0000-000000000001";
const YEAR = "yyyyyyyy-0000-0000-0000-000000002026";

async function liveProvider(): Promise<DataProvider> {
  const db: MockDb = {
    test_centres: [{ id: CENTRE, name: "Shatila 1", code: "SHA1", slug: "shatila-1", active: true, created_at: "2026-01-01T00:00:00Z" }],
    exam_years: [{ id: YEAR, name: "2026", region: "eu-west", test_centre_id: CENTRE }],
    exam_cycles: [{ id: "c-may", name: "May 2026", status: "draft", region: "eu-west", year_id: YEAR, sitting: "may", created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z" }],
  };
  const h = (await hydrate(makeSupabaseReadClient(db) as never))!;
  return new InMemoryDataProvider(h.seed, undefined, true);
}

describe("Start a new sitting — Period and Year are explicit choices", () => {
  it("renders the February / May period selector and a year picker with the existing year + 'New year…'", async () => {
    active = await liveProvider();
    const { default: NewCyclePage } = await import("@/app/cycles/new/page");
    const html = renderToStaticMarkup(e(NewCyclePage));

    expect(html).toContain(">Period<");
    expect(html).toMatch(/>February<\/button>/);
    expect(html).toMatch(/>May<\/button>/);
    expect(html).toContain('aria-label="Year"');
    expect(html).toContain(">2026</option>");
    expect(html).toContain("New year…");
  });

  it("with no real years (demo), offers the new-year entry instead", async () => {
    active = new InMemoryDataProvider();
    const { default: NewCyclePage } = await import("@/app/cycles/new/page");
    const html = renderToStaticMarkup(e(NewCyclePage));

    expect(html).toContain('aria-label="New year"');
    expect(html).toContain('value="2026"'); // defaulted from the sitting date
  });
});
