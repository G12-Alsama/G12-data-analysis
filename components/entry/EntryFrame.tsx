"use client";

/**
 * Full-screen split frame for the entry screens (sign-in / access-denied),
 * ported from design/hfEntry.jsx. Brand panel on the left, content on the right.
 * No nav rail — these screens are pre-auth.
 */
import type { ReactNode } from "react";
import Image from "next/image";
import { H } from "@/lib/ui/tokens";

/** App name shown in the brand panel of every entry screen: one definition, rendered as a two-line heading. */
const APP_NAME_LINES = ["G12++ Candidate", "Performance App"] as const;
/** Alsama logo: trimmed transparent PNG, drawn directly on the brand panel (intrinsic size from the file). */
const LOGO = { src: "/images/alsama-logo.png", width: 1200, height: 459 };

export function EntryFrame({ children, brand }: { children: ReactNode; brand?: "signin" }) {
  // Layout is fluid and lives in the `.entry*` rules in globals.css: two columns on
  // desktop, a compact brand header stacked above the content on narrow screens.
  const signin = brand === "signin";
  return (
    <div className="entry" style={{ background: H.canvas, fontFamily: "var(--font-ui)", color: H.ink }}>
      {/* brand panel */}
      <div className="entry-panel" style={{ background: H.slate, color: "#fff", position: "relative", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ position: "absolute", width: 360, height: 360, borderRadius: 999, background: H.pink, opacity: 0.16, right: -150, top: -120 }} />
        <div style={{ position: "absolute", width: 240, height: 240, borderRadius: 999, border: `2px solid ${H.pink}`, opacity: 0.18, left: -90, bottom: 40 }} />
        <div className="entry-mark" style={{ position: "relative" }}>
          {/* `signin` sits a step lower and slightly larger (see .entry-logo--signin) */}
          <div className={signin ? "entry-logo entry-logo--signin" : "entry-logo"}>
            <Image
              src={LOGO.src}
              width={LOGO.width}
              height={LOGO.height}
              alt="Alsama logo"
              priority
              style={{ width: "100%", height: "auto", display: "block" }}
            />
          </div>
        </div>
        <div className="entry-spacer" style={{ flex: 1 }} />
        <div className="entry-copy" style={{ position: "relative" }}>
          <div className="entry-title" style={{ fontWeight: 700, letterSpacing: "-.5px", lineHeight: 1.15 }}>
            {APP_NAME_LINES[0]}<br />{APP_NAME_LINES[1]}
          </div>
          <div className="entry-desc" style={{ fontSize: 14, color: "rgba(255,255,255,.72)", marginTop: 14, maxWidth: 320, lineHeight: 1.5 }}>
            Review item quality, set grade boundaries, and publish auditable results — one exam sitting at a time.
          </div>
        </div>
        <div className="entry-spacer" style={{ flex: 1 }} />
        <div className="entry-foot" style={{ position: "relative", fontSize: 11.5, color: "rgba(255,255,255,.5)" }}>Alsama Project · internal assessment tool</div>
      </div>
      {/* content */}
      <div className="entry-main">{children}</div>
    </div>
  );
}

export function MSLogo({ s = 18 }: { s?: number }) {
  const sq = s / 2 - 1;
  const C = ["#F25022", "#7FBA00", "#00A4EF", "#FFB900"];
  return (
    <span style={{ width: s, height: s, display: "inline-grid", gridTemplateColumns: "1fr 1fr", gap: 2, flex: "0 0 auto" }}>
      {C.map((c, i) => (
        <span key={i} style={{ background: c, width: sq, height: sq }} />
      ))}
    </span>
  );
}
