/**
 * Build the canonical model by joining the three Questionmark exports on
 * `ResultId`. Faithful intake only — trusts QM's totals, keeps every question,
 * retains all participant data, excludes surveys, normalises subject names, runs
 * the reconciliation integrity guard, and tags the sitting.
 */

import { repairText } from "../repair";
import { isSurveyAssessment, stripHtml } from "../normalize";
import {
  assignParticipantIdentities,
  type IdentityInputRow,
  type ResolvedIdentity,
} from "../participant-identity";
import { normalizeResultId } from "./result-id";
import type { CsvTable } from "./csv";
import { detectThreeExports, type NamedInput } from "./detect";
import { periodOfMonth } from "@/lib/data/periods";
import type {
  CanonicalModel,
  IntegrityReport,
  QmItem,
  QmParticipant,
  QmResult,
  QmSubject,
  QmTopicRollup,
  ReconcileIssue,
  ResitForm,
  Sitting,
} from "./model";

const RTL_SCRIPT = /[؀-ۿ]/;

/** Tolerance for the reconciliation check (QM percentages are exact integers/halves). */
const RECONCILE_EPS = 0.01;

function num(value: string | undefined, fallback: number | null): number | null {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value: string | undefined): string | null {
  if (value === undefined) return null;
  const t = repairText(value).trim();
  if (t === "" || t === "<Not defined>" || t === "<Unknown>") return null;
  return t;
}

/**
 * A small, configurable alias map for GENUINE subject-name variants (encoding or
 * spelling differences that denote the SAME exam form). Default empty: nothing is
 * merged unless an analyst adds an explicit alias here. A typo'd re-sit form that
 * carries a DIFFERENT item set (e.g. "Applicable Maths") is deliberately NOT an
 * alias — it is surfaced as a re-sit form, never merged (see `detectResitForms`).
 *
 * Keys are matched case-insensitively against the trimmed, whitespace-collapsed
 * raw name; the value is the canonical display name.
 */
export type SubjectAliasMap = Readonly<Record<string, string>>;
export const DEFAULT_SUBJECT_ALIASES: SubjectAliasMap = {};

/**
 * Canonicalise a raw `AssessmentName`: repair encoding, collapse whitespace, trim,
 * then apply the configurable alias map (case-insensitive). It does NOT merge
 * "Applicable Maths" into "Applicable Math" — that trailing-"s" form is a distinct
 * 44-question re-sit, surfaced separately so its items never inflate the real
 * Applicable Math item set.
 */
export function normalizeSubjectName(raw: string, aliases: SubjectAliasMap = DEFAULT_SUBJECT_ALIASES): string {
  const cleaned = repairText(raw).replace(/\s+/g, " ").trim();
  const alias = aliases[cleaned.toLowerCase()];
  return alias ?? cleaned;
}

/**
 * Collapse a canonical subject name to a comparison BASE: lowercase, drop the
 * "G12++" prefix, and strip a trailing plural "s" from the final word. Two names
 * that share a base but differ otherwise (e.g. "Applicable Math" vs "Applicable
 * Maths") are re-sit-form candidates. RTL/Arabic names have no Latin plural and
 * collapse to themselves.
 */
export function subjectBaseKey(name: string): string {
  const base = name.replace(/^G12\+\+\s*/i, "").replace(/\s+/g, " ").trim().toLowerCase();
  return base.replace(/s\b/g, (m, off: number) => (off === base.length - 1 ? "" : m));
}

/**
 * Detect re-sit / alternate forms: when two canonical subjects share a base key
 * but have DIFFERENT item sets, the one with fewer participants is flagged as a
 * re-sit of the larger (base) subject. Surfaced for review; never merged.
 */
export function detectResitForms(subjects: readonly QmSubject[]): ResitForm[] {
  const byBase = new Map<string, QmSubject[]>();
  for (const s of subjects) {
    const k = subjectBaseKey(s.name);
    (byBase.get(k) ?? byBase.set(k, []).get(k)!).push(s);
  }
  const forms: ResitForm[] = [];
  for (const group of byBase.values()) {
    if (group.length < 2) continue;
    // Largest participant count is the base subject; the rest are re-sit forms.
    const sorted = [...group].sort((a, b) => b.resultCount - a.resultCount);
    const base = sorted[0]!;
    for (const form of sorted.slice(1)) {
      forms.push({
        name: form.name,
        baseName: base.name,
        participantCount: form.resultCount,
        itemCount: form.itemCount,
      });
    }
  }
  return forms;
}

/** Three-letter month tokens, January first (index + 1 = calendar month). */
const MONTH_TOKENS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

