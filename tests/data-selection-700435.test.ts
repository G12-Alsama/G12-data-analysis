/**
 * Data selection & aggregation — sitting 700435 (P1 regression gate).
 *
 * Pins the published oracles for the de-identified 700435 fixture
 * (`tests/fixtures/qm/*.csv`), driving the REAL pipeline end-to-end:
 *   ingest (3-CSV) → buildLiveCycleData → InMemoryDataProvider (Score / Grades /
 *   Raw scores) — the same path the app runs.
 *
 * Covers the five root causes from the brief:
 *   A. The "Applicable Maths" re-sit form is NOT merged into Applicable Math
 *      (41 MCQ items, not 85; denominator is the un-merged scored max, not /83).
 *   B. Staff (lavinia / student15) + test (muamina / student16) accounts are
 *      excluded via the authoritative cohort-exclusion action (no hardcoded email).
 *   C. That exclusion propagates to Raw scores, Score and Grades from one source.
 *   D. All 15 Math students survive aggregation with correct raw scores
 *      (no participant collapse; the per-subject unique-key invariant holds).
 *   E. Surveys + non-MCQ rows reach no subject's scored set or denominator.
 *
 * Note on the denominator: the brief quotes "41 / 40.3%" (counting the 41 items).
 * The de-identified fixture carries one synthetic max-0 stimulus item per MCQ
 * subject, which the engine correctly excludes from the scored max (documented
 * behaviour) — so the fixture's Math scored max is 40 and the cohort average is
 * 41.3%. The grade-bearing facts (no merge, all 15 present, exact raw scores,
 * exclusions) match the oracle exactly; the 1-mark difference is the max-0
 * stimulus, NOT the /83 merge bug.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ingestThreeExports, type NamedInput } from "@/lib/ingest/qm";
import { buildLiveCycleData } from "@/lib/data/build-live-cycle";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { ENGINE_VERSION } from "@/lib/engine";
import type { Seed } from "@/lib/data/seed-types";

const here = path.dirname(fileURLToPath(import.meta.url));
const qmDir = path.join(here, "fixtures", "qm");
const read = (name: string) => readFileSync(path.join(qmDir, `${name}.csv`));
const files = (): NamedInput[] => [
  { name: "Items.csv", data: read("Items") },
  { name: "Assessments.csv", data: read("Assessments") },
  { name: "Topics.csv", data: read("Topics") },
];

// The two non-real accounts in the 700435 roster (de-identified):
const LAVINIA = "student15@example.edu"; // G12 Lead — English only (staff)
const MUAMINA = "student16@example.edu"; // re-sit/test — Applicable Maths att2 + Life Skills

const CYCLE = "live";

function buildProvider(excludeStaffTest: boolean) {
  const { cleanedResponses, validationReport, canonical } = ingestThreeExports(files());
  const built = buildLiveCycleData(cleanedResponses);
  const seed: Seed = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    engineVersion: ENGINE_VERSION,
    liveCycle: {
      id: CYCLE,
      name: "Sitting 700435",
      region: "EU",
      startedAt: "x",
      lastActivity: "x",
      stageIndex: 1,
      fileName: "qm",
      fileSizeMB: 1,
      uploadedAgo: "now",
      validation: validationReport,
      preview: built.preview,
      duplicates: 0,
      participants: built.participants,
      assessments: built.assessments,
      diagnostics: built.diagnostics,
    },
    priorCycles: [],
  };
  const p = new InMemoryDataProvider(seed);
  const idOf = (email: string) => built.participants.find((x) => x.studentId === email)!.id;
  if (excludeStaffTest) {
    p.excludeParticipantFromCohort(CYCLE, idOf(LAVINIA), true, "G12 Lead (staff account)");
    p.excludeParticipantFromCohort(CYCLE, idOf(MUAMINA), true, "Re-sit / test account");
  }
  const assessmentByName = (re: RegExp) => built.assessments.find((a) => re.test(a.name))!.id;
  return { p, built, idOf, canonical, validationReport, assessmentByName };
}

describe("sitting 700435 — data selection & aggregation", () => {
  // ── A. the re-sit form is not merged ──────────────────────────────────────
  it("A. surfaces the 'Applicable Maths' re-sit and holds it out of the graded set", () => {
    const { canonical, built } = buildProvider(false);
    expect(canonical.resitForms).toHaveLength(1);
    expect(canonical.resitForms[0]).toMatchObject({
      name: "G12++ Applicable Maths",
      baseName: "G12++ Applicable Math",
    });
    // Exactly five GRADED subjects are built (re-sit quarantined).
    expect(built.assessments).toHaveLength(5);
    expect(built.assessments.some((a) => a.name === "G12++ Applicable Maths")).toBe(false);
    // Applicable Math = 41 MCQ items (NOT 85), with one max-0 stimulus excluded
    // from the scored max ⇒ scored max 40, never the merged /83.
    const math = built.assessments.find((a) => a.name === "G12++ Applicable Math")!;
    expect(math.items).toHaveLength(41);
    const scoredMax = math.items.reduce((s, it) => s + (it.maxScore >= 1 ? it.maxScore : 0), 0);
    expect(scoredMax).toBe(40);
    expect(scoredMax).not.toBe(83);
  });

  // ── per-subject counts (after staff/test exclusion) ───────────────────────
  it("yields 16 real students and per-subject participant counts 15/12/11/10/9", () => {
    const { p, built } = buildProvider(true);
    expect(p.getCycle(CYCLE)!.participants).toBe(16);
    expect(p.getGrades(CYCLE)!.rows).toHaveLength(16);

    const count = (re: RegExp) => {
      const id = built.assessments.find((a) => re.test(a.name))!.id;
      return p.getNaiveScores(CYCLE, id)!.students.length;
    };
    expect(count(/Applicable Math$/)).toBe(15);
    expect(count(/Scientific/)).toBe(12);
    expect(count(/English/)).toBe(11);
    expect(count(/Life/)).toBe(10);
    expect(count(/العربيّة/)).toBe(9);
  });

  it("per-subject MCQ item counts are 41/36/63/25/31", () => {
    const { built } = buildProvider(true);
    const items = (re: RegExp) => built.assessments.find((a) => re.test(a.name))!.items.length;
    expect(items(/Applicable Math$/)).toBe(41);
    expect(items(/Scientific/)).toBe(36);
    expect(items(/English/)).toBe(63);
    expect(items(/Life/)).toBe(25);
    expect(items(/العربيّة/)).toBe(31);
  });

  // ── D. all 15 Math students present with correct raw scores ───────────────
  it("D. all 15 Applicable Math students survive with the exact oracle raw scores", () => {
    const { p, assessmentByName } = buildProvider(true);
    const mathId = assessmentByName(/Applicable Math$/);
    const comp = p.getComposition(CYCLE)!;
    const math = comp.students
      .map((s) => s.subjects.find((su) => su.assessmentId === mathId))
      .filter((su): su is NonNullable<typeof su> => !!su);
    expect(math).toHaveLength(15);
    const mcqSorted = math.map((s) => s.mcq).sort((a, b) => b - a);
    expect(mcqSorted).toEqual([24, 19, 19, 19, 17, 17, 17, 16, 16, 16, 16, 14, 14, 14, 10]);
    // The brief's "Louay = 14/41": three students score 14 here (de-identified).
    expect(math.filter((s) => s.mcq === 14)).toHaveLength(3);
    // Every Math cell is scored against the same un-merged max (not /83).
    for (const s of math) expect(s.max).toBe(40);
  });

  it("D. cohort average is the un-merged figure (~41.3%), never the merged ~17%", () => {
    const { p, assessmentByName } = buildProvider(true);
    const mathId = assessmentByName(/Applicable Math$/);
    const comp = p.getComposition(CYCLE)!;
    const math = comp.students
      .map((s) => s.subjects.find((su) => su.assessmentId === mathId))
      .filter((su): su is NonNullable<typeof su> => !!su);
    const avg = math.reduce((a, s) => a + s.pct, 0) / math.length;
    expect(avg).toBeGreaterThan(40);
    expect(avg).toBeLessThan(42);
    // Explicitly NOT the merged ~17% average (the /83 inflation).
    expect(avg).toBeGreaterThan(25);
  });

  // ── B + C. staff / test exclusion propagates from one source ──────────────
  it("B+C. lavinia and muamina are absent from Score, Grades and Raw scores", () => {
    const { p, idOf, assessmentByName } = buildProvider(true);
    const lavinia = idOf(LAVINIA);
    const muamina = idOf(MUAMINA);

    const grades = p.getGrades(CYCLE)!;
    expect(grades.rows.some((r) => r.id === lavinia)).toBe(false);
    expect(grades.rows.some((r) => r.id === muamina)).toBe(false);

    const comp = p.getComposition(CYCLE)!;
    expect(comp.students.some((s) => s.participantId === lavinia)).toBe(false);
    expect(comp.students.some((s) => s.participantId === muamina)).toBe(false);

    // muamina also sat a REAL subject (Life Success Skills) — exclusion must drop
    // her there too, not just from her re-sit form.
    const life = p.getNaiveScores(CYCLE, assessmentByName(/Life/))!;
    expect(life.students.some((s) => s.id === muamina)).toBe(false);
    const english = p.getNaiveScores(CYCLE, assessmentByName(/English/))!;
    expect(english.students.some((s) => s.id === lavinia)).toBe(false);
  });

  it("B+C. before exclusion all 18 appear; the exclusion is reversible", () => {
    const { p, idOf } = buildProvider(false);
    expect(p.getGrades(CYCLE)!.rows).toHaveLength(18);
    const lavinia = idOf(LAVINIA);
    p.excludeParticipantFromCohort(CYCLE, lavinia, true, "staff");
    expect(p.getGrades(CYCLE)!.rows).toHaveLength(17);
    p.excludeParticipantFromCohort(CYCLE, lavinia, false);
    expect(p.getGrades(CYCLE)!.rows).toHaveLength(18);
  });

  // ── E. surveys + non-MCQ excluded everywhere ──────────────────────────────
  it("E. no survey or non-MCQ row reaches any subject's scored set", () => {
    const { built, canonical } = buildProvider(true);
    expect(canonical.excludedSurveys.length).toBeGreaterThan(0);
    for (const a of built.assessments) {
      expect(/survey|user experience/i.test(a.name)).toBe(false);
      // Every built response is a scored MCQ answer (0/1); essays/Likert never enter.
      for (const r of a.responses) expect(Number.isFinite(r.s)).toBe(true);
    }
    // Engine matrix carries only Multiple Choice rows.
    const { cleanedResponses } = ingestThreeExports(files());
    for (const r of cleanedResponses) expect(r.questionType).toBe("Multiple Choice");
  });

  // ── F. getCleanedData excludes the max-0 stimulus item from exported rows ──
  it("F. the Applicable Math max-0 stimulus item never appears as a row in getCleanedData", () => {
    const { p, built, assessmentByName } = buildProvider(true);
    const mathId = assessmentByName(/Applicable Math$/);
    const math = built.assessments.find((a) => a.id === mathId)!;
    const stimulusItem = math.items.find((it) => (it.maxScore ?? 1) < 1)!;
    expect(stimulusItem).toBeTruthy();

    const cleaned = p.getCleanedData(CYCLE, mathId)!;
    const qIdx = cleaned.headers.indexOf("QuestionId");
    const maxIdx = cleaned.headers.indexOf("QuestionMaximumScore");
    expect(cleaned.rows.some((r) => r[qIdx] === stimulusItem.id)).toBe(false);
    for (const r of cleaned.rows) expect(Number(r[maxIdx])).toBeGreaterThanOrEqual(1);
  });
});
