/**
 * Client-side export helpers shared by every analysis screen.
 *
 * The convention across screens (Mimi: "all analysis exported as xlsx or csv"):
 *   - CSV  = the screen's primary tabular data (one flat sheet).
 *   - XLSX = the full multi-sheet workbook that matches the team's reference
 *            formats (built by the lib/export builders).
 *
 * Live exports carry real names; they only ever run in the authenticated
 * context the rest of the live data already lives in, and nothing here persists.
 */
import type { XLSX as XLSXType } from "@/lib/export/sheet-utils";

const CSV_MIME = "text/csv;charset=utf-8";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Quote a single CSV cell (RFC-4180: wrap in quotes, double internal quotes). */
export function csvCell(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

/** Serialise header + rows to a CSV string. */
export function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return lines.join("\r\n");
}

/** Build a CSV from header + rows and download it. */
export function downloadCsv(filename: string, headers: readonly string[], rows: readonly unknown[][]): void {
  downloadBlob(new Blob([toCsv(headers, rows)], { type: CSV_MIME }), filename);
}

/** Serialise a workbook (xlsx-js-style) to bytes and download it. */
export async function downloadWorkbook(filename: string, wb: XLSXType.WorkBook): Promise<void> {
  const { workbookToBuffer } = await import("@/lib/export/sheet-utils");
  const buf = workbookToBuffer(wb);
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  downloadBlob(new Blob([bytes], { type: XLSX_MIME }), filename);
}

/**
 * Download an already-serialised xlsx buffer directly — e.g. from
 * `buildPerformanceReportWorkbook` (ExcelJS, for an embedded image and freeze
 * panes) or from the Assessment Health report builders, whose `bytes()` has
 * patched real conditional-formatting XML into an xlsx-js-style base file
 * (see lib/export/ooxml-cf.ts). Either way the caller already has finished
 * bytes, not the shared xlsx-js-style WorkBook shape.
 */
export function downloadXlsxBuffer(filename: string, buf: ArrayBuffer | Uint8Array): void {
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  downloadBlob(new Blob([bytes], { type: XLSX_MIME }), filename);
}

/** Normalise a label into a file-name stem: lowercased, words → underscores. */
export function fileStem(...parts: string[]): string {
  return parts
    .join("_")
    .replace(/[^\w]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase() || "export";
}
