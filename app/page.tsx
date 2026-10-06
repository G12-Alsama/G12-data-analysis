"use client";

/**
 * Screen 01 — Exam years (home). A cycle is now a full YEAR; within each year
 * are two sittings (February and May) plus a derived Overall view. This screen
 * lists the years; opening one reveals its February / May / Overall tiles
 * (app/years/[yearId]). Each sitting opens the existing per-sitting pipeline
 * (app/cycles/[cycleId]) unchanged.
 */
import { useState } from "react";
import Link from "next/link";
import { useProvider, useProviderData } from "@/lib/data/context";
import { can } from "@/lib/auth/actions";
import { H } from "@/lib/ui/tokens";
import { Shell } from "@/components/shell/Shell";
import { Button, Chip } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/icons";
import { YearRowDeleteMenu, type DeletableCycle } from "@/components/cycle/YearRowDeleteMenu";
import type { SittingRef, TestCentreSummary, YearSummary } from "@/lib/data/types";

type Filter = "all" | "in_progress" | "locked";

/** The started sittings of a Years row, as deletable cycles (real cycle ids). */
function deletableCyclesOf(y: YearSummary): DeletableCycle[] {
  return y.sittings
    .filter((s): s is SittingRef & { cycleId: string } => s.started && !!s.cycleId)
    .map((s) => ({ cycleId: s.cycleId, label: s.label, cycleName: s.cycleName ?? `${y.name} ${s.label}` }));
}

/** A year is "in progress" while any started sitting is still unlocked. */
function yearLocked(y: YearSummary): boolean {
  const started = y.sittings.filter((s) => s.started);
  return started.length > 0 && started.every((s) => s.locked);
}

function SittingPill({ s }: { s: SittingRef }) {
  if (!s.started) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: H.ink3 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, border: `1px dashed ${H.line2}` }} />
        {s.label} · not started
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: H.ink2 }}>
      {s.locked ? (
        <Icon name="lock" size={12} color={H.ink2} />
      ) : (
        <span style={{ width: 8, height: 8, borderRadius: 999, background: H.pink }} />
      )}
      {s.label}
      {s.live && (
        <span style={{ fontSize: 9, fontWeight: 700, color: H.pink, background: H.pinkSoft, padding: "1px 6px", borderRadius: 999 }}>
          ACTIVE
        </span>
      )}
      {s.mock && (
        <span style={{ fontSize: 8.5, color: H.ink3, border: `1px solid ${H.line2}`, borderRadius: 4, padding: "1px 4px", letterSpacing: 0.5 }}>
          MOCK
        </span>
      )}
    </span>
  );
}

/**
 * The CENTRE cell. For a Lead/Admin it's an inline picker that reassigns the year
 * to another centre (calls move_exam_year_to_centre — pure labelling, no engine
 * recompute); a server-side conflict ("centre already has a 2026 year") or
 * permission error is surfaced beneath the control. Everyone else sees the plain
 * centre name.
 */
function YearCentreCell({
  year,
  centres,
  canEdit,
  onMove,
}: {
  year: YearSummary;
  centres: TestCentreSummary[];
  canEdit: boolean;
  onMove: (yearId: string, centreId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canEdit) {
    return <span style={{ fontWeight: 600, fontSize: 12.5, color: H.ink2 }}>{year.testCentreName}</span>;
  }

  // Offer every active centre, plus the year's current one even if it's inactive
  // (so a year parked on a deactivated/Unassigned centre can always be moved off).
  const options = centres.filter((c) => c.active || c.id === year.testCentreId);

  const change = async (centreId: string) => {
    if (centreId === year.testCentreId) return;
    setBusy(true);
    setError(null);
    try {
      await onMove(year.id, centreId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not move the year.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 200 }}>
      <span className="hf-field" style={{ padding: 0, overflow: "hidden" }}>
        <select
          value={year.testCentreId}
          disabled={busy}
          aria-label={`Centre for ${year.name}`}
          onChange={(e) => change(e.target.value)}
          style={{ border: "none", outline: "none", background: "transparent", flex: 1, fontSize: 12.5, fontFamily: "inherit", color: H.ink2, fontWeight: 600, padding: "6px 10px", cursor: busy ? "default" : "pointer" }}
        >
          {options.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </span>
      {error && <span style={{ fontSize: 11, color: "#d98a8a" }}>{error}</span>}
    </div>
  );
}

export default function YearsDashboard() {
  const provider = useProvider();
  const years = useProviderData((p) => p.listYears());
  const centres = useProviderData((p) => p.listTestCentres());
  const isAdmin = can(provider.getCurrentUser().role, "general.manage_centres");
  const [filter, setFilter] = useState<Filter>("all");

  const rows = years.filter((y) => {
    if (filter === "all") return true;
    const locked = yearLocked(y);
    return filter === "locked" ? locked : !locked;
  });

  return (
    <Shell
      active="Cycles"
      crumb={[{ label: "Years" }]}
      actions={
        <>
          <Button variant="ghost">
            <Icon name="search" />
            Search
          </Button>
          <Link href="/cycles/new">
            <Button variant="pri">
              <Icon name="plus" color="#fff" />
              Start new sitting
            </Button>
          </Link>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "28px 32px", gap: 22, flex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div className="hf-h1">Exam years</div>
            <div className="hf-sub" style={{ marginTop: 7 }}>
              Each year has a February and a May sitting. Open a year to process a sitting or view the overall best-of-two result.
              {isAdmin && " Change a year's Centre to reassign it."}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Chip on={filter === "all"} onClick={() => setFilter("all")}>All</Chip>
            <Chip on={filter === "in_progress"} onClick={() => setFilter("in_progress")}>In progress</Chip>
            <Chip on={filter === "locked"} onClick={() => setFilter("locked")}>Locked</Chip>
          </div>
        </div>

        <div className="hf-card" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th className="hf-th">Centre</th>
                <th className="hf-th">Year</th>
                <th className="hf-th">Sittings</th>
                <th className="hf-th" style={{ textAlign: "right" }}>Participants</th>
                <th className="hf-th">Last activity</th>
                <th className="hf-th" />
              </tr>
            </thead>
            <tbody>
              {rows.map((y) => (
                <tr key={y.id} className="hf-hover" style={{ background: y.live ? H.pinkSoft2 : "transparent" }}>
                  <td className="hf-td">
                    <YearCentreCell
                      year={y}
                      centres={centres}
                      canEdit={isAdmin}
                      onMove={(yearId, centreId) => provider.moveExamYearToCentre(yearId, centreId)}
                    />
                  </td>
                  <td className="hf-td">
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{y.name}</span>
                  </td>
                  <td className="hf-td">
                    <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
                      {y.sittings.map((s) => (
                        <SittingPill key={s.sitting} s={s} />
                      ))}
                    </div>
                  </td>
                  <td className="hf-td hf-mono" style={{ textAlign: "right", fontSize: 13 }}>
                    {y.participants.toLocaleString()}
                  </td>
                  <td className="hf-td hf-sub">{y.lastActivity}</td>
                  <td className="hf-td" style={{ textAlign: "right" }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {/* Delete a cycle straight from the list — by its real cycle id,
                          with no need to open the (possibly 404-ing) year/pipeline. */}
                      <YearRowDeleteMenu cycles={deletableCyclesOf(y)} />
                      <Link href={`/years/${y.id}`}>
                        <Button>
                          Open<Icon name="arrow" />
                        </Button>
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="hf-sub" style={{ marginTop: "auto" }}>
          {years.length} years · oldest archived after 3 years per retention policy
        </div>
      </div>
    </Shell>
  );
}
