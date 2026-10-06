/**
 * Item Analysis workbook — reconciled to the exact layout of the real
 * `MCQ_Item_Analysis` file (Section 9).
 *
 * Workbook structure:
 *   - "README & Summary" sheet: title, purpose, a per-assessment summary table,
 *     a "Methodology & Rating Thresholds" section (pulled live from the
 *     ScoringConfig actually used to rate this cycle's stats), and an
 *     interpretation note.
 *   - one sheet per assessment: a pink title bar, a meta row, a reading-guide
 *     block, the 20-column header on row 6, then one row per item.
 *
 * All formatting (fills, merges, column widths, row heights) is computed here
 * at export time from that cycle's actual data — nothing is injected into a
 * pre-built template, so it holds for any item/assessment count.
 */

import {
  XLSX,
  RATING_STYLES,
  IA_TITLE_STYLE,
  IA_SECTION_TITLE_STYLE,
  IA_META_STYLE,
  IA_GUIDE_STYLE,
  IA_HEADER_STYLE,
  IA_DATA_STYLE,
  mergeRange,
  setColWidths,
  setRowHeights,
  estimateRowHeight,
  sanitizeSheetName,
  styleCell,
  median,
  roundOrNull,
} from "./sheet-utils";
import type { CellStyle } from "./sheet-utils";
import type {
  ItemAnalysisBlock,
  ItemAnalysisInput,
  ItemAnalysisRow,
} from "./types";

/** Canonical per-assessment header (exact column order from the template). */
export const ITEM_ANALYSIS_HEADERS = [
  "QuestionId",
  "QuestionWording",
  "QuestionMajorElement",
  "QuestionSubElement",
  "DemandLevel",
  "Participants Presented",
  "Participants Answered",
  "Avg Response Time (sec)",
  "P-Value",
  "P-Value Rating",
  "Item-Total Correlation",
  "Item-Total Rating",
  "Point-Biserial Correlation",
  "Point-Biserial Rating",
  "Item Discrimination",
  "Discrimination Rating",
  "Overall Item Review",
  "Notes",
  "Remove Item?",
  "Reason for removing item",
] as const;

/** Summary-sheet header (exact column order from the template). */
export const ITEM_ANALYSIS_SUMMARY_HEADERS = [
  "AssessmentName",
  "Participants",
  "Items",
  "Rows",
  "Upper/Lower Group Size",
  "Good Items",
  "Review Items",
  "Flag Items",
  "Median P-Value",
  "Median Item-Total",
  "Median Point-Biserial",
  "Median Discrimination",
] as const;

const READING_GUIDE =
  "Reading guide: Green = psychometrically strong/acceptable, amber = review, " +
  "red = flag for priority review.\nBecause sample size is small, use these " +
  "findings as evidence for expert review rather than automatic item removal.";

const SUMMARY_PURPOSE =
  "Purpose: item-level evidence to help review question quality before deciding " +
  "which MCQ items should contribute to the overall score.";

const IMPORTANT_NOTE =
  "These automated ratings are evidence for expert review, not automatic decisions " +
  "to remove items. With small cohorts, correlation-based statistics (Item-Total, " +
  "Point-Biserial, Discrimination) are noisy — treat a single Flag as a prompt to " +
  "look at the item's wording and options, not as proof the item is faulty. Final " +
  "inclusion/removal decisions are made during Question Review, using this analysis " +
  "as supporting evidence alongside subject-specialist judgement.";

// 0-based indices of the columns that get rating fills.
const RATING_COLUMNS = [9, 11, 13, 15, 16];

// 0-based column → Excel number format, for the numeric (non-rating) statistic
// columns. Every other column is left as general/text.
const NUMBER_FORMATS: Record<number, string> = {
  7: "0.0", // Avg Response Time (sec)
  8: "0.000", // P-Value
  10: "0.000", // Item-Total Correlation
  12: "0.000", // Point-Biserial Correlation
  14: "0.000", // Item Discrimination
};

