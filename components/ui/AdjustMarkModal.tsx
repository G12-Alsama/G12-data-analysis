"use client";

/**
 * Manual mark-adjustment dialog — shared by the Grades view (uncapped) and the Score
 * page (`maxDelta`: at most ±N marks from the current mark).
 *
 * Adjusts the subject MARK (not a direct grade flip), with a required reason; the delta
 * rides the existing Alterations input the engine consumes, so the grade recomputes
 * through the full path (incl. the D3 safeguard). Reversible — an existing adjustment
 * can be removed (also audited).
 *
 * The caller's `onSave` / `onRemove` may answer asynchronously with a `MarkAdjustResult`:
 * a refusal (the server's ±5 cap, a permission failure, a stale sitting…) keeps the
 * dialog open and is shown inline; success closes it. The cap is ENFORCED by the
 * database — the clamp here only saves a round trip.
 */
import { useEffect, useId, useState } from "react";
import { H } from "@/lib/ui/tokens";
import { Button, Spinner } from "@/components/ui/primitives";
import { MarginalGlyph } from "@/components/ui/icons";
import type { GradeCell, MarkAdjustResult, SubjectComposition } from "@/lib/data/types";

type Outcome = MarkAdjustResult | void | Promise<MarkAdjustResult | void>;

/** One-decimal rounding for display. */
const round1 = (n: number): number => Math.round(n * 10) / 10;
/** Float-noise-free rounding for bounds arithmetic (marks can be fractional). */
const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * The mark range the dialog allows: 0..`max`, narrowed to ±`maxDelta` of the current
 * (un-adjusted) `base` when a cap is set. Exported so the clamp is testable.
 */
export function markBounds(base: number, max: number, maxDelta?: number): { lo: number; hi: number } {
  if (maxDelta == null) return { lo: 0, hi: max };
  return { lo: Math.max(0, r4(base - maxDelta)), hi: Math.min(max, r4(base + maxDelta)) };
}

export function AdjustMarkModal({ studentName, subjectName, subject, cell, maxDelta, onSave, onRemove, onClose }: {
  studentName: string;
  subjectName: string;
  subject: SubjectComposition;
  cell?: GradeCell;
  /** Largest change allowed from the current mark. Omitted → only 0..max applies. */
  maxDelta?: number;
  onSave: (newMark: number, reason: string) => Outcome;
  onRemove?: () => Outcome;
  onClose: () => void;
}) {
  const titleId = useId();
  // The un-adjusted base is the current total minus any existing manual delta, so
  // the input reads as the true mark and re-adjusting never compounds. The cap is
  // measured from this base too (the database does the same).
  const base = subject.adjustment ? round1(subject.total - subject.adjustment.delta) : subject.total;
  const { lo, hi } = markBounds(base, subject.max, maxDelta);
  const clamp = (n: number) => Math.min(hi, Math.max(lo, n));

  const suggested = cell?.marginal && cell.marksToNext != null ? round1(base + cell.marksToNext) : base;
  const [mark, setMark] = useState<string>(String(clamp(suggested)));
  const [reason, setReason] = useState<string>(subject.adjustment?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const newMark = Number(mark);
  const numeric = mark.trim() !== "" && Number.isFinite(newMark);
  const inRange = numeric && newMark >= lo && newMark <= hi;
  const valid = inRange && reason.trim() !== "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const run = async (act: () => Outcome) => {
    setBusy(true);
    setError(null);
    try {
      const res = await act();
      if (res && res.ok === false) {
        setError(res.error);
        setBusy(false);
        return;
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t save the adjustment.");
      setBusy(false);
    }
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(31,42,49,.32)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}
      onClick={() => { if (!busy) onClose(); }}
    >
      <div
        className="hf-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ padding: "22px 24px", maxWidth: 460, width: "100%", background: H.paper }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <MarginalGlyph color={H.pink} />
          <span id={titleId} className="hf-h2">Adjust mark</span>
        </div>
        <div className="hf-sub" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 14 }}>
          <b style={{ color: H.ink }}>{studentName}</b> · {subjectName}. The adjusted mark flows through the
          existing scoring + grade path (including the Distinction D3 safeguard) and recomputes the grade.
          {cell?.marginal && cell.marksToNext != null && (
            <> Currently <b style={{ color: H.ink }}>{round1(cell.marksToNext)}</b> mark{cell.marksToNext === 1 ? "" : "s"} below {cell.nextLevel}.</>
          )}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginBottom: maxDelta != null ? 6 : 12 }}>
          <label style={{ fontSize: 12, color: H.ink2 }}>
            Current mark
            <div className="hf-mono" style={{ fontSize: 15, color: H.ink, fontWeight: 700, marginTop: 4 }}>{round1(base)} / {fmtNum(subject.max)}</div>
          </label>
          <span style={{ color: H.ink3, paddingBottom: 4 }}>→</span>
          <label style={{ fontSize: 12, color: H.ink2 }}>
            New mark
            <input
              type="number"
              value={mark}
              min={lo}
              max={hi}
              step="0.5"
              disabled={busy}
              aria-invalid={numeric && !inRange}
              onChange={(e) => setMark(e.target.value)}
              // Typing can step outside min/max (the browser only validates on submit);
              // pull the value back into the allowed range when the field is left.
              onBlur={() => { if (numeric && !inRange) setMark(String(clamp(newMark))); }}
              style={{ display: "block", marginTop: 4, width: 90, padding: "6px 8px", border: `1px solid ${numeric && !inRange ? H.bad : H.line2}`, borderRadius: 7, fontSize: 14 }}
            />
          </label>
        </div>
        {maxDelta != null && (
          <div className="hf-sub" style={{ fontSize: 11.5, marginBottom: 12, color: numeric && !inRange ? H.bad : undefined }} role="note">
            Allowed: <b className="hf-mono">{fmtNum(lo)}–{fmtNum(hi)}</b> — a mark can move by at most ±{maxDelta} from {round1(base)}.
          </div>
        )}
        <label style={{ fontSize: 12, color: H.ink2, display: "block", marginBottom: 16 }}>
          Reason <span style={{ color: H.pink }}>*</span> (required — recorded in the audit log)
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            disabled={busy}
            placeholder="e.g. Remarked Q14 essay after appeal"
            style={{ display: "block", marginTop: 4, width: "100%", padding: "7px 9px", border: `1px solid ${H.line2}`, borderRadius: 7, fontSize: 13, resize: "vertical" }}
          />
        </label>
        {error && (
          <div
            role="alert"
            style={{ fontSize: 12.5, lineHeight: 1.45, color: H.bad, background: H.badSoft, borderRadius: 7, padding: "8px 10px", marginBottom: 14 }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>
            {onRemove && (
              <Button variant="ghost" disabled={busy} onClick={() => run(onRemove)} title="Remove this adjustment and revert the grade">
                Remove adjustment
              </Button>
            )}
          </span>
          <span style={{ display: "flex", gap: 8 }}>
            <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button variant="pri" disabled={!valid || busy} onClick={() => run(() => onSave(newMark, reason.trim()))}>
              {busy && <Spinner />}
              Save adjustment
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
