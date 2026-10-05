/**
 * The cycle layout makes sure a sitting is LOADED before its pages render, with an honest
 * loading / error state in between (never a misleading "no data for this sitting").
 */
import { describe, it, expect, vi } from "vitest";
import { createElement as e } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CycleLoadState } from "@/lib/data/types";
import type { DataProvider } from "@/lib/data/provider";

let state: CycleLoadState = "ready";
const stub = { getCycleLoadState: () => state, ensureCycleLoaded: vi.fn(async () => {}), getCurrentUser: () => ({ id: "u", name: "U", initials: "U", role: "lead_admin" }) } as unknown as DataProvider;
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  usePathname: () => "/cycles/c/score",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/data/context", () => ({
  useProvider: () => stub,
  useProviderData: <T,>(selector: (p: DataProvider) => T) => selector(stub),
}));
vi.mock("@/components/shell/Shell", () => ({
  Shell: ({ children }: { children?: React.ReactNode }) => e("div", { "data-shell": true }, children),
}));

async function render(s: CycleLoadState): Promise<string> {
  state = s;
  const { default: Layout } = await import("@/app/cycles/[cycleId]/layout");
  return renderToStaticMarkup(e(Layout, { params: { cycleId: "c" }, children: e("p", null, "PAGE BODY") }));
}

describe("cycle layout", () => {
  it("renders the page once the sitting is ready", async () => {
    expect(await render("ready")).toContain("PAGE BODY");
  });
  it("shows a loading state — NOT the page and NOT a 'no data' empty state — while it loads", async () => {
    const html = await render("loading");
    expect(html).toContain("Loading this sitting");
    expect(html).not.toContain("PAGE BODY");
    expect(html).not.toMatch(/no data/i);
  });
  it("shows a retryable error if the load failed", async () => {
    const html = await render("error");
    expect(html).toContain("Couldn’t load this sitting");
    expect(html).toContain("Retry");
    expect(html).not.toContain("PAGE BODY");
  });
  it("lets the page render its own 'not found' for a sitting that doesn't exist", async () => {
    expect(await render("missing")).toContain("PAGE BODY");
  });
});
