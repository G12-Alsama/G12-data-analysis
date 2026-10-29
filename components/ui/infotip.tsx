"use client";

/**
 * InfoTip — a small "ⓘ" affordance that opens a short plain-language popover.
 * Used to define jargon inline for untrained users (e.g. "Item quality"). Click
 * (or focus + Enter) to toggle; closes on Escape or an outside click. The
 * trigger stops event propagation so it can sit inside clickable headers (e.g. a
 * sortable column header) without triggering the parent action.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { H } from "@/lib/ui/tokens";

export function InfoTip({
  children,
  label = "More information",
  width = 290,
  align = "left",
}: {
  children: ReactNode;
  /** Accessible label for the trigger. */
  label?: string;
  width?: number;
  /** Which edge of the trigger the panel lines up with. "right" opens it leftwards, for a
   *  trigger near the right edge of a scroll container (e.g. a right-aligned table cell). */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={wrapRef} style={{ position: "relative", display: "inline-flex", verticalAlign: "middle" }}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 15,
          height: 15,
          borderRadius: 999,
          border: `1px solid ${open ? H.pink : H.line2}`,
          background: open ? H.pink : H.paper,
          color: open ? "#fff" : H.ink3,
          font: "inherit",
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 1,
          cursor: "pointer",
          padding: 0,
        }}
      >
        i
      </button>
      {open && (
        <span
          id={panelId}
          role="tooltip"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "calc(100% + 7px)",
            ...(align === "right" ? { right: 0 } : { left: 0 }),
            zIndex: 50,
            width,
            maxWidth: "80vw",
            padding: "12px 14px",
            background: H.paper,
            border: `1px solid ${H.line2}`,
            borderRadius: 10,
            boxShadow: "0 10px 30px -10px rgba(31,42,49,.35)",
            textAlign: "left",
            whiteSpace: "normal",
            font: "inherit",
            fontWeight: 400,
            color: H.ink2,
            cursor: "default",
          }}
        >
          {children}
        </span>
      )}
    </span>
  );
}
