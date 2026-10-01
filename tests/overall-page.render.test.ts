/**
 * Overall view (year best-of-two) render test. Smoke-renders the real page with
 * the live provider to lock the design: a per-student table reusing the Grades
 * layout, a Feb/May provenance tag on every subject cell, and the derived overall
 * award per student. Reads provider read-models only — engine parity unaffected.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement as e } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import type { DataProvider } from "@/lib/data/provider";

const live = new InMemoryDataProvider();
live.lockCycle("may-2026"); // Overall renders only once both sittings are locked
const provisional = new InMemoryDataProvider(); // May still open

let activeProvider: DataProvider = live;
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  usePathname: () => "/years/year-2026/overall",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/data/context", () => ({
  useProvider: () => activeProvider,
  useProviderData: <T,>(selector: (p: DataProvider) => T) => selector(activeProvider),
}));

async function renderOverall(yearId: string): Promise<string> {
  const { default: Page } = await import("@/app/years/[yearId]/overall/page");
  return renderToStaticMarkup(e(Page, { params: { yearId } }));
}

describe("Overall view — best-of-two with Feb/May provenance", () => {
  it("renders a per-student table with every subject + an Overall award column", async () => {
    activeProvider = live;
    const overall = live.getOverallGrades("year-2026")!;
    const html = await renderOverall("year-2026");

    expect(html).toContain("Overall award");
    for (const h of ["Applicable Math", "English", "Scientific", "Arabic", "Life"]) {
      expect(html).toContain(`>${h}<`);
    }
    // Each subject carries a February, a May and a Combined column.
    expect(html.match(/>Combined</g)?.length).toBe(5);
    expect(html.match(/>Feb<\/th>/g)?.length).toBe(5);
    expect(html.match(/>May<\/th>/g)?.length).toBe(5);
    // First few students reach the markup.
    for (const r of overall.rows.slice(0, 4)) {
      expect(html).toContain(r.label);
    }
  });

  it("shows a Feb/May provenance tag on the subject cells", async () => {
    activeProvider = live;
    const html = await renderOverall("year-2026");
    expect(html).toContain(">Feb<");
    expect(html).toContain(">May<");
  });

  it("labels the synthesized February baseline as demo data", async () => {
    activeProvider = live;
    const html = await renderOverall("year-2026");
    expect(html).toContain("Demo February sitting");
  });

  it("shows no table — only the outstanding sittings — until both are locked", async () => {
    activeProvider = provisional;
    const html = await renderOverall("year-2026");
    expect(html).toContain("Overall is not available yet");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Generate certificates");
    expect(html).toMatch(/May<\/strong>: .*not locked/);
  });
});
