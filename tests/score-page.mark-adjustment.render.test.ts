/**
 * Score page (and Grades view) — what a user sees and can do around a mark adjustment.
 *
 * Smoke-renders the real pages with the in-memory provider via renderToStaticMarkup:
 *   - a user who holds `grades.adjust` gets an editable score cell + the ±5 hint;
 *   - a user whose role lacks it gets NO edit control and no Undo — but STILL sees the
 *     adjusted cell's ± marker and its detail popover trigger (the badge is for everyone);
 *   - the same permission gate now applies to the Grades-view nudge;
 *   - the shared dialog clamps to ±maxDelta around the current mark (and to 0..max);
 *   - the popover shows old → new, delta, reason, actor and time, with Undo only for a
 *     user who may adjust.
 * (No DOM library here, so clicks are covered through the provider contract in
 * tests/score-page.mark-adjustment.test.ts; this file covers what is rendered.)
 */
import { describe, it, expect, vi } from "vitest";
import { createElement as e } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import type { DataProvider } from "@/lib/data/provider";
import type { CurrentUser, ManualMarkAdjustment, SubjectComposition } from "@/lib/data/types";
import { AdjustmentDetail } from "@/components/ui/composition";
import { AdjustMarkModal, markBounds } from "@/components/ui/AdjustMarkModal";

let activeProvider: DataProvider;
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  usePathname: () => "/cycles/x/score",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/data/context", () => ({
  useProvider: () => activeProvider,
  useProviderData: <T,>(selector: (p: DataProvider) => T) => selector(activeProvider),
}));

const REVIEWER: CurrentUser = { id: "m-sami", name: "Omar Reviewer", initials: "OR", role: "reviewer" };
const ADJUST_BUTTON = "Adjust mark (currently";
const TRIGGER = 'aria-label="Mark adjustment details"';

async function renderScore(p: InMemoryDataProvider, cycleId: string): Promise<string> {
  activeProvider = p;
  const { default: ScorePage } = await import("@/app/cycles/[cycleId]/score/page");
  return renderToStaticMarkup(e(ScorePage, { params: { cycleId } }));
}
async function renderGrades(p: InMemoryDataProvider, cycleId: string): Promise<string> {
  activeProvider = p;
  const { default: GradesPage } = await import("@/app/cycles/[cycleId]/grades/page");
  return renderToStaticMarkup(e(GradesPage, { params: { cycleId } }));
}

/** A fresh provider, one nudged cell, and the cycle id — then optionally switch to a user without grades.adjust. */
async function nudged({ asReadOnlyUser = false } = {}) {
  const p = new InMemoryDataProvider();
  const cycle = p.listCycles()[0]!.id;
  const comp = p.getComposition(cycle)!;
  let hit: { pid: string; aid: string; total: number } | undefined;
  for (const s of comp.students) {
    for (const sj of s.subjects) if (!hit && sj.total >= 6 && sj.total <= sj.max - 6) hit = { pid: s.participantId, aid: sj.assessmentId, total: sj.total };
  }
  const t = hit!;
  await p.adjustStudentMarkBounded(cycle, t.pid, t.aid, t.total + 2, "Remarked after appeal");
  if (asReadOnlyUser) {
    p.setRoleAction("team_member", "grades.adjust", false); // an admin edits the role × action grid…
    p.setCurrentUser(REVIEWER); // …then a team member looks at the page
  }
  return { p, cycle, t };
}

