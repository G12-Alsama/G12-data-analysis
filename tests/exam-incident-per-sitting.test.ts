/**
 * The same technical-incident file imported into two sittings keeps BOTH sets.
 *
 * (The database half of this guarantee — the per-sitting unique key and the upsert
 * that no longer moves rows — is covered structurally in
 * migration.exam-incidents-per-cycle.test.ts and executed for real in the opt-in
 * pg.exam-incidents.test.ts.) Here: the app's provider, which stages incidents per
 * cycle, must never let one sitting's import touch another's.
 */
import { describe, it, expect } from "vitest";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { assertLocalPg } from "@/tests/helpers/scratch-pg";
import type { ExamIncidentRecord } from "@/lib/incidents/exam-incident-match";
import seedJson from "@/lib/data/seed.generated.json";

const seed = seedJson as unknown as { liveCycle: { id: string } };
const LIVE = seed.liveCycle.id;
const OTHER = "other-sitting-id";

function record(reference: string, batchId: string): ExamIncidentRecord {
  return {
    reference,
    importBatchId: batchId,
    examCycle: "2026",
    subjectRaw: "Applicable Mathematics",
    subjectKey: "AM",
    examDate: null,
    partnerCenter: "",
    category: "",
    issue: "",
    code: "",
    studentName: "A Student",
    studentEmail: "a@x.org",
    studentIdExternal: "",
    timeStarted: "",
    timeResolved: "",
    durationMin: 10,
    actionTaken: "",
    questionsAffectedCount: null,
    questionsAffectedList: null,
    status: "",
    invigilator: "",
    sourceCreatedAt: null,
    matchedQmResultId: null,
    matchStatus: "unmatched_email",
    flags: [],
    adjustmentType: null,
    adjustmentMagnitude: null,
    adjustmentNotes: null,
  };
}

describe("one incident file imported into two sittings keeps both sets", () => {
  const FILE = ["INC-1", "INC-2", "INC-3"];

  it("both sittings hold the full set after the same references are staged in each", () => {
    const p = new InMemoryDataProvider();
    p.upsertExamIncidents(LIVE, "batch-A", "incidents.csv", FILE.map((r) => record(r, "batch-A")));
    p.upsertExamIncidents(OTHER, "batch-B", "incidents.csv", FILE.map((r) => record(r, "batch-B")));

    const live = p.getExamIncidentsForCycle(LIVE);
    const other = p.getExamIncidentsForCycle(OTHER);
    expect(live.map((r) => r.reference).sort()).toEqual(FILE);
    expect(other.map((r) => r.reference).sort()).toEqual(FILE);
    // each set still belongs to its own import batch (nothing was re-homed)
    expect(new Set(live.map((r) => r.importBatchId))).toEqual(new Set(["batch-A"]));
    expect(new Set(other.map((r) => r.importBatchId))).toEqual(new Set(["batch-B"]));
  });

  it("re-importing a corrected file into one sitting updates it in place and leaves the other alone", () => {
    const p = new InMemoryDataProvider();
    p.upsertExamIncidents(LIVE, "batch-A", "incidents.csv", FILE.map((r) => record(r, "batch-A")));
    p.upsertExamIncidents(OTHER, "batch-B", "incidents.csv", FILE.map((r) => record(r, "batch-B")));

    p.upsertExamIncidents(LIVE, "batch-A2", "corrected.csv", [{ ...record("INC-1", "batch-A2"), issue: "CORRECTED" }]);

    const live = p.getExamIncidentsForCycle(LIVE);
    expect(live).toHaveLength(3); // upserted, not duplicated
    expect(live.find((r) => r.reference === "INC-1")!.issue).toBe("CORRECTED");
    expect(p.getExamIncidentsForCycle(OTHER).find((r) => r.reference === "INC-1")!.issue).toBe("");
  });

  it("clearing one sitting's incidents leaves the other sitting's set intact", () => {
    const p = new InMemoryDataProvider();
    p.upsertExamIncidents(LIVE, "batch-A", "incidents.csv", FILE.map((r) => record(r, "batch-A")));
    p.upsertExamIncidents(OTHER, "batch-B", "incidents.csv", FILE.map((r) => record(r, "batch-B")));

    p.clearExamIncidents(LIVE);

    expect(p.getExamIncidentsForCycle(LIVE)).toHaveLength(0);
    expect(p.getExamIncidentsForCycle(OTHER)).toHaveLength(3);
  });
});

describe("scratch-pg safety guard (the opt-in SQL harness only ever targets local servers)", () => {
  it("accepts unix sockets and localhost", () => {
    expect(() => assertLocalPg("postgresql://postgres@/postgres?host=/var/tmp/g12-pg")).not.toThrow();
    expect(() => assertLocalPg("postgresql://postgres@localhost:5432/postgres")).not.toThrow();
    expect(() => assertLocalPg("postgresql://postgres@127.0.0.1/postgres")).not.toThrow();
    expect(() => assertLocalPg("postgresql://postgres@[::1]:5432/postgres")).not.toThrow();
  });

  it("refuses any remote host", () => {
    expect(() => assertLocalPg("postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres")).toThrow(/local servers only/);
    expect(() => assertLocalPg("postgresql://u@10.0.0.5/postgres")).toThrow(/local servers only/);
    expect(() => assertLocalPg("postgresql://u@example.com/postgres")).toThrow(/local servers only/);
  });

  it("cannot be bypassed by a host/hostaddr parameter or a multi-host list", () => {
    expect(() => assertLocalPg("postgresql://u@localhost/postgres?host=db.supabase.co")).toThrow(/local servers only/);
    expect(() => assertLocalPg("postgresql://u@localhost/postgres?hostaddr=10.1.2.3")).toThrow(/local servers only/);
    expect(() => assertLocalPg("postgresql://u@/postgres?host=/tmp,db.supabase.co")).toThrow(/local servers only/);
    expect(() => assertLocalPg("not a uri")).toThrow(/unparseable/);
  });
});
