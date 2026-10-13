/**
 * The Overall PAGE over real sittings: it lists every sitting with whether it counts
 * ("not counted yet: grades not locked"), and shows only locked sittings' results.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement as e } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { liveProvider } from "@/tests/helpers/fake-supabase-live";
import { buildDb, YEAR } from "@/tests/helpers/multi-cycle-db";
import type { DataProvider } from "@/lib/data/provider";

vi.mock("server-only", () => ({}));
let active: DataProvider;
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  usePathname: () => "/years/y/overall",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/data/context", () => ({
  useProvider: () => active,
  useProviderData: <T,>(selector: (p: DataProvider) => T) => selector(active),
}));

const sittings = (mayStatus: string) =>
  buildDb([
    { id: "f", name: "February 2026", sitting: "february", status: "locked", age: 10, students: { "amal@s.edu": [1, 1, 1, 0], "bilal@s.edu": [1, 1, 0, 0] } },
    { id: "m", name: "May 2026", sitting: "may", status: mayStatus, age: 20, students: { "amal@s.edu": [1, 1, 1, 1] } },
  ]);

async function render(): Promise<string> {
  const { default: Page } = await import("@/app/years/[yearId]/overall/page");
  return renderToStaticMarkup(e(Page, { params: { yearId: YEAR } }));
}

describe("Overall page over real sittings", () => {
  it("shows the unlocked sitting as 'not counted yet' and only the locked sitting's students", async () => {
    const { provider } = await liveProvider(sittings("in_review"));
    active = provider;
    await provider.ensureYearLoaded(YEAR);
    const html = await render();
    expect(html).toMatch(/May: not counted yet — grades not locked/);
    expect(html).toContain('data-status="not_locked"');
    expect(html).toContain("amal");
    expect(html).toContain("bilal");
    expect(html).not.toContain("Demo February sitting");
  });

  it("when both sittings are locked, both are counted and the table has the rolled-up students", async () => {
    const { provider } = await liveProvider(sittings("locked"));
    active = provider;
    await provider.ensureYearLoaded(YEAR);
    const html = await render();
    expect(html).not.toContain("not counted yet");
    expect(html.match(/data-status="counted"/g)).toHaveLength(2);
    expect(html).toContain("Overall award");
  });

  it("with nothing locked, says so instead of showing an empty table", async () => {
    const db = sittings("in_review");
    db.exam_cycles!.find((c) => c.id === "f")!.status = "in_review";
    const { provider } = await liveProvider(db);
    active = provider;
    const html = await render();
    expect(html).toContain("No results to roll up yet");
    expect(html).toMatch(/No sitting is locked yet/);
  });
});
