"use client";

/**
 * Overall (best-of-two) view.
 *
 * Per the year model, Overall takes — for every student and every subject — the
 * HIGHER performance level across the February and May sittings (best-of-two by
 * level RANK, not raw score). Each subject shows the February level, the May
 * level and the combined (best) level tagged with the sitting it came from; the
 * overall award is DERIVED from the combined per-subject levels using the
 * existing award-derivation rule. The table appears only once BOTH sittings are
 * locked and both sittings' real grades are loaded. It is a derived
 * aggregation, not a pipeline run — no scoring/engine/safeguard work runs here;
 * each sitting's award is already its own signed-off, safeguard-checked result.
 *
 * Certificates issue from this Overall (see ./overall/documents).
 */
import Link from "next/link";
import { useProviderData } from "@/lib/data/context";
import { H } from "@/lib/ui/tokens";
import { Shell } from "@/components/shell/Shell";
import { Button, Card, Badge } from "@/components/ui/primitives";
import { Icon, Mark } from "@/components/ui/icons";
import { MiniGradeBars } from "@/components/ui/charts";
import { StepIntro } from "@/components/ui/StepIntro";
import { AWARD_SHORT } from "@/lib/data/grading";
import type { OverallGradeCell } from "@/lib/data/types";

/** Plain subject-name column header, matching the Grades screen. */
function subjectHeader(shortName: string): string {
  if (/applicable/i.test(shortName)) return "Applicable Math";
  if (/english/i.test(shortName)) return "English";
  if (/scientific/i.test(shortName)) return "Scientific";
  if (/arabic/i.test(shortName)) return "Arabic";
  if (/life/i.test(shortName)) return "Life";
  return shortName.split(" ")[0] ?? shortName;
}

/** A small Feb / May provenance tag for one Overall cell. */
function SourceTag({ source }: { source: OverallGradeCell["source"] }) {
  const isFeb = source === "february";
  return (
    <span
      title={`Best result came from the ${isFeb ? "February" : "May"} sitting`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 14,
        padding: "0 5px",
        borderRadius: 4,
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.3,
        textTransform: "uppercase",
        background: isFeb ? H.tint2 : H.pinkSoft,
        color: isFeb ? H.ink2 : H.pink,
      }}
    >
      {isFeb ? "Feb" : "May"}
    </span>
  );
}

/** Compact performance-level label for the per-sitting columns. */
function shortLevel(level: string | null | undefined): string {
  if (!level) return "—";
  if (/^doesn|not yet/i.test(level)) return "Not yet";
  return level.split(" ")[0] ?? level;
}

/** One sitting's level for a subject (February or May column). */
function SittingLevel({ level }: { level: string | null | undefined }) {
  return (
    <span
      title={level ?? "No result in this sitting"}
      style={{ fontSize: 11, color: level ? H.ink2 : H.ink3, whiteSpace: "nowrap" }}
    >
      {shortLevel(level)}
    </span>
  );
}

/** Per-subject Overall cell: stars + the Feb/May provenance tag (best-of-two). */
function OverallCell({ cell, starMap }: { cell?: OverallGradeCell; starMap: Record<string, string> }) {
  if (!cell) {
    return <span className="hf-mono" style={{ color: H.ink3 }}>·</span>;
  }
  const tooltip =
    `Best of two — chosen ${cell.level} (${cell.source === "february" ? "February" : "May"})` +
    `\nFebruary: ${cell.februaryLevel ?? "no result"}` +
    `\nMay: ${cell.mayLevel ?? "no result"}`;
  return (
    <span title={tooltip} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
      <span
        className="hf-mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 34,
          height: 23,
          borderRadius: 7,
          border: `1px solid ${H.line2}`,
          background: H.paper,
          color: cell.stars ? H.pink : H.ink3,
          fontWeight: 700,
          fontSize: 12,
          letterSpacing: 1.5,
        }}
      >
        {starMap[cell.level] || "·"}
      </span>
      <span style={{ fontSize: 10.5, fontWeight: 600, color: H.ink, whiteSpace: "nowrap" }}>{shortLevel(cell.level)}</span>
      <SourceTag source={cell.source} />
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

