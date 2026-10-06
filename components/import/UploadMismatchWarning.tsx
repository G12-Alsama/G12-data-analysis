"use client";

/**
 * Held-upload warning: the file the user chose does not look like it belongs to the sitting
 * it is being uploaded into (its tag or dates name another year or period). Nothing has been
 * sent yet — the user must either confirm ("Upload anyway") or cancel. It never hard-blocks:
 * a deliberately re-labelled export is legitimate. Pure presentational (no hooks beyond the
 * caller's handlers), so it renders deterministically.
 */
import { H } from "@/lib/ui/tokens";
import { Button, Card } from "@/components/ui/primitives";
import { Mark } from "@/components/ui/icons";
import type { SittingMatchReport } from "@/lib/ingest/qm/sitting-match";

export function UploadMismatchWarning({
  report,
  fileName,
  busy,
  onConfirm,
  onCancel,
}: {
  report: SittingMatchReport;
  fileName: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Card
      style={{ padding: "12px 14px", background: H.warnSoft, display: "flex", flexDirection: "column", gap: 10, maxWidth: 640, flexBasis: "100%" }}
    >
      <div role="alert" aria-label="Upload does not match this sitting" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <Mark kind="warn" size={15} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>
            This file may not belong to the {report.targetLabel} sitting
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
            {report.issues.map((i) => (
              <li key={i.kind} className="hf-sub" style={{ fontSize: 12 }}>{i.message}</li>
            ))}
          </ul>
          <div className="hf-sub" style={{ fontSize: 11.5 }}>
            Nothing has been uploaded yet. <span className="hf-mono">{fileName}</span> will replace this sitting’s data only if you confirm.
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 9 }}>
        <Button variant="pri" onClick={onConfirm} disabled={busy}>Upload anyway</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </Card>
  );
}
