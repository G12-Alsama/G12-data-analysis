/**
 * computeOverallAnalytics — the read-model behind the "Overall" analytics page.
 *
 * A pure aggregation over the persisted per-sitting outputs (already-computed
 * per-subject performance levels + overall awards + per-subject score
 * percentages), grouped by centre × year × sitting × subject. It never runs the
 * scoring engine, never re-derives an award from scratch, and holds no provider
 * state — every figure is a roll-up of outputs the pipeline already signed off.
 *
 * ## Locked methodology (implemented EXACTLY here)
 *
 *  1. Combined = best-of-two AWARD. Per student × subject, the HIGHER performance
 *     LEVEL across the two sittings (by rank), then the award rule on the
 *     rolled-up levels — via the existing `rollupOverall` (which itself calls the
 *     engine's `deriveAward`). There is no numeric combined score anywhere.
 *  2. Improvement = movement in performance-LEVEL rank (February → May, same
 *     students, same subject): `gain` = average levels gained; `up` = % of
 *     students who moved up ≥ 1 level. Never score points.
 *  3. Pass = any overall award ABOVE the lowest band. Per-subject "pass" (a single
 *     sitting's score stats) = performance level ≥ Meets (not the lowest level).
 *  4. The inputs describe only who SAT — there is no "registered" concept.
 *  6. Score statistics (mean / median / high / low / SD) come from a single
 *     sitting's raw-score percentages. Under Combined only level data exists.
 *
 * The best-of-two + award rule are REUSED from `lib/data/overall.ts`
 * (`rollupOverall` → `deriveAward`); this module only groups and tallies.
 */

import { rollupOverall } from "./overall";
import { SITTING_ORDER, type SittingKey } from "./periods";
import type {
  AssessmentRef,
  AwardBand,
  AwardDistYear,
  CentreSpreadYear,
  CentreSubjectSpread,
  GradeMatrixRow,
  GradesModel,
  OverallAnalytics,
  OverallGradeRow,
  ParticipationYear,
  PLevel,
  SittingStats,
  SubjectYear,
} from "./types";

// ── input shape (a projection of the persisted outputs) ──────────────────────

/** One student's persisted per-sitting output: their per-subject performance
 *  levels (keyed by the CANONICAL subject key, so the two sittings align) and the
 *  signed-off overall award for that sitting. */
export interface OASittingStudent {
  studentId: string;
  /** Overall award label for this single sitting (as persisted). */
  award: string;
  /** subjectKey → performance-level label. A subject the student did not sit is
   *  absent (or empty) — never invent a lowest-band level for an absent subject. */
  levels: Record<string, string>;
}

/** One sitting (February or May) at one centre in one year. */
export interface OASitting {
  students: OASittingStudent[];
  /** subjectKey → raw-score percentages across the students who sat that subject,
   *  for the single-sitting score stats. */
  scores: Record<string, number[]>;
}

/**
 * The analytics projection compares exactly TWO sittings per (centre × year): the
 * registry's first two periods (its `february` / `may` cell slots). A sitting in any
 * other period is left out of this projection (see `fetchOverallAnalytics`) rather than
 * mislabelled; generalising the analytics views is part of the persisted-grades work.
 */
export const SLOT_PERIODS = [SITTING_ORDER[0]!, SITTING_ORDER[1]!] as const;

/** One (centre × year) cell: the persisted outputs for its two sittings. */
export interface OACell {
  /** Centre display name. */
  centre: string;
  year: number;
  /** True for clearly-labelled synthetic data (the in-memory seed). Never affects
   *  the maths — it is carried only so callers can flag non-real cells. */
  synthetic?: boolean;
  february: OASitting | null;
  may: OASitting | null;
}

