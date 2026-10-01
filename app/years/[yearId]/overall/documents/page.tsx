"use client";

/**
 * Overall certificates & reports — document generation from the year's Overall
 * (best-of-two) result, NOT a single sitting. Certificates issue from Overall, so
 * this page reads `getOverallDocuments(yearId)` (the rolled-up best-of-two awards)
 * and feeds the same in-browser PPTX generator the per-sitting documents screen
 * uses. Available once the Overall is signed off (both sittings locked).
 *
 * Issuance gate: certificates have two export modes —
 *  - DRAFT proofs: watermarked, always available once the Overall is locked.
 *  - OFFICIAL issue: real certificates, blocked until G12 signs off the two open
 *    methodology decisions (O1 = D3 cap per-exam vs aggregate; O2 = CGJ PLD→award
 *    mapping) AND the operator explicitly confirms on this screen. Real issuance
 *    is never silently enabled — see `IssuanceSignOff` in the documents model.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useProvider, useProviderData } from "@/lib/data/context";
import { H } from "@/lib/ui/tokens";
import { Shell } from "@/components/shell/Shell";
import { Button, Card, Badge, Check } from "@/components/ui/primitives";
import { Icon, Mark } from "@/components/ui/icons";
import { getDocumentGenerator } from "@/lib/documents/generator";
import type { DocKind, GenerateResult } from "@/lib/documents/types";
import type { IssuanceSignOff, IssuanceReadiness } from "@/lib/data/types";
import { BatchPreview, CertificateProof, ReportProof, studentIssues } from "@/components/documents/BatchPreview";
import { can } from "@/lib/auth/actions";

type IssueMode = "draft" | "official";

const KINDS: DocKind[] = ["certificate", "report"];
const KIND_LABEL: Record<DocKind, string> = {
  certificate: "Certificates",
  report: "Performance reports",
  unofficial: "Unofficial reports",
};

export default function OverallDocumentsPage({ params }: { params: { yearId: string } }) {
  const yearId = params.yearId;
  const provider = useProvider();
  const year = useProviderData((p) => p.getYear(yearId), [yearId]);
  const model = useProviderData((p) => p.getOverallDocuments(yearId), [yearId]);

  const [selected, setSelected] = useState<Set<DocKind>>(() => new Set<DocKind>(["certificate"]));
  const [step, setStep] = useState<"config" | "generating" | "results">("config");
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBatch, setShowBatch] = useState(false);
  const [issueMode, setIssueMode] = useState<IssueMode>("draft");
  // Explicit operator confirmation, required before any official (non-draft) run.
  const [officialConfirmed, setOfficialConfirmed] = useState(false);

  const kinds: DocKind[] = useMemo(() => KINDS.filter((k) => selected.has(k)), [selected]);
  const toggleKind = (k: DocKind) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      if (next.size === 0) next.add(k);
      return next;
    });

  const crumb = [
    { label: "Years", href: "/" },
    { label: year?.name ?? "Year", href: `/years/${yearId}` },
    { label: "Overall", href: `/years/${yearId}/overall` },
    { label: "Certificates" },
  ];

  if (!model) {
    return (
      <Shell active="Cycles" crumb={crumb}>
        <div style={{ padding: 32 }} className="hf-sub">No Overall results for this year.</div>
      </Shell>
    );
  }

  const first = model.students[0];
  const flaggedCount = model.students.filter((s) => studentIssues(s, kinds).length).length;

  // Issuance gate (P5). Draft/preview is ALWAYS allowed — even on provisional or
  // synthetic data — so staff can inspect proofs. OFFICIAL issue needs every hard
  // gate met (scores reconciled, sittings locked, O1/O2 signed off, real data) AND
  // the operator's explicit tick.
  const signOff: IssuanceSignOff | undefined = model.signOff;
  const readiness: IssuanceReadiness | undefined = model.readiness;
  const officialAllowed = readiness?.officialAllowed ?? false;
  const draft = issueMode === "draft";
  // Awards gate (migration 0040): generating Overall Award documents — draft proofs
  // included — now requires `awards.generate`, which the default seed grants to Admin.
  const canGenerate = can(provider.getCurrentUser().role, "awards.generate");
  // Nothing to export until the Overall is available (both sittings locked + loaded).
  const canExport = canGenerate && model.students.length > 0 && (draft || (officialAllowed && officialConfirmed));

  const doGenerate = async () => {
    if (!canExport) return;
    setError(null);
    setStep("generating");
    try {
      const res = await getDocumentGenerator().generate({
        cycleId: model.cycleId,
        kinds,
        students: model.students,
        settings: model.settings,
        templates: {},
        draft,
      });
      setResult(res);
      setStep("results");
      if (res.zipUrl) {
        const a = document.createElement("a");
        a.href = res.zipUrl;
        a.download = res.zipName ?? "overall_documents.zip";
        a.click();
      }
      const total = Object.values(res.kinds).reduce((s, k) => s + (k?.complete ?? 0), 0);
      const tag = draft ? "DRAFT proof" : "OFFICIAL issue (all pre-issue gates passed)";
      provider.recordDocuments(model.cycleId, `${tag}: ${total} Overall .pptx across ${kinds.join(" + ")} (zip)`);
    } catch (e) {
      setError((e as Error).message);
      setStep("config");
    }
  };

  return (
    <Shell active="Cycles" crumb={crumb}>
      <div style={{ display: "flex", flexDirection: "column", padding: "26px 32px", gap: 20, flex: 1, minHeight: 0, overflow: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div className="hf-h1">{model.settings.cycleName} · Certificates &amp; reports</div>
          {officialAllowed ? (
            <Badge tone="good"><Mark kind="pass" size={12} /> Ready to issue</Badge>
          ) : (
            <Badge tone="warn"><Mark kind="warn" size={12} /> Draft / preview only</Badge>
          )}
        </div>
        <div className="hf-sub" style={{ maxWidth: 720 }}>
          Certificates &amp; performance reports for the <strong>Overall best-of-two awards</strong> ({model.students.length} students) — each carries the higher award across the two sittings (with Feb/May provenance), not a single sitting’s result. Fills the built-in PowerPoint templates and downloads one .pptx per student in a .zip.
        </div>

        {error && (
          <Card style={{ padding: "12px 15px", background: H.badSoft, borderColor: H.bad, display: "flex", gap: 10, alignItems: "flex-start" }}>
            <Mark kind="fail" size={16} />
            <span style={{ fontSize: 12.5, color: H.bad, wordBreak: "break-word" }}>{error}</span>
          </Card>
        )}

        {step === "results" && result ? (
          <ResultsView result={result} total={model.students.length} onBack={() => setStep("config")} />
        ) : (
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, flex: "1 1 360px", minWidth: 320 }}>
              <div>
                <div className="hf-lbl" style={{ marginBottom: 10 }}>Document type</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {KINDS.map((k) => (
                    <button
                      key={k}
                      onClick={() => toggleKind(k)}
                      style={{
                        padding: "8px 16px", borderRadius: 8,
                        border: `1px solid ${selected.has(k) ? H.pink : H.line2}`,
                        background: selected.has(k) ? H.pinkSoft : H.paper,
                        color: selected.has(k) ? H.pink : H.ink2,
                        fontWeight: selected.has(k) ? 700 : 600, fontSize: 12.5, cursor: "pointer",
                        display: "inline-flex", alignItems: "center", gap: 6,
                      }}
                    >
                      {selected.has(k) && <Mark kind="pass" size={12} />}
                      {KIND_LABEL[k]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="hf-lbl" style={{ marginBottom: 10 }}>Issue mode</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {([
                    { mode: "draft" as IssueMode, label: "Draft proof", hint: "Watermarked — safe to circulate" },
                    { mode: "official" as IssueMode, label: "Official issue", hint: "Real certificates" },
                  ]).map(({ mode, label, hint }) => {
                    const on = issueMode === mode;
                    return (
                      <button
                        key={mode}
                        onClick={() => setIssueMode(mode)}
                        title={hint}
                        style={{
                          padding: "8px 16px", borderRadius: 8,
                          border: `1px solid ${on ? H.pink : H.line2}`,
                          background: on ? H.pinkSoft : H.paper,
                          color: on ? H.pink : H.ink2,
                          fontWeight: on ? 700 : 600, fontSize: 12.5, cursor: "pointer",
                          display: "inline-flex", alignItems: "center", gap: 6,
                        }}
                      >
                        {on && <Mark kind="pass" size={12} />}
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <IssuanceChecklist
                readiness={readiness}
                signOff={signOff}
                mode={issueMode}
                confirmed={officialConfirmed}
                onToggleConfirm={() => setOfficialConfirmed((v) => !v)}
              />

              {flaggedCount > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, color: H.warn, fontWeight: 700 }}>
                  <Mark kind="warn" size={13} /> {flaggedCount} student{flaggedCount === 1 ? "" : "s"} with content issues — check before generating
                </div>
              )}

              <div style={{ display: "flex", gap: 10 }}>
                <Button variant="pri" disabled={step === "generating" || !canExport} onClick={doGenerate}>
                  <Icon name={draft ? "doc" : "award"} color="#fff" />
                  {step === "generating"
                    ? "Generating…"
                    : draft
                      ? `Export ${model.students.length} draft proof${model.students.length === 1 ? "" : "s"}`
                      : `Issue ${model.students.length} certificate${model.students.length === 1 ? "" : "s"}`}
                </Button>
                <Button onClick={() => setShowBatch(true)} disabled={!model.students.length}>
                  <Icon name="search" />
                  Preview &amp; verify
                </Button>
              </div>
              {!canGenerate && (
                <div className="hf-sub" style={{ fontSize: 11, color: H.ink3 }}>
                  You need the “Generate certificates / reports” permission to produce Overall Award documents.
                </div>
              )}
              {canGenerate && !draft && !canExport && (
                <div className="hf-sub" style={{ fontSize: 11, color: H.ink3 }}>
                  {officialAllowed
                    ? "Tick the confirmation above to issue official documents."
                    : `Official issue is blocked — ${readiness?.blockedReason ?? "a pre-issue gate is unmet"}. Export draft proofs in the meantime.`}
                </div>
              )}
            </div>

            <Card style={{ flex: "0 1 320px", minWidth: 280, padding: 16, display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
              <span className="hf-lbl" style={{ alignSelf: "flex-start" }}>Preview · first student</span>
              {first && kinds.includes("certificate") && <CertificateProof student={first} settings={model.settings} scale={300 / 1122} />}
              {first && kinds.includes("report") && <ReportProof student={first} settings={model.settings} scale={232 / 1080} />}
              <div className="hf-sub" style={{ fontSize: 11, textAlign: "center" }}>
                {first ? `${first.name} · ${first.award}` : "No students"}
              </div>
            </Card>
          </div>
        )}

        <div>
          <Link href={`/years/${yearId}/overall`} style={{ color: H.pink, fontSize: 13 }}>
            ‹ Back to Overall
          </Link>
        </div>
      </div>

      {showBatch && (
        <BatchPreview students={model.students} settings={model.settings} kinds={kinds} onClose={() => setShowBatch(false)} />
      )}
    </Shell>
  );
}

/**
 * Pre-issue checklist (P5). Lists every hard issuance gate — upstream scores
 * verified, all sittings locked, O1/O2 signed off, and real (non-synthetic) data —
 * with a met/unmet mark and a reason. The O1/O2 methodology decisions nest under
 * the sign-off gate. In official mode it carries the explicit confirmation tick
 * (enabled only when every gate is met); draft/preview ignores all of this.
 */
