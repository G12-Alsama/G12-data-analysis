"use client";

/**
 * Screen 06 — Grades & sign-off. Shows every participant's section + overall
 * grade (computed by the provider/engine from the boundaries), the overall
 * distribution, CSV / Excel export, and the Lead-only lock & sign-off flow.
 * Once locked the cycle is read-only until re-opened.
 */
import { useState } from "react";
import Link from "next/link";
import { useProvider, useProviderData } from "@/lib/data/context";
import type { DataProvider } from "@/lib/data/provider";
import { H } from "@/lib/ui/tokens";
import { CycleShell, AlertStack, type Notice } from "@/components/shell/CycleShell";
import { useProvisionalNotice } from "@/components/shell/ProvisionalBanner";
import { Button } from "@/components/ui/primitives";
import { ExportButtons } from "@/components/ui/ExportButtons";
import { downloadCsv, downloadWorkbook, downloadXlsxBuffer } from "@/lib/ui/export";
import { Icon, Mark, MarginalGlyph } from "@/components/ui/icons";
import { AdjustMarkModal } from "@/components/ui/AdjustMarkModal";
import { useCan } from "@/lib/auth/useCan";
import { MiniGradeBars } from "@/components/ui/charts";
import { useTableZoom, ZoomControl } from "@/lib/ui/tableZoom";
import { InlineComposition } from "@/components/ui/composition";
import { StepIntro } from "@/components/ui/StepIntro";
import { AWARD_SHORT } from "@/lib/data/grading";
import type { GradeCell, GradesModel, StudentComposition, PerfReportStudent, PerfReportSubject, PerfElementResult, DemandScore } from "@/lib/data/types";