export default function YearOverallPage({ params }: { params: { yearId: string } }) {
  const year = useProviderData((p) => p.getYear(params.yearId), [params.yearId]);
  const model = useProviderData((p) => p.getOverallGrades(params.yearId), [params.yearId]);
  // Overall is shown only once both sittings are locked and both real sittings' grades are in.
  const showTable = !!model && model.ready && model.blocked === null;

  if (!year) {
    return (
      <Shell active="Cycles" crumb={[{ label: "Years", href: "/" }, { label: "Not found" }]}>
        <div style={{ padding: "40px 32px" }}>
          <div className="hf-h1">Year not found</div>
          <div className="hf-sub" style={{ marginTop: 8 }}>
            <Link href="/" style={{ color: H.pink }}>Back to years</Link>.
          </div>
        </div>
      </Shell>
    );
  }

  const crumb = [
    { label: "Years", href: "/" },
    { label: year.name, href: `/years/${year.id}` },
    { label: "Overall" },
  ];

  return (
    <Shell active="Cycles" crumb={crumb}>
      <StepIntro>
        This step combines each student&rsquo;s subject grades into their final award and certificate outcome,
        taking the best of their two sittings where applicable. This is the surface real certificates are issued
        from, so it reflects only reviewed, signed-off results.
      </StepIntro>
      <div style={{ display: "flex", flexDirection: "column", padding: "20px 32px 18px", gap: 14, flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div className="hf-h1" style={{ fontSize: 19 }}>{year.name} · Overall</div>
          <Badge tone={showTable ? "good" : "neutral"}>
            {showTable ? "Ready" : "Waiting for both sittings"}
          </Badge>
          {showTable && model && (
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="hf-lbl">Awards</span>
              <MiniGradeBars data={model.distribution.map((d) => ({ label: AWARD_SHORT[d.level] ?? d.level, count: d.count }))} />
            </span>
          )}
          <div style={{ flex: 1, minWidth: 12 }} />
          {showTable && (
            <Link href={`/years/${year.id}/overall/documents`}>
              <Button variant="pri">
                <Icon name="award" color="#fff" />
                Generate certificates &amp; reports
              </Button>
            </Link>
          )}
        </div>

        <div className="hf-sub" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>
            Each subject shows the February and May performance levels and the <strong>combined</strong> level — the higher of the two by <strong>performance level</strong> (not raw score). The <span style={{ color: H.pink, fontWeight: 700 }}>Feb</span>/<span style={{ color: H.pink, fontWeight: 700 }}>May</span> tag shows which sitting it came from; the overall award is derived from the combined levels.
          </span>
          {model?.demo && (
            <Badge tone="warn">Demo February sitting</Badge>
          )}
        </div>
        {model?.demo && (
          <Card style={{ padding: "10px 14px", background: H.warnSoft, display: "flex", gap: 10, alignItems: "flex-start" }}>
            <Mark kind="warn" size={15} />
            <span className="hf-sub" style={{ fontSize: 11.5 }}>
              This is the fixtures-only demo build (no database), so the February baseline shown here is <strong>generated from the May cohort</strong> to demonstrate the best-of-two rollup. On live data this view reads both sittings’ real signed-off grades and never synthesises a sitting.
            </span>
          </Card>
        )}

        {!showTable || !model ? (
          <Card style={{ padding: 24, maxWidth: 640 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Overall is not available yet</div>
            <div className="hf-sub" style={{ marginTop: 8 }}>{model?.blocked ?? year.overall.note}</div>
            <div className="hf-sub" style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
              {[year.february, year.may].map((s) => (
                <span key={s.sitting}>
                  <strong>{s.label}</strong>: {!s.started ? "not started" : s.locked ? "locked" : `${s.stageLabel} — not locked`}
                </span>
              ))}
            </div>
          </Card>
        ) : (
          <div className="hf-card" style={{ overflow: "auto", flex: 1, minWidth: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th className="hf-th" rowSpan={2}>Participant</th>
                  {model.assessments.map((a) => (
                    <th key={a.id} className="hf-th" colSpan={3} style={{ textAlign: "center" }}>{subjectHeader(a.shortName)}</th>
                  ))}
                  <th className="hf-th" rowSpan={2} style={{ textAlign: "center" }}>Overall award</th>
                </tr>
                <tr>
                  {model.assessments.map((a) => [
                    <th key={`${a.id}-feb`} className="hf-th" style={{ textAlign: "center", fontSize: 10 }}>Feb</th>,
                    <th key={`${a.id}-may`} className="hf-th" style={{ textAlign: "center", fontSize: 10 }}>May</th>,
                    <th key={`${a.id}-best`} className="hf-th" style={{ textAlign: "center", fontSize: 10 }}>Combined</th>,
                  ])}
                </tr>
              </thead>
              <tbody>
                {model.rows.map((r) => (
                  <tr key={r.id} className="hf-hover">
                    <td className="hf-td">
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.label}>{r.label}</div>
                        <div className="hf-mono" style={{ fontSize: 10.5, color: H.ink3, marginTop: 1, display: "flex", gap: 6, alignItems: "center" }}>
                          <span title="Student ID">{r.studentId}</span>
                          {!r.inMay && <span title="Did not retake in May — February stands" style={{ color: H.ink2 }}>Feb only</span>}
                          {!r.inFebruary && <span title="No February result — May stands" style={{ color: H.ink2 }}>May only</span>}
                        </div>
                      </div>
                    </td>
                    {model.assessments.map((a) => {
                      const cell = r.grades[a.id];
                      return [
                        <td key={`${a.id}-feb`} className="hf-td" style={{ textAlign: "center" }}>
                          <SittingLevel level={cell?.februaryLevel} />
                        </td>,
                        <td key={`${a.id}-may`} className="hf-td" style={{ textAlign: "center" }}>
                          <SittingLevel level={cell?.mayLevel} />
                        </td>,
                        <td key={`${a.id}-best`} className="hf-td" style={{ textAlign: "center" }}>
                          <OverallCell cell={cell} starMap={model.starMap} />
                        </td>,
                      ];
                    })}
                    <td className="hf-td" style={{ textAlign: "center" }}>
                      <AwardBadge award={r.award} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <Link href={`/years/${year.id}`} style={{ color: H.pink, fontSize: 13 }}>
            ‹ Back to {year.name}
          </Link>
        </div>
      </div>
    </Shell>
  );
}
