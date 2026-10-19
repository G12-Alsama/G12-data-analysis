"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { H } from "@/lib/ui/tokens";
import { EntryFrame } from "@/components/entry/EntryFrame";
import { updatePassword } from "./actions";

export function UpdatePasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    startTransition(async () => {
      const result = await updatePassword(password);
      if (result.error) {
        setError(result.error);
      } else {
        router.push("/signin?reset=1");
        router.refresh();
      }
    });
  };

  return (
    <EntryFrame>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 380 }}>
        <div className="hf-h1" style={{ fontSize: 24 }}>Choose a new password</div>
        <div className="hf-sub" style={{ marginTop: 8, marginBottom: 22, fontSize: 13.5 }}>
          Your new password must be at least 8 characters.
        </div>

        <label className="hf-sub" style={{ fontSize: 12, fontWeight: 600 }}>New password</label>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          className="hf-textinput"
          style={{ marginTop: 6, marginBottom: 14 }}
        />

        <label className="hf-sub" style={{ fontSize: 12, fontWeight: 600 }}>Confirm new password</label>
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          className="hf-textinput"
          style={{ marginTop: 6, marginBottom: 18 }}
        />

        {error && (
          <div
            className="hf-card"
            style={{
              padding: "10px 13px",
              background: H.badSoft,
              borderColor: H.bad,
              color: H.bad,
              fontSize: 12.5,
              marginBottom: 14,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          className="hf-btn pri"
          disabled={isPending}
          style={{ width: "100%", justifyContent: "center", padding: 13, fontSize: 14 }}
        >
          {isPending ? "Updating…" : "Update password"}
        </button>
      </form>
    </EntryFrame>
  );
}