export default function GradesPage({ params }: { params: { cycleId: string } }) {
  const cycleId = params.cycleId;
  const provider = useProvider();
  const model = useProviderData((p) => p.getGrades(cycleId), [cycleId]);
  const comp = useProviderData((p) => p.getComposition(cycleId), [cycleId]);
  const perf = useProviderData((p) => p.getPerformanceReport(cycleId), [cycleId]);
  // The live borderline (marginal) band (percentage points), from Settings config.
  const borderlineBand = useProviderData((p) => p.getConfig().borderline.bandPct);
  const cycleName = useProviderData((p) => p.getCycle(cycleId)?.name, [cycleId]) ?? "Sitting";
  // A sitting's year-Overall surface, where certificates/reports are generated from
  // the best-of-two award. Route on the OWNING year's canonical id (resolved by the
  // sitting's cycle id, never re-derived from the cycle name): this is correct for a
  // non-primary centre, and a null/"Unknown"-named year still resolves and links.
  const overallYearId = useProviderData(
    (p) => p.listYears().find((y) => y.sittings.some((s) => s.cycleId === cycleId))?.id ?? null,
    [cycleId],
  );
  const overallHref = overallYearId ? `/years/${overallYearId}/overall` : "/";
  const provisional = useProvisionalNotice(cycleId);
  const [confirming, setConfirming] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Marginal-student review: filter to "just-missed" rows, and the open adjust dialog.
  const [onlyMarginal, setOnlyMarginal] = useState(false);
  const [adjust, setAdjust] = useState<{ participantId: string; assessmentId: string } | null>(null);
  // Only a holder of `grades.adjust` gets the editable cell + dialog (the RPC re-checks
  // server-side); everyone else still sees the marginal / adjusted markers.
  const canAdjust = useCan("grades.adjust");
  const { zoom, setZoom, scrollRef, zoomWrapStyle } = useTableZoom();

  const intro = (
    <StepIntro>
      This step applies the agreed cut scores to each student&rsquo;s marks to produce a grade per subject. It is a
      faithful application of decisions already made and signed off — the grade is the consequence of the score and
      the cut point, nothing more.
    </StepIntro>
  );

  if (!model) {
    return (
      <CycleShell cycleId={cycleId} cycleName={cycleName} page="Grades & sign-off" stageIndex={9} intro={intro}>
        <div style={{ padding: 32 }} className="hf-sub">No grades for this sitting.</div>
      </CycleShell>
    );
  }

  const lock = () => {
    provider.lockCycle(cycleId);
    setConfirming(false);
  };
  const compById = new Map((comp?.students ?? []).map((s) => [s.participantId, s]));
  // A row is marginal when any subject cell sits just below its next grade-up cut.
  const isMarginalRow = (r: GradesModel["rows"][number]) => model.assessments.some((a) => r.grades[a.id]?.marginal);
  const marginalCount = model.rows.filter(isMarginalRow).length;
  const visibleRows = onlyMarginal ? model.rows.filter(isMarginalRow) : model.rows;

  return (
    <CycleShell
      cycleId={cycleId}
      cycleName={cycleName}
      page="Grades & sign-off"
      stageIndex={9}
      actions={
        <ExportButtons
          xlsxLabel="Performance report (.xlsx)"
          onCsv={() => { exportCsv(model); provider.recordExport(cycleId, "Grades & awards (CSV)"); }}
          onXlsx={async () => { await exportExcel(provider, cycleId, model); provider.recordExport(cycleId, "Students' Performance Report (Excel)"); }}
        />
      }
      primary={
        model.locked ? (
          // Certificates & performance reports issue from the cycle/overall
          // best-of-two award, not a single sitting — so a locked sitting points
          // onward to its year's Overall surface (where document generation lives)
          // rather than generating documents here.
          <Link href={overallHref}>
            <Button variant="pri">
              <Icon name="award" color="#fff" />
              Go to Overall &amp; certificates
            </Button>
          </Link>
        ) : (
          <Button
            variant="pri"
            disabled={!model.canLock}
            onClick={() => setConfirming(true)}
            title={model.canLock ? undefined : "Only a Lead can lock grades"}
          >
            <Icon name="lock" color="#fff" />
            Lock grades…
          </Button>
        )
      }
      alerts={
        <AlertStack
          notices={[
            ...(provisional ? [provisional] : []),
            ...(!model.locked
              ? ([
                  {
                    key: "distinction",
                    tone: "warn",
                    message: (
                      <>
                        <b>Distinction safeguard</b> — confirm every provisional top award attempted enough top-difficulty questions before sign-off.
                      </>
                    ),
                    action: (
                      <Link href={`/cycles/${cycleId}/grades/distinction`} style={{ fontSize: 11.5, color: H.pink, fontWeight: 600 }}>
                        Review safeguard →
                      </Link>
                    ),
                  },
                  {
                    key: "locking",
                    tone: "info",
                    message: (
                      <>
                        Locking writes a signed, timestamped record and freezes all {model.assessments.length} assessments — cut scores can’t change afterward without re-opening.
                      </>
                    ),
                  },
                ] satisfies Notice[])
              : []),
          ]}
        />
      }
      intro={intro}
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "16px 32px 18px", gap: 12, flex: 1, minHeight: 0 }}>
        {/* slim header strip — title + compact award distribution + level legend + zoom,
            kept small so the table (the point of the screen) gets the vertical space */}
        <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
          <span className="hf-h2" style={{ fontSize: 16 }}>Grades &amp; sign-off</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="hf-lbl">Awards</span>
            <MiniGradeBars data={model.distribution.map((d) => ({ label: AWARD_SHORT[d.level] ?? d.level, count: d.count }))} />
          </span>
          <span style={{ width: 1, height: 18, background: H.line2 }} />
          {model.performanceLevels.map((lvl) => (
            <span key={lvl} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: H.ink2 }}>
              <span className="hf-mono" style={{ color: H.pink, fontWeight: 700, letterSpacing: 1, minWidth: 16 }}>
                {model.starMap[lvl] || "·"}
              </span>
              {lvl}
            </span>
          ))}
          <div style={{ flex: 1, minWidth: 12 }} />
          {/* marginal-student filter — the just-missed-a-boundary cases */}
          <button
            type="button"
            onClick={() => setOnlyMarginal((v) => !v)}
            aria-pressed={onlyMarginal}
            title={`Show only students within ${borderlineBand}% below a grade boundary`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11.5,
              fontWeight: 600,
              padding: "4px 10px",
              borderRadius: 999,
              cursor: "pointer",
              border: `1px solid ${onlyMarginal ? H.pink : H.line2}`,
              background: onlyMarginal ? H.pinkSoft : H.paper,
              color: onlyMarginal ? H.pink : H.ink2,
            }}
          >
            <MarginalGlyph color={onlyMarginal ? H.pink : H.ink3} />
            Marginal{marginalCount ? ` · ${marginalCount}` : ""}
          </button>
          <ZoomControl zoom={zoom} onZoom={setZoom} />
        </div>

        {/* grades table + click-row → composition right-panel (same pattern as Review) */}
        <div style={{ display: "flex", gap: 0, alignItems: "stretch", flex: 1, minHeight: 0 }}>
          <div ref={scrollRef} className="hf-card" style={{ overflow: "auto", flex: 1, minWidth: 0 }}>
            <div style={zoomWrapStyle}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th className="hf-th">Participant</th>
                  {model.assessments.map((a) => (
                    <th key={a.id} className="hf-th" style={{ textAlign: "center" }}>{subjectHeader(a.shortName)}</th>
                  ))}
                  <th
                    className="hf-th"
                    style={{ textAlign: "center" }}
                    title="This sitting's provisional award only. The final Overall is the best of February + May, decided at the year level — not here."
                  >
                    Sitting award
                    <div style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, color: H.ink3, fontSize: 9 }}>provisional · not the final Overall</div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const on = selectedId === r.id;
                  return (
                    <tr
                      key={r.id}
                      className="hf-hover"
                      onClick={() => setSelectedId((cur) => (cur === r.id ? null : r.id))}
                      style={{ cursor: "pointer", background: on ? H.pinkSoft2 : "transparent", boxShadow: on ? `inset 3px 0 0 ${H.pink}` : "none" }}
                    >
                      <td className="hf-td">
                        {/* one clean identity column: name (or email) on top,
                            Student ID as a quiet secondary line beneath it */}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.label}>{r.label}</div>
                          <div className="hf-mono" style={{ fontSize: 10.5, color: H.ink3, marginTop: 1 }} title="Student ID">{r.studentId}</div>
                        </div>
                      </td>
                      {model.assessments.map((a) => {
                        const cell = r.grades[a.id];
                        return (
                          <td key={a.id} className="hf-td" style={{ textAlign: "center" }}>
                            <GradeCellView
                              cell={cell}
                              locked={model.locked}
                              canAdjust={canAdjust}
                              onAdjust={() => setAdjust({ participantId: r.id, assessmentId: a.id })}
                            />
                          </td>
                        );
                      })}
                      <td className="hf-td" style={{ textAlign: "center" }}>
                        <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                          <AwardBadge award={r.award} />
                          <span
                            className="hf-mono"
                            style={{ fontSize: 11, color: H.ink2, whiteSpace: "nowrap" }}
                            title="Overall raw score / maximum · percentage"
                          >
                            {fmtNum(r.overallRaw)} / {fmtNum(r.overallMax)} · {r.overallPct.toFixed(1)}%
                          </span>
                          {/* score composition (MCQ + Essay + Alt → total) belongs with the
                              overall score, not under the identifier; click the row for detail */}
                          <InlineComposition cs={compById.get(r.id)} />
                          {r.distinctionCap && (
                            <span
                              title={`Capped below Distinction — ${r.distinctionCap.correct}/${r.distinctionCap.available} D3 items correct in ${r.distinctionCap.subject}; majority is ${r.distinctionCap.majority}`}
                              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color: H.warn, background: H.warnSoft, padding: "1px 7px", borderRadius: 999, whiteSpace: "nowrap" }}
                            >
                              <Icon name="lock" size={10} color={H.warn} />
                              D3 cap · {r.distinctionCap.correct}/{r.distinctionCap.available} (need {r.distinctionCap.majority})
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {visibleRows.length === 0 && (
                  <tr>
                    <td className="hf-td" colSpan={model.assessments.length + 2} style={{ textAlign: "center", color: H.ink3, padding: 18 }}>
                      No marginal students — nobody is within {borderlineBand}% below a grade boundary.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </div>

          {selectedId && (
            <CompositionPanel
              student={comp?.students.find((s) => s.participantId === selectedId) ?? null}
              award={model.rows.find((r) => r.id === selectedId)?.award ?? ""}
              perf={perf?.students.find((s) => s.participantId === selectedId) ?? null}
              perfSubjects={perf?.subjects ?? []}
              starMap={model.starMap}
              onBack={() => setSelectedId(null)}
            />
          )}
        </div>
      </div>

      {/* lock confirmation modal — the single entry point, no header reflow */}
      {confirming && !model.locked && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(31,42,49,.32)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}
          onClick={() => setConfirming(false)}
        >
          <div className="hf-card" style={{ padding: "22px 24px", maxWidth: 480, width: "100%", background: H.paper }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <Mark kind="warn" size={20} />
              <span className="hf-h2">Lock grades &amp; sign off?</span>
            </div>
            <div className="hf-sub" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 20 }}>
              Locking writes a signed, timestamped record and freezes all {model.assessments.length} assessments.
              Cut scores and grades can’t change afterward without re-opening the sitting.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
              <Button variant="pri" onClick={lock}><Icon name="lock" color="#fff" />Confirm lock</Button>
            </div>
          </div>
        </div>
      )}

      {/* manual mark adjustment modal — opened from a (flagged) Grades cell */}
      {adjust && canAdjust && !model.locked && (() => {
        const cell = model.rows.find((r) => r.id === adjust.participantId)?.grades[adjust.assessmentId];
        const subj = compById.get(adjust.participantId)?.subjects.find((s) => s.assessmentId === adjust.assessmentId);
        const aName = subjectHeader(model.assessments.find((a) => a.id === adjust.assessmentId)?.shortName ?? "");
        const who = model.rows.find((r) => r.id === adjust.participantId)?.label ?? "";
        if (!subj) return null;
        return (
          <AdjustMarkModal
            studentName={who}
            subjectName={aName}
            subject={subj}
            cell={cell}
            onSave={(newMark, reason) => provider.adjustStudentMark(cycleId, adjust.participantId, adjust.assessmentId, newMark, reason)}
            onRemove={subj.adjustment ? () => provider.removeStudentMarkAdjustment(cycleId, subj.adjustment!.id) : undefined}
            onClose={() => setAdjust(null)}
          />
        );
      })()}
    </CycleShell>
  );
}

