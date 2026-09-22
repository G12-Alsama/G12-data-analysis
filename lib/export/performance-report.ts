/**
 * Students' Performance Report workbook — generated to match
 * `Students_Performance_Report_Final_May2026.xlsx` (design-reference) exactly:
 * title bars, the 4-tier performance/award color scale, borders, hyperlinks,
 * the Alsama logo, and frozen headers.
 *
 * Three matched sheets, then the clearly-additional Alterations and Audit
 * Trail sheets appended after them:
 *
 *  1. `Class Performance` — per assessment × major-element, the proportion of
 *     students at each performance level, then the overall award-level
 *     distribution.
 *  2. `Student Summary` — one row per student: ID, name (linked to their
 *     profile card), award level, the canonical subject performance levels,
 *     and an Open Profile link, with a Legend block.
 *  3. `Student Profiles` — a repeating fixed-size per-student card: name bar
 *     (linked back to the summary row), award, then each subject's overall
 *     level and a bulleted major-element breakdown.
 *
 * Built on ExcelJS rather than the xlsx-js-style/xlsx pair the other export
 * builders use — neither of those can write an embedded image or a freeze
 * pane, and both are required by the reference design (confirmed against the
 * reference file itself: the logo is anchored top-left of the header on
 * `Student Summary` and `Student Profiles`, and all three sheets freeze the
 * header row). `buildPerformanceReportWorkbook` therefore returns a
 * ready-to-download `Buffer` instead of the shared `XLSX.WorkBook` shape —
 * see `downloadXlsxBuffer` in lib/ui/export.ts.
 *
 * Nothing here is hardcoded to the May 2026 sample: subject count, major
 * elements per subject, and student count are all read from `input`. The
 * 4-tier color scale is keyed off a value's RANK among the configured
 * performance/award levels (`colorForLevel` in sheet-utils.ts), never by
 * string-matching label text.
 *
 * A handful of cells in the reference file are themselves inconsistent
 * (confirmed by inspection): the Student Summary award-level column relies on
 * a live conditional-format rule pointing at mis-colored legend swatches, a
 * few Student Profiles subject-performance cells are colored for the wrong
 * tier, and the Student Summary ⇄ Student Profiles hyperlinks are off by one
 * row in both directions. This builder computes every color from the cell's
 * actual value and computes both hyperlink directions from the same shared
 * row formula, which corrects all of the above rather than reproducing them.
 */

import ExcelJS from "exceljs";
import {
  colorForLevel,
  PERFORMANCE_REPORT_BRAND,
  PERFORMANCE_REPORT_BORDER,
  PERFORMANCE_REPORT_TEXT,
  PERFORMANCE_REPORT_LEGEND_ACCENT,
  PERFORMANCE_REPORT_FONT,
} from "./sheet-utils";
import { ALSAMA_LOGO_PNG_BASE64 } from "./assets/alsama-logo";
import { ALTERATION_HEADERS, ALTERATIONS_SHEET_NAME } from "./alterations";
import type { GradeAuditEntry, AlterationRecord } from "./types";

export const PERFORMANCE_REPORT_SHEETS = [
  "Class Performance",
  "Student Summary",
  "Student Profiles",
] as const;

export const STUDENT_SUMMARY_HEADERS = [
  "Student ID",
  "Student Name",
  "Award Level",
  "Applicable Maths",
  "Scientific Thinking",
  "Arabic 1st Language",
  "English 2nd Language",
  "Life Success Skills",
  "Open Profile",
] as const;

/** One assessment/subject with its ordered major elements. */
export interface PRSubject {
  assessmentId: string;
  name: string;
  majorElements: string[];
  /** Major element → its ordered sub-elements (construct structure, from data). */
  subElements?: Record<string, string[]>;
}

/** A student's result on one subject: overall level + per-element + per-sub-element levels. */
export interface PRStudentSubject {
  level: string;
  elements: Record<string, string>;
  /** Major element → (sub-element → level). Finer-grained breakdown. */
  subElements?: Record<string, Record<string, string>>;
}

