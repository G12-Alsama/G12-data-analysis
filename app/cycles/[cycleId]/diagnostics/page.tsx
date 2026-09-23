"use client";

/**
 * Critical-path "Assessment Health" step — the whole-assessment go/no-go check
 * before results are defended. INFORMATIONAL ONLY: nothing here changes a grade.
 * It carries only WHOLE-ASSESSMENT measures, computed from the raw QM export
 * (response-time + answer columns):
 *   - whole-assessment speededness / omission / completion (was it timed right?),
 *   - whole-assessment timing vs performance,
 *   - internal consistency (Cronbach's α).
 * The exploratory demand-level (D1/D2/D3) and item breakdowns live on the
 * separate "Diagnostics" reference tab (/cycles/[cycleId]/diagnostics-hub), not here.
 * Plain-language interpretation sits next to each figure.
 */
import Link from "next/link";
import { useProvider, useProviderData } from "@/lib/data/context";
import { H } from "@/lib/ui/tokens";
import { CycleShell } from "@/components/shell/CycleShell";
import { AssessmentTabs } from "@/components/shell/AssessmentTabs";
import { Button } from "@/components/ui/primitives";
import { ExportButtons } from "@/components/ui/ExportButtons";
import { downloadCsv, downloadWorkbookBytes, fileStem } from "@/lib/ui/export";
import { Icon } from "@/components/ui/icons";
import { useTableZoom, ZoomControl } from "@/lib/ui/tableZoom";
import { ReliabilityPanel } from "@/components/ui/reliability";
import { CorrMeter, DiagStatusBadge, Hc, HelpNote, SpeededRow } from "@/components/ui/diagnostics-parts";
import { StepIntro } from "@/components/ui/StepIntro";
import { useState } from "react";
import type { DiagnosticsModel, ReliabilityModel } from "@/lib/data/types";
import type { DiagStatus } from "@/lib/diagnostics";

