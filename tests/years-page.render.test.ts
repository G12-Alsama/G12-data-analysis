/**
 * The Years pages show REAL stats for every sitting, straight from the light summary —
 * before any sitting has been opened. (Non-newest sittings used to show 0 participants,
 * 0 assessments, a forced "Locked & exported" stage and a MOCK tag.)
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
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/data/context", () => ({
  useProvider: () => active,
  useProviderData: <T,>(selector: (p: DataProvider) => T) => selector(active),
}));

const db = () =>
  buildDb([
    { id: "f", name: "February 2026", sitting: "february", status: "locked", age: 10, date: "2026-02-12",
      students: { "a@s.edu": [1, 1, 1, 0], "b@s.edu": [1, 0, 0, 0], "c@s.edu": [1, 1, 0, 0] } },
    { id: "m", name: "May 2026", sitting: "may", status: "in_review", age: 20, date: "2026-05-14",
      students: { "a@s.edu": [1, 1, 1, 1], "b@s.edu": [1, 1, 0, 0] } },
  ]);

async function renderYear(): Promise<string> {
  const { default: Page } = await import("@/app/years/[yearId]/page");
  return renderToStaticMarkup(e(Page, { params: { yearId: YEAR } }));
}

describe("Year page — both sittings show real stats without being opened", () => {
  it("shows each sitting's own participants and assessments (not zeros)", async () => {
    const { provider, fake } = await liveProvider(db());
    active = provider;
    fake.clearLog();
    const html = await renderYear();
    // February (older, never opened): 3 participants · May: 2 — each tile its own number
    expect(html).toMatch(/>3<\/div><div class="hf-sub"[^>]*>Participants</);
    expect(html).toMatch(/>2<\/div><div class="hf-sub"[^>]*>Participants</);
    expect(html.match(/>1<\/div><div class="hf-sub"[^>]*>Assessments</g)).toHaveLength(2);
    // rendering it read no per-cycle fact table
    expect(fake.log.filter((q) => ["responses", "items", "sittings"].includes(q.table))).toEqual([]);
  });

  it("shows the REAL lock/stage state — no forced mock, locked, or ACTIVE", async () => {
    const { provider } = await liveProvider(db());
    active = provider;
    const html = await renderYear();
    expect(html).toContain("Locked");       // February is locked in the DB
    expect(html).toContain("In progress");  // May is not
    expect(html).not.toContain("MOCK");
    expect(html).not.toContain("ACTIVE");
    expect(html).toContain("Locked &amp; exported"); // February's real stage
    expect(html).toMatch(/Question review/);          // May's real stage (not the forced locked one)
  });

  it("shows the date each sitting was held", async () => {
    const { provider } = await liveProvider(db());
    active = provider;
    const html = await renderYear();
    expect(html).toContain("12 February 2026");
    expect(html).toContain("14 May 2026");
  });

  it("the Overall card explains that only locked sittings count", async () => {
    const { provider } = await liveProvider(db());
    active = provider;
    const html = await renderYear();
    expect(html).toContain("counts only sittings whose grades are locked");
    expect(html).toContain("February: locked — counted");
    expect(html).toContain("May: not counted yet — grades not locked");
  });
});

describe("Years list (home) — real stats for every year's sittings", () => {
  it("lists the year with both sittings, neither flagged MOCK", async () => {
    const { provider } = await liveProvider(db());
    active = provider;
    const { default: Home } = await import("@/app/page");
    const html = renderToStaticMarkup(e(Home));
    expect(html).toContain("2026");
    expect(html).toContain("February");
    expect(html).toContain("May");
    expect(html).not.toContain("MOCK");
  });
});