export interface PRStudent {
  participantId: string;
  name: string;
  award: string;
  /** Keyed by assessmentId. */
  subjects: Record<string, PRStudentSubject>;
}

/** A canonical Student-Summary column mapped to a suite assessment by alias. */
export interface PRSummarySubject {
  label: string;
  assessmentId: string | null;
}

export interface PerformanceReportInput {
  cycleName: string;
  /** Performance levels, best → lowest. */
  performanceLevels: string[];
  /** Award levels, best → lowest. */
  awardLevels: string[];
  /** Assessments with their major elements (Class Performance + Profiles). */
  subjects: PRSubject[];
  /** The five canonical Student-Summary columns (by alias). */
  summarySubjects: PRSummarySubject[];
  students: PRStudent[];
  awardDistribution: { level: string; count: number; pct: number }[];
  alterations: AlterationRecord[];
  audit: GradeAuditEntry[];
}

const AUDIT_HEADER = ["Timestamp", "Actor", "Action", "Detail", "Entity", "EntityId"];

const argb = (hex: string) => `FF${hex}`;
const WHITE = argb("FFFFFF");
const BRAND = argb(PERFORMANCE_REPORT_BRAND);
const BORDER = argb(PERFORMANCE_REPORT_BORDER);
const DARK = argb(PERFORMANCE_REPORT_TEXT);
const LEGEND_ACCENT = argb(PERFORMANCE_REPORT_LEGEND_ACCENT);

/** A card on Student Profiles is: name + award + column-header + one row per subject + spacer. */
function profileCardRowCount(numSubjects: number): number {
  return numSubjects + 4;
}

/** The 1-based row of student `index`'s name-bar on Student Profiles (row 1 = title, row 2 = spacer). */
function profileCardStartRow(numSubjects: number, index: number): number {
  return 3 + index * profileCardRowCount(numSubjects);
}

/** The 1-based row of student `index`'s data row on Student Summary (row 1 = title, row 2 = spacer, row 3 = header). */
function summaryStudentRow(index: number): number {
  return 4 + index;
}

type Font = Partial<ExcelJS.Font>;
type Alignment = Partial<ExcelJS.Alignment>;

function style(
  cell: ExcelJS.Cell,
  opts: { font?: Font; fill?: string; align?: Alignment; numFmt?: string; border?: boolean },
): void {
  if (opts.font) cell.font = { name: PERFORMANCE_REPORT_FONT, ...opts.font };
  if (opts.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } };
  if (opts.align) cell.alignment = opts.align;
  if (opts.numFmt) cell.numFmt = opts.numFmt;
  if (opts.border) cell.border = { bottom: { style: "thin", color: { argb: BORDER } } };
}

function hyperlinkCell(cell: ExcelJS.Cell, text: string, sheet: string, target: string): void {
  // No leading "#" — matches the reference file's own internal-hyperlink
  // `location` attribute exactly (confirmed by inspecting its raw XML).
  cell.value = { text, hyperlink: `'${sheet}'!${target}` };
  cell.font = { name: PERFORMANCE_REPORT_FONT, size: 11, color: { argb: BRAND }, underline: true };
}

/** Anchor the Alsama logo top-left of row 1 (roughly one row tall), matching the reference file. */
function addHeaderLogo(ws: ExcelJS.Worksheet, imageId: number): void {
  ws.addImage(imageId, {
    tl: { col: 0.02, row: 0.02 },
    ext: { width: 73, height: 62 },
    editAs: "oneCell",
  });
}

function titleBar(
  ws: ExcelJS.Worksheet,
  lastCol: number,
  text: string,
  opts: { height: number; align?: "left" | "center" },
): void {
  ws.mergeCells(1, 1, 1, lastCol);
  const cell = ws.getCell(1, 1);
  cell.value = text;
  style(cell, {
    font: { size: 16, bold: true, color: { argb: WHITE } },
    fill: BRAND,
    align: { horizontal: opts.align ?? "left", vertical: "middle" },
  });
  ws.getRow(1).height = opts.height;
}