export default function AssessmentHealthPage({ params }: { params: { cycleId: string } }) {
  const cycleId = params.cycleId;
  const provider = useProvider();
  const model = useProviderData((p) => p.getDiagnostics(cycleId), [cycleId]) as DiagnosticsModel | null;
  const reliability = useProviderData((p) => p.getReliability(cycleId), [cycleId]) as ReliabilityModel | null;
  const cycleName = useProviderData((p) => p.getCycle(cycleId)?.name, [cycleId]) ?? "Sitting";
  const [active, setActive] = useState(0);
  const { zoom, setZoom, scrollRef, zoomWrapStyle } = useTableZoom();

  if (!model || model.assessments.length === 0) {
    return (
      <CycleShell cycleId={cycleId} cycleName={cycleName} page="Assessment Health" stageIndex={4}>
        <div style={{ padding: 32 }} className="hf-sub">No assessment-health data for this sitting.</div>
      </CycleShell>
    );
  }
  const a = model.assessments[Math.min(active, model.assessments.length - 1)]!;

  // CSV = the reliability table (α with item k + participant n alongside);
  // XLSX = three separate workbooks — Reliability, Speededness, Timing — each
  // reconciled cell-by-cell against the team's original manual-analysis
  // files, replacing the old single condensed "assessment health" export.
  const exportCsv = () => {
    if (!reliability) return;
    const headers = ["Level", "Group", "Subject", "Items (k)", "Participants (n)", "Cronbach's Alpha", "Low items?", "Small sample?", "Note"];
    const levelLabel: Record<string, string> = { overall: "Overall exam", subject: "Subject", majorElement: "Major element", subElement: "Sub-element" };
    const rows = reliability.rows.map((r) => [levelLabel[r.level] ?? r.level, r.label, r.assessmentName ?? "", r.k, r.n, r.alpha ?? "n/a", r.lowItems ? "Yes" : "", r.smallSample ? "Yes" : "", r.note ?? ""]);
    downloadCsv(`${fileStem("reliability", cycleName)}.csv`, headers, rows);
    provider.recordExport(cycleId, "Reliability (CSV)");
  };
  const exportXlsx = async () => {
    const exp = await import("@/lib/export");
    const suffix = fileStem(cycleName);
    const reliabilityWb = exp.buildReliabilityWorkbook({ cycleName, reliability });
    const speedednessWb = exp.buildSpeedednessWorkbook({ cycleName, reliability, diagnostics: model });
    const timingWb = exp.buildTimingWorkbook({ cycleName, reliability, diagnostics: model });
    const [reliabilityBytes, speedednessBytes, timingBytes] = await Promise.all([
      reliabilityWb.bytes(),
      speedednessWb.bytes(),
      timingWb.bytes(),
    ]);
    downloadWorkbookBytes(`mcq_reliability_internal_consistency_${suffix}.xlsx`, reliabilityBytes);
    downloadWorkbookBytes(`speededness_omission_rate_${suffix}.xlsx`, speedednessBytes);
    downloadWorkbookBytes(`timing_performance_analysis_${suffix}.xlsx`, timingBytes);
    provider.recordExport(cycleId, "Assessment health: Reliability, Speededness & Timing (Excel, 3 files)");
  };

  const whole = a.whole.speeded;
  const wholeTiming = a.whole.timing;

  return (
    <CycleShell
      cycleId={cycleId}
      cycleName={cycleName}
      page="Assessment Health"
      stageIndex={4}
      actions={<ExportButtons onCsv={exportCsv} onXlsx={exportXlsx} disabled={!reliability} title={reliability ? undefined : "No reliability data"} />}
      primary={
        <Link href={`/cycles/${cycleId}/adjustments`}>
          <Button variant="pri" title="Continue to incident adjustments">Continue<Icon name="arrow" color="#fff" /></Button>
        </Link>
      }
      intro={
        <StepIntro>
          A whole-assessment check on whether the paper was timed right and internally consistent, before results are
          confirmed. It never changes a mark — it tells you whether the scores can be trusted.
        </StepIntro>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <div className="hf-pad" style={{ padding: "14px 28px 0" }}>
          <div className="hf-sub" style={{ maxWidth: 720 }}>
            A whole-assessment health check — was the paper timed right, and is it internally consistent — before results
            are confirmed. Demand-level and item
            breakdowns live on the <Link href={`/cycles/${cycleId}/diagnostics-hub`} style={{ color: H.pink, fontWeight: 600 }}>Diagnostics</Link> tab.
          </div>
        </div>

        {/* assessment selector — shared canonical chip-tab row; zoom on the right */}
        <AssessmentTabs
          activeId={String(active)}
          tabs={model.assessments.map((as, i) => ({ id: String(i), label: as.shortName }))}
          onSelect={(id) => setActive(Number(id))}
          right={<ZoomControl zoom={zoom} onZoom={setZoom} />}
        />

        <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: "20px 28px 40px" }}>
          <div style={zoomWrapStyle}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* A — whole-assessment speededness / omission / completion */}
          <div className="hf-card" style={{ overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${H.line2}`, gap: 12 }}>
              <div style={{ flex: 1 }}>
                <span className="hf-h2">Speededness, omission &amp; completion</span>
                <div className="hf-sub" style={{ fontSize: 11.5, marginTop: 3 }}>Whether students had enough time to attempt the questions across the whole paper.</div>
              </div>
              <span style={{ display: "flex", gap: 10 }}>{(["Good", "Review", "Flag"] as DiagStatus[]).map((s) => <DiagStatusBadge key={s} s={s} />)}</span>
            </div>
            <div style={{ overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
                <thead>
                  <tr>
                    <th className="hf-th">Level</th>
                    <Hc t="Speededness index" sub="0–1, lower is better" />
                    <Hc t="Omission rate" sub="% left blank" />
                    <Hc t="Completion rate" sub="% reaching the end" />
                    <th className="hf-th" style={{ textAlign: "right" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <SpeededRow label="Whole assessment" s={whole} whole />
                </tbody>
              </table>
            </div>
            <HelpNote
              title="How to read this"
              body={
                <>
                  <b>Speededness index</b> (0–1) combines two end-of-paper warning signs: more blanks late than early, and a
                  late accuracy drop. <b>≤0.05</b> is fine; <b>0.05–0.15</b> worth a look; <b>&gt;0.15</b> flags time pressure.
                  <b> Omission rate</b> is the share of presented questions left blank; <b>completion</b> is its mirror.
                  If the whole paper flags, the fix is on the paper — shorten it or rebalance where the demanding items sit.
                  For the difficulty-tier and item-level view, see the <b>Diagnostics</b> tab.
                </>
              }
            />
          </div>

          {/* B — timing / performance (whole assessment only) */}
          <div className="hf-card" style={{ overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${H.line2}`, gap: 12 }}>
              <div style={{ flex: 1 }}>
                <span className="hf-h2">Timing &amp; performance</span>
                <div className="hf-sub" style={{ fontSize: 11.5, marginTop: 3 }}>Whether time spent relates to how well students scored.</div>
              </div>
              <span className="hf-sub" style={{ fontSize: 11 }}>correlation of median item time ↔ score %</span>
            </div>
            <div style={{ overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
                <thead>
                  <tr>
                    <th className="hf-th">Level</th>
                    <Hc t="Students" sub="with timing" />
                    <Hc t="Time ↔ score" sub="Pearson r" />
                    <Hc t="Spearman" sub="rank ρ" />
                    <th className="hf-th">Strength</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ background: H.canvas }}>
                    <td className="hf-td" style={{ fontWeight: 700, fontSize: 12.5, paddingLeft: 12 }}>Whole assessment</td>
                    <td className="hf-td hf-mono" style={{ textAlign: "right", fontSize: 13 }}>{wholeTiming.nStudents}</td>
                    <td className="hf-td" style={{ textAlign: "right" }}>{wholeTiming.pearson === null ? <span className="hf-sub hf-mono">—</span> : <CorrMeter r={wholeTiming.pearson} />}</td>
                    <td className="hf-td hf-mono" style={{ textAlign: "right", fontSize: 13 }}>{wholeTiming.spearman === null ? "—" : wholeTiming.spearman.toFixed(2)}</td>
                    <td className="hf-td" style={{ fontSize: 11.5, color: H.ink2, fontWeight: 600 }}>{wholeTiming.pearsonStrength}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* C — internal consistency (Cronbach's α) for this subject */}
          {reliability && <ReliabilityPanel model={reliability} assessmentId={a.assessmentId} />}
          </div>
          </div>
        </div>
      </div>
    </CycleShell>
  );
}
