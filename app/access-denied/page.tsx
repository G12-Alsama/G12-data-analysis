"use client";

/**
 * Access-denied state for an authenticated-but-unprovisioned account. Shows the
 * REAL signed-in email (from the Supabase session) — the account that isn't yet
 * a member — not a mock person.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { H } from "@/lib/ui/tokens";
import { EntryFrame } from "@/components/entry/EntryFrame";
import { Button, Avatar, Badge } from "@/components/ui/primitives";
import { Icon, Mark } from "@/components/ui/icons";
import { createClient } from "@/lib/supabase/client";

const SUPABASE = process.env.NEXT_PUBLIC_DATA_PROVIDER === "supabase";

export default function AccessDeniedPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    if (!SUPABASE) return;
    let alive = true;
    (async () => {
      try {
        const { data } = await createClient().auth.getUser();
        if (alive) setEmail(data.user?.email ?? null);
      } catch { /* no session */ }
    })();
    return () => { alive = false; };
  }, []);
  const switchAccount = async () => {
    if (SUPABASE) {
      try { await createClient().auth.signOut(); } catch { /* ignore */ }
    }
    router.push("/signin");
    router.refresh();
  };
  return (
    <EntryFrame>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ width: 46, height: 46, borderRadius: 12, background: H.warnSoft, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 18 }}>
          <Mark kind="warn" size={24} />
        </div>
        <div className="hf-h1" style={{ fontSize: 23 }}>You’re signed in — but not on the list</div>
        <div className="hf-sub" style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.55 }}>
          Your Microsoft account is authenticated, but it hasn’t been granted access to G12++ yet. Only people a G12 lead has invited can enter.
        </div>

        {email && (
          <div className="hf-card" style={{ padding: "13px 15px", marginTop: 20, display: "flex", alignItems: "center", gap: 11 }}>
            <Avatar name={email} size={36} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="hf-mono hf-sub" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{email}</div>
            </div>
            <Badge tone="bad">No access</Badge>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 22 }}>
          <a href="mailto:?subject=G12%2B%2B%20access%20request" style={{ textDecoration: "none" }}>
            <Button variant="pri" style={{ width: "100%", justifyContent: "center", padding: 12 }}>
              <Icon name="mail" color="#fff" />
              Email a G12 lead to request access
            </Button>
          </a>
          <Button style={{ width: "100%", justifyContent: "center", padding: 12 }} onClick={switchAccount}>
            Sign in with a different account
          </Button>
        </div>
        <div className="hf-sub" style={{ fontSize: 11.5, marginTop: 18, textAlign: "center" }}>
          Think this is a mistake? Your lead can add you under{" "}
          <span style={{ fontWeight: 600, color: H.ink2 }}>Settings › Users &amp; access</span>.
        </div>
      </div>
    </EntryFrame>
  );
}