/** Fraction (0–1) of `values` equal to `target`, over defined entries. */
function proportionAt(values: (string | undefined)[], target: string): number {
  const defined = values.filter((v) => v != null && v !== "");
  if (defined.length === 0) return 0;
  const n = defined.filter((v) => v === target).length;
  return n / defined.length;
}

function buildClassPerformanceSheet(wb: ExcelJS.Workbook, input: PerformanceReportInput): void {
  const ws = wb.addWorksheet("Class Performance");
  const levels = input.performanceLevels;

  type Col = { kind: "overall" | "element"; assessmentId: string; element?: string };
  const cols: Col[] = [];
  const blocks: { name: string; start: number; span: number }[] = [];
  let col = 2; // excel column; col 1 is the row-label column
  for (const s of input.subjects) {
    const start = col;
    cols.push({ kind: "overall", assessmentId: s.assessmentId });
    col += 1;
    for (const el of s.majorElements) {
      cols.push({ kind: "element", assessmentId: s.assessmentId, element: el });
      col += 1;
    }
    blocks.push({ name: s.name, start, span: 1 + s.majorElements.length });
  }
  const lastCol = Math.max(col - 1, 1);

  const valueFor = (c: Col, level: string): number => {
    const vals = input.students.map((st) => {
      const subj = st.subjects[c.assessmentId];
      if (!subj) return undefined;
      return c.kind === "overall" ? subj.level : subj.elements[c.element!];
    });
    return proportionAt(vals, level);
  };

  titleBar(ws, lastCol, "Class Performance Report", { height: 31.5, align: "left" });
  ws.getRow(2).height = 4.5;

  // Row 3: per-subject group header band.
  ws.getRow(3).height = 19.5;
  for (const b of blocks) {
    if (b.span > 1) ws.mergeCells(3, b.start, 3, b.start + b.span - 1);
    const cell = ws.getCell(3, b.start);
    cell.value = b.name;
    style(cell, {
      font: { size: 11, bold: true, color: { argb: WHITE } },
      fill: BRAND,
      align: { horizontal: "center", vertical: "middle" },
    });
  }

  // Row 4: "% Performance" + per-subject total/element headers.
  ws.getRow(4).height = 54;
  const labelHeader = ws.getCell(4, 1);
  labelHeader.value = "% Performance";
  style(labelHeader, {
    font: { size: 10, bold: true, color: { argb: DARK } },
    align: { horizontal: "center", vertical: "middle" },
    border: true,
  });
  cols.forEach((c, i) => {
    const cell = ws.getCell(4, 2 + i);
    if (c.kind === "overall") {
      const subj = input.subjects.find((s) => s.assessmentId === c.assessmentId)!;
      cell.value = subj.name;
      style(cell, {
        font: { size: 10, bold: true, color: { argb: DARK } },
        align: { horizontal: "center", vertical: "middle", wrapText: true },
        border: true,
      });
    } else {
      cell.value = c.element!;
      style(cell, {
        font: { size: 9, bold: false, color: { argb: DARK } },
        align: { horizontal: "center", vertical: "middle", wrapText: true },
        border: true,
      });
    }
  });

  // Rows 5..: one row per performance level, best → worst.
  levels.forEach((lvl, li) => {
    const row = 5 + li;
    const { fill, text } = colorForLevel(li, "classPerformance");
    const labelCell = ws.getCell(row, 1);
    labelCell.value = lvl;
    style(labelCell, {
      font: { size: 10, bold: true, color: { argb: argb(text) } },
      fill: argb(fill),
      align: { horizontal: "left", vertical: "middle" },
      border: true,
    });
    cols.forEach((c, ci) => {
      const cell = ws.getCell(row, 2 + ci);
      cell.value = valueFor(c, lvl);
      style(cell, {
        font: { size: 10, bold: c.kind === "overall", color: { argb: argb(text) } },
        fill: argb(fill),
        align: { horizontal: "center", vertical: "middle" },
        numFmt: "0%",
        border: true,
      });
    });
  });

  // Award Level Distribution block, two rows below the last tier row.
  const awardTitleRow = 5 + levels.length + 1;
  ws.mergeCells(awardTitleRow, 1, awardTitleRow, lastCol);
  const awardTitle = ws.getCell(awardTitleRow, 1);
  awardTitle.value = "Award Level Distribution";
  style(awardTitle, { font: { size: 12, bold: true, color: { argb: WHITE } }, fill: BRAND });
  ws.getRow(awardTitleRow).height = 15.75;

  const awardHeaderRow = awardTitleRow + 1;
  ["Award Level", "Number of Students", "% of Class"].forEach((h, i) => {
    const cell = ws.getCell(awardHeaderRow, 1 + i);
    cell.value = h;
    style(cell, { font: { size: 10, bold: true, color: { argb: DARK } }, border: true });
  });
  ws.getRow(awardHeaderRow).height = 25.5;

  input.awardDistribution.forEach((d, i) => {
    const row = awardHeaderRow + 1 + i;
    const { fill, text } = colorForLevel(i, "classPerformance");
    const cells = [d.level, d.count, d.pct / 100];
    cells.forEach((v, ci) => {
      const cell = ws.getCell(row, 1 + ci);
      cell.value = v;
      style(cell, {
        font: { size: 10, bold: ci !== 1, color: { argb: argb(text) } },
        fill: argb(fill),
        numFmt: ci === 2 ? "0%" : undefined,
        border: true,
      });
    });
  });

  ws.getColumn(1).width = 22;
  cols.forEach((c, i) => {
    ws.getColumn(2 + i).width = c.kind === "overall" ? 16 : 14;
  });
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 4, topLeftCell: "B5", activeCell: "B5" }];
}