// Column widths ("wch" units), proportioned from the reference file.
const ASSESSMENT_COL_WIDTHS = [
  10, // QuestionId
  54, // QuestionWording
  19, // QuestionMajorElement
  28, // QuestionSubElement
  11, // DemandLevel
  19, // Participants Presented
  19, // Participants Answered
  21, // Avg Response Time (sec)
  7, // P-Value
  13, // P-Value Rating
  18, // Item-Total Correlation
  13, // Item-Total Rating
  20, // Point-Biserial Correlation
  15, // Point-Biserial Rating
  16, // Item Discrimination
  15, // Discrimination Rating
  16, // Overall Item Review
  46, // Notes
  12, // Remove Item?
  26, // Reason for removing item
];

interface RatingTally {
  good: number;
  review: number;
  flag: number;
}

function tallyRatings(rows: ItemAnalysisRow[]): RatingTally {
  const t: RatingTally = { good: 0, review: 0, flag: 0 };
  for (const r of rows) {
    switch (r.stat.overallReview) {
      case "Good":
        t.good += 1;
        break;
      case "Review":
        t.review += 1;
        break;
      case "Flag":
        t.flag += 1;
        break;
    }
  }
  return t;
}

function buildAssessmentSheet(block: ItemAnalysisBlock): XLSX.WorkSheet {
  const ncols = ITEM_ANALYSIS_HEADERS.length;
  const lastCol = ncols - 1;

  const title = `${block.name} – Item-Level Psychometric Analysis`;
  const meta =
    `Participants: ${block.participants} | Items: ${block.rows.length} | ` +
    `Rows analysed: ${block.rowsAnalysed} | ` +
    `Upper/Lower group size for discrimination: ${block.groupSize} students`;

  const aoa: (string | number | null)[][] = [
    [title],
    [meta],
    [READING_GUIDE],
    [],
    [],
    [...ITEM_ANALYSIS_HEADERS],
  ];

  for (const r of block.rows) {
    const s = r.stat;
    aoa.push([
      s.itemId,
      s.wording ?? null,
      s.majorElement ?? null,
      s.subElement ?? null,
      s.demandLevel ?? null,
      r.participantsPresented,
      r.participantsAnswered,
      r.avgResponseTime,
      s.pValue,
      s.pRating,
      s.itemTotal,
      s.itRating,
      s.pointBiserial,
      s.pbRating,
      s.discrimination,
      s.discRating,
      s.overallReview,
      r.notes,
      r.exclude ? "Yes" : "No",
      r.removeReason,
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Row 1: title bar (pink, Carlito 16pt bold white), merged full width.
  styleCell(ws, 0, 0, IA_TITLE_STYLE);
  mergeRange(ws, 0, 0, 0, lastCol);

  // Row 2: plain participants/items/rows summary, merged full width.
  styleCell(ws, 1, 0, IA_META_STYLE);
  mergeRange(ws, 1, 0, 1, lastCol);

  // Rows 3–4: reading guide, merged as one 2-row-tall block spanning the full
  // width (only the anchor cell needs the value + style; Excel fills the
  // whole merged region from it).
  styleCell(ws, 2, 0, IA_GUIDE_STYLE);
  mergeRange(ws, 2, 0, 3, lastCol);

  // Row 6 (index 5): header — bold, centered, no fill.
  const headerRow = 5;
  for (let c = 0; c < ncols; c++) styleCell(ws, headerRow, c, IA_HEADER_STYLE);

  // Data rows: thin border + wrap/vertical-top everywhere, number formats on
  // the numeric columns, and green/amber/red fills on the rating columns —
  // computed per row from THAT row's actual Good/Review/Flag rating.
  const rowHeights: Record<number, number> = { 0: 40, 1: 17.5, 2: 17.5, 3: 17.5, [headerRow]: 27 };
  block.rows.forEach((r, i) => {
    const rowIdx = headerRow + 1 + i;
    const ratingByCol: Partial<Record<number, string>> = {
      9: r.stat.pRating,
      11: r.stat.itRating,
      13: r.stat.pbRating,
      15: r.stat.discRating,
      16: r.stat.overallReview,
    };
    for (let c = 0; c < ncols; c++) {
      const numFmt = NUMBER_FORMATS[c];
      const rating = ratingByCol[c];
      const ratingStyle = rating ? RATING_STYLES[rating] : undefined;
      styleCell(ws, rowIdx, c, {
        ...IA_DATA_STYLE,
        ...(numFmt ? { numFmt } : {}),
        ...(ratingStyle ?? {}),
      });
    }
    rowHeights[rowIdx] = estimateRowHeight(
      [
        { text: r.stat.wording, colWidthCh: ASSESSMENT_COL_WIDTHS[1]! },
        { text: r.notes, colWidthCh: ASSESSMENT_COL_WIDTHS[17]! },
      ],
      { min: 20 },
    );
  });

  setColWidths(ws, ASSESSMENT_COL_WIDTHS);
  setRowHeights(ws, rowHeights);
  // No frozen panes — the reference file doesn't use them.

  return ws;
}

/** One row of the "Methodology & Rating Thresholds" table. */
interface MethodologyRow {
  metric: string;
  definition: string;
  good: string;
  review: string;
  flag: string;
  note: string;
}

/**
 * Build the methodology table's rows straight from the ScoringConfig thresholds
 * actually used to rate this cycle's stats, so the documented bands can never
 * drift from the real ones applied to the rating-column fills above.
 */
function methodologyRows(q: ItemAnalysisInput["qualityThresholds"]): MethodologyRow[] {
  return [
    {
      metric: "P-Value (item difficulty)",
      definition: "Mean score on the item across all participants who answered it (0–1).",
      good: `${q.pValue.reviewBelow}–${q.pValue.goodUpTo}`,
      review: `${q.pValue.flagBelow}–${q.pValue.reviewBelow} or ${q.pValue.goodUpTo}–${q.pValue.reviewUpTo}`,
      flag: `below ${q.pValue.flagBelow} or above ${q.pValue.reviewUpTo}`,
      note: "Two-sided: an item can be flagged for being too hard OR too easy.",
    },
    {
      metric: "Item-Total Correlation",
      definition: "Corrected item-total correlation (item score vs the total of the OTHER items).",
      good: `${q.itemTotal.reviewBelow} or above`,
      review: `${q.itemTotal.flagBelow}–${q.itemTotal.reviewBelow}`,
      flag: `below ${q.itemTotal.flagBelow}`,
      note: "Undefined (zero variance) is treated as Flag.",
    },
    {
      metric: "Point-Biserial Correlation",
      definition: "Point-biserial correlation (item score vs the full total, including the item itself).",
      good: `${q.pointBiserial.reviewBelow} or above`,
      review: `${q.pointBiserial.flagBelow}–${q.pointBiserial.reviewBelow}`,
      flag: `below ${q.pointBiserial.flagBelow}`,
      note: "Undefined (zero variance) is treated as Flag.",
    },
    {
      metric: "Item Discrimination",
      definition: "Upper-minus-lower discrimination, comparing the top and bottom ~1/3 of scorers.",
      good: `${q.discrimination.reviewBelow} or above`,
      review: `${q.discrimination.flagBelow}–${q.discrimination.reviewBelow}`,
      flag: `below ${q.discrimination.flagBelow}`,
      note: "A negative value means lower scorers outperformed higher scorers on this item.",
    },
  ];
}

const METHODOLOGY_HEADERS = ["Metric", "Definition Used", "Good", "Review", "Flag", "Important Note"] as const;

function buildSummarySheet(input: ItemAnalysisInput): XLSX.WorkSheet {
  const ncols = ITEM_ANALYSIS_SUMMARY_HEADERS.length;
  const lastCol = ncols - 1;
  const colWidths = [32, 40, 14, 14, 14, 40, 14, 14, 14, 16, 16, 16];

  const aoa: (string | number | null)[][] = [];
  const styles: { row: number; col: number; style: CellStyle }[] = [];
  const merges: [number, number, number, number][] = [];
  const rowHeights: Record<number, number> = {};

  const pushRow = (cells: (string | number | null)[] = []): number => {
    aoa.push(cells);
    return aoa.length - 1;
  };

  // Title bar.
  const titleRow = pushRow([`G12++ MCQ Psychometric Item Analysis – ${input.cycleName}`]);
  styles.push({ row: titleRow, col: 0, style: IA_TITLE_STYLE });
  merges.push([titleRow, 0, titleRow, lastCol]);
  rowHeights[titleRow] = 40;

  // Purpose.
  const purposeRow = pushRow([SUMMARY_PURPOSE]);
  styles.push({ row: purposeRow, col: 0, style: IA_GUIDE_STYLE });
  merges.push([purposeRow, 0, purposeRow, lastCol]);

  pushRow(); // blank spacer

  // Per-assessment summary table — bold header, no fill.
  const headerRow = pushRow([...ITEM_ANALYSIS_SUMMARY_HEADERS]);
  for (let c = 0; c < ncols; c++) styles.push({ row: headerRow, col: c, style: IA_HEADER_STYLE });
  rowHeights[headerRow] = 27;

  for (const block of input.blocks) {
    const tally = tallyRatings(block.rows);
    const r = pushRow([
      block.name,
      block.participants,
      block.rows.length,
      block.rowsAnalysed,
      block.groupSize,
      tally.good,
      tally.review,
      tally.flag,
      roundOrNull(median(block.rows.map((x) => x.stat.pValue)), 3),
      roundOrNull(median(block.rows.map((x) => x.stat.itemTotal)), 3),
      roundOrNull(median(block.rows.map((x) => x.stat.pointBiserial)), 3),
      roundOrNull(median(block.rows.map((x) => x.stat.discrimination)), 3),
    ]);
    for (let c = 0; c < ncols; c++) styles.push({ row: r, col: c, style: IA_DATA_STYLE });
  }

  pushRow(); // blank spacer

  // Methodology & Rating Thresholds — read from the real ScoringConfig used to
  // rate this cycle, so this table can never drift from the actual fills above.
  const methodTitleRow = pushRow(["Methodology & Rating Thresholds"]);
  styles.push({ row: methodTitleRow, col: 0, style: IA_SECTION_TITLE_STYLE });
  merges.push([methodTitleRow, 0, methodTitleRow, lastCol]);

  const methodHeaderRow = pushRow([...METHODOLOGY_HEADERS]);
  for (let c = 0; c < METHODOLOGY_HEADERS.length; c++) {
    styles.push({ row: methodHeaderRow, col: c, style: IA_HEADER_STYLE });
  }

  for (const m of methodologyRows(input.qualityThresholds)) {
    const cells = [m.metric, m.definition, m.good, m.review, m.flag, m.note];
    const r = pushRow(cells);
    for (let c = 0; c < cells.length; c++) styles.push({ row: r, col: c, style: IA_DATA_STYLE });
    rowHeights[r] = estimateRowHeight(
      cells.map((text, c) => ({ text, colWidthCh: colWidths[c] ?? 16 })),
      { min: 20 },
    );
  }

  pushRow(); // blank spacer

  // Important interpretation note.
  const noteTitleRow = pushRow(["Important interpretation note"]);
  styles.push({ row: noteTitleRow, col: 0, style: IA_SECTION_TITLE_STYLE });
  merges.push([noteTitleRow, 0, noteTitleRow, lastCol]);

  const noteRow = pushRow([IMPORTANT_NOTE]);
  styles.push({ row: noteRow, col: 0, style: IA_GUIDE_STYLE });
  merges.push([noteRow, 0, noteRow, lastCol]);
  const fullWidthCh = colWidths.reduce((a, b) => a + b, 0);
  rowHeights[noteRow] = estimateRowHeight([{ text: IMPORTANT_NOTE, colWidthCh: fullWidthCh }], { min: 30 });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (const { row, col, style } of styles) styleCell(ws, row, col, style);
  for (const [r1, c1, r2, c2] of merges) mergeRange(ws, r1, c1, r2, c2);
  setColWidths(ws, colWidths);
  setRowHeights(ws, rowHeights);

  return ws;
}

export function buildItemAnalysisWorkbook(input: ItemAnalysisInput): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();

  // README & Summary first.
  XLSX.utils.book_append_sheet(
    wb,
    buildSummarySheet(input),
    sanitizeSheetName("README & Summary", used),
  );

  for (const block of input.blocks) {
    XLSX.utils.book_append_sheet(
      wb,
      buildAssessmentSheet(block),
      sanitizeSheetName(block.name, used),
    );
  }

  return wb;
}
