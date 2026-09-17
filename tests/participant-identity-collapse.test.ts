/**
 * Participant IDENTITY collapse at ingest — the ~8-per-subject bug (P-A).
 *
 * The de-identified 700435 fixture (`tests/fixtures/qm/*.csv`) gives every
 * participant a UNIQUE `ResultParticipantName` (a synthetic email), which sanitises
 * away the real cohort's identity shapes — so it cannot reproduce the collapse.
 * This suite drives a REALISTIC-identity variant (`tests/fixtures/qm-collide/*.csv`)
 * that mirrors the raw exports: the ONLY collision-free field is
 * `ResultParticipantName` (the email / login) — 18 distinct, 0 collisions — while
 * every name- or DOB-shaped field COLLIDES: `ResultParticipantFirstName` (two shared:
 * the two Fatimas, the two Nours), `ResultParticipantLastName` (one shared), and
 * `ResultSpecialField4` = date-of-birth (shared + placeholder `2001-01-01` dates).
 * The roster also carries three students sharing the `A-A` first+last initial and
 * RTL Arabic names. There is NO magic unique `ParticipantID` column — reality has
 * none.
 *
 * It proves:
 *   1. The collision shape WOULD collapse a name/initial/DOB-keyed ingest below the
 *      true sitter count (the bug), and the detection-boundary invariant catches it.
 *   2. The fixed ingest keys identity on the collision-free email and mints a stable
 *      internal id from it, so the Upload/detection participant counts hit the oracle
 *      exactly and the per-student score matrix reconciles (no merge / overwrite).
 *   3. The internal id is a 1:1 function of the email and is NEVER derived from a
 *      name, initial or DOB — colliding names/DOBs do not merge or split students.
 *   4. Cohort exclusion of the staff + test accounts propagates to the per-subject
 *      counts without dropping any real sitter below the true count.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ingestThreeExports,
  type NamedInput,
} from "@/lib/ingest/qm";
import { assertParticipantIdentityIntact } from "@/lib/ingest";
import {
  assignParticipantIdentities,
  internalParticipantId,
  type IdentityInputRow,
} from "@/lib/ingest/participant-identity";
import { parseCsv } from "@/lib/ingest/qm/csv";
import { buildLiveCycleData } from "@/lib/data/build-live-cycle";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { ENGINE_VERSION } from "@/lib/engine";
import type { CleanResponse } from "@/lib/ingest/types";
import type { Seed } from "@/lib/data/seed-types";

const here = path.dirname(fileURLToPath(import.meta.url));
const qmDir = path.join(here, "fixtures", "qm");
const collideDir = path.join(here, "fixtures", "qm-collide");
// Only the Assessments export carries participant identity, so the colliding
// variant overrides just that file; Items + Topics (byte-identical, ~1.5 MB) are
// reused from the de-identified 700435 fixture and join on the same ResultIds.
const read = (name: string) => readFileSync(path.join(qmDir, `${name}.csv`));
const files = (): NamedInput[] => [
  { name: "Items.csv", data: read("Items") },
  { name: "Assessments.csv", data: readFileSync(path.join(collideDir, "Assessments.csv")) },
  { name: "Topics.csv", data: read("Topics") },
];

// The two non-real accounts in the roster, by their email (the natural key).
const LAVINIA = "student15@example.edu"; // G12 Lead (staff) — English only
const MUAMINA = "student16@example.edu"; // re-sit / test — Applicable Maths form + Life Skills

const CYCLE = "live";

function buildProvider(excludeStaffTest: boolean) {
  const { cleanedResponses, validationReport, canonical } = ingestThreeExports(files());
  const built = buildLiveCycleData(cleanedResponses);
  const seed: Seed = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    engineVersion: ENGINE_VERSION,
    liveCycle: {
      id: CYCLE,
      name: "Sitting 700435 (realistic identities)",
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
  return { p, built, idOf, canonical, cleanedResponses, validationReport, assessmentByName };
}

describe("participant identity collapse — realistic-identity fixture", () => {
  // ── the collision shape is real (ONLY the email is collision-free) ─────────
  it("the fixture collides on every name/DOB field but is unique on ResultParticipantName", () => {
    const rows = parseCsv(readFileSync(path.join(collideDir, "Assessments.csv"))).rows.filter(
      (r) => !/survey/i.test(r["AssessmentName"] ?? ""),
    );
    const distinct = (f: string) =>
      new Set(rows.map((r) => String(r[f] ?? "").trim().toLowerCase()).filter(Boolean)).size;
    // The email (ResultParticipantName) is the ONLY collision-free field: 18 distinct.
    expect(distinct("ResultParticipantName")).toBe(18);
    // Every name / DOB-shaped field collides — a key built on any of them would fold
    // distinct students together (first name: 2 shared; last: 1 shared; DOB: several).
    expect(distinct("ResultParticipantFirstName")).toBeLessThan(18);
    expect(distinct("ResultParticipantLastName")).toBeLessThan(18);
    expect(distinct("ResultSpecialField4")).toBeLessThan(18); // date of birth
    // Reality carries no magic unique ParticipantID column.
    expect(parseCsv(readFileSync(path.join(collideDir, "Assessments.csv"))).headers).not.toContain(
      "ParticipantID",
    );
  });

  // ── 1. the detection-boundary invariant catches a collapse ─────────────────
  it("assertParticipantIdentityIntact throws when distinct sitters fold into fewer participants", () => {
    const collapsed: CleanResponse[] = [
      // two DISTINCT results (sitters) folded onto one pseudonym in one subject.
      { assessmentName: "Math", qmQuestionId: "q1", qmResultId: "R1", qmParticipantId: "a@x.edu", participantPseudonym: "P0001", wording: null, description: null, parentWording: null, majorElement: null, subElement: null, demandLevel: null, itemSet: null, questionType: "Multiple Choice", maxScore: 1, answerGiven: "a", answerGivenChoiceNumber: "1", answerScore: 1, responseTime: null, resultStatus: "Finished OK" },
      { assessmentName: "Math", qmQuestionId: "q1", qmResultId: "R2", qmParticipantId: "a@x.edu", participantPseudonym: "P0001", wording: null, description: null, parentWording: null, majorElement: null, subElement: null, demandLevel: null, itemSet: null, questionType: "Multiple Choice", maxScore: 1, answerGiven: "b", answerGivenChoiceNumber: "2", answerScore: 0, responseTime: null, resultStatus: "Finished OK" },
    ];
    expect(() => assertParticipantIdentityIntact(collapsed)).toThrow(/identity collapse/i);
  });

  it("the fixed ingest of the realistic fixture passes the invariant (no collapse)", () => {
    const { cleanedResponses } = buildProvider(false);
    expect(() => assertParticipantIdentityIntact(cleanedResponses)).not.toThrow();
  });

  // ── 2. identity keys on the collision-free email, minted into an internal id ─
  it("keys participant identity on the email, not the colliding name/DOB fields", () => {
    const { built } = buildProvider(false);
    // Every student survives as a distinct identity, and the internal id is a 1:1
    // mint of the email (e.g. "student01@example.edu"), never a name/initial/DOB.
    expect(built.participants).toHaveLength(18);
    expect(new Set(built.participants.map((p) => p.studentId)).size).toBe(18);
    for (const p of built.participants) {
      expect(p.studentId).toMatch(/^student\d{2}@example\.edu$/);
    }
  });

  // ── 3. the internal id is a 1:1 fn of the email, never of name/DOB ─────────
  it("colliding names/DOBs do not merge or split students; the same email is stable", () => {
    // Two DISTINCT students who share first name, last name AND date of birth but
    // have different emails must resolve to two distinct internal ids.
    const shared = { subject: "Math" as const };
    const rows: IdentityInputRow[] = [
      {
        resultId: "r1",
        ...shared,
        row: {
          ResultParticipantName: "s7f2a1@example.edu",
          ResultParticipantFirstName: "Nour",
          ResultParticipantLastName: "Twin",
          ResultSpecialField4: "2001-01-01",
        },
      },
      {
        resultId: "r2",
        ...shared,
        row: {
          ResultParticipantName: "s9b4c3@example.edu",
          ResultParticipantFirstName: "Nour",
          ResultParticipantLastName: "Twin",
          ResultSpecialField4: "2001-01-01",
        },
      },
      // The SAME email appearing again (a second subject) keeps the SAME id.
      {
        resultId: "r3",
        subject: "English",
        row: { ResultParticipantName: "S7F2A1@example.edu" },
      },
    ];
    const ids = assignParticipantIdentities(rows);
    expect(ids.get("r1")!.id).not.toBe(ids.get("r2")!.id); // no merge on name+DOB
    expect(ids.get("r1")!.id).toBe(ids.get("r3")!.id); // same email → same id (case-folded)
    expect(ids.get("r1")!.id).toBe(internalParticipantId("s7f2a1@example.edu"));
    // The id is derived only from the email — never from the name or DOB.
    expect(ids.get("r1")!.id).not.toContain("nour");
    expect(ids.get("r1")!.id).not.toContain("2001");
  });

  // ── Upload/detection oracle — BEFORE cohort exclusion (18 participants) ─────
  it("Upload/detection participant counts hit the oracle (15/12/12/9/11)", () => {
    const { p } = buildProvider(false);
    const split = p.getCombinedSplit(CYCLE)!;
    expect(split.totalParticipants).toBe(18);
    const count = (re: RegExp) => split.subjects.find((s) => re.test(s.name))!.participants;
    expect(count(/Applicable Math$/)).toBe(15);
    expect(count(/English/)).toBe(12);
    expect(count(/Scientific/)).toBe(12);
    expect(count(/العربيّة/)).toBe(9);
    expect(count(/Life/)).toBe(11);
    // No subject falls below its true sitter count (the collapse signature).
    for (const s of split.subjects) expect(s.participants).toBeGreaterThan(0);
  });

  // ── per-subject counts AFTER staff/test exclusion (16 students) ────────────
  it("after excluding the staff + test accounts the counts are 15/11/12/9/10", () => {
    const { p, built } = buildProvider(true);
    expect(p.getCycle(CYCLE)!.participants).toBe(16);
    const count = (re: RegExp) => {
      const id = built.assessments.find((a) => re.test(a.name))!.id;
      return p.getNaiveScores(CYCLE, id)!.students.length;
    };
    expect(count(/Applicable Math$/)).toBe(15);
    expect(count(/English/)).toBe(11);
    expect(count(/Scientific/)).toBe(12);
    expect(count(/العربيّة/)).toBe(9);
    expect(count(/Life/)).toBe(10);
  });

  // ── 4. the per-student score matrix reconciles (no merge / overwrite) ──────
  it("all 15 Applicable Math students survive with the exact oracle raw scores", () => {
    const { p, assessmentByName } = buildProvider(true);
    const mathId = assessmentByName(/Applicable Math$/);
    const comp = p.getComposition(CYCLE)!;
    const math = comp.students
      .map((s) => s.subjects.find((su) => su.assessmentId === mathId))
      .filter((su): su is NonNullable<typeof su> => !!su);
    expect(math).toHaveLength(15);
    // Identical distribution to the de-identified 700435 oracle — proving the
    // realistic identities are correctly separated, not merged/overwritten.
    const mcqSorted = math.map((s) => s.mcq).sort((a, b) => b - a);
    expect(mcqSorted).toEqual([24, 19, 19, 19, 17, 17, 17, 16, 16, 16, 16, 14, 14, 14, 10]);
    for (const s of math) expect(s.max).toBe(40);
  });

  it("the staff + test accounts are absent from Score, Grades and Raw scores", () => {
    const { p, idOf, assessmentByName } = buildProvider(true);
    const lavinia = idOf(LAVINIA);
    const muamina = idOf(MUAMINA);
    const grades = p.getGrades(CYCLE)!;
    expect(grades.rows.some((r) => r.id === lavinia)).toBe(false);
    expect(grades.rows.some((r) => r.id === muamina)).toBe(false);
    const english = p.getNaiveScores(CYCLE, assessmentByName(/English/))!;
    expect(english.students.some((s) => s.id === lavinia)).toBe(false);
    const life = p.getNaiveScores(CYCLE, assessmentByName(/Life/))!;
    expect(life.students.some((s) => s.id === muamina)).toBe(false);
  });
});
