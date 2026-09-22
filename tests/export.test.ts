/**
 * Excel export tests: assert each workbook has the expected sheets, the exact
 * item-analysis layout (title / meta / guide / header / rows), the README &
 * Summary sheet, rating-column fills, and xlsx round-trip.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as XLSXR from "xlsx"; // community reader (styles ignored on read — fine)
import {
  assembleItemAnalysis,
  buildItemAnalysisWorkbook,
  buildScoreAnalysisWorkbook,
  buildGradesWorkbook,
  assembleScoreAnalysis,
  workbookToBuffer,
  ITEM_ANALYSIS_HEADERS,
  ITEM_ANALYSIS_SUMMARY_HEADERS,
  ALTERATION_HEADERS,
  SCORE_ANALYSIS_SHEETS,
  GRADES_STUDENT_HEADERS,
  GRADES_SHEETS,
  DEFAULT_SUBJECT_COLUMNS,
  RATING_STYLES,
  PERFORMANCE_STYLES,
  buildPerformanceReportWorkbook,
  PERFORMANCE_REPORT_SHEETS,
  STUDENT_SUMMARY_HEADERS,
} from "@/lib/export";
import type {
  ItemResponseFact,
  GradesInput,
} from "@/lib/export";
import { getEngine, responsesFromClean } from "@/lib/engine";
import type { ItemMeta, ItemStat, ResponseRecord } from "@/lib/engine";
import { parseExport, ingestAndClean } from "@/lib/ingest";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { loadParityFixtures, sampleExportPath } from "./fixtures";

const engine = getEngine();
const fixtures = loadParityFixtures();
const ASSESSMENT = "Applicable Math";

function buildFromFixture() {
  const a = fixtures[ASSESSMENT]!;
  const responses: ResponseRecord[] = a.responses.map((r) => ({
    participantId: r.student,
    itemId: String(r.qid),
    assessmentId: ASSESSMENT,
    score: r.score,
  }));
  const items: ItemMeta[] = a.items.map((it) => ({
    itemId: String(it.qid),
    assessmentId: ASSESSMENT,
    wording: it.wording,
    majorElement: it.major,
    subElement: it.sub,
    demandLevel: it.demand,
  }));
  const stats = engine.computeItemStats({ responses, items });
  const facts: ItemResponseFact[] = a.responses.map((r) => ({
    assessmentId: ASSESSMENT,
    itemId: String(r.qid),
    participantId: r.student,
    answered: true,
    responseTime: null,
  }));
  const participants = [...new Set(responses.map((r) => r.participantId))].map((id) => ({
    id,
    label: id,
  }));
  return { responses, items, stats, facts, participants };
}

function aoaOf(wb: XLSXR.WorkBook, sheet: string): unknown[][] {
  const ws = wb.Sheets[sheet]!;
  return XLSXR.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: true });
}

describe("item analysis workbook — exact layout", () => {
  const { stats, facts } = buildFromFixture();
  const input = assembleItemAnalysis({
    cycleName: "May 2026",
    assessments: [{ id: ASSESSMENT, name: ASSESSMENT }],
    stats,
    facts,
    reviews: {
      [stats[0]!.itemId]: {
        exclude: true,
        reason: "Negative discrimination",
        notes: "SME flagged wording",
      },
    },
  });
  const wb = buildItemAnalysisWorkbook(input);

  it("has a README & Summary sheet first, then one sheet per assessment", () => {
    expect(wb.SheetNames).toEqual(["README & Summary", "Applicable Math"]);
  });

  it("lays out the assessment sheet exactly (title / meta / guide / header)", () => {
    const aoa = aoaOf(wb as unknown as XLSXR.WorkBook, "Applicable Math");
    expect(aoa[0]![0]).toBe("Applicable Math – Item-Level Psychometric Analysis");
    const meta = String(aoa[1]![0]);
    expect(meta).toContain("Participants: 15");
    expect(meta).toContain("Items: 40");
    expect(meta).toContain("Rows analysed: 600");
    expect(meta).toContain("Upper/Lower group size for discrimination: 5 students");
    expect(String(aoa[2]![0])).toContain("Reading guide:");
    // rows 4 and 5 (index 3,4) are blank
    expect(aoa[3] ?? []).toEqual([]);
    expect(aoa[4] ?? []).toEqual([]);
    // header on row 6 (index 5)
    expect(aoa[5]).toEqual([...ITEM_ANALYSIS_HEADERS]);
  });

  it("has 20 columns with a single Remove/Reason pair", () => {
    expect(ITEM_ANALYSIS_HEADERS).toHaveLength(20);
    expect(ITEM_ANALYSIS_HEADERS.filter((h) => h === "Remove Item?")).toHaveLength(1);
    expect(
      ITEM_ANALYSIS_HEADERS.filter((h) => h === "Reason for removing item"),
    ).toHaveLength(1);
  });

  it("writes one row per item starting at row 7, with the exclusion decision", () => {
    const aoa = aoaOf(wb as unknown as XLSXR.WorkBook, "Applicable Math");
    const dataRows = aoa.slice(6).filter((r) => r.length > 0);
    expect(dataRows).toHaveLength(stats.length);
    const first = dataRows[0]!;
    expect(String(first[0])).toBe(stats[0]!.itemId); // QuestionId
    expect(first[17]).toBe("SME flagged wording"); // Notes
    expect(first[18]).toBe("Yes"); // Remove Item?
    expect(first[19]).toBe("Negative discrimination"); // Reason
  });

  it("applies green/amber/red fills to the rating columns", () => {
    const ws = wb.Sheets["Applicable Math"]!;
    const first = stats[0]!;
    // Row 7 = sheet row index 6. P-Value Rating is column 9, Overall is 16.
    const pCell = ws[XLSXR.utils.encode_cell({ r: 6, c: 9 })] as { s?: { fill?: { fgColor?: { rgb?: string } } } };
    const oCell = ws[XLSXR.utils.encode_cell({ r: 6, c: 16 })] as { s?: { fill?: { fgColor?: { rgb?: string } } } };
    expect(pCell.s?.fill?.fgColor?.rgb).toBe(
      (RATING_STYLES[first.pRating]!.fill as { fgColor: { rgb: string } }).fgColor.rgb,
    );
    expect(oCell.s?.fill?.fgColor?.rgb).toBe(
      (RATING_STYLES[first.overallReview]!.fill as { fgColor: { rgb: string } }).fgColor.rgb,
    );
  });

  it("builds the README & Summary sheet", () => {
    const aoa = aoaOf(wb as unknown as XLSXR.WorkBook, "README & Summary");
    expect(String(aoa[0]![0])).toBe("G12++ MCQ Psychometric Item Analysis – May 2026");
    expect(String(aoa[1]![0])).toContain("Purpose:");
    expect(aoa[3]).toEqual([...ITEM_ANALYSIS_SUMMARY_HEADERS]);
    const row = aoa[4]!;
    expect(row[0]).toBe("Applicable Math");
    expect(row[1]).toBe(15); // Participants
    expect(row[2]).toBe(40); // Items
    expect(row[3]).toBe(600); // Rows
    expect(row[4]).toBe(5); // group size
    // Good + Review + Flag counts sum to item count.
    expect(Number(row[5]) + Number(row[6]) + Number(row[7])).toBe(40);
  });

  it("round-trips through a buffer", () => {
    const buf = workbookToBuffer(wb);
    expect(buf.length).toBeGreaterThan(0);
    const reread = XLSXR.read(buf, { type: "buffer" });
    expect(reread.SheetNames).toEqual(["README & Summary", "Applicable Math"]);
  });
});

describe("item analysis — average response time from real responses", () => {
  it("computes a positive average response time from the sample export", () => {
    const file = readFileSync(sampleExportPath());
    const { rows } = parseExport(file);
    const { cleanedResponses } = ingestAndClean(rows);

    const responses = responsesFromClean(cleanedResponses);
    // distinct item metadata
    const itemMap = new Map<string, ItemMeta>();
    for (const r of cleanedResponses) {
      if (!itemMap.has(r.qmQuestionId)) {
        itemMap.set(r.qmQuestionId, {
          itemId: r.qmQuestionId,
          assessmentId: r.assessmentName,
          wording: r.wording,
          majorElement: r.majorElement,
          subElement: r.subElement,
          demandLevel: r.demandLevel ?? null,
        });
      }
    }
    const stats: ItemStat[] = engine.computeItemStats({
      responses,
      items: [...itemMap.values()],
    });
    const facts: ItemResponseFact[] = cleanedResponses.map((r) => ({
      assessmentId: r.assessmentName,
      itemId: r.qmQuestionId,
      participantId: r.participantPseudonym,
      answered: !!r.answerGiven,
      responseTime: r.responseTime,
    }));
    const assessments = [...new Set(cleanedResponses.map((r) => r.assessmentName))].map(
      (name) => ({ id: name, name }),
    );

    const input = assembleItemAnalysis({
      cycleName: "Feb 2026",
      assessments,
      stats,
      facts,
    });

    const withTimes = input.blocks
      .flatMap((b) => b.rows)
      .filter((r) => r.avgResponseTime !== null);
    expect(withTimes.length).toBeGreaterThan(0);
    for (const r of withTimes) expect(r.avgResponseTime!).toBeGreaterThan(0);

    // Presented/answered are populated and consistent.
    for (const block of input.blocks) {
      for (const r of block.rows) {
        expect(r.participantsPresented).toBeGreaterThan(0);
        expect(r.participantsAnswered).toBeLessThanOrEqual(r.participantsPresented);
      }
    }
  });
});

describe("score analysis workbook — canonical layout", () => {
  const { participants } = buildFromFixture();
  const a = fixtures[ASSESSMENT]!;
  const responses: ResponseRecord[] = a.responses.map((r) => ({
    participantId: r.student,
    itemId: String(r.qid),
    assessmentId: ASSESSMENT,
    score: r.score,
  }));
  const items: ItemMeta[] = a.items.map((it) => ({
    itemId: String(it.qid),
    assessmentId: ASSESSMENT,
    majorElement: it.major,
    demandLevel: it.demand,
    maxScore: 1,
  }));
  // Drop one item for everyone (cohort exclusion).
  const cohortExcludedItem = items[0]!.itemId;

  const input = assembleScoreAnalysis({
    assessments: [{ id: ASSESSMENT, name: ASSESSMENT }],
    participants,
    responses,
    items,
    excludedItemIds: [cohortExcludedItem],
  });
  const wb = buildScoreAnalysisWorkbook(input);

  it("has all five canonical sheets in order", () => {
    expect(wb.SheetNames).toEqual([...SCORE_ANALYSIS_SHEETS]);
  });

  it("drops cohort-excluded responses from the scored set", () => {
    // cohort-excluded item never appears
    expect(input.scoredResponses.some((r) => r.itemId === cohortExcludedItem)).toBe(false);
    // a retained item still appears for participants
    expect(input.scoredResponses.length).toBeGreaterThan(0);
  });

  it("by-assessment sheet has the canonical header on row 6 and consistent percentages", () => {
    const aoa = aoaOf(wb as unknown as XLSXR.WorkBook, "Overall Scores by Assessment");
    expect(aoa[5]).toEqual([
      "AssessmentName",
      "ParticipantID",
      "ParticipantFullName",
      "ParticipantScore",
      "AssessmentTotalScore",
      "ParticipantScorePercentage",
    ]);
    const dataRows = aoa.slice(6).filter((r) => r.length > 0);
    expect(dataRows.length).toBeGreaterThan(0);
    for (const r of dataRows) {
      const score = Number(r[3]);
      const total = Number(r[4]);
      const pctCell = Number(r[5]);
      expect(pctCell).toBeCloseTo(Math.round((score / total) * 100 * 100) / 100, 6);
    }
    // every participant now scores against the same retained-item total (one
    // cohort-excluded item dropped); there are no per-student exclusions.
    for (const r of dataRows) {
      expect(Number(r[4])).toBe(a.items.length - 1 /*cohort*/);
    }
  });

  it("major-element and demand-level sheets carry their key columns", () => {
    const major = aoaOf(wb as unknown as XLSXR.WorkBook, "Overall Scores by Major Element");
    expect(major[5]).toEqual([
      "AssessmentName",
      "QuestionMajorElement",
      "ParticipantID",
      "ParticipantFullName",
      "ParticipantScore",
      "MajorElementTotalScore",
      "ParticipantScorePercentage",
    ]);
    const demand = aoaOf(wb as unknown as XLSXR.WorkBook, "Overall Scores by Demand Level");
    expect(demand[5]![1]).toBe("DemandLevel");
  });

  it("Analysis sheet reports distinct questions and participants per assessment", () => {
    const aoa = aoaOf(wb as unknown as XLSXR.WorkBook, "Analysis");
    expect(aoa[2]).toEqual([
      "AssessmentName",
      "Distinct Count of Questions",
      "Average of AnswerScore",
      "Distinct Count of Participants",
    ]);
    const row = aoa[3]!;
    expect(row[0]).toBe(ASSESSMENT);
    expect(Number(row[1])).toBe(a.items.length - 1); // cohort-excluded item gone
  });

  it("round-trips through a buffer", () => {
    const reread = XLSXR.read(workbookToBuffer(wb), { type: "buffer" });
    expect(reread.SheetNames).toEqual([...SCORE_ANALYSIS_SHEETS]);
  });
});