export interface ComputeOverallAnalyticsArgs {
  cells: OACell[];
  /** Canonical subject list (union across cells), ordinal. */
  subjects: { key: string; name: string; short: string; rtl?: boolean }[];
  /** Award bands best → worst; index i aligns to `awardLevels[i]`. */
  awards: AwardBand[];
  /** Performance levels best → worst; index i aligns to `performanceLevels[i]`. */
  plevels: PLevel[];
  /** Performance-level labels best → lowest (the engine vocabulary). */
  performanceLevels: string[];
  /** Award-level labels best → lowest (the engine vocabulary). */
  awardLevels: string[];
  /** Level → stars map (for the rolled-up cells; presentation only). */
  starMap: Record<string, string>;
  /** Which years are REAL (drive `hasComparison`). Defaults to every year present. */
  realYears?: number[];
}

// ── small numeric helpers ────────────────────────────────────────────────────

const round = (n: number, dp = 1): number => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};
const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
const mean = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : 0);
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mu = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - mu) ** 2)) / (xs.length - 1));
}
const pct = (num: number, den: number): number => (den > 0 ? round((num / den) * 100, 1) : 0);

// ── rank helpers over the ordinal vocabularies ───────────────────────────────

/** Rank of a level label within `levels` (0 = best). Absent/unknown → +∞. */
function rankOf(level: string | null | undefined, levels: readonly string[]): number {
  if (!level) return Number.POSITIVE_INFINITY;
  const i = levels.indexOf(level);
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

// ── building minimal GradesModels so rollupOverall can align the two sittings ─
// The two sittings are distinct pipeline runs, so their subject ids differ. We
// re-key each sitting's rows by the CANONICAL subject key and hand rollupOverall
// assessments whose ids ARE those keys, so its per-subject best-of-two join lines
// the same subject up across February and May.

function assessmentsFromSubjects(subjects: ComputeOverallAnalyticsArgs["subjects"]): AssessmentRef[] {
  return subjects.map((s) => ({
    id: s.key,
    name: s.name,
    shortName: s.short,
    rtl: s.rtl ?? false,
    itemCount: 0,
    excludedCount: 0,
    stageIndex: 0,
  }));
}

function toGradesModel(
  sitting: OASitting | null,
  assessments: AssessmentRef[],
  starMap: Record<string, string>,
  performanceLevels: string[],
  awardLevels: string[],
): GradesModel | null {
  if (!sitting) return null;
  const rows: GradeMatrixRow[] = sitting.students.map((st) => {
    const grades: GradeMatrixRow["grades"] = {};
    for (const a of assessments) {
      const level = st.levels[a.id];
      if (level) grades[a.id] = { level, stars: starMap[level] ?? "" };
    }
    return {
      id: st.studentId,
      studentId: st.studentId,
      label: st.studentId,
      grades,
      award: st.award,
      distinctionCap: null,
      overallRaw: 0,
      overallMax: 0,
      overallPct: 0,
    };
  });
  return {
    cycleId: "",
    assessments,
    rows,
    distribution: [],
    awardLevels,
    starMap,
    performanceLevels,
    locked: true,
    canLock: false,
  };
}

// ── per-cell derived state ───────────────────────────────────────────────────

interface CellDerived {
  cell: OACell;
  /** Best-of-two rows (union of students present in either sitting). */
  overall: OverallGradeRow[];
  febStudents: OASittingStudent[];
  mayStudents: OASittingStudent[];
}

export function computeOverallAnalytics(args: ComputeOverallAnalyticsArgs): OverallAnalytics {
  const { cells, subjects, awards, plevels, performanceLevels, awardLevels, starMap } = args;
  const assessments = assessmentsFromSubjects(subjects);
  const subjectKeys = subjects.map((s) => s.key);

  // Award pass = award strictly above the lowest band.
  const lowestAwardRank = awardLevels.length - 1;
  const awardIsPass = (award: string): boolean => {
    const r = awardLevels.indexOf(award);
    return r >= 0 && r < lowestAwardRank;
  };
  // Per-subject pass = performance level ≥ Meets (not the lowest level).
  const lowestPerfRank = performanceLevels.length - 1;
  const levelIsPass = (level: string | null | undefined): boolean => {
    const r = rankOf(level, performanceLevels);
    return Number.isFinite(r) && r < lowestPerfRank;
  };
  // award label index → AwardBand key; performance index → PLevel key.
  const awardKeyAt = (i: number): AwardBand["key"] => awards[i]?.key ?? "rol";
  const plevelKeyAt = (i: number): PLevel["key"] => plevels[i]?.key ?? "not";

  // Roll each cell up once (best-of-two) and cache per-sitting rosters.
  const derived: CellDerived[] = cells.map((cell) => {
    const feb = toGradesModel(cell.february, assessments, starMap, performanceLevels, awardLevels);
    const may = toGradesModel(cell.may, assessments, starMap, performanceLevels, awardLevels);
    const overall = rollupOverall({
      sittings: [
        { key: SLOT_PERIODS[0], grades: feb },
        { key: SLOT_PERIODS[1], grades: may },
      ],
      assessments,
      performanceLevels,
      awardLevels,
      starMap,
    });
    return { cell, overall, febStudents: cell.february?.students ?? [], mayStudents: cell.may?.students ?? [] };
  });

  const years = [...new Set(cells.map((c) => c.year))].sort((a, b) => a - b);
  const centreNames = [...new Set(cells.map((c) => c.centre))];
  const byYear = (y: number) => derived.filter((d) => d.cell.year === y);

  // Empty distribution helpers keyed by the award/perf band keys.
  const emptyAwardDist = (): AwardDistYear => ({ dist: 0, adv: 0, sec: 0, rol: 0 });
  const emptyLevels = (): SubjectYear["levels"] => ({ out: 0, exc: 0, meet: 0, not: 0 });

  // ── Participation ──────────────────────────────────────────────────────────
  const participation: Record<number, ParticipationYear> = {};
  for (const y of years) {
    const ds = byYear(y);
    let satFeb = 0;
    let satMay = 0;
    let both = 0;
    let passFebN = 0;
    let passFebD = 0;
    let passMayN = 0;
    let passMayD = 0;
    let passCombN = 0;
    let passCombD = 0;
    const centres = new Set<string>();
    for (const d of ds) {
      centres.add(d.cell.centre);
      const febIds = new Set(d.febStudents.map((s) => s.studentId));
      const mayIds = new Set(d.mayStudents.map((s) => s.studentId));
      satFeb += febIds.size;
      satMay += mayIds.size;
      for (const id of febIds) if (mayIds.has(id)) both += 1;
      for (const s of d.febStudents) {
        passFebD += 1;
        if (awardIsPass(s.award)) passFebN += 1;
      }
      for (const s of d.mayStudents) {
        passMayD += 1;
        if (awardIsPass(s.award)) passMayN += 1;
      }
      for (const r of d.overall) {
        passCombD += 1;
        if (awardIsPass(r.award)) passCombN += 1;
      }
    }
    participation[y] = {
      centres: centres.size,
      satFeb,
      satMay,
      both,
      passFeb: pct(passFebN, passFebD),
      passMay: pct(passMayN, passMayD),
      passComb: pct(passCombN, passCombD),
    };
  }

  // ── Award distribution (overall / best-of-two) per year ─────────────────────
  const awardDist: Record<number, AwardDistYear> = {};
  for (const y of years) {
    awardDist[y] = awardDistOf(byYear(y).flatMap((d) => d.overall.map((r) => r.award)));
  }
  function awardDistOf(awardsList: string[]): AwardDistYear {
    const out = emptyAwardDist();
    if (!awardsList.length) return out;
    const counts = new Array(awardLevels.length).fill(0);
    for (const a of awardsList) {
      const i = awardLevels.indexOf(a);
      if (i >= 0) counts[i] += 1;
    }
    const n = awardsList.length;
    for (let i = 0; i < awardLevels.length; i++) out[awardKeyAt(i)] = pct(counts[i], n);
    return out;
  }

  // ── Award distribution per centre, keyed by year ────────────────────────────
  // Every year is materialised so Section 4 can render the per-centre award
  // distribution under the SELECTED year's label (not always the latest).
  const awardByCentre: Record<number, Record<string, AwardDistYear>> = {};
  for (const y of years) {
    const perCentre: Record<string, AwardDistYear> = {};
    for (const d of byYear(y)) {
      // A centre appears once per (centre, year); if a centre had multiple cells
      // in a year (shouldn't happen), keep the first non-empty.
      if (!perCentre[d.cell.centre]) perCentre[d.cell.centre] = awardDistOf(d.overall.map((r) => r.award));
    }
    awardByCentre[y] = perCentre;
  }

  // ── Centre award spread (per-centre combined pass rate) per year ─────────────
  const centreAwardSpread: Record<number, CentreSpreadYear> = {};
  for (const y of years) {
    const perCentre = byYear(y).map((d) => {
      const passN = d.overall.filter((r) => awardIsPass(r.award)).length;
      return pct(passN, d.overall.length);
    });
    centreAwardSpread[y] = {
      best: perCentre.length ? round(Math.max(...perCentre), 1) : 0,
      worst: perCentre.length ? round(Math.min(...perCentre), 1) : 0,
      mean: round(mean(perCentre), 1),
    };
  }

  // ── Performance per subject × year ──────────────────────────────────────────
  const perf: Record<string, Record<number, SubjectYear>> = {};
  const centreSubjectSpread: Record<string, Record<number, CentreSubjectSpread>> = {};
  for (const key of subjectKeys) {
    perf[key] = {};
    centreSubjectSpread[key] = {};
    for (const y of years) {
      const ds = byYear(y);
      const anyFeb = ds.some((d) => d.cell.february !== null);
      const anyMay = ds.some((d) => d.cell.may !== null);

      perf[key][y] = {
        feb: anyFeb ? sittingStats(ds, key, SLOT_PERIODS[0]) : null,
        may: anyMay ? sittingStats(ds, key, SLOT_PERIODS[1]) : null,
        levels: bestOfTwoLevels(ds, key),
        change: anyFeb && anyMay ? levelChange(ds, key) : null,
      };

      // Per-centre combined subject pass rate → spread across centres.
      const perCentre = ds.map((d) => {
        let n = 0;
        let pass = 0;
        for (const r of d.overall) {
          const lvl = r.grades[key]?.level;
          if (!lvl) continue;
          n += 1;
          if (levelIsPass(lvl)) pass += 1;
        }
        return pct(pass, n);
      });
      centreSubjectSpread[key][y] = {
        mean: round(mean(perCentre), 1),
        best: perCentre.length ? round(Math.max(...perCentre), 1) : 0,
        worst: perCentre.length ? round(Math.min(...perCentre), 1) : 0,
        sd: round(stddev(perCentre), 1),
      };
    }
  }

  /** Single-sitting score stats + per-subject pass for one subject/year. */
  function sittingStats(ds: CellDerived[], key: string, sitting: SittingKey): SittingStats {
    const scores: number[] = [];
    let passN = 0;
    let passD = 0;
    for (const d of ds) {
      const s = sitting === SLOT_PERIODS[0] ? d.cell.february : d.cell.may;
      if (!s) continue;
      scores.push(...(s.scores[key] ?? []));
      for (const st of s.students) {
        const lvl = st.levels[key];
        if (!lvl) continue; // did not sit this subject
        passD += 1;
        if (levelIsPass(lvl)) passN += 1;
      }
    }
    return {
      mean: round(mean(scores), 1),
      median: round(median(scores), 1),
      high: scores.length ? round(Math.max(...scores), 1) : 0,
      low: scores.length ? round(Math.min(...scores), 1) : 0,
      sd: round(stddev(scores), 1),
      pass: pct(passN, passD),
    };
  }

  /** Best-of-two level distribution (%) for one subject/year. */
  function bestOfTwoLevels(ds: CellDerived[], key: string): SubjectYear["levels"] {
    const counts = new Array(performanceLevels.length).fill(0);
    let n = 0;
    for (const d of ds) {
      for (const r of d.overall) {
        const lvl = r.grades[key]?.level;
        if (!lvl) continue;
        const i = performanceLevels.indexOf(lvl);
        if (i < 0) continue;
        counts[i] += 1;
        n += 1;
      }
    }
    const out = emptyLevels();
    if (!n) return out;
    for (let i = 0; i < performanceLevels.length; i++) out[plevelKeyAt(i)] = pct(counts[i], n);
    return out;
  }

  /** February→May level movement for one subject/year (students in both). */
  function levelChange(ds: CellDerived[], key: string): { gain: number; up: number } {
    let gainSum = 0;
    let n = 0;
    let up = 0;
    for (const d of ds) {
      const mayByStudent = new Map(d.mayStudents.map((s) => [s.studentId, s]));
      for (const fs of d.febStudents) {
        const ms = mayByStudent.get(fs.studentId);
        if (!ms) continue;
        const fLvl = fs.levels[key];
        const mLvl = ms.levels[key];
        if (!fLvl || !mLvl) continue;
        const fr = performanceLevels.indexOf(fLvl);
        const mr = performanceLevels.indexOf(mLvl);
        if (fr < 0 || mr < 0) continue;
        // Lower rank = better level. Levels gained = febRank − mayRank.
        const gained = fr - mr;
        gainSum += gained;
        if (gained > 0) up += 1;
        n += 1;
      }
    }
    return { gain: n ? round(gainSum / n, 2) : 0, up: pct(up, n) };
  }

  const realYears = args.realYears ?? years;
  const realYearSet = new Set(realYears);
  const distinctRealYears = years.filter((y) => realYearSet.has(y));

  return {
    years,
    centres: centreNames,
    subjects: subjects.map((s) => ({ key: s.key, name: s.name, short: s.short, ...(s.rtl ? { rtl: true } : {}) })),
    awards,
    plevels,
    participation,
    perf,
    awardDist,
    awardByCentre,
    centreAwardSpread,
    centreSubjectSpread,
    hasComparison: distinctRealYears.length >= 2,
  };
}

// ── presentation vocabularies (map grading config → the design's ramps) ──────
// The engine's internal lowest award band ("No Award") is exposed as "Record of
// Learning". Keys/names are positional (best → worst) so a re-labelled vocabulary
// still maps cleanly; the raw label is the fallback name.

const AWARD_BAND_PRESENTATION: { key: AwardBand["key"]; name: string; short: string }[] = [
  { key: "dist", name: "Distinction", short: "Dist" },
  { key: "adv", name: "Advanced Achievement", short: "Adv" },
  { key: "sec", name: "Secondary Achievement", short: "Sec" },
  { key: "rol", name: "Record of Learning", short: "RoL" },
];

const PLEVEL_PRESENTATION: { key: PLevel["key"]; name: string; short: string }[] = [
  { key: "out", name: "Outstanding", short: "Out" },
  { key: "exc", name: "Exceeds", short: "Exc" },
  { key: "meet", name: "Meets", short: "Meet" },
  { key: "not", name: "Does Not Yet Meet", short: "DNYM" },
];

/** Build the ordinal award-band ramp from the grading config's award labels. */
export function overallAwardBands(_awardLevels: readonly string[]): AwardBand[] {
  return AWARD_BAND_PRESENTATION.map((b) => ({ ...b }));
}

/** Build the ordinal performance-level ramp from the grading config's levels. */
export function overallPLevels(_performanceLevels: readonly string[]): PLevel[] {
  return PLEVEL_PRESENTATION.map((p) => ({ ...p }));
}

/** Canonical, stable subject key from a subject's short/long name. Matches the
 *  hydrate `classify` subject codes for the known five; slugifies anything else. */
export function subjectKeyOf(name: string): string {
  const n = name.toLowerCase();
  if (/[؀-ۿ]/.test(name) || /arabic/.test(n)) return "afl";
  if (/applicable math|\bmath/.test(n)) return "am";
  if (/english/.test(n)) return "esl";
  if (/scientific/.test(n)) return "st";
  if (/life/.test(n)) return "ls";
  return n.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "subj";
}
