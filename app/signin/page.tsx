"use client";

/**
 * Sign-in (invite-only). Email/password against Supabase Auth (no Microsoft SSO
 * yet). The signed-in user's role comes from the `memberships` table; an
 * authenticated account that isn't a member is routed to /access-denied by the
 * AccessGate. When Supabase isn't configured (the in-memory demo), the button
 * just enters the app.
 */
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { H } from "@/lib/ui/tokens";
import { EntryFrame } from "@/components/entry/EntryFrame";
import { Icon } from "@/components/ui/icons";
import { createClient } from "@/lib/supabase/client";

const SUPABASE = process.env.NEXT_PUBLIC_DATA_PROVIDER === "supabase";

/** Only allow internal absolute paths as a post-login destination (no
 *  open-redirect to "//evil.com" or absolute URLs). Falls back to the home page. */
function safeNext(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const dest = safeNext(params.get("next") ?? params.get("redirect"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!SUPABASE) {
      router.push(dest);
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        setError(error.message);
        return;
      }
      // The session cookie is now persisted; the provider's onAuthStateChange
      // re-hydrates so the AccessGate sees the session instead of bouncing back.
      // The gate decides ok vs access-denied from `memberships`.
      router.push(dest);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EntryFrame brand="signin">
      <form onSubmit={submit} style={{ width: 380 }}>
        <div className="hf-h1" style={{ fontSize: 24 }}>Sign in</div>
        <div className="hf-sub" style={{ marginTop: 8, marginBottom: 22, fontSize: 13.5 }}>
          G12++ is invite-only. Use the account your G12 lead added.
        </div>

        <label className="hf-sub" style={{ fontSize: 12, fontWeight: 600 }}>Email</label>
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="hf-textinput"
          style={{ marginTop: 6, marginBottom: 14 }}
        />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <label className="hf-sub" style={{ fontSize: 12, fontWeight: 600 }}>Password</label>
          <Link href="/forgot-password" className="hf-sub" style={{ fontSize: 11, color: H.ink3 }}>
            Forgot password?
          </Link>
        </div>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="hf-textinput"
          style={{ marginTop: 6, marginBottom: 18 }}
        />

        {error && (
          <div className="hf-card" style={{ padding: "10px 13px", background: H.badSoft, borderColor: H.bad, color: H.bad, fontSize: 12.5, marginBottom: 14 }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          className="hf-btn pri"
          disabled={busy}
          style={{ width: "100%", justifyContent: "center", padding: 13, fontSize: 14 }}
        >
          {busy ? "Signing in…" : SUPABASE ? "Sign in" : "Enter demo"}
        </button>

        <div className="hf-card" style={{ padding: "14px 16px", background: H.tint, display: "flex", gap: 11, alignItems: "flex-start", marginTop: 22 }}>
          <Icon name="lock" size={16} color={H.ink2} />
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>No account yet?</div>
            <div className="hf-sub" style={{ fontSize: 12, marginTop: 3 }}>
              Access is granted by a G12 lead. Ask them to invite your email, then sign in here.
            </div>
          </div>
        </div>
        <div className="hf-sub" style={{ fontSize: 11, marginTop: 18, textAlign: "center" }}>
          <Link href="/access-denied" style={{ color: H.ink3 }}>preview access-denied</Link>
        </div>
      </form>
    </EntryFrame>
  );
}

export default function SignInPage() {
  // useSearchParams() requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<EntryFrame brand="signin"><div style={{ width: 380 }} /></EntryFrame>}>
      <SignInForm />
    </Suspense>
  );
}
