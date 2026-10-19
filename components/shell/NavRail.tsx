"use client";

/**
 * Left icon nav rail (ported from design/hf.jsx HRail). Light cool-neutral rail;
 * the magenta accent appears only on the Alsama mark and the active item. The
 * current-user avatar at the foot reflects the mocked Lead user.
 */
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { H } from "@/lib/ui/tokens";
import { AccountMenu } from "./AccountMenu";

// Three areas, with the batch-2 rail icons (design/hf.jsx HRAIL).
const NAV = [
  { k: "Cycles", label: "Years", href: "/", d: "M3 5h10M3 8h10M3 11h7" },
  { k: "Analytics", label: "Analytics", href: "/analytics", d: "M3 13V8.5M7.5 13V3.5M12 13V10" },
  {
    k: "Settings",
    label: "Settings",
    href: "/settings",
    d: "M8 6a2 2 0 100 4 2 2 0 100-4M8 2.6V4.2M8 11.8v1.6M13.4 8H11.8M4.2 8H2.6M11.4 4.6l-1 1M5.6 10.4l-1 1M11.4 11.4l-1-1M5.6 5.6l-1-1",
  },
] as const;

export function NavRail({ active }: { active?: "Cycles" | "Analytics" | "Settings" }) {
  const pathname = usePathname();
  const activeKey =
    active ??
    (pathname.startsWith("/settings")
      ? "Settings"
      : pathname.startsWith("/analytics")
        ? "Analytics"
        : "Cycles");

  return (
    <nav
      aria-label="Primary"
      style={{
        width: 64,
        flex: "0 0 auto",
        background: H.tint,
        borderRight: `1px solid ${H.line2}`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "16px 0",
        gap: 5,
      }}
    >
      <Link
        href="/"
        aria-label="G12++ home"
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 14,
          textDecoration: "none",
        }}
      >
        {/* compact "A" mark cropped from the Alsama logo (the full wordmark is too small at the rail's width) */}
        <Image src="/images/alsama-mark.png" width={128} height={128} alt="Alsama logo" priority style={{ width: 34, height: 34, display: "block" }} />
      </Link>
      {NAV.map((it) => {
        const on = it.k === activeKey;
        return (
          <Link
            key={it.k}
            href={it.href}
            aria-label={it.k}
            aria-current={on ? "page" : undefined}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              textDecoration: "none",
            }}
          >
            <span
              style={{
                width: 40,
                height: 36,
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: on ? H.pinkSoft : "transparent",
                color: on ? H.pink : H.ink3,
              }}
            >
              <svg width="19" height="19" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d={it.d} />
              </svg>
            </span>
            {/* permanent label under each icon (always visible) */}
            <span style={{ fontSize: 8.5, fontWeight: on ? 700 : 500, letterSpacing: "0.2px", color: on ? H.pink : H.ink3, lineHeight: 1 }}>
              {it.label}
            </span>
          </Link>
        );
      })}
      <div style={{ flex: 1 }} />
      <AccountMenu />
    </nav>
  );
}
