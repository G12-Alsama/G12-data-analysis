"use client";

/**
 * "Expected sittings" for a year — the periods that must each have a LOCKED sitting before
 * the year's Overall is final (`exam_years.expected_periods`). Everyone sees which periods
 * are expected; people who may manage centres (the same gate as moving a year) can toggle
 * them. The server owns the gate and the "at least one" rule; a refusal is shown as-is.
 */
import { useState } from "react";
import { H } from "@/lib/ui/tokens";
import { Chip } from "@/components/ui/primitives";
import { SITTING_ORDER, periodLabel, sortPeriods, type SittingKey } from "@/lib/data/periods";

export function ExpectedPeriods({
  expected,
  canEdit,
  onChange,
}: {
  expected: readonly SittingKey[];
  canEdit: boolean;
  onChange: (next: SittingKey[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (key: SittingKey) => {
    const next = expected.includes(key) ? expected.filter((k) => k !== key) : [...expected, key];
    if (next.length === 0) {
      setError("A year must expect at least one period.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onChange(sortPeriods(next));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the expected periods.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} aria-label="Expected sittings">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="hf-lbl">Expected sittings</span>
        {canEdit ? (
          <span role="group" aria-label="Expected sittings" style={{ display: "flex", gap: 8, opacity: busy ? 0.6 : 1 }}>
            {SITTING_ORDER.map((k) => (
              <Chip key={k} on={expected.includes(k)} onClick={busy ? undefined : () => void toggle(k)}>
                {periodLabel(k)}
              </Chip>
            ))}
          </span>
        ) : (
          <span className="hf-sub" style={{ fontSize: 12.5, color: H.ink2 }}>
            {expected.map(periodLabel).join(", ")}
          </span>
        )}
        <span className="hf-sub" style={{ fontSize: 11.5 }}>
          The Overall is final once each expected sitting is locked.
        </span>
      </div>
      {error && (
        <div role="alert" className="hf-sub" style={{ color: H.warn, fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