/** One-decimal rounding for display. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * One grade cell: the star badge, with a marginal marker (just below the next
 * boundary) and/or a manual-adjustment marker. When the sitting is open the cell
 * is a button that opens the mark-adjustment dialog.
 */
function GradeCellView({ cell, locked, canAdjust, onAdjust }: { cell?: GradeCell; locked: boolean; canAdjust: boolean; onAdjust: () => void }) {
  const marginal = !!cell?.marginal;
  const adjusted = !!cell?.adjustment;
  // Read-only (sitting locked, or the user can't adjust): same markers + detail, no click.
  const readOnly = locked || !canAdjust;
  const title = adjusted
    ? `Manual mark adjustment: ${cell!.adjustment!.oldMark} → ${cell!.adjustment!.newMark} (${cell!.adjustment!.delta >= 0 ? "+" : ""}${cell!.adjustment!.delta}) — ${cell!.adjustment!.reason}.${readOnly ? "" : " Click to edit."}`
    : marginal
    ? `Marginal — ${round1(cell!.marksToNext ?? 0)} mark${cell!.marksToNext === 1 ? "" : "s"} below ${cell!.nextLevel}.${readOnly ? "" : " Click to adjust the mark."}`
    : readOnly ? cell?.level ?? "—" : "Click to adjust the mark";
  const inner = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <StarBadge cell={cell} flagged={marginal || adjusted} />
      {adjusted ? (
        <span title={title} style={{ fontSize: 10, fontWeight: 800, color: H.pink }}>±</span>
      ) : marginal ? (
        <MarginalGlyph color={H.pink} />
      ) : null}
    </span>
  );
  if (readOnly) {
    return <span title={title}>{inner}</span>;
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onAdjust(); }}
      title={title}
      style={{ background: "transparent", border: "none", padding: 2, cursor: "pointer", display: "inline-flex", alignItems: "center" }}
    >
      {inner}
    </button>
  );
}

