"use client";

/**
 * Screen — Data import (Ingest + Validate merged into one step). The full-width
 * main window from the new Claude Design: expandable input cards —
 * 01 Raw exam export (Required) and 02 Essay marks (Optional). Open a card to
 * upload its file and read its validation/match report inline; collapse it so
 * they sit together. Per-card status lives on each header. No right-hand sidebar
 * (the mark-composition explainer lives in Grades). Only the raw export is
 * required — and its blocking issues (duplicates) must be resolved — to continue.
 *
 * The incident-log import is NOT here: incidents are imported and triaged on the
 * later Technical adjustments step, its single home.
 */
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { useProvider, useProviderData } from "@/lib/data/context";
import { H } from "@/lib/ui/tokens";
import { Shell } from "@/components/shell/Shell";
import { CycleShell } from "@/components/shell/CycleShell";
import { Button, Badge } from "@/components/ui/primitives";
import { UploadButton } from "@/components/import/UploadButton";
import { UploadStatusLine, ConfirmStep, type UploadStage } from "@/components/import/UploadFlow";
import { UploadMismatchWarning } from "@/components/import/UploadMismatchWarning";
import { compareExportToSitting, planUpload, type SittingMatchReport } from "@/lib/ingest/qm/sitting-match";
import { Icon, Mark, type MarkKind } from "@/components/ui/icons";
import { EssayMarksCard } from "@/components/cycle/EssayMarksCard";
import { StepIntro } from "@/components/ui/StepIntro";
import { SittingDangerZone } from "@/components/cycle/SittingDangerZone";
import { SchemaHealthBanner } from "@/components/cycle/SchemaHealthBanner";
import { ingestThreeExports, DetectionError } from "@/lib/ingest";
import type { CombinedSplitModel, DuplicateStrategy, EssayMarksModel, IngestModel } from "@/lib/data/types";

type Tone = "pass" | "warn" | "fail" | "neutral";

