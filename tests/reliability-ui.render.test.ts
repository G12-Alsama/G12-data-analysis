/**
 * Smoke-renders the reliability surfaces (shared by Review and Diagnostics) via
 * renderToStaticMarkup, with both live data AND the degenerate shapes that
 * previously crashed the Review route: a model whose `overall` group is absent
 * (no usable items → empty engine output) and rows whose α is null. The UI must
 * render the "n/a — …" state for any missing/uncomputable α and never read
 * `.alpha` off undefined.
 */
import { describe, it, expect } from "vitest";
import { createElement as e } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { ReliabilityPanel, ReliabilityInline } from "@/components/ui/reliability";
import type { ReliabilityModel, ReliabilityRow } from "@/lib/data/types";

describe("Reliability UI renders without crashing", () => {
  it("renders the panel with the real provider model", () => {
    const provider = new InMemoryDataProvider();
    const cycle = provider.listCycles().find((c) => !c.mock)!;
    const model = provider.getReliability(cycle.id)!;
    const subjectRow = model.rows.find((r) => r.level === "subject")!;
    const html = renderToStaticMarkup(
      e(ReliabilityPanel, { model, assessmentId: subjectRow.assessmentId! }),
    );
    expect(html).toContain("Cronbach");
  });

  it("renders n/a (no crash) when the overall group is absent", () => {
    // Reproduces the previously-crashing Review route: the engine returned no
    // groups (no computable α anywhere), so `overall` is undefined and rows is
    // empty. Reading `.alpha` off `overall` used to throw.
    const model = {
      cycleId: "c",
      engineVersion: "test",
      participants: 0,
      lowItemsThreshold: 5,
      smallSampleThreshold: 30,
      overall: undefined as unknown as ReliabilityRow,
      rows: [],
    } as ReliabilityModel;
    const html = renderToStaticMarkup(e(ReliabilityPanel, { model, assessmentId: "subj-1" }));
    expect(html).toContain("n/a");
  });

  it("renders n/a for an uncomputable (null α) subject and group rows", () => {
    const naRow = (level: ReliabilityRow["level"], key: string): ReliabilityRow => ({
      level,
      assessmentId: "subj-1",
      assessmentName: "Subject One",
      key,
      label: key,
      k: 1,
      n: 0,
      alpha: null,
      note: "n/a — too few items (need at least 2)",
      lowItems: true,
      smallSample: true,
      totalParticipants: 0,
      itemResponses: 0,
      spearmanBrown: null,
      sbMultiplier80: null,
      sbMultiplier90: null,
      avgInterItemCorrelation: null,
      status: "Not Available",
      interpretation: "Alpha could not be computed for this group — see note.",
    });
    const overall: ReliabilityRow = { ...naRow("overall", "overall"), assessmentId: null, assessmentName: null };
    const subject = naRow("subject", "subject|subj-1");
    const model: ReliabilityModel = {
      cycleId: "c",
      engineVersion: "test",
      participants: 1,
      lowItemsThreshold: 5,
      smallSampleThreshold: 30,
      overall,
      rows: [overall, subject, naRow("majorElement", "major|subj-1|A")],
    };
    const panel = renderToStaticMarkup(e(ReliabilityPanel, { model, assessmentId: "subj-1" }));
    expect(panel).toContain("too few items");
    expect(panel).not.toContain("NaN");
    // Inline summary guards a missing subject by rendering nothing.
    const inline = renderToStaticMarkup(e(ReliabilityInline, { model, assessmentId: "subj-1" }));
    expect(inline).toContain("n/a");
  });
});
