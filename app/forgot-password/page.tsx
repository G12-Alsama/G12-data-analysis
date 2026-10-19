"use client";

import { useState, useTransition } from "react";
import { H } from "@/lib/ui/tokens";
import { EntryFrame } from "@/components/entry/EntryFrame";
import { requestPasswordReset } from "./actions";

function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      await requestPasswordReset(email.trim());
      setDone(true);
    });
  };

  if (done) {
    return (
      <EntryFrame>
        <div style={{ width: "100%", maxWidth: 380 }}>
          <div className="hf-h1" style={{ fontSize: 24 }}>Check your email</div>
          <div
            className="hf-sub"
            style={{ marginTop: 10, marginBottom: 24, fontSize: 13.5, lineHeight: 1.55 }}
          >
            If that address has an account, you'll receive a password-reset link shortly. Check
            your spam folder if it doesn't arrive within a few minutes.
          </div>
          <a href="/signin" style={{ textDecoration: "none" }}>
            <button
              className="hf-btn"
              style={{ width: "100%", justifyContent: "center", padding: 13, fontSize: 14 }}
            >
              Back to sign in
            </button>
          </a>
        </div>
      </EntryFrame>
    );
  }

  return (
    <EntryFrame>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 380 }}>
        <div className="hf-h1" style={{ fontSize: 24 }}>Forgot your password?</div>
        <div className="hf-sub" style={{ marginTop: 8, marginBottom: 22, fontSize: 13.5 }}>
          Enter your account email and we'll send a reset link.
        </div>

        <label className="hf-sub" style={{ fontSize: 12, fontWeight: 600 }}>
          Email
        </label>
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="hf-textinput"
          style={{ marginTop: 6, marginBottom: 18 }}
        />

        <button
          type="submit"
          className="hf-btn pri"
          disabled={isPending}
          style={{ width: "100%", justifyContent: "center", padding: 13, fontSize: 14 }}
        >
          {isPending ? "Sending…" : "Send reset link"}
        </button>

        <div style={{ textAlign: "center", marginTop: 18 }}>
          <a href="/signin" className="hf-sub" style={{ fontSize: 12, color: H.ink3, textDecoration: "none" }}>
            Back to sign in
          </a>
        </div>
      </form>
    </EntryFrame>
  );
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