function buildStudentSummarySheet(wb: ExcelJS.Workbook, input: PerformanceReportInput, logoImageId: number): void {
  const ws = wb.addWorksheet("Student Summary");
  const levels = input.performanceLevels;
  const numSubjects = input.summarySubjects.length;
  const openProfileCol = 4 + numSubjects;
  const legendCol = openProfileCol + 2;

  titleBar(ws, openProfileCol, "Students' Performance Report", { height: 47.25, align: "center" });
  addHeaderLogo(ws, logoImageId);
  ws.getRow(2).height = 21;

  // Header row.
  const headers = [
    "Student ID",
    "Student Name",
    "Award Level",
    ...input.summarySubjects.map((s) => s.label),
    "Open Profile",
  ];
  headers.forEach((h, i) => {
    const cell = ws.getCell(3, 1 + i);
    cell.value = h;
    style(cell, {
      font: { size: 11, bold: true, color: { argb: WHITE } },
      fill: BRAND,
      align: { horizontal: "center", vertical: "middle", wrapText: true },
      border: true,
    });
  });
  ws.getRow(3).height = 29.25;

  // Legend block, in a column to the right of a one-column gap.
  const legendTitle = ws.getCell(1, legendCol);
  legendTitle.value = "Legend";
  style(legendTitle, { font: { size: 12, bold: true, color: { argb: BRAND } } });

  const awardHeader = ws.getCell(3, legendCol);
  awardHeader.value = "Award levels";
  style(awardHeader, { font: { size: 11, bold: true, color: { argb: BRAND } } });

  input.awardLevels.forEach((lvl, i) => {
    const { fill } = colorForLevel(i, "summary");
    const cell = ws.getCell(4 + i, legendCol);
    cell.value = lvl;
    style(cell, {
      font: { size: 11, color: { argb: DARK } },
      fill: argb(fill),
      align: { horizontal: "center", vertical: "middle" },
      border: true,
    });
  });

  const perfHeaderRow = 4 + input.awardLevels.length + 1;
  const perfHeader = ws.getCell(perfHeaderRow, legendCol);
  perfHeader.value = "Performance levels";
  style(perfHeader, { font: { size: 11, bold: true, color: { argb: LEGEND_ACCENT } } });

  levels.forEach((lvl, i) => {
    const { fill } = colorForLevel(i, "summary");
    const cell = ws.getCell(perfHeaderRow + 1 + i, legendCol);
    cell.value = lvl;
    style(cell, {
      font: { size: 11, color: { argb: DARK } },
      fill: argb(fill),
      align: { horizontal: "center", vertical: "middle" },
      border: true,
    });
  });

  // Data rows.
  input.students.forEach((st, i) => {
    const row = summaryStudentRow(i);
    ws.getRow(row).height = 19.95;
    const cardTarget = `A${profileCardStartRow(numSubjects, i)}`;

    const idCell = ws.getCell(row, 1);
    idCell.value = st.participantId;
    style(idCell, {
      font: { size: 11, color: { argb: BRAND } },
      align: { horizontal: "center", vertical: "middle" },
      border: true,
    });

    const nameCell = ws.getCell(row, 2);
    hyperlinkCell(nameCell, st.name, "Student Profiles", cardTarget);
    nameCell.alignment = { horizontal: "center", vertical: "middle" };
    style(nameCell, { border: true });

    const awardRank = input.awardLevels.indexOf(st.award);
    const awardStyle = colorForLevel(awardRank < 0 ? levels.length - 1 : awardRank, "summary");
    const awardCell = ws.getCell(row, 3);
    awardCell.value = st.award;
    style(awardCell, {
      font: { size: 11, color: { argb: argb(awardStyle.text) } },
      fill: argb(awardStyle.fill),
      align: { horizontal: "center", vertical: "middle" },
      border: true,
    });

    input.summarySubjects.forEach((subj, si) => {
      const lvl = subj.assessmentId ? st.subjects[subj.assessmentId]?.level : undefined;
      const rank = lvl ? levels.indexOf(lvl) : -1;
      const cell = ws.getCell(row, 4 + si);
      cell.value = lvl ?? "";
      if (rank >= 0) {
        const s = colorForLevel(rank, "summary");
        style(cell, {
          font: { size: 11, color: { argb: argb(s.text) } },
          fill: argb(s.fill),
          align: { horizontal: "center", vertical: "middle" },
          border: true,
        });
      } else {
        style(cell, {
          font: { size: 11, color: { argb: DARK } },
          align: { horizontal: "center", vertical: "middle" },
          border: true,
        });
      }
    });

    const openCell = ws.getCell(row, openProfileCol);
    hyperlinkCell(openCell, "Open profile", "Student Profiles", cardTarget);
    openCell.alignment = { horizontal: "center", vertical: "middle" };
    style(openCell, { border: true });
  });

  ws.getColumn(1).width = 16;
  ws.getColumn(2).width = 22;
  ws.getColumn(3).width = 24;
  for (let i = 0; i < numSubjects; i++) ws.getColumn(4 + i).width = 20;
  ws.getColumn(openProfileCol).width = 14;
  ws.getColumn(openProfileCol + 1).width = 3;
  ws.getColumn(legendCol).width = 32;

  ws.views = [{ state: "frozen", xSplit: 0, ySplit: 3, topLeftCell: "A4", activeCell: "A4" }];
}

