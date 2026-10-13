"use client";

/**
 * Full-screen split frame for the entry screens (sign-in / access-denied),
 * ported from design/hfEntry.jsx. Brand panel on the left, content on the right.
 * No nav rail — these screens are pre-auth.
 */
import type { ReactNode } from "react";
import Image from "next/image";
import { H } from "@/lib/ui/tokens";

/** Sign-in branding (opt-in via `EntryFrame`'s `brand` prop; other entry screens keep the default). */
const SIGNIN_LOGO = { src: "/images/alsama-logo.jpeg", width: 2000, height: 842 };

export function EntryFrame({ children, brand }: { children: ReactNode; brand?: "signin" }) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", height: "100vh", background: H.canvas, fontFamily: "var(--font-ui)", color: H.ink }}>
      {/* brand panel */}
      <div style={{ width: 460, flex: "0 0 auto", background: H.slate, color: "#fff", padding: "52px 48px", position: "relative", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ position: "absolute", width: 360, height: 360, borderRadius: 999, background: H.pink, opacity: 0.16, right: -150, top: -120 }} />
        <div style={{ position: "absolute", width: 240, height: 240, borderRadius: 999, border: `2px solid ${H.pink}`, opacity: 0.18, left: -90, bottom: 40 }} />
        <div style={{ position: "relative" }}>
          {brand === "signin" ? (
            // The logo file has a light-grey (#f7f7f7) background, so it sits on a matching rounded tile.
            <div style={{ width: "100%", maxWidth: 300, borderRadius: 14, overflow: "hidden", background: "#f7f7f7", lineHeight: 0 }}>
              <Image
                src={SIGNIN_LOGO.src}
                width={SIGNIN_LOGO.width}
                height={SIGNIN_LOGO.height}
                alt="Alsama logo"
                priority
                style={{ width: "100%", height: "auto", display: "block" }}
              />
            </div>
          ) : (
            <>
              <div style={{ width: 46, height: 46, borderRadius: 13, background: H.pink, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 10px rgba(193,44,104,.5)" }}>
                <span style={{ fontFamily: "var(--font-script)", fontSize: 30, marginTop: 6 }}>A</span>
              </div>
              <div style={{ fontFamily: "var(--font-script)", fontSize: 40, marginTop: 26, lineHeight: 1 }}>Alsama</div>
            </>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ position: "relative" }}>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-.5px", lineHeight: 1.15 }}>
            {brand === "signin" ? (
              <>G12++ Candidate<br />Performance App</>
            ) : (
              <>G12++ Exam<br />Processing Suite</>
            )}
          </div>
          <div style={{ fontSize: 14, color: "rgba(255,255,255,.72)", marginTop: 14, maxWidth: 320, lineHeight: 1.5 }}>
            Review item quality, set grade boundaries, and publish auditable results — one exam sitting at a time.
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ position: "relative", fontSize: 11.5, color: "rgba(255,255,255,.5)" }}>Alsama Project · internal assessment tool</div>
      </div>
      {/* content */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>{children}</div>
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
