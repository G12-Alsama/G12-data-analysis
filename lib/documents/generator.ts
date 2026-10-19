"use client";

/**
 * DocumentGenerator — produces the certificate + performance-report documents.
 *
 * Implementation: in-browser PPTX templating + zip. For each student we fill the
 * existing `.pptx` templates by token replacement (docxtemplater over pizzip),
 * then bundle every generated `.pptx` into a single `.zip` (jszip) the browser
 * downloads. Staff open the `.pptx` files and export to PDF themselves.
 *
 * This replaces the old Python + LibreOffice worker path, which can't run on
 * Vercel serverless. Everything here runs client-side — no external worker, no
 * server route, no new hosting platform. The `DocumentGenerator` interface and
 * the swap-point (`getDocumentGenerator`) are unchanged.
 */
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import JSZip from "jszip";
import type { DocKind, GenerateRequest, GenerateResult, PerStudentStatus } from "./types";
import type { DocSettings, StudentSummary } from "@/lib/data/types";
import { isSittingKey, periodShortLabel } from "@/lib/data/periods";

export const DOCGEN_VERSION = "docgen-pptx-zip-1.0.0";

export interface DocumentGenerator {
  readonly version: string;
  /** Human-readable deployment mode, surfaced in the UI. */
  readonly mode: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** Built-in templates live in /public/templates (copied from data/*.pptx). The
 *  official certificate + performance report ship with the app; the unofficial
 *  diagnostic report has no built-in template, so it must be uploaded to generate. */
const BUILTIN_TEMPLATE: Partial<Record<DocKind, string>> = {
  certificate: "/templates/certificate_template.pptx",
  report: "/templates/report_template.pptx",
};
const KIND_LABEL: Record<DocKind, string> = {
  certificate: "Certificate",
  report: "Performance Report",
  unofficial: "Unofficial Report",
};

/** Filesystem-safe filename fragment. */
function safe(name: string): string {
  return (name || "Student").replace(/[\\/:*?"<>|]+/g, "_").trim();
}

/** DRAFT watermark string injected into the {{WATERMARK}} token; empty for an
 *  official run so issued documents stay clean. Templates that don't carry the
 *  token simply ignore it (extras are dropped). */
export const DRAFT_WATERMARK = "DRAFT — NOT FOR ISSUE";

/** The full token set for a student (templates use a subset; extras are ignored,
 *  and unknown tokens render empty via the nullGetter). */
function tokensFor(s: StudentSummary, settings: DocSettings, draft: boolean): Record<string, string> {
  const data: Record<string, string> = {
    NAME: s.name,
    AWARD: s.award,
    RESULTID: s.participantId,
    TESTCENTRE: settings.testCentre,
    EXAMDATE: settings.examDate,
    ISSUEDATE: settings.issueDate,
    CYCLE: settings.cycleName,
    WATERMARK: draft ? DRAFT_WATERMARK : "",
  };
  for (const sub of s.subjects) {
    data[`${sub.slot}_STARS`] = sub.stars;
    data[`${sub.slot}_LEVEL`] = sub.level;
    // Feb/May provenance for the best-of-two level (Overall performance reports).
    // Empty for a per-sitting document or a subject with no result; templates that
    // don't carry the token simply ignore it.
    data[`${sub.slot}_SOURCE`] = sub.source && isSittingKey(sub.source) ? periodShortLabel(sub.source) : "";
  }
  // Element/sub-element tokens for the unofficial diagnostic report (populated
  // only when the locked-grades read-model carries the breakdown). Each subject
  // gets a flattened, human-readable list its template can drop in.
  for (const subj of s.unofficial ?? []) {
    const elementLines = subj.elements.map((el) => `${el.major}: ${el.level} (${el.stars})`);
    const subLines = subj.elements.flatMap((el) =>
      el.subs.map((sub) => `${el.major} › ${sub.sub}: ${sub.level} (${sub.stars})`),
    );
    data[`${subj.slot}_ELEMENT_LEVELS`] = elementLines.join("\n");
    data[`${subj.slot}_SUBELEMENT_LEVELS`] = subLines.join("\n");
  }
  return data;
}

/** Fill one template for one student → a .pptx as a Uint8Array. */
function renderPptx(template: ArrayBuffer, data: Record<string, string>): Uint8Array {
  const zip = new PizZip(template);
  const doc = new Docxtemplater(zip, {
    delimiters: { start: "{{", end: "}}" },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => "",
  });
  doc.render(data);
  return doc.getZip().generate({ type: "uint8array" });
}

async function loadTemplate(kind: DocKind, uploaded?: ArrayBuffer): Promise<ArrayBuffer> {
  if (uploaded) return uploaded;
  const builtin = BUILTIN_TEMPLATE[kind];
  if (!builtin) throw new Error(`No built-in ${KIND_LABEL[kind]} template — upload a .pptx to generate it.`);
  const res = await fetch(builtin);
  if (!res.ok) throw new Error(`Could not load the built-in ${KIND_LABEL[kind]} template.`);
  return res.arrayBuffer();
}

class PptxZipDocumentGenerator implements DocumentGenerator {
  readonly version = DOCGEN_VERSION;
  readonly mode = "Browser PPTX → zip (no server worker)";

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const draft = req.draft ?? false;
    const namePrefix = draft ? "DRAFT - " : "";
    const archive = new JSZip();
    const perStudent = new Map<string, PerStudentStatus>();
    const kinds: GenerateResult["kinds"] = {};

    for (const s of req.students) {
      perStudent.set(s.participantId, { id: s.participantId, name: s.name, award: s.award, results: {} });
    }

    for (const kind of req.kinds) {
      let template: ArrayBuffer;
      try {
        template = await loadTemplate(kind, req.templates[kind]);
      } catch (e) {
        // A missing template (e.g. unofficial with no upload) fails only its own
        // kind — the other selected kinds still generate into the zip.
        const message = (e as Error).message;
        for (const s of req.students) perStudent.get(s.participantId)!.results[kind] = { status: "error", error: message };
        kinds[kind] = { complete: 0, total: req.students.length, error: message };
        continue;
      }
      let complete = 0;
      for (const s of req.students) {
        const ps = perStudent.get(s.participantId)!;
        try {
          const bytes = renderPptx(template, tokensFor(s, req.settings, draft));
          archive.file(`${namePrefix}${KIND_LABEL[kind]} - ${safe(s.name)}.pptx`, bytes);
          ps.results[kind] = { status: "complete" };
          complete += 1;
        } catch (e) {
          ps.results[kind] = { status: "error", error: (e as Error).message };
        }
      }
      kinds[kind] = { complete, total: req.students.length };
    }

    const blob = await archive.generateAsync({ type: "blob", compression: "DEFLATE" });
    const zipUrl = URL.createObjectURL(blob);
    const zipName = `${safe(req.settings.cycleName) || "documents"}${draft ? "_DRAFT" : ""}_documents.zip`;

    return {
      jobId: `pptx-${Date.now()}`,
      fonts: {
        georgiaPresent: false,
        barlowPresent: false,
        warnings: [
          ...(draft
            ? [`${DRAFT_WATERMARK}: this is a draft proof, watermarked and filename-prefixed. Do not issue — official certificates require the O1/O2 methodology sign-off.`]
            : []),
          "Generated as editable .pptx. Open each file and export to PDF to finalise. Token replacement keeps the template design; non-embedded fonts may substitute on machines without them.",
        ],
      },
      kinds,
      perStudent: [...perStudent.values()],
      zipUrl,
      zipName,
    };
  }
}

const generator: DocumentGenerator = new PptxZipDocumentGenerator();

/** The active document generator. The only place to change to swap renderers. */
export function getDocumentGenerator(): DocumentGenerator {
  return generator;
}
