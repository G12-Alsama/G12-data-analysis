"use client";

/**
 * Two-step upload-flow pieces for the data-import screen, kept as pure
 * presentational components so each stage renders deterministically (and is
 * testable without a DOM):
 *
 *   • UploadStatusLine — names the current upload stage next to the control
 *     (idle → uploading → ingesting → done / failed), reusing the existing
 *     Spinner and status Marks.
 *   • ConfirmStep — the distinct, second-step Confirm action. Disabled with a
 *     visible hint until ingest + validation succeed, then the clear primary
 *     next action.
 *
 * Both build on the existing Button / Icon / Spinner primitives — no new pattern.
 */
import Link from "next/link";
import { H } from "@/lib/ui/tokens";
import { Button, Spinner } from "@/components/ui/primitives";
import { Icon, Mark } from "@/components/ui/icons";

/** Explicit, visible stages the upload control moves through. */
export type UploadStage = "idle" | "uploading" | "confirm" | "ingesting" | "done" | "failed";

const STAGE_TEXT: Record<"uploading" | "ingesting", string> = {
  uploading: "Uploading — reading and parsing the file…",
  ingesting: "Ingesting — detecting and splitting subjects…",
};

/**
 * The status line shown next to the upload control. Renders nothing while idle;
 * otherwise names the active stage so it's unmistakable that work is happening,
 * and resolves to a clear done / failed state.
 */
export function UploadStatusLine({
  stage,
  error,
  subjectCount,
}: {
  stage: UploadStage;
  error?: string | null;
  subjectCount?: number;
}) {
  // "confirm" = a parsed file is held for the mismatch warning; that card speaks for itself.
  if (stage === "idle" || stage === "confirm") return null;

  const base = {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    fontSize: 11.5,
  } as const;

  if (stage === "uploading" || stage === "ingesting") {
    return (
      <span role="status" aria-live="polite" className="hf-sub" style={base}>
        <Spinner size={13} />
        {STAGE_TEXT[stage]}
      </span>
    );
  }

  if (stage === "failed") {
    return (
      <span role="status" aria-live="polite" className="hf-sub" style={{ ...base, color: H.bad }}>
        <Mark kind="fail" size={14} />
        {error || "Upload failed — try again."}
      </span>
    );
  }

  // done
  return (
    <span role="status" aria-live="polite" className="hf-sub" style={{ ...base, color: H.good }}>
      <Mark kind="pass" size={14} />
      {subjectCount
        ? `Done — ${subjectCount} subject${subjectCount === 1 ? "" : "s"} detected and split.`
        : "Done — file ingested and validated."}
    </span>
  );
}

/**
 * Step 2 of the flow: confirm the detected subjects and continue. Visually
 * distinct from the upload control (its own numbered card) and disabled — with a
 * visible hint explaining why — until ingest + validation succeed, after which it
 * becomes the obvious primary next action.
 */
export function ConfirmStep({
  subjectCount,
  canContinue,
  hint,
  href,
}: {
  subjectCount: number;
  canContinue: boolean;
  /** Why Confirm is disabled — shown to the user while it's not yet available. */
  hint: string;
  href: string;
}) {
  const label = subjectCount ? `Confirm ${subjectCount} subjects & continue` : "Confirm & continue";
  const button = (
    <Button variant="pri" disabled={!canContinue} aria-disabled={!canContinue} title={canContinue ? undefined : hint}>
      {label}
      <Icon name="arrow" color="#fff" />
    </Button>
  );

  return (
    <div
      className="hf-card"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "16px 18px",
        background: canContinue ? H.pinkSoft2 : H.paper,
        borderColor: canContinue ? H.pink : H.line,
      }}
    >
      <span
        className="hf-mono"
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: canContinue ? H.pink : H.tint2,
          color: canContinue ? "#fff" : H.ink3,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 700,
          fontSize: 13,
          flex: "0 0 auto",
        }}
        aria-hidden="true"
      >
        2
      </span>
      <div style={{ flex: 1 }}>
        <div className="hf-h2" style={{ fontSize: 14 }}>
          Confirm &amp; continue
        </div>
        <div className="hf-sub" style={{ fontSize: 12, marginTop: 3 }}>
          {canContinue
            ? "Subjects detected and validated — confirm to continue to raw data."
            : hint}
        </div>
      </div>
      {canContinue ? <Link href={href}>{button}</Link> : button}
    </div>
  );
}
