"use client";

/**
 * Overall (best-of-two) view.
 *
 * Per the year model, Overall takes — for every student and every subject — the
 * HIGHER award level across the February and May sittings (best-of-two by level
 * RANK, not raw score). Each cell is tagged with the sitting it came from
 * (Feb / May) for provenance, and the overall award is DERIVED from the rolled-up
 * per-subject levels using the existing award-derivation rule. It is a derived
 * aggregation, not a pipeline run — no scoring/engine/safeguard work runs here;
 * each sitting's award is already its own signed-off, safeguard-checked result.
 *
 * Certificates issue from this Overall (see ./overall/documents).
 */
import { useEffect } from "react";
import Link from "next/link";
import { useProvider, useProviderData } from "@/lib/data/context";
import { H } from "@/lib/ui/tokens";
import { Shell } from "@/components/shell/Shell";
import { Button, Card, Badge } from "@/components/ui/primitives";
import { Icon, Mark } from "@/components/ui/icons";
import { MiniGradeBars } from "@/components/ui/charts";
import { StepIntro } from "@/components/ui/StepIntro";
import { AWARD_SHORT } from "@/lib/data/grading";
import type { OverallGradeCell, OverallSittingInfo } from "@/lib/data/types";

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

/**
 * Which of the year's sittings count toward this Overall. Only sittings whose grades are
 * LOCKED count; an unlocked one is shown here — with why — instead of silently ignored.
 */
function SittingsCounted({ sittings }: { sittings: OverallSittingInfo[] }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} aria-label="Sittings counted in this Overall">
      {sittings.map((s) => {
        const counted = s.status === "counted";
        const waiting = s.status === "not_locked";
        return (
          <span
            key={s.key}
            title={s.cycleName ?? s.label}
            data-status={s.status}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 10px",
              borderRadius: 999,
              fontSize: 11.5,
              fontWeight: 600,
              border: `1px solid ${H.line2}`,
              background: counted ? H.goodSoft : waiting ? H.warnSoft : H.tint,
              color: counted ? H.good : waiting ? H.warn : H.ink2,
            }}
          >
            {counted ? <Icon name="lock" size={11} color={H.good} /> : null}
            {s.note}
          </span>
        );
      })}
    </div>
  );
}

export default function YearOverallPage({ params }: { params: { yearId: string } }) {
  const provider = useProvider();
  const year = useProviderData((p) => p.getYear(params.yearId), [params.yearId]);
  const model = useProviderData((p) => p.getOverallGrades(params.yearId), [params.yearId]);
  // Overall counts the year's LOCKED sittings: make sure their data is loaded.
  useEffect(() => {
    void provider.ensureYearLoaded(params.yearId);
  }, [provider, params.yearId]);

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
          <Badge tone={year.overall.ready ? "good" : "neutral"}>
            {year.overall.ready ? "Ready" : "Provisional"}
          </Badge>
          {model && (
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="hf-lbl">Awards</span>
              <MiniGradeBars data={model.distribution.map((d) => ({ label: AWARD_SHORT[d.level] ?? d.level, count: d.count }))} />
            </span>
          )}
          <div style={{ flex: 1, minWidth: 12 }} />
          {model && (
            <Link href={`/years/${year.id}/overall/documents`}>
              <Button variant="pri">
                <Icon name="award" color="#fff" />
                Generate certificates &amp; reports
              </Button>
            </Link>
          )}
        </div>

        {model?.sittings && <SittingsCounted sittings={model.sittings} />}

        <div className="hf-sub" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>
            Best of two by <strong>award level</strong> (not raw score), per student per subject. The <span style={{ color: H.pink, fontWeight: 700 }}>Feb</span>/<span style={{ color: H.pink, fontWeight: 700 }}>May</span> tag shows which sitting each result came from; the overall award is derived from the best-of-two levels.
          </span>
          {model?.demo && (
            <Badge tone="warn">Demo February sitting</Badge>
          )}
        </div>
        {model?.demo && (
          <Card style={{ padding: "10px 14px", background: H.warnSoft, display: "flex", gap: 10, alignItems: "flex-start" }}>
            <Mark kind="warn" size={15} />
            <span className="hf-sub" style={{ fontSize: 11.5 }}>
              Live Supabase is unreachable in this environment and the seed carries real grades only for the {model.may?.cycleName ?? "May"} sitting, so the February baseline shown here is <strong>generated from the May cohort</strong> to demonstrate the best-of-two rollup. With real two-sitting data the same view reads both sittings’ signed-off grades.
            </span>
          </Card>
        )}

        {!model || model.rows.length === 0 ? (
          <Card style={{ padding: 24, maxWidth: 640 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>No results to roll up yet</div>
            <div className="hf-sub" style={{ marginTop: 8 }}>{model?.note ?? year.overall.note}</div>
          </Card>
        ) : (
          <div className="hf-card" style={{ overflow: "auto", flex: 1, minWidth: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th className="hf-th">Participant</th>
                  {model.assessments.map((a) => (
                    <th key={a.id} className="hf-th" style={{ textAlign: "center" }}>{subjectHeader(a.shortName)}</th>
                  ))}
                  <th className="hf-th" style={{ textAlign: "center" }}>Overall award</th>
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
                    {model.assessments.map((a) => (
                      <td key={a.id} className="hf-td" style={{ textAlign: "center" }}>
                        <OverallCell cell={r.grades[a.id]} starMap={model.starMap} />
                      </td>
                    ))}
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
