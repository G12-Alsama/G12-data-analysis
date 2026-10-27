"use client";

/**
 * Cycle route layout — makes sure a sitting's data is LOADED before any of its pages
 * render.
 *
 * The live provider holds only a light summary of every sitting and loads a sitting's
 * full data lazily, when it is opened. Every pipeline page under /cycles/[cycleId]/…
 * reads that data synchronously and shows a "no data for this sitting" empty state when
 * a model is null — which, mid-load, would be a lie. So this layout kicks the load off
 * (idempotent; concurrent callers share one) and shows an honest loading / error state
 * until the sitting is ready, then renders the page. A sitting that doesn't exist falls
 * through to the page's own "not found" handling.
 *
 * The in-memory demo is always "ready", so this is a pass-through there. Server render
 * and the first client render agree: the live app is gated behind AccessGate's loading
 * state until the provider is ready, so this layout never renders ahead of it.
 */
import { useEffect, type ReactNode } from "react";
import { useProvider, useProviderData } from "@/lib/data/context";
import { H } from "@/lib/ui/tokens";
import { Shell } from "@/components/shell/Shell";

export default function CycleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: { cycleId: string };
}) {
  const { cycleId } = params;
  const provider = useProvider();
  const state = useProviderData((p) => p.getCycleLoadState(cycleId), [cycleId]);

  useEffect(() => {
    void provider.ensureCycleLoaded(cycleId);
  }, [provider, cycleId]);

  if (state === "ready" || state === "missing") return <>{children}</>;

  if (state === "error") {
    return (
      <Shell active="Cycles" crumb={[{ label: "Sittings", href: "/" }, { label: "Couldn’t open" }]}>
        <div style={{ display: "flex", flexDirection: "column", padding: "26px 32px", gap: 14, flex: 1 }}>
          <div className="hf-h1">Couldn’t load this sitting</div>
          <div className="hf-sub" style={{ maxWidth: 560 }}>
            The sitting’s data didn’t load. This can happen if the connection dropped. Try again, or go back to the sittings list.
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button className="hf-btn" onClick={() => void provider.ensureCycleLoaded(cycleId)}>Retry</button>
            <a href="/" className="hf-btn ghost" style={{ textDecoration: "none" }}>Back to sittings</a>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell active="Cycles" crumb={[{ label: "Sittings", href: "/" }, { label: "Opening sitting…" }]}>
      <div role="status" style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", color: H.ink3, fontSize: 13, padding: 32 }}>
        Loading this sitting…
      </div>
    </Shell>
  );
}