function buildStudentProfilesSheet(wb: ExcelJS.Workbook, input: PerformanceReportInput, logoImageId: number): void {
  const ws = wb.addWorksheet("Student Profiles");
  const levels = input.performanceLevels;
  const numSubjects = input.summarySubjects.length;
  const lastCol = 8; // fixed card width: A..H, regardless of subject count

  titleBar(ws, lastCol, "Student Profiles", { height: 46.5, align: "center" });
  addHeaderLogo(ws, logoImageId);
  ws.getRow(2).height = 6;

  const elementCountByAssessment = new Map(input.subjects.map((s) => [s.assessmentId, s.majorElements.length]));

  input.students.forEach((st, i) => {
    const nameRow = profileCardStartRow(numSubjects, i);
    const awardRow = nameRow + 1;
    const headerRow = nameRow + 2;
    const firstSubjectRow = nameRow + 3;
    const spacerRow = nameRow + 3 + numSubjects;
    const summaryTarget = `A${summaryStudentRow(i)}`;

    // Name bar + Back link.
    ws.mergeCells(nameRow, 1, nameRow, lastCol - 1);
    const nameCell = ws.getCell(nameRow, 1);
    nameCell.value = st.name;
    style(nameCell, {
      font: { size: 13, bold: true, color: { argb: WHITE } },
      fill: BRAND,
      align: { horizontal: "left", vertical: "middle" },
      border: true,
    });
    const backCell = ws.getCell(nameRow, lastCol);
    hyperlinkCell(backCell, "Back", "Student Summary", summaryTarget);
    backCell.font = { name: PERFORMANCE_REPORT_FONT, size: 11, bold: true, color: { argb: BRAND } };
    style(backCell, { fill: WHITE, align: { horizontal: "center", vertical: "middle" }, border: true });
    ws.getRow(nameRow).height = 22.2;

    // Award Level row.
    ws.mergeCells(awardRow, 2, awardRow, lastCol);
    const awardLabel = ws.getCell(awardRow, 1);
    awardLabel.value = "Award Level";
    style(awardLabel, {
      font: { size: 11, bold: true, color: { argb: BRAND } },
      fill: WHITE,
      align: { vertical: "middle" },
      border: true,
    });
    const awardValue = ws.getCell(awardRow, 2);
    awardValue.value = st.award;
    style(awardValue, {
      font: { size: 11, bold: true, color: { argb: BRAND } },
      fill: WHITE,
      align: { horizontal: "center", vertical: "middle", wrapText: true },
      border: true,
    });
    ws.getRow(awardRow).height = 22.2;

    // Column header row.
    ws.mergeCells(headerRow, 3, headerRow, lastCol);
    const subjectHead = ws.getCell(headerRow, 1);
    subjectHead.value = "Subject";
    style(subjectHead, {
      font: { size: 11, bold: true, color: { argb: BRAND } },
      fill: WHITE,
      align: { horizontal: "center", vertical: "middle" },
      border: true,
    });
    const perfHead = ws.getCell(headerRow, 2);
    perfHead.value = "Subject Performance";
    style(perfHead, {
      font: { size: 11, bold: true, color: { argb: BRAND } },
      fill: WHITE,
      align: { horizontal: "left", vertical: "middle" },
      border: true,
    });
    const elementsHead = ws.getCell(headerRow, 3);
    elementsHead.value = "Major Elements Performance";
    style(elementsHead, {
      font: { size: 11, bold: true, color: { argb: BRAND } },
      fill: WHITE,
      align: { horizontal: "center", vertical: "middle" },
      border: true,
    });
    ws.getRow(headerRow).height = 24;

    // One row per subject.
    input.summarySubjects.forEach((subj, si) => {
      const row = firstSubjectRow + si;
      const result = subj.assessmentId ? st.subjects[subj.assessmentId] : undefined;
      const level = result?.level ?? "—";
      const rank = result ? levels.indexOf(result.level) : -1;

      const subjectCell = ws.getCell(row, 1);
      subjectCell.value = subj.label;
      style(subjectCell, {
        font: { size: 11, bold: true, color: { argb: DARK } },
        align: { horizontal: "left", vertical: "top" },
        border: true,
      });

      const perfCell = ws.getCell(row, 2);
      perfCell.value = level;
      if (rank >= 0) {
        const s = colorForLevel(rank, "summary");
        style(perfCell, {
          font: { size: 11, bold: true, color: { argb: argb(s.text) } },
          fill: argb(s.fill),
          align: { horizontal: "center", vertical: "middle" },
          border: true,
        });
      } else {
        style(perfCell, {
          font: { size: 11, bold: true, color: { argb: DARK } },
          align: { horizontal: "center", vertical: "middle" },
          border: true,
        });
      }

      ws.mergeCells(row, 3, row, lastCol);
      const bulletCell = ws.getCell(row, 3);
      const majorElements = subj.assessmentId
        ? (input.subjects.find((s) => s.assessmentId === subj.assessmentId)?.majorElements ?? Object.keys(result?.elements ?? {}))
        : Object.keys(result?.elements ?? {});
      const bullets = result
        ? majorElements.map((el) => `• ${el}: ${result.elements[el] ?? "—"}`).join("\n") || "—"
        : "—";
      bulletCell.value = bullets;
      style(bulletCell, {
        font: { size: 10, bold: false, color: { argb: DARK } },
        fill: WHITE,
        align: { horizontal: "left", vertical: "top", wrapText: true },
        border: true,
      });

      const n = subj.assessmentId ? (elementCountByAssessment.get(subj.assessmentId) ?? majorElements.length) : majorElements.length;
      ws.getRow(row).height = 14.25 * (Math.max(n, 1) + 1);
    });

    ws.getRow(spacerRow).height = 8;
  });

  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 26;
  ws.getColumn(3).width = 18;
  ws.getColumn(4).width = 9;
  ws.getColumn(5).width = 9;
  ws.getColumn(6).width = 9;
  ws.getColumn(7).width = 9;
  ws.getColumn(8).width = 12;
}

