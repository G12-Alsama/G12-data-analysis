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
  ScoreAnalysisInput,
  ScoredItemResponse,
} from "@/lib/export";
import { DEFAULT_SCORING_CONFIG, getEngine, responsesFromClean } from "@/lib/engine";
import type { ItemMeta, ItemStat, ResponseRecord } from "@/lib/engine";
import { parseExport, ingestAndClean } from "@/lib/ingest";
import { InMemoryDataProvider } from "@/lib/data/in-memory-provider";
import { canonicalSubjectLabel } from "@/lib/data/subject-catalog";
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
    // Exact reference-file colours (ARGB, no alpha) — not just "some fill".
    expect((RATING_STYLES.Good!.fill as { fgColor: { rgb: string } }).fgColor.rgb).toBe("DFF3E4");
    expect((RATING_STYLES.Review!.fill as { fgColor: { rgb: string } }).fgColor.rgb).toBe("FFF3CD");
    expect((RATING_STYLES.Flag!.fill as { fgColor: { rgb: string } }).fgColor.rgb).toBe("FCE4E4");
  });

  it("pink title bar is merged full-width and the header row is bold/centered with no fill", () => {
    const ws = wb.Sheets["Applicable Math"]!;
    type Style = { fill?: { fgColor?: { rgb?: string } }; font?: { bold?: boolean }; alignment?: { horizontal?: string; vertical?: string } };
    const titleCell = ws[XLSXR.utils.encode_cell({ r: 0, c: 0 })] as { s?: Style };
    expect(titleCell.s?.fill?.fgColor?.rgb).toBe("B2375B");
    expect(titleCell.s?.font?.bold).toBe(true);

    const merges = (ws["!merges"] ?? []) as { s: { r: number; c: number }; e: { r: number; c: number } }[];
    const lastCol = ITEM_ANALYSIS_HEADERS.length - 1;
    expect(merges).toContainEqual({ s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } });
    // Reading guide spans rows 3–4 (index 2–3) as ONE merged block.
    expect(merges).toContainEqual({ s: { r: 2, c: 0 }, e: { r: 3, c: lastCol } });

    const headerCell = ws[XLSXR.utils.encode_cell({ r: 5, c: 0 })] as { s?: Style };
    expect(headerCell.s?.font?.bold).toBe(true);
    expect(headerCell.s?.alignment?.horizontal).toBe("center");
    expect(headerCell.s?.alignment?.vertical).toBe("center");
    expect(headerCell.s?.fill).toBeUndefined();
  });

  it("sets number formats on the statistic columns and sizes columns/rows", () => {
    const ws = wb.Sheets["Applicable Math"]!;
    type Style = { numFmt?: string };
    // Row 7 = index 6. Avg Response Time = col 7, P-Value = col 8.
    const rtCell = ws[XLSXR.utils.encode_cell({ r: 6, c: 7 })] as { s?: Style };
    const pCell = ws[XLSXR.utils.encode_cell({ r: 6, c: 8 })] as { s?: Style };
    expect(rtCell.s?.numFmt).toBe("0.0");
    expect(pCell.s?.numFmt).toBe("0.000");

    expect(ws["!cols"]).toHaveLength(ITEM_ANALYSIS_HEADERS.length);
    expect((ws["!cols"]![0] as { wch: number }).wch).toBeGreaterThan(0);
    const rows = ws["!rows"] as { hpt?: number }[];
    expect(rows[0]?.hpt).toBeGreaterThan(0); // title row sized
    expect(rows[6]?.hpt).toBeGreaterThan(0); // first data row sized (not Excel default)
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

  it("documents the REAL scoring thresholds in a Methodology & Rating Thresholds table, never retyped", () => {
    const aoa = aoaOf(wb as unknown as XLSXR.WorkBook, "README & Summary");
    const flat = aoa.map((r) => String(r?.[0] ?? ""));
    const methodTitleRow = flat.indexOf("Methodology & Rating Thresholds");
    expect(methodTitleRow).toBeGreaterThan(0);
    expect(aoa[methodTitleRow + 1]).toEqual(["Metric", "Definition Used", "Good", "Review", "Flag", "Important Note"]);

    const q = DEFAULT_SCORING_CONFIG.quality; // this fixture never overrides qualityThresholds
    const pValueRow = aoa[methodTitleRow + 2]!;
    expect(pValueRow[0]).toBe("P-Value (item difficulty)");
    // The Good band text is built FROM the config values, not hardcoded literals.
    expect(String(pValueRow[2])).toContain(String(q.pValue.goodUpTo));
    expect(String(pValueRow[3])).toContain(String(q.pValue.flagBelow));
    expect(String(pValueRow[4])).toContain(String(q.pValue.reviewUpTo));

    const itemTotalRow = aoa[methodTitleRow + 3]!;
    expect(itemTotalRow[0]).toBe("Item-Total Correlation");
    expect(String(itemTotalRow[2])).toContain(String(q.itemTotal.reviewBelow));
    expect(String(itemTotalRow[4])).toContain(String(q.itemTotal.flagBelow));

    const noteTitleRow = flat.indexOf("Important interpretation note");
    expect(noteTitleRow).toBeGreaterThan(methodTitleRow);
    expect(String(aoa[noteTitleRow + 1]?.[0] ?? "")).toContain("evidence for expert review");
  });

  it("uses a custom qualityThresholds when the caller supplies one (never falls back silently)", () => {
    const customQuality = {
      ...DEFAULT_SCORING_CONFIG.quality,
      itemTotal: { flagBelow: 0.42, reviewBelow: 0.77 },
    };
    const customInput = assembleItemAnalysis({
      cycleName: "May 2026",
      assessments: [{ id: ASSESSMENT, name: ASSESSMENT }],
      stats,
      facts,
      qualityThresholds: customQuality,
    });
    expect(customInput.qualityThresholds).toBe(customQuality);
    const customWb = buildItemAnalysisWorkbook(customInput);
    const aoa = aoaOf(customWb as unknown as XLSXR.WorkBook, "README & Summary");
    const flat = aoa.map((r) => String(r?.[0] ?? ""));
    const methodTitleRow = flat.indexOf("Methodology & Rating Thresholds");
    const itemTotalRow = aoa[methodTitleRow + 3]!;
    expect(String(itemTotalRow[2])).toContain("0.77");
    expect(String(itemTotalRow[4])).toContain("0.42");
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

  it("canonicalizes every sheet title from the raw QM assessment name — Arabic script included", () => {
    // The real sample export's Arabic sheet name is a raw/local-script label
    // (straight off the QM export), exactly the case the sheet title must never
    // be built from directly.
    const file = readFileSync(sampleExportPath());
    const { rows } = parseExport(file);
    const { cleanedResponses } = ingestAndClean(rows);
    const rawNames = [...new Set(cleanedResponses.map((r) => r.assessmentName))];
    expect(rawNames.some((n) => /[؀-ۿ]/.test(n))).toBe(true); // sanity: fixture really has raw Arabic

    const responses = responsesFromClean(cleanedResponses);
    const itemMap = new Map<string, ItemMeta>();
    for (const r of cleanedResponses) {
      if (!itemMap.has(r.qmQuestionId)) {
        itemMap.set(r.qmQuestionId, { itemId: r.qmQuestionId, assessmentId: r.assessmentName });
      }
    }
    const stats = engine.computeItemStats({ responses, items: [...itemMap.values()] });
    const facts: ItemResponseFact[] = cleanedResponses.map((r) => ({
      assessmentId: r.assessmentName,
      itemId: r.qmQuestionId,
      participantId: r.participantPseudonym,
      answered: !!r.answerGiven,
      responseTime: r.responseTime,
    }));
    const input = assembleItemAnalysis({
      cycleName: "Feb 2026",
      assessments: rawNames.map((name) => ({ id: name, name })),
      stats,
      facts,
    });

    // Every block name is now a canonical English label — never raw/local-script.
    for (const block of input.blocks) {
      expect(/[؀-ۿ]/.test(block.name)).toBe(false);
    }
    const arabicBlock = input.blocks.find((b) => /arabic/i.test(b.name));
    expect(arabicBlock?.name).toBe("G12++ Arabic as a 1st Language");

    const wb = buildItemAnalysisWorkbook(input);
    expect(wb.SheetNames).toContain("G12++ Arabic as a 1st Language");
    expect(wb.SheetNames.some((n) => /[؀-ۿ]/.test(n))).toBe(false);
  });
});

describe("canonicalSubjectLabel — sheet titles never come from a raw/local-script field", () => {
  it("maps every known raw spelling to its canonical English label, prefix preserved", () => {
    expect(canonicalSubjectLabel("G12++ اللّغة العربيّة")).toBe("G12++ Arabic as a 1st Language");
    expect(canonicalSubjectLabel("G12++ Applicable Maths")).toBe("G12++ Applicable Math");
    expect(canonicalSubjectLabel("G12++ English as 2nd Language")).toBe("G12++ English as a 2nd Language");
    expect(canonicalSubjectLabel("G12++ Scientific Thinking")).toBe("G12++ Scientific Thinking");
    expect(canonicalSubjectLabel("G12++ Life Success Skills")).toBe("G12++ Life Success Skills");
    // No "G12++" prefix in the raw name → none added.
    expect(canonicalSubjectLabel("Applicable Math")).toBe("Applicable Math");
    expect(canonicalSubjectLabel("Arabic 1st Language")).toBe("Arabic as a 1st Language");
  });

  it("leaves an unrecognised name unchanged rather than silently renaming it", () => {
    expect(canonicalSubjectLabel("User Experience Survey")).toBe("User Experience Survey");
  });
});

describe("InMemoryDataProvider.getItemAnalysisData — real production data path", () => {
  it("populates wording/majorElement/demandLevel and avg response time (not blank)", () => {
    const provider = new InMemoryDataProvider();
    const data = provider.getItemAnalysisData("may-2026");
    expect(data).not.toBeNull();
    expect(data!.stats.length).toBeGreaterThan(0);
    // These come straight from items/facts the DB (or seed) already carries —
    // the export must not leave them blank for lack of being asked for.
    expect(data!.stats.some((s) => !!s.wording)).toBe(true);
    expect(data!.stats.some((s) => !!s.majorElement)).toBe(true);
    expect(data!.stats.some((s) => !!s.demandLevel)).toBe(true);
    expect(data!.facts.some((f) => f.responseTime !== null)).toBe(true);
    expect(data!.qualityThresholds).toBeDefined();

    const input = assembleItemAnalysis(data!);
    const rows = input.blocks.flatMap((b) => b.rows);
    expect(rows.some((r) => r.avgResponseTime !== null)).toBe(true);
    expect(rows.some((r) => !!r.stat.wording)).toBe(true);

    // Sheet titles are canonical for every subject, not just Arabic.
    const wb = buildItemAnalysisWorkbook(input);
    for (const name of wb.SheetNames) {
      expect(/[؀-ۿ]/.test(name)).toBe(false);
    }
  });
});

describe("item analysis — maxScore:0 stimulus/instruction items are excluded", () => {
  const { stats, facts } = buildFromFixture(); // 40 real items, Applicable Math fixture
  const stimulusItemId = "stim-instructions";

  // Graft one synthetic maxScore:0 stimulus item onto the real fixture: its own
  // stat (the engine computes SOMETHING for it, however meaningless) and facts
  // (every participant "responds" to it, same as a real instruction page).
  const stimulusStat: ItemStat = {
    ...stats[0]!,
    itemId: stimulusItemId,
    n: stats[0]!.n,
  };
  const participantIds = [...new Set(facts.map((f) => f.participantId))];
  const stimulusFacts: ItemResponseFact[] = participantIds.map((pid) => ({
    assessmentId: ASSESSMENT,
    itemId: stimulusItemId,
    participantId: pid,
    answered: true,
    responseTime: null,
  }));
  const itemMetas: ItemMeta[] = [
    ...Array.from(new Set(stats.map((s) => s.itemId))).map((id) => ({
      itemId: id,
      assessmentId: ASSESSMENT,
      maxScore: 1,
    })),
    { itemId: stimulusItemId, assessmentId: ASSESSMENT, maxScore: 0 },
  ];

  it("drops the stimulus item's row and shrinks every affected aggregate", () => {
    const withStimulus = assembleItemAnalysis({
      cycleName: "May 2026",
      assessments: [{ id: ASSESSMENT, name: ASSESSMENT }],
      stats: [...stats, stimulusStat],
      facts: [...facts, ...stimulusFacts],
      items: itemMetas,
    });
    const block = withStimulus.blocks[0]!;
    // No row for the stimulus item.
    expect(block.rows.some((r) => r.stat.itemId === stimulusItemId)).toBe(false);
    expect(block.rows).toHaveLength(stats.length); // 40, not 41
    // "Rows analysed" (the response-fact count) excludes the stimulus item's
    // facts too — not just its own row.
    expect(block.rowsAnalysed).toBe(facts.length);

    const wb = buildItemAnalysisWorkbook(withStimulus);
    const aoa = aoaOf(wb as unknown as XLSXR.WorkBook, "Applicable Math");
    const dataRows = aoa.slice(6).filter((r) => r.length > 0);
    expect(dataRows).toHaveLength(stats.length);
    expect(dataRows.some((r) => String(r[0]) === stimulusItemId)).toBe(false);

    const summaryAoa = aoaOf(wb as unknown as XLSXR.WorkBook, "README & Summary");
    const summaryRow = summaryAoa[4]!; // first (only) assessment row
    expect(summaryRow[0]).toBe("Applicable Math");
    expect(summaryRow[2]).toBe(stats.length); // Items = 40, not 41
    expect(summaryRow[3]).toBe(facts.length); // Rows = scored-only fact count
    // Good + Review + Flag still sum to the SCORED item count only.
    expect(Number(summaryRow[5]) + Number(summaryRow[6]) + Number(summaryRow[7])).toBe(stats.length);
  });

  it("matches the unfiltered baseline exactly when no item is maxScore:0 (no stimulus items present)", () => {
    const allScoredMetas: ItemMeta[] = itemMetas.filter((m) => m.itemId !== stimulusItemId);
    const withItemsButNoStimulus = assembleItemAnalysis({
      cycleName: "May 2026",
      assessments: [{ id: ASSESSMENT, name: ASSESSMENT }],
      stats,
      facts,
      items: allScoredMetas,
    });
    const withoutItemsAtAll = assembleItemAnalysis({
      cycleName: "May 2026",
      assessments: [{ id: ASSESSMENT, name: ASSESSMENT }],
      stats,
      facts,
    });
    expect(withItemsButNoStimulus.blocks[0]!.rows).toHaveLength(stats.length);
    expect(withItemsButNoStimulus.blocks[0]!.rows).toHaveLength(
      withoutItemsAtAll.blocks[0]!.rows.length,
    );
    expect(withItemsButNoStimulus.blocks[0]!.rowsAnalysed).toBe(
      withoutItemsAtAll.blocks[0]!.rowsAnalysed,
    );
  });

  it("leaves manual item-review exclusions of a REAL (scored) item untouched", () => {
    const excludedRealItemId = stats[0]!.itemId;
    const withManualExclusion = assembleItemAnalysis({
      cycleName: "May 2026",
      assessments: [{ id: ASSESSMENT, name: ASSESSMENT }],
      stats: [...stats, stimulusStat],
      facts: [...facts, ...stimulusFacts],
      items: itemMetas,
      reviews: { [excludedRealItemId]: { exclude: true, reason: "SME call" } },
    });
    const block = withManualExclusion.blocks[0]!;
    // The manually-excluded item STILL has a row (flagged, not removed) —
    // this mechanism is unrelated to the maxScore:0 structural exclusion.
    expect(block.rows).toHaveLength(stats.length);
    const excludedRow = block.rows.find((r) => r.stat.itemId === excludedRealItemId)!;
    expect(excludedRow.exclude).toBe(true);
    expect(excludedRow.removeReason).toBe("SME call");
    // The stimulus item is still gone regardless.
    expect(block.rows.some((r) => r.stat.itemId === stimulusItemId)).toBe(false);
  });

  it("real production data (may-2026): Applicable Math shows 40 scored rows, not 41", () => {
    const provider = new InMemoryDataProvider();
    const data = provider.getItemAnalysisData("may-2026")!;
    const zeroScoreCount = (data.items ?? []).filter((it) => (it.maxScore ?? 1) === 0).length;
    expect(zeroScoreCount).toBeGreaterThan(0); // sanity: the seed really has stimulus items

    const input = assembleItemAnalysis(data);
    const applicableMath = input.blocks.find((b) => b.name === "Applicable Math")!;
    expect(applicableMath.rows).toHaveLength(40);
    expect(applicableMath.rows.every((r) => r.stat.itemId !== "100002785249")).toBe(true);

    const wb = buildItemAnalysisWorkbook(input);
    const aoa = aoaOf(wb as unknown as XLSXR.WorkBook, "Applicable Math");
    const dataRows = aoa.slice(6).filter((r) => r.length > 0);
    expect(dataRows).toHaveLength(40);

    const summaryAoa = aoaOf(wb as unknown as XLSXR.WorkBook, "README & Summary");
    const headerIdx = summaryAoa.findIndex((r) => r[0] === "AssessmentName");
    const amRow = summaryAoa.slice(headerIdx + 1).find((r) => r[0] === "Applicable Math")!;
    expect(amRow[2]).toBe(40); // Items
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
    const reread = XLSXR.read(workbookToBuffer(wb), { type: "buffer", cellStyles: true });
    expect(reread.SheetNames).toEqual([...SCORE_ANALYSIS_SHEETS]);
    // Colour, merges, sizing and AutoFilter (§3 of the export styling fix) must
    // actually survive serialisation — not just exist on the in-memory sheet.
    const summary = reread.Sheets["Overall Scores Summary"]!;
    expect(summary["!merges"]!.length).toBeGreaterThan(0);
    expect(summary["!autofilter"]).toBeDefined();
    expect(summary["!cols"]!.length).toBe(6); // ASSESSMENT_SUMMARY_HEADER's column count
  });
});

describe("score analysis workbook — colour, merges, sizing and AutoFilter scale with data", () => {
  const ASSESSMENT_SUMMARY_HEADER = [
    "AssessmentName",
    "AssessmentTotalScore",
    "NumberOfParticipants",
    "AverageOfParticipantScores",
    "LowestParticipantScore",
    "HighestParticipantScore",
  ];

  /** A minimal, fully synthetic ScoreAnalysisInput — no engine/fixture dependency, so sizes are exact and controllable. */
  function makeInput(opts: {
    assessmentCount: number;
    participantsPerAssessment: number;
    majors: string[];
    demands: string[];
  }) {
    const assessments = Array.from({ length: opts.assessmentCount }, (_, i) => ({
      id: `asm${i}`,
      name: `Assessment ${i}`,
    }));
    const participants = Array.from({ length: opts.participantsPerAssessment }, (_, i) => ({
      id: `p${i}`,
      label: `Participant ${i}`,
    }));
    const scoredResponses: ScoredItemResponse[] = [];
    assessments.forEach((a, ai) => {
      participants.forEach((p, pi) => {
        scoredResponses.push({
          participantId: p.id,
          assessmentId: a.id,
          itemId: `${a.id}-item`,
          majorElement: opts.majors[(ai + pi) % opts.majors.length] ?? null,
          demandLevel: opts.demands[(ai + pi) % opts.demands.length] ?? null,
          score: 1,
          maxScore: 1,
        });
      });
    });
    return { assessments, participants, scoredResponses } satisfies ScoreAnalysisInput;
  }

  it("Summary sheet's Assessment Summary AutoFilter spans exactly the header + N assessment rows, for varying N", () => {
    for (const assessmentCount of [1, 4, 9]) {
      const input = makeInput({ assessmentCount, participantsPerAssessment: 2, majors: ["Number"], demands: ["Recall"] });
      const ws = buildScoreAnalysisWorkbook(input).Sheets["Overall Scores Summary"]!;
      const ref = ws["!autofilter"]!.ref;
      const range = XLSXR.utils.decode_range(ref);
      expect(range.s.r).toBe(9); // header always at row 10 (0-indexed 9), regardless of size
      expect(range.e.r - range.s.r + 1).toBe(assessmentCount + 1); // header + N data rows
      expect(range.e.c - range.s.c + 1).toBe(ASSESSMENT_SUMMARY_HEADER.length);
    }
  });

  it("Summary sheet's section-banner merges shift downward as the assessment block grows, never a fixed address", () => {
    const small = buildScoreAnalysisWorkbook(
      makeInput({ assessmentCount: 1, participantsPerAssessment: 2, majors: ["Number", "Algebra"], demands: ["Recall"] }),
    ).Sheets["Overall Scores Summary"]!;
    const large = buildScoreAnalysisWorkbook(
      makeInput({ assessmentCount: 6, participantsPerAssessment: 2, majors: ["Number", "Algebra"], demands: ["Recall"] }),
    ).Sheets["Overall Scores Summary"]!;
    const smallMajorBanner = small["!merges"]![3]!.s.r;
    const largeMajorBanner = large["!merges"]![3]!.s.r;
    expect(largeMajorBanner).toBeGreaterThan(smallMajorBanner);
    expect(largeMajorBanner - smallMajorBanner).toBe(5); // exactly the 5 extra assessment rows
    // every merge still spans the sheet's real column count, not a hardcoded width
    for (const m of large["!merges"]!) expect(m.e.c - m.s.c + 1).toBe(ASSESSMENT_SUMMARY_HEADER.length);
  });

  it("breakdown sheet AutoFilter spans header + (assessments × participants) rows, for varying sizes", () => {
    for (const [assessmentCount, participantsPerAssessment] of [
      [1, 3],
      [3, 5],
    ] as const) {
      const input = makeInput({ assessmentCount, participantsPerAssessment, majors: ["Number"], demands: ["Recall"] });
      const ws = buildScoreAnalysisWorkbook(input).Sheets["Overall Scores by Assessment"]!;
      const range = XLSXR.utils.decode_range(ws["!autofilter"]!.ref);
      expect(range.s.r).toBe(5); // header always at row 6 (0-indexed 5)
      expect(range.e.r - range.s.r).toBe(assessmentCount * participantsPerAssessment);
    }
  });

  it("breakdown-sheet merge/column width matches that sheet's own header length (6 vs 7 columns)", () => {
    const input = makeInput({ assessmentCount: 2, participantsPerAssessment: 2, majors: ["Number", "Algebra"], demands: ["Recall"] });
    const wb = buildScoreAnalysisWorkbook(input);
    const byAssessment = wb.Sheets["Overall Scores by Assessment"]!;
    const byMajor = wb.Sheets["Overall Scores by Major Element"]!;
    expect(byAssessment["!merges"]![0]!.e.c).toBe(5); // 6-column header (index 0-5)
    expect(byMajor["!merges"]![0]!.e.c).toBe(6); // 7-column header (index 0-6)
  });

  it("column widths grow with actual content length rather than a fixed guess", () => {
    const shortLabels = makeInput({ assessmentCount: 1, participantsPerAssessment: 1, majors: ["Number"], demands: ["Recall"] });
    shortLabels.participants[0]!.label = "P1";
    const longLabels = makeInput({ assessmentCount: 1, participantsPerAssessment: 1, majors: ["Number"], demands: ["Recall"] });
    longLabels.participants[0]!.label = "A Very Long Participant Full Name Indeed";

    const shortWs = buildScoreAnalysisWorkbook(shortLabels).Sheets["Overall Scores by Assessment"]!;
    const longWs = buildScoreAnalysisWorkbook(longLabels).Sheets["Overall Scores by Assessment"]!;
    const nameCol = 2; // "ParticipantFullName" in BY_ASSESSMENT_HEADER
    expect(longWs["!cols"]![nameCol]!.wch!).toBeGreaterThan(shortWs["!cols"]![nameCol]!.wch!);
  });

  it("row-height overrides only touch title/banner rows, not header or data rows", () => {
    const input = makeInput({ assessmentCount: 2, participantsPerAssessment: 2, majors: ["Number"], demands: ["Recall"] });
    const ws = buildScoreAnalysisWorkbook(input).Sheets["Overall Scores Summary"]!;
    const rows = ws["!rows"]!;
    expect(rows[0]!.hpt).toBeDefined(); // title row
    expect(rows[1]?.hpt).toBeUndefined(); // blank row keeps default height
    expect(rows[9]?.hpt).toBeUndefined(); // header row keeps default height
  });

  it("embeds the reference file's real Alsama Brand theme so theme-colour fills resolve to the actual palette", () => {
    const input = makeInput({ assessmentCount: 1, participantsPerAssessment: 1, majors: ["Number"], demands: ["Recall"] });
    const wb = buildScoreAnalysisWorkbook(input) as unknown as { Themes?: { raw: string } };
    expect(wb.Themes?.raw).toContain("Alsama Brand");
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
