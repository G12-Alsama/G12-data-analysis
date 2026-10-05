"use client";

/**
 * Screen 02 — A year opened. Shows the year's two sittings (February and May)
 * plus the derived Overall view. Each sitting tile opens the existing
 * per-sitting pipeline (app/cycles/[cycleId]) unchanged; Overall opens the
 * best-of-two rollup (app/years/[yearId]/overall).
 */
import Link from "next/link";
import { useProviderData } from "@/lib/data/context";
import { H } from "@/lib/ui/tokens";
import { Shell } from "@/components/shell/Shell";
import { Button, Card, Badge } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/icons";
import { CycleCardMenu } from "@/components/cycle/CycleCardMenu";
import { PIPELINE, type SittingRef } from "@/lib/data/types";

// The step total shown in "k/N steps" derives from the canonical pipeline list
// (the same one the in-pipeline stepper renders), so the card and the tracker
// can never disagree on N — and a stale/over-counted source can never read as
// more steps done than exist.
const TOTAL_STEPS = PIPELINE.length;

/** "2026-05-14" → "14 May 2026" (date-only: parsed as UTC so it never shifts a day). */
function formatSittingDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function SittingCard({ s }: { s: SittingRef }) {
  return (
    <Card style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14, minHeight: 190 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{s.label}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {s.started ? (
            s.live ? (
              <Badge tone="accent">ACTIVE</Badge>
            ) : s.locked ? (
              <Badge tone="neutral"><Icon name="lock" size={11} color={H.ink2} /> Locked</Badge>
            ) : (
              <Badge tone="warn">In progress</Badge>
            )
          ) : (
            <Badge tone="neutral">Not started</Badge>
          )}
          {/* Admin-only per-cycle overflow menu (Delete cycle). Only for a started
              sitting, which has a real cycle id to target. */}
          {s.started && s.cycleId && <CycleCardMenu cycleId={s.cycleId} cycleName={s.cycleName ?? s.label} />}
        </div>
      </div>

      {s.started ? (
        <>
          <div className="hf-sub">
            {s.cycleName}
            {s.sittingDate && <> · {formatSittingDate(s.sittingDate)}</>}
          </div>
          <div style={{ display: "flex", gap: 22, marginTop: "auto" }}>
            <div>
              <div className="hf-mono" style={{ fontSize: 18, fontWeight: 700 }}>{s.participants.toLocaleString()}</div>
              <div className="hf-sub" style={{ fontSize: 11 }}>Participants</div>
            </div>
            <div>
              <div className="hf-mono" style={{ fontSize: 18, fontWeight: 700 }}>{s.assessments}</div>
              <div className="hf-sub" style={{ fontSize: 11 }}>Assessments</div>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{s.stageLabel}</div>
              <div className="hf-sub" style={{ fontSize: 11 }}>{Math.min(s.stepsDone, TOTAL_STEPS)}/{TOTAL_STEPS} steps</div>
            </div>
          </div>
          <Link href={`/cycles/${s.cycleId}`}>
            <Button variant="pri">
              {s.locked ? "View pipeline" : "Open pipeline"}
              <Icon name="arrow" color="#fff" />
            </Button>
          </Link>
        </>
      ) : (
        <>
          <div className="hf-sub" style={{ marginTop: "auto" }}>
            No pipeline run yet for the {s.label} sitting.
          </div>
          <Link href="/cycles/new">
            <Button variant="pri">
              <Icon name="plus" color="#fff" />
              Start {s.label} sitting
            </Button>
          </Link>
        </>
      )}
    </Card>
  );
}

export default function YearPage({ params }: { params: { yearId: string } }) {
  const year = useProviderData((p) => p.getYear(params.yearId), [params.yearId]);

  if (!year) {
    return (
      <Shell active="Cycles" crumb={[{ label: "Years", href: "/" }, { label: "Not found" }]}>
        <div style={{ padding: "40px 32px" }}>
          <div className="hf-h1">Year not found</div>
          <div className="hf-sub" style={{ marginTop: 8 }}>
            This year doesn’t exist. <Link href="/" style={{ color: H.pink }}>Back to years</Link>.
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell active="Cycles" crumb={[{ label: "Years", href: "/" }, { label: year.testCentreName }, { label: year.name }]}>
      <div style={{ display: "flex", flexDirection: "column", padding: "28px 32px", gap: 22, flex: 1 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div className="hf-h1">{year.name}</div>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: H.ink2, background: H.tint, border: `1px solid ${H.line2}`, padding: "2px 9px", borderRadius: 999 }}>
              {year.testCentreName}
            </span>
          </div>
          <div className="hf-sub" style={{ marginTop: 7 }}>
            Two sittings run the full pipeline independently. Overall takes the higher award across the two, per student per subject.
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18 }}>
          <SittingCard s={year.february} />
          <SittingCard s={year.may} />

          {/* Overall — derived best-of-two across the two sittings. */}
          <Card style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14, minHeight: 190, borderStyle: "dashed" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Overall</div>
              <Badge tone={year.overall.ready ? "good" : "neutral"}>
                {year.overall.ready ? "Ready" : "Pending"}
              </Badge>
            </div>
            <div className="hf-sub" style={{ marginTop: "auto" }}>{year.overall.note}</div>
            <Link href={`/years/${year.id}/overall`}>
              <Button>
                View overall
                <Icon name="arrow" />
              </Button>
            </Link>
          </Card>
        </div>
      </div>
    </Shell>
  );
}
