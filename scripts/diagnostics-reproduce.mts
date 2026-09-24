/**
 * P-C reproduction harness — the analyst's two notebooks are the oracle for the
 * Analytics-tab timing/speededness figures (as the item-stats notebook was for
 * P-B). This script computes each notebook's reference table with a STANDALONE
 * reference implementation of its formulae (below), runs the REAL app engine over
 * the same cleaned matrix, and asserts they match to 4 dp — the reproduced-vs-app
 * gate captured in docs/diagnostics-parity.md and tests/diagnostics.notebook.test.ts.
 *
 * Run with:  npx tsx scripts/diagnostics-reproduce.mts
 */
import { readFileSync } from "node:fs";
import { parseExport, ingestAndClean } from "../lib/ingest/index";
import { buildAssessmentDiagnostics, cleanDiagResponses, type DiagResponse } from "../lib/diagnostics";
import type { CleanResponse } from "../lib/ingest/types";

const TARGET = process.argv[2] ?? "Applicable";

// ── build the cleaned DiagResponse matrix exactly as buildLiveCycleData does ──
const { rows } = parseExport(readFileSync("data/sample_qm_export.xlsx"));
const { cleanedResponses } = ingestAndClean(rows);
const byName = new Map<string, CleanResponse[]>();
for (const r of cleanedResponses) (byName.get(r.assessmentName) ?? byName.set(r.assessmentName, []).get(r.assessmentName)!).push(r);
const name = [...byName.keys()].find((n) => n.includes(TARGET));
if (!name) throw new Error(`no assessment matching "${TARGET}"`);
const recs = byName.get(name)!;

// Cohort exclusions are DATA (the per-cohort `cohort_exclusions` table), not a code
// list; the redacted sample export carries no staff/test accounts, so this oracle
// runs on the full sample cohort. Point `excluded` at real ids only if reproducing a
// live cohort's figures locally.
const excluded = new Set<string>();
// Max Score = 0 items (instructions/stimuli) were never scored — exclude their
// responses here too, mirroring buildLiveCycleData's diagSourceRecs filter.
const diagSourceRecs = recs.filter((r) => (r.maxScore ?? 1) >= 1);
const itemOrder = new Map<string, number>();
for (const r of diagSourceRecs) if (!itemOrder.has(r.qmQuestionId)) itemOrder.set(r.qmQuestionId, itemOrder.size);
const records: DiagResponse[] = cleanDiagResponses(
  diagSourceRecs.map((r) => ({
    participantId: r.participantPseudonym,
    itemId: r.qmQuestionId,
    demandLevel: r.demandLevel,
    itemSet: r.itemSet,
    majorElement: r.majorElement,
    order: itemOrder.get(r.qmQuestionId)!,
    // AnswerGiven carries QM's "<Not defined>" sentinel for an unanswered item
    // (truthy), so omission/speededness/timing key off AnswerGivenChoiceNumber,
    // which is genuinely blank instead.
    answered: !!r.answerGivenChoiceNumber,
    correct: r.answerScore === 1,
    responseTime: r.responseTime,
  })),
  { excludedParticipantIds: excluded },
);