describe("grades workbook — canonical layout", () => {
  const CYCLE = "may-2026";

  // A real provider, exercised so the Distinction safeguard caps at least one
  // student (lower the Distinction boundary to bring candidates in line; the
  // per-exam D3 majority then makes some fall short).
  function makeInput(): GradesInput {
    const provider = new InMemoryDataProvider();
    provider.setBoundary(CYCLE, "overall", { cutIndex: 0, cutValue: 30 });

    const model = provider.getGrades(CYCLE)!;
    const safeguard = provider.getDistinctionSafeguard(CYCLE)!;
    const review = provider.getStudentReview(CYCLE)!;
    const audit = provider.getAuditLog(CYCLE, "all", "");

    const alias: Record<string, RegExp> = {
      ApplicableMath: /applicable math/i,
      EnglishL2: /english/i,
      ScientificThinking: /scientific/i,
      ArabicL1: /arabic/i,
      LifeSuccessSkills: /life/i,
    };
    const subjects = DEFAULT_SUBJECT_COLUMNS.map((s) => ({
      ...s,
      assessmentId: model.assessments.find((a) => alias[s.key]?.test(a.name))?.id ?? null,
    }));
    const capByP = new Map(
      safeguard.candidates.map((c) => [
        c.id,
        {
          applied: c.result === "capped",
          reason: c.result === "capped" ? `Fewer than ${safeguard.threshold} top-difficulty questions attempted` : null,
          overridden: c.result === "override",
          overrideReason: c.overrideReason,
        },
      ]),
    );
    const students = model.rows.map((r) => {
      const cap = capByP.get(r.id);
      const perAssessment: Record<string, { level: string; score: number | null; pct: number | null }> = {};
      for (const a of model.assessments) perAssessment[a.id] = { level: r.grades[a.id]?.level ?? "", score: null, pct: null };
      return {
        participantId: r.id,
        participantName: r.label,
        perAssessment,
        overallAward: r.award,
        overallPct: null,
        capApplied: cap?.applied ?? false,
        capReason: cap?.reason ?? null,
        capOverridden: cap?.overridden ?? false,
        overrideReason: cap?.overrideReason ?? null,
      };
    });
    const n = model.rows.length;
    return {
      cycleName: "May 2026",
      participantCount: n,
      assessmentCount: model.assessments.length,
      lockedAt: null,
      signedOffBy: null,
      awardLevels: model.awardLevels,
      performanceLevels: model.performanceLevels,
      subjects,
      students,
      awardDistribution: model.distribution.map((d) => ({ level: d.level, count: d.count, pct: n ? Math.round((d.count / n) * 1000) / 10 : 0 })),
      performanceDistribution: model.assessments.map((a) => {
        const counts: Record<string, number> = {};
        for (const lvl of model.performanceLevels) counts[lvl] = 0;
        for (const r of model.rows) {
          const lvl = r.grades[a.id]?.level;
          if (lvl) counts[lvl] = (counts[lvl] ?? 0) + 1;
        }
        return { assessmentName: a.name, counts };
      }),
      alterations: [
        {
          participantId: model.rows[0]!.id,
          participantName: model.rows[0]!.label,
          subject: model.assessments[0]!.name,
          marks: 3,
          reason: "Lost time on a frozen item",
          decidedBy: "G12 Lead",
          decidedAt: "2026-06-10T09:00:00.000Z",
          sourceIncident: "Calculator froze",
        },
      ],
      audit: audit.entries.map((e) => ({ timestamp: e.ts, actor: e.actorName, action: e.action, detail: e.detail, entity: e.type, entityId: e.cycleId ?? "" })),
    };
  }

  const input = makeInput();
  const wb = buildGradesWorkbook(input);

  it("has the four canonical sheets", () => {
    expect(wb.SheetNames).toEqual([...GRADES_SHEETS]);
  });

  it("Student Grades has the canonical 22-column header and one row per participant", () => {
    const aoa = aoaOf(wb as unknown as XLSXR.WorkBook, "Student Grades");
    expect(aoa[2]).toEqual([...GRADES_STUDENT_HEADERS]);
    const dataRows = aoa.slice(3).filter((r) => r.length > 0);
    expect(dataRows).toHaveLength(input.students.length);
  });

  it("cap columns render a Distinction-safeguard cap", () => {
    // The honest seeded cohort attempts every top-difficulty question, so the
    // live safeguard caps no one. Exercise the cap-COLUMN rendering (the export's
    // responsibility) with a student carrying a cap decision.
    const capInput: GradesInput = {
      ...input,
      students: input.students.map((s, i) =>
        i === 0
          ? { ...s, capApplied: true, capReason: "Fewer than 10 top-difficulty questions attempted" }
          : s,
      ),
    };
    const capWb = buildGradesWorkbook(capInput);
    const aoa = aoaOf(capWb as unknown as XLSXR.WorkBook, "Student Grades");
    const dataRows = aoa.slice(3).filter((r) => r.length > 0);
    // DistinctionCapApplied is column 18; the capped student shows "Yes".
    expect(dataRows.some((r) => r[18] === "Yes")).toBe(true);
    // the capped row carries a non-empty CapReason (column 19).
    const yesRow = dataRows.find((r) => r[18] === "Yes")!;
    expect(String(yesRow[19]).length).toBeGreaterThan(0);
  });

  it("colours performance-level cells to match each cell's level", () => {
    const ws = wb.Sheets["Student Grades"]!;
    // Rows are sorted in the sheet, so read the level cell's own value (col 2 =
    // first subject's Level) and assert its fill matches that level's style.
    let checked = 0;
    for (let r = 3; r < 3 + input.students.length; r++) {
      const cell = ws[XLSXR.utils.encode_cell({ r, c: 2 })] as
        | { v?: string; s?: { fill?: { fgColor?: { rgb?: string } } } }
        | undefined;
      const level = cell?.v;
      if (!level) continue;
      const lvlIdx = input.performanceLevels.indexOf(level);
      if (lvlIdx < 0) continue;
      const expected = (PERFORMANCE_STYLES[lvlIdx]!.fill as { fgColor: { rgb: string } }).fgColor.rgb;
      expect(cell!.s?.fill?.fgColor?.rgb).toBe(expected);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("Audit Trail has the header and at least one entry", () => {
    const aoa = aoaOf(wb as unknown as XLSXR.WorkBook, "Audit Trail");
    expect(aoa[2]).toEqual(["Timestamp", "Actor", "Action", "Detail", "Entity", "EntityId"]);
    expect(aoa.slice(3).filter((r) => r.length > 0).length).toBeGreaterThan(0);
  });

  it("includes the Alterations sheet with the canonical columns + a row per alteration", () => {
    expect(wb.SheetNames).toContain("Alterations");
    const aoa = aoaOf(wb as unknown as XLSXR.WorkBook, "Alterations");
    expect(aoa[0]).toEqual([...ALTERATION_HEADERS]);
    // one synthetic alteration was supplied in makeInput
    const dataRows = aoa.slice(1).filter((r) => r.length > 1);
    expect(dataRows.length).toBe(1);
    expect(Number(dataRows[0]![3])).toBe(3); // Marks column
  });
});

describe("performance report workbook — Students_Performance_Report layout", () => {
  const CYCLE = "may-2026";

  async function build(): Promise<XLSXR.WorkBook> {
    const provider = new InMemoryDataProvider();
    // Bring real candidates into the upper bands so the level rows are populated.
    provider.setBoundary(CYCLE, "applicable-math", { cuts: [60, 40, 20] });
    const report = provider.getPerformanceReport(CYCLE)!;
    const buf = await buildPerformanceReportWorkbook({
      ...report,
      alterations: [],
      audit: provider.getAuditLog(CYCLE, "all", "").entries.map((e) => ({
        timestamp: e.ts,
        actor: e.actorName,
        action: e.action,
        detail: e.detail,
        entity: e.type,
        entityId: e.cycleId ?? "",
      })),
    });
    return XLSXR.read(buf, { type: "buffer" });
  }

  it("emits the three matched sheets, then alterations + audit, in order", async () => {
    const wb = await build();
    expect(wb.SheetNames.slice(0, 3)).toEqual([...PERFORMANCE_REPORT_SHEETS]);
    expect(wb.SheetNames).toContain("Alterations");
    expect(wb.SheetNames).toContain("Audit Trail");
    // additional sheets come AFTER the matched ones
    expect(wb.SheetNames.indexOf("Alterations")).toBeGreaterThan(2);
    expect(wb.SheetNames.indexOf("Audit Trail")).toBeGreaterThan(2);
  });

  it("Class Performance has the title, a row per performance level, and the award block", async () => {
    const wb = await build();
    const report = new InMemoryDataProvider().getPerformanceReport(CYCLE)!;
    const aoa = aoaOf(wb, "Class Performance");
    expect(aoa[0]?.[0]).toBe("Class Performance Report");
    expect(aoa[3]?.[0]).toBe("% Performance");
    // r5.. one row per performance level (best → lowest), label in col A
    report.performanceLevels.forEach((lvl, i) => {
      expect(aoa[4 + i]?.[0]).toBe(lvl);
    });
    // Award Level Distribution block follows
    const flat = aoa.map((r) => String(r?.[0] ?? ""));
    const awardTitle = flat.indexOf("Award Level Distribution");
    expect(awardTitle).toBeGreaterThan(0);
    expect(aoa[awardTitle + 1]).toEqual(["Award Level", "Number of Students", "% of Class"]);
  });

  it("Student Summary matches the canonical 9-column header (Student ID first) with one row per student", async () => {
    const wb = await build();
    const report = new InMemoryDataProvider().getPerformanceReport(CYCLE)!;
    const aoa = aoaOf(wb, "Student Summary");
    expect(aoa[2]?.slice(0, STUDENT_SUMMARY_HEADERS.length)).toEqual([...STUDENT_SUMMARY_HEADERS]);
    expect(STUDENT_SUMMARY_HEADERS[0]).toBe("Student ID");
    // one data row per student, last column "Open profile"
    expect(aoa[3]?.[STUDENT_SUMMARY_HEADERS.length - 1]).toBe("Open profile");
    const dataRows = aoa.slice(3).filter((r) => r && r[0]);
    expect(dataRows.length).toBe(report.students.length);
    // Legend block sits one column past the data table (a blank spacer column between).
    expect(aoa[0]?.[STUDENT_SUMMARY_HEADERS.length + 1]).toBe("Legend");
  });

  it("Student Profiles repeats an Award Level / Subject block per student, with a working Back link", async () => {
    const wb = await build();
    const report = new InMemoryDataProvider().getPerformanceReport(CYCLE)!;
    const aoa = aoaOf(wb, "Student Profiles");
    const flat = aoa.map((r) => String(r?.[0] ?? ""));
    expect(flat.filter((v) => v === "Award Level").length).toBe(report.students.length);
    expect(flat.filter((v) => v === "Subject").length).toBe(report.students.length);
    // "Back" appears in the last column (H, index 7) of each student's name row
    const backs = aoa.filter((r) => r?.[7] === "Back");
    expect(backs.length).toBe(report.students.length);
  });

  it("links Student Summary ⇄ Student Profiles to the correct row for every student, both directions", async () => {
    const wb = await build();
    const report = new InMemoryDataProvider().getPerformanceReport(CYCLE)!;
    const numSubjects = report.summarySubjects.length;
    const summaryWs = wb.Sheets["Student Summary"]!;
    const profilesWs = wb.Sheets["Student Profiles"]!;
    const location = (cell: unknown) =>
      String((cell as { l?: { location?: string } } | undefined)?.l?.location ?? "").replace(/&apos;/g, "'");

    report.students.forEach((_st, i) => {
      const summaryRow0 = 3 + i; // 0-based: row 4 (1-based) is the first student
      const nameCell = summaryWs[XLSXR.utils.encode_cell({ r: summaryRow0, c: 1 })];
      const expectedCardRow1Based = 3 + i * (numSubjects + 4);
      expect(location(nameCell)).toBe(`'Student Profiles'!A${expectedCardRow1Based}`);

      const backCell = profilesWs[XLSXR.utils.encode_cell({ r: expectedCardRow1Based - 1, c: 7 })];
      const expectedSummaryRow1Based = 4 + i;
      expect(location(backCell)).toBe(`'Student Summary'!A${expectedSummaryRow1Based}`);
    });
  });
});