function buildAlterationsSheetXlsx(wb: ExcelJS.Workbook, records: readonly AlterationRecord[]): void {
  const ws = wb.addWorksheet(ALTERATIONS_SHEET_NAME);
  const headers = [...ALTERATION_HEADERS];
  headers.forEach((h, i) => {
    const cell = ws.getCell(1, 1 + i);
    cell.value = h;
    style(cell, { font: { bold: true }, fill: argb("E7E6E6"), align: { vertical: "middle", wrapText: true } });
  });
  if (records.length === 0) {
    ws.mergeCells(2, 1, 2, headers.length);
    const cell = ws.getCell(2, 1);
    cell.value = "No alterations recorded for this cycle.";
    cell.font = { name: PERFORMANCE_REPORT_FONT, italic: true, color: { argb: argb("595959") } };
  } else {
    records.forEach((r, i) => {
      const row = 2 + i;
      const values = [r.participantId, r.participantName, r.subject, r.marks, r.reason, r.decidedBy, r.decidedAt, r.sourceIncident ?? null];
      values.forEach((v, ci) => {
        ws.getCell(row, 1 + ci).value = v;
      });
    });
  }
  ws.columns = [{ width: 14 }, { width: 18 }, { width: 22 }, { width: 11 }, { width: 34 }, { width: 18 }, { width: 20 }, { width: 28 }];
}

