"use client";

/**
 * Shared type-to-confirm dialog for deleting a whole cycle. Used by every
 * Delete-cycle surface (the top-level Years-list row menu, the Year-screen sitting
 * card menu, and — via its own copy — the cycle Settings danger zone) so the
 * confirmation, cascade call and error handling never drift between them.
 *
 * Runs the SECURITY DEFINER `delete_cycle` RPC (admin-gated, audit-logged) which
 * removes the cycle row AND every row keyed to that cycle_id across all tables. It
 * resolves only once the DB confirms rows were removed, so a silent no-op can never
 * read as success.
 *
 * `stayOnPage` controls what happens after a successful delete:
 *   - false (default): navigate to Years (`/`) — for surfaces INSIDE the deleted
 *     cycle/year, where staying would land on a now-dead route.
 *   - true: just close — for the Years LIST, which is already the right place and
 *     re-renders itself (the provider bumps subscribers when the sitting list refreshes), so the row
 *     simply disappears.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useProvider } from "@/lib/data/context";
import { H } from "@/lib/ui/tokens";
import { Button } from "@/components/ui/primitives";
import { Mark } from "@/components/ui/icons";

export function DeleteCycleDialog({
  cycleId,
  cycleName,
  onClose,
  stayOnPage = false,
}: {
  cycleId: string;
  cycleName: string;
  onClose: () => void;
  stayOnPage?: boolean;
}) {
  const provider = useProvider();
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = text.trim().toLowerCase() === "delete";

  const confirm = async () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      await provider.deleteCycle(cycleId);
      if (stayOnPage) onClose(); // the list re-renders itself; the row disappears
      else router.replace("/"); // back to Years from an in-cycle/in-year surface
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t delete this cycle.");
      setBusy(false);
    }
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(31,42,49,.42)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120, padding: 20 }}
      onClick={busy ? undefined : onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="hf-card" style={{ padding: "20px 22px", maxWidth: 520, width: "100%", background: H.paper }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <Mark kind="fail" size={18} />
          <span className="hf-h2">Delete this cycle?</span>
        </div>
        <div className="hf-sub" style={{ fontSize: 12.5, marginBottom: 14 }}>
          This permanently removes <strong>{cycleName}</strong> and <strong>all</strong> its data across every table
          (assessments, items, participants, responses, sittings, rollups, scores, grades, incidents, essays). It cannot
          be undone and is recorded in the audit log. Other cycles are untouched.
        </div>
        <label style={{ display: "block", fontSize: 11.5, color: H.ink2, marginBottom: 6 }}>
          Type <span className="hf-mono" style={{ color: H.bad, fontWeight: 700 }}>delete</span> to confirm
        </label>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && armed && !busy) confirm(); }}
          placeholder="delete"
          className="hf-mono"
          style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${H.line2}`, fontSize: 13, marginBottom: 16 }}
        />
        {error && (
          <div style={{ fontSize: 12, color: H.bad, marginBottom: 14, display: "flex", gap: 8, alignItems: "flex-start" }}>
            <Mark kind="fail" size={14} />
            <span>{error}</span>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <button
            onClick={confirm}
            disabled={!armed || busy}
            style={{
              padding: "7px 14px",
              borderRadius: 8,
              border: `1px solid ${!armed || busy ? H.line2 : H.bad}`,
              background: !armed || busy ? H.tint : H.bad,
              color: !armed || busy ? H.ink3 : "#fff",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: !armed || busy ? "default" : "pointer",
            }}
          >
            {busy ? "Deleting…" : "Delete cycle"}
          </button>
        </div>
      </div>
    </div>
  );
}