/** Plain subject-name column header (no "+E" essay suffix). */
/** Compact number: integers stay whole; fractional scores show one decimal. */
function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function subjectHeader(shortName: string): string {
  if (/applicable/i.test(shortName)) return "Applicable Math";
  if (/english/i.test(shortName)) return "English";
  if (/scientific/i.test(shortName)) return "Scientific";
  if (/arabic/i.test(shortName)) return "Arabic";
  if (/life/i.test(shortName)) return "Life";
  return shortName.split(" ")[0] ?? shortName;
}

/**
 * Right-hand composition panel — the selected student's mark breakdown:
 * MCQ + Essay + Alterations = subject total (out of its max), per subject. Same
 * click-row → right-panel pattern as Review.
 */
function CompositionPanel({ student, award, perf, perfSubjects, starMap, onBack }: {
  student: StudentComposition | null;
  award: string;
  perf: PerfReportStudent | null;
  perfSubjects: PerfReportSubject[];
  starMap: Record<string, string>;
  onBack: () => void;
}) {
  return (
    <aside style={{ width: 360, flex: "0 0 auto", borderLeft: `1px solid ${H.line2}`, background: H.paper, boxShadow: "-12px 0 28px -18px rgba(31,42,49,.20)", overflow: "auto", padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <button onClick={onBack} className="hf-btn ghost" style={{ fontSize: 12, padding: "3px 8px" }}>← Back</button>
        <div style={{ flex: 1 }} />
      </div>
      {!student ? (
        <div className="hf-sub" style={{ padding: 12 }}>No composition for this student.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{student.name}</div>
            <div className="hf-sub" style={{ fontSize: 11.5, marginTop: 3 }}>
              <span className="hf-mono">{student.participantId}</span> · Overall <b style={{ color: H.ink }}>{AWARD_SHORT[award] ?? award ?? "—"}</b> · {student.overall.pct}%
            </div>
          </div>
          <div className="hf-sub" style={{ fontSize: 11.5 }}>
            Each subject total is <b style={{ color: H.ink }}>MCQ + Essay + Alterations</b>, out of its max (English/Arabic include the 20 essay marks).
          </div>
          {student.subjects.map((c) => (
            <div key={c.assessmentId} className="hf-card" style={{ padding: "11px 13px" }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>{c.name}</div>
              <div className="hf-mono" style={{ fontSize: 12, marginTop: 6, color: H.ink2, lineHeight: 1.8 }}>
                <div>MCQ <span style={{ float: "right", color: H.ink }}>{c.mcq}</span></div>
                <div>Essay <span style={{ float: "right", color: c.hasEssay ? H.ink : H.ink3 }}>{c.hasEssay ? c.essay : "—"}</span></div>
                <div>Alterations <span style={{ float: "right", color: c.alterations ? H.pink : H.ink3 }}>{c.alterations >= 0 ? "+" : ""}{c.alterations}</span></div>
                <div style={{ borderTop: `1px solid ${H.line2}`, marginTop: 4, paddingTop: 4, fontWeight: 700 }}>Total <span style={{ float: "right", color: H.ink }}>{c.total}/{c.max}</span></div>
              </div>
              {c.adjustment && (
                <div style={{ marginTop: 7, padding: "6px 8px", borderRadius: 7, background: H.pinkSoft, fontSize: 11, color: H.ink2, lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 700, color: H.pink }}>Manual adjustment</span>{" "}
                  <span className="hf-mono">{c.adjustment.oldMark} → {c.adjustment.newMark} ({c.adjustment.delta >= 0 ? "+" : ""}{c.adjustment.delta})</span>
                  <div style={{ marginTop: 2 }}>{c.adjustment.reason}</div>
                  <div style={{ marginTop: 2, color: H.ink3, fontSize: 10 }}>by {c.adjustment.by} · {new Date(c.adjustment.ts).toLocaleString()}</div>
                </div>
              )}
              <DemandBreakdown rows={c.byDemand} />
              <ElementBreakdown
                subjectMeta={perfSubjects.find((s) => s.assessmentId === c.assessmentId)}
                result={perf?.subjects[c.assessmentId]}
                starMap={starMap}
              />
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

/**
 * Per-subject MCQ score split by demand level (D1/D2/D3) for one student — a
 * rollup of the already-computed item scores by demand tag (additive reporting,
 * no scoring change), mirroring the "Overall Scores by Demand Level" export. Sits
 * with the score composition since demand scores are MCQ marks, not levels.
 */
function DemandBreakdown({ rows }: { rows: DemandScore[] }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div style={{ marginTop: 8, borderTop: `1px dashed ${H.line2}`, paddingTop: 7 }}>
      <div className="hf-lbl" style={{ fontSize: 10, marginBottom: 5 }}>By demand level</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {rows.map((d) => (
          <span
            key={d.demand}
            title={`${d.demand}: ${d.score} of ${d.max} marks`}
            style={{ display: "inline-flex", alignItems: "baseline", gap: 5, fontSize: 11, background: H.tint, border: `1px solid ${H.line}`, borderRadius: 6, padding: "2px 8px" }}
          >
            <span className="hf-mono" style={{ fontWeight: 700, color: H.ink2 }}>{d.demand}</span>
            <span className="hf-mono" style={{ color: H.ink }}>{d.score}<span style={{ color: H.ink3 }}>/{d.max}</span></span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Truncate a long sub-element label, keeping the full text in a title tooltip. */
function Trunc({ text, max = 30 }: { text: string; max?: number }) {
  const short = text.length > max ? text.slice(0, max - 1) + "…" : text;
  return <span title={text} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{short}</span>;
}

/**
 * Per-subject major-element / sub-element performance for one student — the
 * finer-grained breakdown beneath the MCQ/Essay/Alterations composition. Reads
 * the construct structure (major → sub-elements) from the report; sub-element
 * labels are long, so they wrap/truncate-with-tooltip.
 */
function ElementBreakdown({ subjectMeta, result, starMap }: {
  subjectMeta?: PerfReportSubject;
  result?: PerfElementResult;
  starMap: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  if (!subjectMeta || !result || subjectMeta.majorElements.length === 0) return null;
  const stars = (lvl?: string) => (lvl ? starMap[lvl] ?? "" : "");
  return (
    <div style={{ marginTop: 8, borderTop: `1px dashed ${H.line2}`, paddingTop: 7 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="hf-btn ghost"
        style={{ fontSize: 10.5, padding: "2px 7px", display: "flex", alignItems: "center", gap: 5 }}
      >
        <Icon name={open ? "chev" : "arrow"} size={11} color={H.ink3} />
        {open ? "Hide" : "Show"} element & sub-element levels
      </button>
      {open && (
        <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 6 }}>
          {subjectMeta.majorElements.map((el) => {
            const subs = subjectMeta.subElements?.[el] ?? [];
            const subLevels = result.subElements?.[el] ?? {};
            return (
              <div key={el} style={{ fontSize: 11 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                  <Trunc text={el} max={28} />
                  <span style={{ flex: 1 }} />
                  <span className="hf-mono" style={{ color: H.pink, letterSpacing: 1 }}>{stars(result.elements[el]) || "·"}</span>
                  <span className="hf-sub" style={{ fontSize: 10 }}>{result.elements[el] ?? "—"}</span>
                </div>
                {subs.map((s) => (
                  <div key={s} style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 12, color: H.ink2, marginTop: 2 }}>
                    <Trunc text={s} max={30} />
                    <span style={{ flex: 1 }} />
                    <span className="hf-mono" style={{ color: H.ink3, letterSpacing: 1 }}>{stars(subLevels[s]) || "·"}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Per-assessment cell: the star rating, with the full level as a tooltip. A
 *  `flagged` cell (marginal or manually adjusted) gets a pink outline. */
function StarBadge({ cell, flagged }: { cell?: GradeCell; flagged?: boolean }) {
  const stars = cell?.stars ?? "";
  const level = cell?.level ?? "—";
  return (
    <span
      title={level}
      className="hf-mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 34,
        height: 23,
        borderRadius: 7,
        border: `1px solid ${flagged ? H.pink : H.line2}`,
        background: flagged ? H.pinkSoft : H.paper,
        color: stars ? H.pink : H.ink3,
        fontWeight: 700,
        fontSize: 12,
        letterSpacing: 1.5,
      }}
    >
      {stars || "·"}
    </span>
  );
}

/** Overall award pill (compact label, full award as tooltip). */
function AwardBadge({ award }: { award: string }) {
  const isNoAward = award === "No Award" || award === "";
  return (
    <span
      title={award}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "4px 10px",
        height: 24,
        borderRadius: 999,
        fontWeight: 700,
        fontSize: 11,
        background: isNoAward ? H.tint2 : H.pink,
        color: isNoAward ? H.ink2 : "#fff",
        whiteSpace: "nowrap",
      }}
    >
      {AWARD_SHORT[award] ?? award ?? "—"}
    </span>
  );
}

function exportCsv(model: GradesModel) {
  const headers = ["Student ID", "Student Name", ...model.assessments.map((a) => a.name), "Award Level"];
  const rows = model.rows.map((r) => [
    // Real Student ID (matches what's shown on screen), not the internal key.
    r.studentId,
    r.label,
    ...model.assessments.map((a) => r.grades[a.id]?.level ?? ""),
    r.award,
  ]);
  downloadCsv("grades_may_2026.csv", headers, rows);
}

async function exportExcel(provider: DataProvider, cycleId: string, model: GradesModel) {
  // Students_Performance_Report workbook (Class Performance / Student Summary /
  // Student Profiles), then the clearly-additional Alterations and Audit Trail
  // sheets. All cells come from the REAL provider read-models — per-student
  // per-element levels via getPerformanceReport, alterations from the Adjustments
  // incident triage, and the audit log.
  void model;
  const exp = await import("@/lib/export");
  const report = provider.getPerformanceReport(cycleId);
  if (!report) return;
  const adj = provider.getAdjustments(cycleId);
  const audit = provider.getAuditLog(cycleId, "all", "");

  // One Alterations record per applied alteration (whole-subject decisions expand
  // to one row per roster student), built from the decided incidents.
  const subjectName = (id: string | null) => adj?.subjects.find((s) => s.id === id)?.name ?? id ?? "—";
  const nameOf = (id: string | null) => adj?.roster.find((r) => r.id === id)?.name ?? id ?? "—";
  const alterations = (adj?.incidents ?? [])
    .filter((i) => i.applyTo === "student" || i.applyTo === "subject")
    .flatMap((i) => {
      const base = { subject: subjectName(i.subjectId), marks: i.marks, reason: i.reason ?? "", decidedBy: i.decidedBy ?? "", decidedAt: i.decidedAt ?? "", sourceIncident: i.studentName || i.source };
      if (i.applyTo === "subject") {
        return (adj?.roster ?? []).map((r) => ({ participantId: r.id, participantName: r.name, ...base }));
      }
      return [{ participantId: i.studentId ?? "", participantName: nameOf(i.studentId), ...base }];
    });

  const auditEntries = audit.entries.map((e) => ({
    timestamp: e.ts,
    actor: e.actorName,
    action: e.action,
    detail: e.detail,
    entity: e.type,
    entityId: e.cycleId ?? "",
  }));

  const buf = await exp.buildPerformanceReportWorkbook({
    ...report,
    alterations,
    audit: auditEntries,
  });
  downloadXlsxBuffer("students_performance_report_may_2026.xlsx", buf);
}
