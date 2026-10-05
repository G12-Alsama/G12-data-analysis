"use client";

/**
 * Start a new sitting — choose its period (February / May) and year, name it, set
 * the date, pick the assessments. The period and year are explicit choices stored
 * on the sitting; they are never inferred from its name. Creating a sitting is
 * metadata only; the three Questionmark CSVs are uploaded later at the
 * pipeline's first step (Upload). "Create sitting" persists through the
 * DataProvider (a real Supabase write when running live), then navigates to the
 * new sitting by its real id.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useProvider, useProviderData } from "@/lib/data/context";
import { H } from "@/lib/ui/tokens";
import { Shell } from "@/components/shell/Shell";
import { Button, Card, Check, Chip } from "@/components/ui/primitives";
import { normalizeYearName, sittingLabel } from "@/lib/data/create-cycle";
import type { SittingKey } from "@/lib/data/types";

/** Sentinel for the "new year" choice in the year picker. */
const NEW_YEAR = "__new__";
const SITTINGS: SittingKey[] = ["february", "may"];

export default function NewCyclePage() {
  const router = useRouter();
  const provider = useProvider();
  const model = useProviderData((p) => p.getNewCycle());

  const [name, setName] = useState(model.defaultName);
  const [sittingDate, setSittingDate] = useState(model.sittingDate);
  const [testCentreId, setTestCentreId] = useState(model.defaultTestCentreId ?? "");
  const [sitting, setSitting] = useState<SittingKey>(model.defaultSitting);
  const firstYearOf = (centreId: string) => model.years.find((y) => y.testCentreId === centreId)?.examYearId ?? NEW_YEAR;
  const [yearChoice, setYearChoice] = useState<string>(() => firstYearOf(model.defaultTestCentreId ?? ""));
  const [newYearName, setNewYearName] = useState(() => (/^\d{4}/.exec(model.sittingDate)?.[0]) ?? "");
  // The name is a free-text label. Keep it in step with period + year until the user edits it.
  const [nameTouched, setNameTouched] = useState(false);
  const [included, setIncluded] = useState<Record<string, boolean>>(
    () => Object.fromEntries(model.assessments.map((a) => [a.id, a.included])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCount = useMemo(() => Object.values(included).filter(Boolean).length, [included]);

  const yearsHere = model.years.filter((y) => y.testCentreId === testCentreId);
  const chosenYear = yearChoice === NEW_YEAR ? null : yearsHere.find((y) => y.examYearId === yearChoice) ?? null;
  const typedYear = normalizeYearName(newYearName);
  const yearLabel = chosenYear ? chosenYear.name : typedYear ?? "";
  const yearValid = chosenYear !== null || typedYear !== null;
  const periodTaken = chosenYear?.takenSittings.includes(sitting) ?? false;

  const suggestName = (nextSitting: SittingKey, nextYear: string) =>
    `${sittingLabel(nextSitting)}${nextYear ? ` ${nextYear}` : ""}`;
  const pickSitting = (next: SittingKey) => {
    setSitting(next);
    if (!nameTouched) setName(suggestName(next, yearLabel));
  };
  const pickYear = (choice: string) => {
    setYearChoice(choice);
    const label = model.years.find((y) => y.examYearId === choice)?.name ?? typedYear ?? "";
    if (!nameTouched) setName(suggestName(sitting, label));
  };
  const pickCentre = (centreId: string) => {
    setTestCentreId(centreId);
    const next = firstYearOf(centreId);
    setYearChoice(next);
    const label = model.years.find((y) => y.examYearId === next)?.name ?? typedYear ?? "";
    if (!nameTouched) setName(suggestName(sitting, label));
  };

  const create = async () => {
    if (busy || !testCentreId || !yearValid || periodTaken) return;
    setBusy(true);
    setError(null);
    try {
      const assessmentIds = model.assessments.filter((a) => included[a.id]).map((a) => a.id);
      const cycleId = await provider.createCycle({
        name,
        sittingDate,
        assessmentIds,
        testCentreId,
        sitting,
        ...(chosenYear ? { examYearId: chosenYear.examYearId } : { yearName: typedYear ?? "" }),
      });
      router.push(`/cycles/${cycleId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the sitting. Please try again.");
      setBusy(false);
    }
  };

  return (
    <Shell
      active="Cycles"
      crumb={[{ label: "Sittings", href: "/" }, { label: "New sitting" }]}
      actions={
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="ghost" onClick={() => router.push("/")} disabled={busy}>Cancel</Button>
          <Button variant="pri" disabled={busy || selectedCount === 0 || !name.trim() || !testCentreId || !yearValid || periodTaken} onClick={create}>
            {busy ? "Creating…" : "Create sitting"}
          </Button>
        </div>
      }
    >
      <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "flex-start", overflow: "auto" }}>
        <div style={{ display: "flex", flexDirection: "column", width: 760, padding: "30px 24px", gap: 24 }}>
          <div>
            <div className="hf-h1">Start a new sitting</div>
            <div className="hf-sub" style={{ marginTop: 7 }}>
              A sitting is one exam event — choose its period and year, name it, set the date, pick the assessments.
            </div>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <span className="hf-lbl">Test centre</span>
            {model.testCentres.length === 0 ? (
              <span className="hf-sub" style={{ fontSize: 12 }}>
                No active test centres. Create one in <strong>Settings › Test centres</strong> before starting a sitting.
              </span>
            ) : (
              <span className="hf-field" style={{ padding: 0, overflow: "hidden" }}>
                <select
                  value={testCentreId}
                  onChange={(e) => pickCentre(e.target.value)}
                  aria-label="Test centre"
                  style={{ border: "none", outline: "none", background: "transparent", flex: 1, fontSize: 12.5, fontFamily: "inherit", color: H.ink, fontWeight: 600, padding: "0 12px", cursor: "pointer" }}
                >
                  {model.testCentres.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} · {c.code}</option>
                  ))}
                </select>
              </span>
            )}
            <span className="hf-sub" style={{ fontSize: 11.5 }}>
              The sitting and its exam year are created under this centre. Cycles and sittings are scoped per centre.
            </span>
          </label>

          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <span className="hf-lbl">Period</span>
              <span role="radiogroup" aria-label="Period" style={{ display: "flex", gap: 8 }}>
                {SITTINGS.map((k) => (
                  <Chip key={k} on={sitting === k} onClick={() => pickSitting(k)}>{sittingLabel(k)}</Chip>
                ))}
              </span>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 7, flex: 1 }}>
              <span className="hf-lbl">Year</span>
              <span style={{ display: "flex", gap: 8 }}>
                <span className="hf-field" style={{ padding: 0, overflow: "hidden", flex: 1 }}>
                  <select
                    value={yearChoice}
                    onChange={(e) => pickYear(e.target.value)}
                    aria-label="Year"
                    style={{ border: "none", outline: "none", background: "transparent", flex: 1, fontSize: 12.5, fontFamily: "inherit", color: H.ink, fontWeight: 600, padding: "0 12px", cursor: "pointer" }}
                  >
                    {yearsHere.map((y) => (
                      <option key={y.examYearId} value={y.examYearId}>{y.name}</option>
                    ))}
                    <option value={NEW_YEAR}>New year…</option>
                  </select>
                </span>
                {yearChoice === NEW_YEAR && (
                  <input
                    className="hf-field"
                    value={newYearName}
                    onChange={(e) => {
                      setNewYearName(e.target.value);
                      const y = normalizeYearName(e.target.value) ?? "";
                      if (!nameTouched) setName(suggestName(sitting, y));
                    }}
                    placeholder="2027"
                    inputMode="numeric"
                    maxLength={4}
                    aria-label="New year"
                    style={{ width: 84, color: H.ink, fontWeight: 600, fontFamily: "inherit" }}
                  />
                )}
              </span>
            </label>
          </div>
          {periodTaken && (
            <div role="alert" style={{ padding: "10px 13px", borderRadius: 8, background: "#3a1d1d", color: "#f3b4b4", fontSize: 12.5 }}>
              A {sittingLabel(sitting)} sitting already exists for {chosenYear?.name} at this centre. Choose the other period or a different year.
            </div>
          )}
          {yearChoice === NEW_YEAR && !typedYear && (
            <div className="hf-sub" style={{ fontSize: 11.5, marginTop: -12 }}>Enter a 4-digit year, e.g. 2027.</div>
          )}

          <div style={{ display: "flex", gap: 16 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 7, flex: 1 }}>
              <span className="hf-lbl">Sitting name</span>
              <input
                className="hf-field"
                value={name}
                onChange={(e) => { setNameTouched(true); setName(e.target.value); }}
                style={{ color: H.ink, fontWeight: 600, fontFamily: "inherit" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 7, width: 220 }}>
              <span className="hf-lbl">Sitting date</span>
              {/* Native date input — its built-in calendar is the picker trigger, so
                  the date can be changed and is submitted with the sitting (it flows
                  through createCycle → create_cycle_with_assessments → sitting_date). */}
              <span className="hf-field" style={{ justifyContent: "space-between" }}>
                <input
                  type="date"
                  value={sittingDate}
                  onChange={(e) => setSittingDate(e.target.value)}
                  aria-label="Sitting date"
                  style={{ border: "none", outline: "none", background: "transparent", flex: 1, fontSize: 12.5, fontFamily: "inherit", color: H.ink, colorScheme: "dark" }}
                />
              </span>
            </label>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <span className="hf-lbl">Assessments in this sitting</span>
              <span className="hf-sub" style={{ fontSize: 11.5 }}>{selectedCount} of {model.assessments.length} selected</span>
            </div>
            <Card style={{ overflow: "hidden" }}>
              {model.assessments.map((a, i) => {
                const on = included[a.id] ?? false;
                return (
                  <div
                    key={a.id}
                    style={{ display: "flex", alignItems: "center", padding: "13px 16px", gap: 13, borderBottom: i < model.assessments.length - 1 ? `1px solid ${H.line}` : "none", opacity: on ? 1 : 0.55 }}
                  >
                    <Check on={on} onClick={() => setIncluded((s) => ({ ...s, [a.id]: !on }))} />
                    <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>
                      {a.name}
                    </span>
                    <span className="hf-sub" style={{ fontSize: 12 }}>{on ? "Included" : "Not included"}</span>
                  </div>
                );
              })}
            </Card>
            <div className="hf-sub" style={{ fontSize: 12, marginTop: 10 }}>
              After you create the sitting you land in the pipeline, where the first step (Upload) takes the three Questionmark CSVs and splits them into subjects.
            </div>
            {error && (
              <div style={{ marginTop: 12, padding: "10px 13px", borderRadius: 8, background: "#3a1d1d", color: "#f3b4b4", fontSize: 12.5 }}>
                {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}