export default function ImportPage({ params }: { params: { cycleId: string } }) {
  const cycleId = params.cycleId;
  const provider = useProvider();
  const model = useProviderData((p) => p.getIngest(cycleId), [cycleId]);
  const essay = useProviderData((p) => p.getEssayMarks(cycleId), [cycleId]) as EssayMarksModel | null;
  const split = useProviderData((p) => p.getCombinedSplit(cycleId), [cycleId]);
  const cycleName = useProviderData((p) => p.getCycle(cycleId)?.name, [cycleId]) ?? "Sitting";
  const testCentreName = useProviderData((p) => p.getCycle(cycleId)?.testCentreName, [cycleId]) ?? null;

  const [open, setOpen] = useState<Record<number, boolean>>({ 1: true, 2: false });
  const [resolved, setResolved] = useState<DuplicateStrategy | null>(null);

  if (!model) {
    return (
      <Shell crumb={[{ label: "Sittings", href: "/" }, { label: "Data import" }]}>
        <div style={{ padding: 32 }} className="hf-sub">No import data for this sitting.</div>
      </Shell>
    );
  }

  const counts = model.report.checks.reduce(
    (acc, c) => ((acc[c.status] = (acc[c.status] ?? 0) + 1), acc),
    {} as Record<string, number>,
  );
  const toggle = (n: number) => setOpen((o) => ({ ...o, [n]: !o[n] }));
  const resolve = (s: DuplicateStrategy) => {
    provider.resolveDuplicates(cycleId, s);
    setResolved(s);
  };

  // An empty/draft cycle hasn't ingested a raw export yet — the normal starting
  // state for this screen, not an error. Show a neutral "Not added" until upload.
  const exportTone: Tone = !model.uploaded ? "neutral" : counts.fail ? "fail" : counts.warn ? "warn" : "pass";
  const exportStatus = !model.uploaded
    ? "Not added"
    : counts.fail
      ? `${counts.fail} must fix`
      : `${counts.pass ?? 0} passed${counts.warn ? ` · ${counts.warn} warning${counts.warn > 1 ? "s" : ""}` : ""}`;

  const essayUp = !!essay?.uploaded;
  const essayStatus = essayUp ? `${essay!.matchedCount} matched · ${essay!.unmatchedIds.length} unmatched` : "Not added";

  // Why the second-step Confirm is unavailable (shown on the disabled ConfirmStep).
  const confirmHint = !model.uploaded
    ? "Upload and ingest a file first."
    : "Resolve the validation issues above to continue.";

  return (
    <CycleShell
      cycleId={cycleId}
      cycleName={cycleName}
      page="Upload exam data"
      stageIndex={0}
      primary={
        <Link href={model.canContinue ? `/cycles/${cycleId}/clean` : "#"} tabIndex={model.canContinue ? undefined : -1}>
          <Button
            variant="pri"
            disabled={!model.canContinue}
            title={split ? `Confirm ${split.subjects.length} subjects & continue` : undefined}
          >
            Continue
            <Icon name="arrow" color="#fff" />
          </Button>
        </Link>
      }
      intro={
        <StepIntro>
          This step brings the raw exam data into the app. We upload the Questionmark exports exactly as
          exported, with no edits, so everything downstream stays traceable to an untouched source. Nothing is
          scored or changed here — this is the single, auditable point of entry.
        </StepIntro>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "26px 30px", gap: 14, flex: 1, maxWidth: 1040 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div className="hf-h1">Upload exam data</div>
            {testCentreName && (
              <span
                title="This upload is scoped to this test centre"
                style={{ fontSize: 11, fontWeight: 700, color: H.pink, background: H.pinkSoft, padding: "2px 9px", borderRadius: 999 }}
              >
                {testCentreName} · {cycleName}
              </span>
            )}
          </div>
          <div className="hf-sub" style={{ marginTop: 7 }}>
            Drop in the <strong>three Questionmark CSV exports</strong> — Items, Assessments and Topics. We detect each by
            its columns (not its filename), join them on <span className="hf-mono">ResultId</span>, and split the subjects
            for you. Only the raw export is required (resolve its blocking issues to continue); essay marks are optional
            and never block progress. The incident log is imported later, on the Technical adjustments step.
          </div>
        </div>

        <SchemaHealthBanner />

        {split && <CombinedSplitPanel split={split} />}

        <ImportCard n="01" title="Raw exam export" required tone={exportTone} status={exportStatus} open={!!open[1]} onToggle={() => toggle(1)}>
          <ExportBody cycleId={cycleId} model={model} counts={counts} resolved={resolved} onResolve={resolve} />
        </ImportCard>

        <ImportCard n="02" title="Essay marks" tone={essayUp ? "pass" : "neutral"} status={essayStatus} open={!!open[2]} onToggle={() => toggle(2)}>
          <EssayMarksCard cycleId={cycleId} model={essay} />
        </ImportCard>

        <ConfirmStep
          subjectCount={split?.subjects.length ?? 0}
          canContinue={model.canContinue}
          hint={confirmHint}
          href={`/cycles/${cycleId}/clean`}
        />

        <SittingDangerZone cycleId={cycleId} uploaded={model.uploaded} />
      </div>
    </CycleShell>
  );
}

// ── combined-upload detection: subjects split out of the single export ───────
function CombinedSplitPanel({ split }: { split: CombinedSplitModel }) {
  const warned = split.subjects.filter((s) => s.status === "warn");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="hf-lbl">Detected {split.subjects.length} subjects in this file</span>
        <span className="hf-sub" style={{ fontSize: 11.5 }}>{split.totalItems} items total · {split.totalParticipants} participants · split automatically</span>
      </div>
      <div className="hf-card" style={{ overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th className="hf-th">Detected subject</th>
              <th className="hf-th" style={{ textAlign: "right" }}>Items</th>
              <th className="hf-th" style={{ textAlign: "right" }}>Participants</th>
              <th className="hf-th" style={{ textAlign: "right" }}>Elements</th>
              <th className="hf-th" style={{ textAlign: "right" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {split.subjects.map((s) => (
              <tr key={s.id} className="hf-hover">
                <td className="hf-td" style={{ fontWeight: 600 }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {s.name}
                    {s.hasEssay && <Badge tone="accent">has essay</Badge>}
                  </span>
                </td>
                <td className="hf-td hf-mono" style={{ textAlign: "right" }}>{s.items}</td>
                <td className="hf-td hf-mono" style={{ textAlign: "right", color: s.status === "warn" ? H.warn : H.ink }}>{s.participants}</td>
                <td className="hf-td hf-mono" style={{ textAlign: "right", color: H.ink2 }} title={s.elements.join(" · ")}>{s.elements.length}</td>
                <td className="hf-td" style={{ textAlign: "right" }}>
                  {s.status === "warn" ? (
                    <Badge tone="warn"><Mark kind="warn" size={11} />{s.note}</Badge>
                  ) : (
                    <Badge tone="good"><Mark kind="pass" size={11} />Split OK</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {warned.length > 0 && (
        <div style={{ display: "flex", gap: 10, padding: "10px 14px", borderRadius: 10, background: H.warnSoft, alignItems: "center" }}>
          <Mark kind="warn" size={15} />
          <span style={{ fontSize: 12, color: H.ink, flex: 1 }}>
            {warned.length} subject{warned.length === 1 ? "" : "s"} {warned.length === 1 ? "has" : "have"} fewer participants than the largest — fine if some students didn’t sit them. You can confirm in cleaning.
          </span>
        </div>
      )}
    </div>
  );
}

// ── card chrome ─────────────────────────────────────────────────────────────
const toneColor = (t: Tone) => (t === "pass" ? H.good : t === "warn" ? H.warn : t === "fail" ? H.bad : H.ink3);
const toneBg = (t: Tone) => (t === "pass" ? H.goodSoft : t === "warn" ? H.warnSoft : t === "fail" ? H.badSoft : H.tint);

function ImportCard({
  n,
  title,
  required,
  tone,
  status,
  open,
  onToggle,
  children,
}: {
  n: string;
  title: string;
  required?: boolean;
  tone: Tone;
  status: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="hf-card" style={{ overflow: "hidden" }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: 13, width: "100%", border: "none", background: open ? H.tint : H.paper, cursor: "pointer", padding: "15px 18px", textAlign: "left" }}
      >
        <span className="hf-mono" style={{ width: 30, height: 30, borderRadius: 8, background: H.tint2, color: H.ink2, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12, flex: "0 0 auto" }}>{n}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="hf-h2" style={{ fontSize: 14 }}>{title}</span>
          <span style={{ fontSize: 9, color: H.ink2, border: `1px solid ${H.line2}`, borderRadius: 4, padding: "1px 6px", letterSpacing: 0.4 }}>{required ? "REQUIRED" : "OPTIONAL"}</span>
        </span>
        <div style={{ flex: 1 }} />
        <span className="hf-mono" style={{ fontSize: 11.5, fontWeight: 600, color: toneColor(tone), background: toneBg(tone), padding: "3px 10px", borderRadius: 999 }}>{status}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s", flex: "0 0 auto" }} aria-hidden="true">
          <path d="M4 2.5L8 6l-4 3.5" fill="none" stroke={H.ink3} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div style={{ borderTop: `1px solid ${H.line}`, padding: "16px 18px" }}>{children}</div>}
    </div>
  );
}

// ── 01 · raw exam export body ───────────────────────────────────────────────
function ExportBody({
  cycleId,
  model,
  counts,
  resolved,
  onResolve,
}: {
  cycleId: string;
  model: IngestModel;
  counts: Record<string, number>;
  resolved: DuplicateStrategy | null;
  onResolve: (s: DuplicateStrategy) => void;
}) {
  // Empty cycle: no raw export ingested yet. Render the upload prompt rather than
  // a file-meta + validation report for data that doesn't exist (which used to
  // crash reading `report.stats.mcqRows`). An empty cycle is the normal start.
  if (!model.uploaded) return <ExportEmpty cycleId={cycleId} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* recognised files: the three QM CSVs, each labelled by what it was detected as */}
      <RecognisedFiles files={model.files} sizeMB={model.fileSizeMB} uploadedAgo={model.uploadedAgo} cycleId={cycleId} />

      {/* validation report */}
      <div>
        <div style={{ display: "flex", gap: 10, marginBottom: 9, alignItems: "center" }}>
          <span className="hf-lbl">Validation report</span>
          <span className="hf-sub" style={{ fontSize: 11.5 }}>{counts.pass ?? 0} passed · {counts.warn ?? 0} warnings · {counts.fail ?? 0} must fix</span>
        </div>
        <div className="hf-card" style={{ overflow: "hidden" }}>
          {model.report.checks.map((c, i) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", padding: "11px 14px", gap: 12, borderBottom: i < model.report.checks.length - 1 ? `1px solid ${H.line}` : "none", background: c.status === "fail" ? H.badSoft : "transparent" }}>
              <Mark kind={c.status as MarkKind} size={16} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: c.status === "fail" ? 600 : 500 }}>{c.label}</div>
                <div className="hf-sub" style={{ fontSize: 11.5 }}>{c.detail}</div>
              </div>
              {c.count != null && <span className="hf-mono" style={{ fontSize: 11.5, color: c.status === "fail" ? H.bad : H.ink2 }}>{c.count}</span>}
              {c.status !== "pass" && <Button variant="ghost" style={{ fontSize: 11.5 }}>Review</Button>}
            </div>
          ))}
        </div>
      </div>

      {/* duplicate resolution (blocks continue) */}
      {model.duplicates > 0 && (
        <div className="hf-card" style={{ padding: "14px 16px", background: H.badSoft, borderColor: H.bad, display: "flex", gap: 12, alignItems: "flex-start" }}>
          <Mark kind="fail" size={17} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: H.bad, fontSize: 13 }}>{model.duplicates} students submitted twice — resolve to continue.</div>
            <div className="hf-sub" style={{ marginTop: 5 }}>Keep the latest submission, keep the first, or exclude these students. You can also re-upload a corrected export.</div>
            {resolved ? (
              <div className="hf-sub" style={{ marginTop: 10, color: H.ink }}>
                Recorded choice: <strong>{labelFor(resolved)}</strong> <span className="hf-mono" style={{ fontSize: 10, color: H.ink3 }}>(stub — no DB write)</span>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 9, marginTop: 12, flexWrap: "wrap" }}>
                <Button onClick={() => onResolve("keep_latest")}>Keep latest</Button>
                <Button onClick={() => onResolve("keep_first")}>Keep first</Button>
                <Button variant="ghost" onClick={() => onResolve("exclude")}>Exclude students</Button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="hf-sub" style={{ fontSize: 11.5 }}>
        MCQ-only rows after cleaning: <span className="hf-mono">{(model.report.stats?.mcqRows ?? 0).toLocaleString()}</span>. Surveys and non-MCQ rows removed; Arabic encoding repaired.
      </div>
    </div>
  );
}

/**
 * The three Questionmark CSVs as recognised at ingest — one row per kind (Items /
 * Assessments / Topics) showing the source filename each was detected as (by its
 * columns, not its name), or a clear "missing / unrecognised" state when a kind
 * wasn't present. Replaces the legacy single-file `exam_export.xlsx` chip.
 */
const QM_KINDS = [
  { key: "items", label: "Items", hint: "questions + per-answer scores" },
  { key: "assessments", label: "Assessments", hint: "result totals + participants" },
  { key: "topics", label: "Topics", hint: "topic-level rollups" },
] as const;

function RecognisedFiles({
  files,
  sizeMB,
  uploadedAgo,
  cycleId,
}: {
  files: IngestModel["files"];
  sizeMB: number;
  uploadedAgo: string;
  cycleId: string;
}) {
  const missing = QM_KINDS.filter((k) => !files[k.key]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="hf-lbl">Recognised files</span>
        <span className="hf-sub" style={{ fontSize: 11.5 }}>
          The three Questionmark CSVs, auto-detected by their columns and joined on{" "}
          <span className="hf-mono">ResultId</span>
          {sizeMB > 0 ? ` · ${sizeMB} MB total` : ""} · uploaded {uploadedAgo}
        </span>
      </div>

      <div className="hf-card" style={{ overflow: "hidden" }}>
        {QM_KINDS.map((k, i) => {
          const name = files[k.key];
          return (
            <div
              key={k.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "11px 14px",
                borderBottom: i < QM_KINDS.length - 1 ? `1px solid ${H.line}` : "none",
                background: name ? "transparent" : H.warnSoft,
              }}
            >
              <Mark kind={name ? "pass" : "warn"} size={16} />
              <span style={{ display: "flex", alignItems: "center", gap: 7, flex: "0 0 auto", minWidth: 116 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{k.label}</span>
                <span className="hf-sub" style={{ fontSize: 11 }}>{k.hint}</span>
              </span>
              <div style={{ flex: 1 }} />
              {name ? (
                <span className="hf-mono" style={{ fontSize: 11, color: H.ink2 }}>{name}</span>
              ) : (
                <span className="hf-mono" style={{ fontSize: 11, color: H.warn }}>missing / unrecognised</span>
              )}
            </div>
          );
        })}
      </div>

      {missing.length > 0 && (
        <div style={{ display: "flex", gap: 10, padding: "10px 14px", borderRadius: 10, background: H.warnSoft, alignItems: "center" }}>
          <Mark kind="warn" size={15} />
          <span style={{ fontSize: 12, color: H.ink, flex: 1 }}>
            {missing.map((k) => k.label).join(", ")} {missing.length === 1 ? "was" : "were"} not recognised in this upload. Re-upload all
            three CSVs together so each can be detected by its columns.
          </span>
        </div>
      )}

      <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
        <RawExportUploader cycleId={cycleId} label="Replace files" variant="ghost" />
      </div>
    </div>
  );
}

/** Empty-state for the raw export card before anything is ingested. The three
 *  Questionmark CSVs are the required input; uploading them joins on ResultId,
 *  splits the subjects, persists the canonical model, validates, and starts the
 *  pipeline. */
function ExportEmpty({ cycleId }: { cycleId: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="hf-sub" style={{ fontSize: 12, maxWidth: 640 }}>
        Upload the <b style={{ color: H.ink }}>three Questionmark CSVs</b> — Items, Assessments and Topics — together
        (drag all three, or multi-select). We auto-detect each by its header columns, join them on{" "}
        <span className="hf-mono">ResultId</span>, split the subjects, persist the model, and run validation
        automatically. No file is required for the optional essay-marks and incident-log steps below.
      </div>
      <RawExportUploader cycleId={cycleId} label="Upload the three QM CSVs" variant="pri" />
    </div>
  );
}

/**
 * Upload + ingest the three Questionmark CSVs (Items, Assessments, Topics).
 * Auto-detects each file by its header signature (not its filename), joins them
 * on ResultId to build the canonical model + cleaned engine responses in the
 * browser (reusing lib/ingest), then hands both to the provider, which persists
 * the richer model to Supabase (live) or rebuilds it in memory (demo). Used for
 * both the first upload and "Replace files".
 */
function RawExportUploader({ cycleId, label, variant }: { cycleId: string; label: string; variant: "pri" | "ghost" }) {
  const provider = useProvider();
  // The sitting's year and period, to check the file against (absent on demo/legacy sittings).
  const target = useProviderData(
    (p) => {
      const c = p.listCycles().find((x) => x.id === cycleId);
      return c ? { yearName: c.yearName, sitting: c.sitting } : null;
    },
    [cycleId],
  );
  const fileRef = useRef<HTMLInputElement>(null);
  // Explicit, visible stages: idle → uploading (read/parse) → ingesting
  // (persist + split) → done / failed. The status line names the active one.
  const [stage, setStage] = useState<UploadStage>("idle");
  const [error, setError] = useState<string | null>(null);
  // A parsed file held because it does not look like it belongs to this sitting; nothing has
  // been sent to the server. Confirming persists it; cancelling drops it.
  const [held, setHeld] = useState<{
    parsed: ReturnType<typeof ingestThreeExports>;
    report: SittingMatchReport;
    fileName: string;
    sizeMB: number;
  } | null>(null);
  const busy = stage === "uploading" || stage === "ingesting";

  const fail = (msg: string) => {
    setError(msg);
    setStage("failed");
  };

  /** Persist an already-parsed export (the server split + store). */
  const persist = async (parsed: ReturnType<typeof ingestThreeExports>, sizeMB: number) => {
    const { canonical, cleanedResponses, validationReport, sources } = parsed;
    setStage("ingesting");
    // `sources` is the REAL recognition (by columns) of which uploaded file became
    // which export — not a filename guess. Persisted for the audit trail + the
    // per-file recognition display.
    await provider.ingestRawExport(
      cycleId,
      { name: sources.assessments, sizeMB },
      cleanedResponses,
      validationReport,
      { canonical, files: sources },
    );
    setStage("done");
  };

  const confirmHeld = async () => {
    if (!held) return;
    const { parsed, sizeMB } = held;
    setHeld(null);
    setError(null);
    try {
      await persist(parsed, sizeMB);
    } catch (e) {
      fail(e instanceof Error ? e.message : "Couldn’t upload that file.");
    }
  };

  const cancelHeld = () => {
    setHeld(null);
    setError(null);
    setStage("idle");
  };

  const onFiles = async (fileList: FileList | null) => {
    const files = fileList ? [...fileList] : [];
    if (files.length === 0) return;
    setError(null);
    setHeld(null);
    setStage("uploading");
    try {
      // Read every dropped file; detection sorts out which is which by columns.
      const named = await Promise.all(
        files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })),
      );
      const parsed = ingestThreeExports(named);
      if (parsed.cleanedResponses.length === 0) {
        fail("No scored responses after cleaning. Check these are the graded G12++ exports (not just surveys).");
        return;
      }
      const totalBytes = files.reduce((n, f) => n + f.size, 0);
      const sizeMB = Math.round((totalBytes / (1024 * 1024)) * 10) / 10;
      // Does the export say it is another year / period than this sitting? If so hold it —
      // nothing is sent — until the user confirms. A match, or an export with nothing to
      // compare (no tag, no dates), goes straight on.
      const report = compareExportToSitting(parsed.canonical, target);
      if (planUpload(report) === "confirm") {
        setHeld({ parsed, report, fileName: parsed.sources.assessments, sizeMB });
        setStage("confirm");
        return;
      }
      // Browser parse/join/clean done; the server persist + split is the next stage.
      await persist(parsed, sizeMB);
    } catch (e) {
      if (e instanceof DetectionError) {
        fail(e.message);
      } else {
        fail(e instanceof Error ? e.message : "Couldn’t read those files. Use the three Questionmark CSV exports.");
      }
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // After a failure the control returns to a clearly retryable state: the primary
  // upload button becomes "Try again"; "Replace files" already reads as retryable.
  // The in-flight stage names itself in the single UploadStatusLine indicator (one
  // spinner, one label), so the button no longer carries its own busy label/spinner.
  const buttonLabel = stage === "failed" && variant === "pri" ? "Try again" : label;

  return (
    <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
      <input
        ref={fileRef}
        type="file"
        accept=".csv"
        multiple
        style={{ display: "none" }}
        onChange={(e) => onFiles(e.target.files)}
      />
      <UploadButton busy={busy} label={buttonLabel} variant={variant} onClick={() => fileRef.current?.click()} />
      <UploadStatusLine stage={stage} error={error} />
      {held && (
        <UploadMismatchWarning
          report={held.report}
          fileName={held.fileName}
          busy={busy}
          onConfirm={() => void confirmHeld()}
          onCancel={cancelHeld}
        />
      )}
    </div>
  );
}

function labelFor(s: DuplicateStrategy): string {
  return s === "keep_latest" ? "Keep latest" : s === "keep_first" ? "Keep first" : "Exclude students";
}