function IssuanceChecklist({
  readiness,
  signOff,
  mode,
  confirmed,
  onToggleConfirm,
}: {
  readiness?: IssuanceReadiness;
  signOff?: IssuanceSignOff;
  mode: IssueMode;
  confirmed: boolean;
  onToggleConfirm: () => void;
}) {
  if (!readiness) return null;
  const allowed = readiness.officialAllowed;
  const official = mode === "official";
  const metCount = readiness.gates.filter((g) => g.met).length;
  return (
    <Card style={{ padding: "14px 16px", background: allowed ? H.goodSoft : H.warnSoft, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <Mark kind={allowed ? "pass" : "warn"} size={16} />
        <div style={{ fontWeight: 700, fontSize: 13 }}>
          {allowed ? "Cleared for official issue" : "Pre-issue checklist"}
        </div>
        <div style={{ flex: 1 }} />
        <Badge tone={allowed ? "good" : "warn"}>{metCount}/{readiness.gates.length} ready</Badge>
      </div>
      <div className="hf-sub" style={{ fontSize: 11.5 }}>
        Official issue requires every gate below. Until then, draft proofs are watermarked <strong>{`“DRAFT — NOT FOR ISSUE”`}</strong> and stay safe to circulate.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {readiness.gates.map((g) => (
          <div key={g.id} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
            <Mark kind={g.met ? "pass" : "warn"} size={14} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: g.met ? H.ink : H.warn }}>{g.label}</div>
              <div className="hf-sub" style={{ fontSize: 11 }}>{g.detail}</div>
              {/* The O1/O2 methodology decisions nest under the sign-off gate. */}
              {g.id === "signoff" && signOff && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 5 }}>
                  {signOff.decisions.map((d) => (
                    <div key={d.id} style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 11 }}>
                      <span className="hf-mono" style={{ color: H.ink3 }}>{d.id}</span>
                      <span style={{ fontWeight: 600 }}>{d.title}</span>
                      <span style={{ color: d.confirmed ? H.good : H.warn, fontWeight: 600 }}>
                        {d.confirmed ? "signed off" : "awaiting sign-off"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {!allowed ? (
        // Surfaced in BOTH modes so it's always clear why real issuance is unavailable.
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, fontWeight: 700, color: H.warn }}>
          <Icon name="lock" size={13} color={H.warn} />
          <span>Official issue is blocked — {readiness.blockedReason ?? "a pre-issue gate is unmet"}.</span>
        </div>
      ) : (
        official && (
          <button
            onClick={onToggleConfirm}
            style={{ display: "flex", gap: 9, alignItems: "center", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
          >
            <Check on={confirmed} />
            <span style={{ fontSize: 12, fontWeight: 600, color: H.ink }}>
              I confirm every gate is satisfied and these documents are for official issue.
            </span>
          </button>
        )
      )}
    </Card>
  );
}

function ResultsView({ result, total, onBack }: { result: GenerateResult; total: number; onBack: () => void }) {
  const kinds = Object.keys(result.kinds) as DocKind[];
  const statusOf = (s: (typeof result.perStudent)[number]) =>
    kinds.some((k) => s.results[k]?.status === "error") ? "failed" : "complete";
  const complete = result.perStudent.filter((s) => statusOf(s) === "complete").length;
  const failed = result.perStudent.length - complete;
  return (
    <Card style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>Generated {complete} of {total}</div>
        {failed > 0 && <span style={{ color: H.bad, fontWeight: 700 }}>{failed} failed</span>}
        <div style={{ flex: 1 }} />
        {result.zipUrl && (
          <a href={result.zipUrl} download={result.zipName ?? "overall_documents.zip"}>
            <Button variant="pri"><Icon name="download" color="#fff" />Download .zip</Button>
          </a>
        )}
        <Button onClick={onBack}>Start over</Button>
      </div>
      <div className="hf-sub" style={{ fontSize: 12 }}>
        One .pptx per student per type, bundled in the .zip — open and export to PDF to finalise.
      </div>
    </Card>
  );
}