describe("Score page — edit controls follow grades.adjust", () => {
  it("a user who holds grades.adjust gets an editable score cell and the ±5 hint", async () => {
    const p = new InMemoryDataProvider();
    const html = await renderScore(p, p.listCycles()[0]!.id);
    expect(html).toContain(ADJUST_BUTTON);
    expect(html).toMatch(/Click a score to adjust it by up to ±5 marks/);
  });

  it("a user without it gets NO edit control and no hint — the figures themselves still render", async () => {
    const { p, cycle } = await nudged({ asReadOnlyUser: true });
    const html = await renderScore(p, cycle);
    expect(html).not.toContain(ADJUST_BUTTON);
    expect(html).not.toContain("Click a score to adjust");
    expect(html).toMatch(/\d+\/\d+ · \d+%/);
  });

  it("the adjusted cell's ± marker and popover trigger are visible to EVERY viewer (no permission needed)", async () => {
    const { p, cycle } = await nudged({ asReadOnlyUser: true });
    const html = await renderScore(p, cycle);
    expect(html).toContain(TRIGGER);
    expect(html).toMatch(/aria-hidden="true"[^>]*>±</);
  });

  it("…and for a user who may adjust, alongside the edit control", async () => {
    const { p, cycle } = await nudged();
    const html = await renderScore(p, cycle);
    expect(html).toContain(TRIGGER);
    expect(html).toContain(ADJUST_BUTTON);
  });

  it("an unadjusted sitting shows no marker at all", async () => {
    const p = new InMemoryDataProvider();
    const html = await renderScore(p, p.listCycles()[0]!.id);
    expect(html).not.toContain(TRIGGER);
  });

  it("a locked sitting hides the edit controls but keeps the marker", async () => {
    const { p, cycle } = await nudged();
    p.lockCycle(cycle);
    const html = await renderScore(p, cycle);
    expect(html).not.toContain(ADJUST_BUTTON);
    expect(html).toContain(TRIGGER);
  });

  it("keeps the composition hover title on the figure (the title is not replaced for unadjusted cells)", async () => {
    const p = new InMemoryDataProvider();
    const html = await renderScore(p, p.listCycles()[0]!.id);
    expect(html).toMatch(/title="MCQ [\d.]+ \+ Essay [\d.]+ [+−] Alt [\d.]+ →/);
  });
});

describe("Grades view — the same gate now applies to the nudge", () => {
  const CLICKABLE = /Click to adjust the mark|Click to edit/;

  it("a user who holds grades.adjust gets clickable cells", async () => {
    const { p, cycle } = await nudged();
    expect(await renderGrades(p, cycle)).toMatch(CLICKABLE);
  });

  it("a user without it gets read-only cells (markers and detail stay)", async () => {
    const { p, cycle } = await nudged({ asReadOnlyUser: true });
    const html = await renderGrades(p, cycle);
    expect(html).not.toMatch(CLICKABLE);
    expect(html).toMatch(/Manual mark adjustment: [\d.]+ → [\d.]+/); // the adjusted cell's detail is still there
  });
});

describe("adjustment detail popover content", () => {
  const adj: ManualMarkAdjustment = {
    id: "madj-1", participantId: "p", assessmentId: "a", oldMark: 12, newMark: 15, delta: 3,
    reason: "Remarked Q14 after appeal", by: "Nadia Admin", ts: "2026-02-01T10:05:00.000Z",
  };

  it("shows old → new, the signed delta, reason, actor and a deterministic UTC time", () => {
    const html = renderToStaticMarkup(e(AdjustmentDetail, { adj }));
    expect(html).toContain("12 → 15 (+3)");
    expect(html).toContain("Remarked Q14 after appeal");
    expect(html).toContain("Nadia Admin");
    expect(html).toContain("2026-02-01 10:05 UTC");
  });

  it("renders a negative delta with a true minus", () => {
    const html = renderToStaticMarkup(e(AdjustmentDetail, { adj: { ...adj, oldMark: 15, newMark: 12, delta: -3 } }));
    expect(html).toContain("15 → 12 (−3)");
  });

  it("offers Undo only when the caller may undo", () => {
    expect(renderToStaticMarkup(e(AdjustmentDetail, { adj }))).not.toContain("Undo adjustment");
    expect(renderToStaticMarkup(e(AdjustmentDetail, { adj }))).toContain("needs permission");
    const withUndo = renderToStaticMarkup(e(AdjustmentDetail, { adj, onUndo: () => ({ ok: true as const }) }));
    expect(withUndo).toContain("Undo adjustment");
    expect(withUndo).not.toContain("needs permission");
  });
});

describe("shared AdjustMarkModal — the ±maxDelta clamp", () => {
  const sub = (total: number, max: number, extra: Partial<SubjectComposition> = {}): SubjectComposition =>
    ({ assessmentId: "a", mcq: total, essay: 0, alterations: 0, total, max, pct: (total / max) * 100, ...extra }) as SubjectComposition;
  const modal = (subject: SubjectComposition, maxDelta?: number) =>
    renderToStaticMarkup(e(AdjustMarkModal, { studentName: "S", subjectName: "Maths", subject, maxDelta, onSave: () => {}, onClose: () => {} }));

  it("markBounds: ±maxDelta around the base, never below 0 or above the max", () => {
    expect(markBounds(20, 40, 5)).toEqual({ lo: 15, hi: 25 });
    expect(markBounds(3, 40, 5)).toEqual({ lo: 0, hi: 8 });
    expect(markBounds(38, 40, 5)).toEqual({ lo: 33, hi: 40 });
    expect(markBounds(20.5, 40, 5)).toEqual({ lo: 15.5, hi: 25.5 });
    expect(markBounds(20, 40)).toEqual({ lo: 0, hi: 40 }); // no cap → just 0..max
  });

  it("with maxDelta the input is bounded and the allowed range is shown", () => {
    const html = modal(sub(20, 40), 5);
    expect(html).toMatch(/min="15"/);
    expect(html).toMatch(/max="25"/);
    expect(html).toContain("Allowed:");
    expect(html).toMatch(/15–25/);
    expect(html).toMatch(/at most ±5/);
  });

  it("without maxDelta (the Grades view) the input spans 0..max and no cap hint is shown", () => {
    const html = modal(sub(20, 40));
    expect(html).toMatch(/min="0"/);
    expect(html).toMatch(/max="40"/);
    expect(html).not.toContain("Allowed:");
  });

  it("measures the range from the UN-adjusted base, so re-opening an adjusted cell doesn't shift it", () => {
    const adjusted = sub(23, 40, { adjustment: { id: "m", participantId: "p", assessmentId: "a", oldMark: 20, newMark: 23, delta: 3, reason: "r", by: "x", ts: "2026-02-01T10:00:00.000Z" } });
    const html = modal(adjusted, 5);
    expect(html).toMatch(/min="15"/);
    expect(html).toMatch(/max="25"/);
    expect(html).toContain("Current mark");
    expect(html).toMatch(/>20 \/ 40</);
  });

  it("offers Remove only for an already-adjusted cell, and is a labelled dialog", () => {
    expect(modal(sub(20, 40), 5)).not.toContain("Remove adjustment");
    const adjusted = sub(23, 40, { adjustment: { id: "m", participantId: "p", assessmentId: "a", oldMark: 20, newMark: 23, delta: 3, reason: "r", by: "x", ts: "2026-02-01T10:00:00.000Z" } });
    const html = renderToStaticMarkup(e(AdjustMarkModal, { studentName: "S", subjectName: "Maths", subject: adjusted, maxDelta: 5, onSave: () => {}, onRemove: () => {}, onClose: () => {} }));
    expect(html).toContain("Remove adjustment");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });
});
