"use client";

/**
 * Top-level Delete-cycle control for a Years-list row — the PRIMARY, always-reachable
 * delete path. A Years row groups a Centre/Year's started sittings (each is a cycle);
 * this ⋯ overflow menu lists them and deletes the chosen one **by its real cycle id,
 * directly from the list**, with no need to open the cycle. Because it never routes
 * through the year/pipeline page, a cycle stranded by a routing 404 can still be
 * deleted here.
 *
 * Admin-only (hidden for everyone else). Type-to-confirm naming the cycle and the
 * existing `delete_cycle` cascade (all cycle_id rows, audit-logged); an admin may
 * delete every cycle, leaving an empty workspace. After a delete the list
 * re-renders itself — the provider bumps subscribers when the sitting list refreshes — so the row
 * disappears immediately without navigating away.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useProviderData } from "@/lib/data/context";
import { can } from "@/lib/auth/actions";
import { H } from "@/lib/ui/tokens";
import { DeleteCycleDialog } from "./DeleteCycleDialog";

export type DeletableCycle = { cycleId: string; label: string; cycleName: string };

export function YearRowDeleteMenu({ cycles }: { cycles: DeletableCycle[] }) {
  const isAdmin = useProviderData((p) => can(p.getCurrentUser?.()?.role ?? "viewer", "general.delete"));
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<DeletableCycle | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Panel is portalled to <body> and positioned `fixed`, anchored to the trigger,
  // so it escapes the Years card's `overflow: hidden` (rounded-corner clip) instead
  // of being cropped to a sliver below the row.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    // Keep it glued to the trigger while the layout moves; close on scroll of any
    // ancestor (capture) so a scrolled-away menu never floats detached.
    const onResize = () => place();
    const onScroll = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, place]);

  // Nothing to delete (no started sitting) or not an admin → no control.
  if (!isAdmin || cycles.length === 0) return null;

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={btnRef}
        type="button"
        aria-label="Cycle actions"
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        style={{
          border: `1px solid ${H.line2}`,
          background: H.paper,
          borderRadius: 8,
          width: 30,
          height: 30,
          fontSize: 16,
          lineHeight: "1",
          color: H.ink2,
          cursor: "pointer",
          verticalAlign: "middle",
        }}
      >
        ⋯
      </button>
      {open && pos && createPortal(
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 90 }} onClick={() => setOpen(false)} />
          <div
            role="menu"
            style={{
              position: "fixed",
              right: pos.right,
              top: pos.top,
              zIndex: 91,
              minWidth: 210,
              background: H.paper,
              border: `1px solid ${H.line2}`,
              borderRadius: 10,
              boxShadow: "0 8px 24px rgba(31,42,49,.18)",
              padding: 6,
              textAlign: "left",
            }}
          >
            {cycles.map((c) => (
              <button
                key={c.cycleId}
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); setTarget(c); }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 7,
                  border: "none",
                  background: "transparent",
                  color: H.bad,
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Delete {c.label} cycle
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
      {target && (
        <DeleteCycleDialog
          cycleId={target.cycleId}
          cycleName={target.cycleName}
          stayOnPage
          onClose={() => setTarget(null)}
        />
      )}
    </div>
  );
}
