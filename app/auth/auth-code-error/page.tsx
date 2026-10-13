"use client";

import Link from "next/link";
import { H } from "@/lib/ui/tokens";
import { EntryFrame } from "@/components/entry/EntryFrame";
import { Mark } from "@/components/ui/icons";

export default function AuthCodeErrorPage() {
  return (
    <EntryFrame>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: 12,
            background: H.badSoft,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 18,
          }}
        >
          <Mark kind="fail" size={24} />
        </div>
        <div className="hf-h1" style={{ fontSize: 23 }}>Link expired or invalid</div>
        <div
          className="hf-sub"
          style={{ marginTop: 10, marginBottom: 24, fontSize: 13.5, lineHeight: 1.55 }}
        >
          The password-reset link you followed has expired or was already used. Links are valid
          for one hour.
        </div>
        <Link href="/forgot-password" style={{ textDecoration: "none" }}>
          <button
            className="hf-btn pri"
            style={{ width: "100%", justifyContent: "center", padding: 13, fontSize: 14 }}
          >
            Request a new link
          </button>
        </Link>
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <Link href="/signin" className="hf-sub" style={{ fontSize: 12, color: H.ink3, textDecoration: "none" }}>
            Back to sign in
          </Link>
        </div>
      </div>
    </EntryFrame>
  );
}