// ── standalone reference implementation of the two notebook formulae ──────────
const rnd = (v: number, d = 4) => { const r = Math.floor(v * 10 ** d + 0.5) / 10 ** d; return r === 0 ? 0 : r; };
const pearson = (x: number[], y: number[]): number | null => {
  const n = x.length; if (n < 2) return null;
  const S = (f: (i: number) => number) => x.reduce((a, _, i) => a + f(i), 0);
  const sx = S((i) => x[i]!), sy = S((i) => y[i]!), sxx = S((i) => x[i]! ** 2), syy = S((i) => y[i]! ** 2), sxy = S((i) => x[i]! * y[i]!);
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  return den === 0 ? null : (n * sxy - sx * sy) / den;
};
const rank = (v: number[]): number[] => {
  const idx = v.map((_, i) => i).sort((a, b) => v[a]! - v[b]!); const out = new Array(v.length).fill(0); let i = 0;
  while (i < idx.length) { let j = i; while (j + 1 < idx.length && v[idx[j + 1]!] === v[idx[i]!]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) out[idx[k]!] = avg; i = j + 1; }
  return out;
};
const spearman = (x: number[], y: number[]) => (x.length < 2 ? null : pearson(rank(x), rank(y)));
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const lateItems = (rs: DiagResponse[]) => {
  const e = new Map<string, number>(); for (const r of rs) { const c = e.get(r.itemId); if (c === undefined || r.order < c) e.set(r.itemId, r.order); }
  const ord = [...e.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k); const n = Math.max(1, Math.ceil(0.25 * ord.length));
  return new Set(ord.slice(ord.length - n));
};
const refSpeeded = (rs: DiagResponse[]) => {
  const late = lateItems(rs); const om = (f: (r: DiagResponse) => boolean) => { const s = rs.filter(f); return s.length ? s.filter((r) => !r.answered).length / s.length : 0; };
  const acc = (f: (r: DiagResponse) => boolean) => { const a = rs.filter((r) => f(r) && r.answered); return a.length ? a.filter((r) => r.correct).length / a.length : 0; };
  const isL = (r: DiagResponse) => late.has(r.itemId);
  const eo = om((r) => !isL(r)), lo = om(isL), ea = acc((r) => !isL(r)), la = acc(isL);
  const omit = rs.length ? rs.filter((r) => !r.answered).length / rs.length : 0;
  return { nItems: new Set(rs.map((r) => r.itemId)).size, nPresentations: rs.length, omissionRate: rnd(omit), speedednessIndex: rnd((Math.max(0, lo - eo) + Math.max(0, ea - la)) / 2), earlyAccuracy: rnd(ea), lateAccuracy: rnd(la) };
};
const refTiming = (rs: DiagResponse[]) => {
  const by = new Map<string, { c: number; p: number; t: number[] }>();
  // Every presented (scored) item contributes its responseTime, answered or
  // not — QM logs dwell time even on a blank answer, and the ground-truth
  // methodology takes the median over all of them, no answered-only filter
  // (mirrors timingPerformance()). Only a genuinely missing/non-finite
  // responseTime is excluded.
  for (const r of rs) { const s = by.get(r.participantId) ?? { c: 0, p: 0, t: [] }; s.p++; if (r.correct) s.c++; if (r.responseTime != null && Number.isFinite(r.responseTime)) s.t.push(r.responseTime); by.set(r.participantId, s); }
  const sp: number[] = [], mt: number[] = []; for (const s of by.values()) { if (!s.p || !s.t.length) continue; sp.push((s.c / s.p) * 100); mt.push(median(s.t)); }
  const p = pearson(mt, sp), s = spearman(mt, sp);
  return { nStudents: sp.length, pearson: p === null ? null : rnd(p), spearman: s === null ? null : rnd(s) };
};
const byDemand = <T>(rs: DiagResponse[], fn: (g: DiagResponse[]) => T) => {
  const g = new Map<string, DiagResponse[]>(); for (const r of rs) if (r.demandLevel) (g.get(r.demandLevel) ?? g.set(r.demandLevel, []).get(r.demandLevel)!).push(r);
  return ["D1", "D2", "D3"].filter((d) => g.has(d)).map((d) => [d, fn(g.get(d)!)] as const);
};

// ── app engine over the same matrix ──────────────────────────────────────────
const app = buildAssessmentDiagnostics(records);

let ok = true;
const check = (label: string, repro: Record<string, number | null>, appv: Record<string, number | null>) => {
  const keys = Object.keys(repro);
  const bad = keys.filter((k) => { const a = repro[k], b = appv[k]; return !(a === b || (a != null && b != null && Math.abs(a - b) < 1e-9)); });
  ok &&= bad.length === 0;
  const cols = keys.map((k) => `${k}=${repro[k]}/${appv[k]}`).join("  ");
  console.log(`${bad.length ? "FAIL" : "ok  "} ${label.padEnd(22)} ${cols}${bad.length ? `  <<< ${bad.join(",")}` : ""}`);
};

console.log(`\n${name}  —  ${new Set(records.map((r) => r.participantId)).size} students × ${new Set(records.map((r) => r.itemId)).size} items × ${records.length} presentations\n`);
console.log("SPEEDEDNESS / OMISSION (reproduced / app)");
check("whole", refSpeeded(records), app.whole.speeded);
for (const [d, s] of byDemand(records, refSpeeded)) check(d, s, app.byDemand.find((x) => x.demand === d)!.speeded);
console.log("\nTIMING ↔ PERFORMANCE (reproduced / app)");
check("whole", refTiming(records), app.whole.timing);
for (const [d, t] of byDemand(records, refTiming)) check(d, t, app.timingByDemand.find((x) => x.demand === d)!.timing);

console.log(ok ? "\n✓ reproduced tables match the app engine to 4 dp\n" : "\n✗ mismatch — see FAIL rows above\n");
process.exit(ok ? 0 : 1);