function buildAuditTrailSheetXlsx(wb: ExcelJS.Workbook, input: PerformanceReportInput): void {
  const ws = wb.addWorksheet("Audit Trail");
  const title = ws.getCell(1, 1);
  title.value = `Audit Trail — ${input.cycleName}`;
  title.font = { name: PERFORMANCE_REPORT_FONT, bold: true, size: 14 };
  AUDIT_HEADER.forEach((h, i) => {
    const cell = ws.getCell(3, 1 + i);
    cell.value = h;
    style(cell, { font: { bold: true }, fill: argb("E7E6E6"), align: { vertical: "middle", wrapText: true } });
  });
  input.audit.forEach((e, i) => {
    const row = 4 + i;
    const values = [e.timestamp, e.actor, e.action, e.detail, e.entity, e.entityId];
    values.forEach((v, ci) => {
      ws.getCell(row, 1 + ci).value = v;
    });
  });
  ws.columns = [{ width: 22 }, { width: 18 }, { width: 22 }, { width: 44 }, { width: 14 }, { width: 14 }];
}

export async function buildPerformanceReportWorkbook(input: PerformanceReportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const logoImageId = wb.addImage({ base64: ALSAMA_LOGO_PNG_BASE64, extension: "png" });
  buildClassPerformanceSheet(wb, input);
  buildStudentSummarySheet(wb, input, logoImageId);
  buildStudentProfilesSheet(wb, input, logoImageId);
  buildAlterationsSheetXlsx(wb, input.alterations);
  buildAuditTrailSheetXlsx(wb, input);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