const MONTH_LABEL: Record<string, string> = {
  JAN: "January", FEB: "February", MAR: "March", APR: "April",
  MAY: "May", JUN: "June", JUL: "July", AUG: "August",
  SEP: "September", OCT: "October", NOV: "November", DEC: "December",
};

/**
 * Parse the sitting from a `ResultGroupName` like "Math Shatila 1 MAY2026".
 * The month maps to a sitting period through the period registry (`periods.ts`;
 * February/May today: Jan–Apr → February, the rest → May, mirroring migration 0005).
 */
export function parseSitting(groupName: string | null | undefined): Sitting | null {
  if (!groupName) return null;
  const m = groupName.toUpperCase().match(/(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*((?:19|20)\d{2})/);
  if (!m) return null;
  const mon = m[1]!;
  const year = Number(m[2]!);
  return {
    code: `${mon}${year}`,
    period: periodOfMonth(MONTH_TOKENS.indexOf(mon as (typeof MONTH_TOKENS)[number]) + 1),
    year,
    label: `${MONTH_LABEL[mon]} ${year}`,
  };
}

/**
 * The calendar date of a QM local timestamp ("2026-05-12 11:32:23"), as ISO `yyyy-mm-dd`;
 * null for a blank, `<Not defined>` or unparsable value (a real date only: month 1–12,
 * day 1–31, year 1990–2100).
 */
export function isoDateOf(raw: string | null | undefined): string | null {
  const m = (raw ?? "").trim().match(/^((?:19|20)\d{2})-(\d{2})-(\d{2})(?:[ T]|$)/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

interface RowsByResult {
  items: Map<string, Record<string, string>[]>;
  topics: Map<string, Record<string, string>[]>;
}

function groupByResultId(table: CsvTable): Map<string, Record<string, string>[]> {
  const map = new Map<string, Record<string, string>[]>();
  for (const row of table.rows) {
    const rid = normalizeResultId(row["ResultId"] ?? "");
    if (!rid) continue;
    const bucket = map.get(rid);
    if (bucket) bucket.push(row);
    else map.set(rid, [row]);
  }
  return map;
}

/**
 * Resolve a guaranteed-unique participant identity per graded result, ONCE, from
 * the authoritative Assessments export (one row per result — the complete roster).
 *
 * This is the SINGLE identity resolution for the 3-CSV path. It is keyed on the
 * collision-free natural key (ParticipantID / email = ResultParticipantName / the
 * result→participant mapping) and minted into a stable internal id — NEVER a name-,
 * initial- or DOB-shaped field. `ingestThreeExports` passes the result of this into
 * BOTH the canonical model (the roster) AND the response normaliser (the cells), so
 * the roster and the responses can never resolve a result to two different ids —
 * the root of the "all-dots / dropped sitter" attribution failure was two
 * INDEPENDENT resolutions over different row-sets (Assessments vs Items) that
 * disagreed whenever a code-sharing result was present in one set but not the other.
 */
export function resolveAssessmentIdentities(assessments: CsvTable): Map<string, ResolvedIdentity> {
  const identityInputs: IdentityInputRow[] = [];
  for (const row of assessments.rows) {
    const rawName = repairText(row["AssessmentName"] ?? "").trim();
    if (isSurveyAssessment(rawName)) continue;
    const resultId = normalizeResultId(row["ResultId"] ?? "");
    if (!resultId) continue;
    identityInputs.push({ resultId, subject: normalizeSubjectName(rawName), row });
  }
  return assignParticipantIdentities(identityInputs);
}

/**
 * Build the canonical model from three already-parsed tables.
 *
 * `identityByResult` is the authoritative, resolve-once identity map (see
 * `resolveAssessmentIdentities`). When omitted (standalone callers) it is computed
 * from `assessments` here; `ingestThreeExports` computes it once and passes the
 * SAME map here and to the normaliser so both agree on every result's identity.
 */
export function buildCanonicalModelFromTables(
  items: CsvTable,
  assessments: CsvTable,
  topics: CsvTable,
  identityByResult: Map<string, ResolvedIdentity> = resolveAssessmentIdentities(assessments),
): CanonicalModel {
  const byResult: RowsByResult = {
    items: groupByResultId(items),
    topics: groupByResultId(topics),
  };

  const results: QmResult[] = [];
  const excludedSurveys = new Set<string>();
  let surveyResults = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;
  let datedResults = 0;
  const sittingTally = new Map<string, { sitting: Sitting; count: number }>();
  /** The lowercased identity key used to group participants + join result/topic
   *  rows back to them (case-folded so the join is stable). */
  const identityKey = (resultId: string): string =>
    (identityByResult.get(resultId)?.id ?? `result:${resultId}`).toLowerCase();

  // ── 1. One QmResult per graded assessment row, joined to its items + topics ──
  for (const row of assessments.rows) {
    const rawName = repairText(row["AssessmentName"] ?? "").trim();
    if (isSurveyAssessment(rawName)) {
      excludedSurveys.add(rawName);
      surveyResults += 1;
      continue;
    }
    const resultId = normalizeResultId(row["ResultId"] ?? "");
    if (!resultId) continue;

    const subject = normalizeSubjectName(rawName);
    for (const col of ["ResultStartLocal", "ResultFinishedLocal"]) {
      const d = isoDateOf(row[col]);
      if (d) {
        if (minDate === null || d < minDate) minDate = d;
        if (maxDate === null || d > maxDate) maxDate = d;
        if (col === "ResultStartLocal") datedResults += 1;
      }
    }
    const groupName = text(row["ResultGroupName"]);
    const sitting = parseSitting(groupName);
    if (sitting) {
      const t = sittingTally.get(sitting.code) ?? { sitting, count: 0 };
      t.count += 1;
      sittingTally.set(sitting.code, t);
    }

    const itemRows = byResult.items.get(resultId) ?? [];
    const responses = itemRows.map((it) => ({
      questionId: (it["QuestionId"] ?? "").trim(),
      answerGiven: text(it["AnswerGiven"]),
      answerScore: num(it["AnswerScore"], 0)!,
      responseTime: num(it["AnswerResponseTimeSeconds"], null),
      questionType: text(it["QuestionType"]) ?? "",
      status: text(it["QuestionStatus"]),
    }));

    const topicRows = byResult.topics.get(resultId) ?? [];
    const topicRollups: QmTopicRollup[] = topicRows.map((tp) => ({
      topicId: text(tp["TopicId"]),
      name: repairText(tp["TopicName"] ?? "").trim(),
      path: text(tp["TopicPath"]),
      score: num(tp["TopicScore"], 0)!,
      maximumScore: num(tp["TopicMaximumScore"], 0)!,
      percentageScore: num(tp["TopicPercentageScore"], null),
      questionCount: num(tp["TopicQuestionCount"], 0)!,
    }));

    results.push({
      resultId,
      subject,
      rawSubjectName: rawName,
      participantEmail: identityKey(resultId),
      groupName,
      sitting,
      status: text(row["ResultStatus"]),
      attemptNumber: num(row["ResultAssessmentAttemptNumber"], null),
      totalScore: num(row["ResultTotalScore"], 0)!,
      maximumScore: num(row["ResultMaximumScore"], 0)!,
      percentageScore: num(row["ResultPercentageScore"], null),
      scoreband: text(row["ResultScorebandName"]),
      responses,
      topics: topicRollups,
    });
  }

  // ── 2. Participants, keyed by the resolved internal identity, retaining every
  //       personal field. NEVER keyed on a name / initial / DOB-shaped field. ──
  const participantMap = new Map<string, QmParticipant>();
  for (const row of assessments.rows) {
    const rawName = repairText(row["AssessmentName"] ?? "").trim();
    if (isSurveyAssessment(rawName)) continue;
    const resultId = normalizeResultId(row["ResultId"] ?? "");
    if (!resultId) continue;
    const key = identityKey(resultId);
    let p = participantMap.get(key);
    if (!p) {
      const first = text(row["ResultParticipantFirstName"]);
      const last = text(row["ResultParticipantLastName"]);
      p = {
        email: key,
        firstName: first,
        lastName: last,
        fullName: [first, last].filter(Boolean).join(" ") || null,
        dob: text(row["ResultSpecialField4"]),
        gender: text(row["ResultSpecialField5"]),
        details: text(row["ResultParticipantDetails"]),
        groupNames: [],
      };
      participantMap.set(key, p);
    }
    const group = text(row["ResultGroupName"]);
    if (group && !p.groupNames.includes(group)) p.groupNames.push(group);
  }

  // ── 3. Distinct items per subject (type / max / status / topic) ──────────────
  const itemMap = new Map<string, QmItem>(); // `${subject}|${questionId}`
  for (const result of results) {
    const itemRows = byResult.items.get(result.resultId) ?? [];
    for (const it of itemRows) {
      const questionId = (it["QuestionId"] ?? "").trim();
      if (!questionId) continue;
      const key = `${result.subject}|${questionId}`;
      if (itemMap.has(key)) continue;
      itemMap.set(key, {
        subject: result.subject,
        questionId,
        questionType: text(it["QuestionType"]) ?? "",
        maxScore: num(it["QuestionMaximumScore"], 0)!,
        status: text(it["QuestionStatus"]),
        topicName: text(it["QuestionTopicName"]),
        topicPath: text(it["QuestionTopicPath"]),
        wording: stripHtml(it["QuestionWording"]),
      });
    }
  }
  const allItems = [...itemMap.values()];

  // ── 4. Subjects (canonical), first-appearance order ──────────────────────────
  const subjectOrder: string[] = [];
  const rawNamesBySubject = new Map<string, Set<string>>();
  const resultsBySubject = new Map<string, QmResult[]>();
  for (const r of results) {
    if (!resultsBySubject.has(r.subject)) {
      resultsBySubject.set(r.subject, []);
      subjectOrder.push(r.subject);
    }
    resultsBySubject.get(r.subject)!.push(r);
    let raws = rawNamesBySubject.get(r.subject);
    if (!raws) {
      raws = new Set();
      rawNamesBySubject.set(r.subject, raws);
    }
    raws.add(r.rawSubjectName);
  }

  const subjects = subjectOrder.map((name) => {
    const subjItems = allItems.filter((it) => it.subject === name);
    const subjResults = resultsBySubject.get(name)!;
    // Modal ResultMaximumScore (the canonical denominator QM reports).
    const maxFreq = new Map<number, number>();
    for (const r of subjResults) maxFreq.set(r.maximumScore, (maxFreq.get(r.maximumScore) ?? 0) + 1);
    let qmMax = 0;
    let best = -1;
    for (const [mx, f] of maxFreq) if (f > best) { best = f; qmMax = mx; }
    return {
      name,
      rawNames: [...rawNamesBySubject.get(name)!],
      rtl: RTL_SCRIPT.test(name),
      itemCount: subjItems.length,
      qmMaximumScore: qmMax,
      resultCount: subjResults.length,
      betaItemCount: subjItems.filter((it) => (it.status ?? "").toLowerCase() === "beta").length,
    };
  });

  // ── 4b. Surface re-sit / alternate forms (same base, different item set) ─────
  const resitForms = detectResitForms(subjects);

  // ── 5. Integrity guard: QM totals must equal the item-level sums ─────────────
  const issues: ReconcileIssue[] = [];
  for (const r of results) {
    const itemRows = byResult.items.get(r.resultId) ?? [];
    const sumItemMax = itemRows.reduce((s, it) => s + (num(it["QuestionMaximumScore"], 0)!), 0);
    const sumItemScore = itemRows.reduce((s, it) => s + (num(it["AnswerScore"], 0)!), 0);
    const maxOk = Math.abs(sumItemMax - r.maximumScore) <= RECONCILE_EPS;
    const totalOk = Math.abs(sumItemScore - r.totalScore) <= RECONCILE_EPS;
    if (!maxOk || !totalOk) {
      issues.push({
        resultId: r.resultId,
        subject: r.subject,
        participantEmail: r.participantEmail,
        expectedMax: r.maximumScore,
        sumItemMax,
        expectedTotal: r.totalScore,
        sumItemScore,
        maxOk,
        totalOk,
      });
    }
  }
  const integrity: IntegrityReport = {
    resultsChecked: results.length,
    reconciled: results.length - issues.length,
    issues,
    ok: issues.length === 0,
  };

  // ── 6. Dominant sitting tag for the export ───────────────────────────────────
  let sitting: Sitting | null = null;
  let bestCount = -1;
  for (const { sitting: s, count } of sittingTally.values()) {
    if (count > bestCount) { bestCount = count; sitting = s; }
  }

  return {
    sitting,
    subjects,
    participants: [...participantMap.values()],
    items: allItems,
    results,
    integrity,
    resitForms,
    excludedSurveys: [...excludedSurveys],
    dateRange: minDate !== null && maxDate !== null ? { from: minDate, to: maxDate, datedResults } : null,
    stats: {
      assessmentRows: assessments.rows.length,
      itemRows: items.rows.length,
      topicRows: topics.rows.length,
      gradedResults: results.length,
      surveyResults,
    },
  };
}

/**
 * Detect + parse a multi-file upload (the three QM CSVs in any order) and build
 * the canonical model. Throws a clear `DetectionError` if the three required
 * files aren't all present.
 */
export function buildCanonicalModel(files: readonly NamedInput[]): CanonicalModel {
  const { items, assessments, topics } = detectThreeExports(files);
  return buildCanonicalModelFromTables(items, assessments, topics);
}
