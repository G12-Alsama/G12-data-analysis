/**
 * Overall rollup — a year's LOCKED sittings combined into one per-student, per-subject
 * result.
 *
 * This is comparison / aggregation only. It consumes each sitting's already
 * signed-off, safeguard-checked grades (a `GradesModel`) and:
 *
 *   1. For every student × subject, takes the BEST performance level across the sittings
 *      (by level RANK, best → lowest — never by raw score). A sitting with no result for
 *      that subject is simply absent from the comparison. When two or more sittings give
 *      the same best level, the LATEST sitting by period order supplies the cell. Each
 *      cell records which sitting it came from and every sitting's own level.
 *   2. Derives the overall award from the best per-subject levels using the EXISTING
 *      award-derivation rule (`deriveAward`) — it does not reinvent the award rule.
 *
 * It works for any number of sittings (one per period); the periods and their order come
 * from the registry (`./periods`), never from this file.
 *
 * It does NOT touch scoring, cut scores, or the D3 safeguard: those are per
 * sitting and already applied to each sitting's signed-off award. At the Overall
 * level the safeguard is NOT re-run, so `deriveAward` is called with
 * `d3Pass: true` (no cap recomputed on the rolled-up levels).
 *
 * Students are matched across sittings by their human Student ID (`studentId`),
 * which is stable across the pipeline runs (the internal cycle-scoped row id is not).
 */

import { deriveAward } from "@/lib/engine";
import { SITTING_ORDER, periodRank, type SittingKey } from "./periods";
import type {
  AssessmentRef,
  GradeCell,
  GradeMatrixRow,
  GradesModel,
  OverallGradeCell,
  OverallGradeRow,
  OverallSittingLevel,
} from "./types";

/** A blank / "" level means "no result for this subject in this sitting". */
function nonEmpty(level: string | undefined | null): string | null {
  return level && level.length > 0 ? level : null;
}

/**
 * Rank of a performance level within the best → lowest list (0 = best). A null
 * (no result) ranks worse than every real level so a present level always beats
 * an absent one; an unrecognised label is treated the same as absent.
 */
function rankOf(level: string | null, levels: readonly string[]): number {
  if (level === null) return Number.POSITIVE_INFINITY;
  const i = levels.indexOf(level);
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

function indexByStudent(model: GradesModel | null): Map<string, GradeMatrixRow> {
  const m = new Map<string, GradeMatrixRow>();
  for (const r of model?.rows ?? []) m.set(r.studentId, r);
  return m;
}

/** One sitting offered to the rollup: its period, and its grades (`null` = not counted). */
export interface RollupSitting {
  key: SittingKey;
  grades: GradesModel | null;
}

export interface RollupArgs {
  /**
   * The sittings to combine, one per period. Order does not matter — the rollup orders
   * them by the registry (oldest → newest), which is what decides ties. A sitting whose
   * `grades` is null is listed (it appears in each cell's `levels` as "no result") but
   * contributes nothing.
   */
  sittings: readonly RollupSitting[];
  /** Subjects to roll up (assessment refs). */
  assessments: AssessmentRef[];
  /** Performance levels, best → lowest. */
  performanceLevels: readonly string[];
  /** Award levels, best → lowest. */
  awardLevels: readonly string[];
  starMap: Record<string, string>;
}

/**
 * Roll the sittings up into per-student best-level rows. Pure: no provider, engine state,
 * or scoring — it only compares already-computed awards/levels.
 *
 * Throws on a period that is not in the registry or that is offered twice: both mean the
 * caller built the wrong input, and guessing would silently misattribute a result.
 */
export function rollupOverall(args: RollupArgs): OverallGradeRow[] {
  const { assessments, performanceLevels, awardLevels, starMap } = args;
  const seenKeys = new Set<string>();
  for (const s of args.sittings) {
    if (periodRank(s.key) < 0) throw new Error(`rollupOverall: unknown sitting period "${s.key}"`);
    if (seenKeys.has(s.key)) throw new Error(`rollupOverall: period "${s.key}" given twice — one sitting per period`);
    seenKeys.add(s.key);
  }
  // Oldest → newest by period order.
  const sittings = [...args.sittings].sort((a, b) => periodRank(a.key) - periodRank(b.key));
  const byStudent = sittings.map((s) => indexByStudent(s.grades));

  // Union of students by Student ID, newest sitting first (so the row order and the label
  // follow the most recent sitting), then anyone who only sat in an older one.
  const order: string[] = [];
  const seen = new Set<string>();
  for (let i = sittings.length - 1; i >= 0; i--) {
    for (const r of sittings[i]!.grades?.rows ?? []) {
      if (!seen.has(r.studentId)) { seen.add(r.studentId); order.push(r.studentId); }
    }
  }

  const rows: OverallGradeRow[] = [];
  for (const sid of order) {
    const found = byStudent.map((m) => m.get(sid) ?? null);
    const label = [...found].reverse().find((r) => r !== null)?.label ?? sid;

    const grades: Record<string, OverallGradeCell> = {};
    const subjectLevels: string[] = [];
    for (const a of assessments) {
      const levels: OverallSittingLevel[] = sittings.map((s, i) => ({
        key: s.key,
        level: nonEmpty(found[i]?.grades[a.id]?.level),
      }));
      if (levels.every((l) => l.level === null)) {
        // No result in any sitting — ranks as lowest for the award derivation,
        // exactly as a never-sat subject does on the per-sitting Grades screen.
        subjectLevels.push("");
        continue;
      }
      // Best by rank (lower index = better). Walking oldest → newest and letting a later
      // sitting replace the holder on `<=` makes a tie go to the LATEST sitting; an older
      // sitting wins only when it is strictly better.
      let best: OverallSittingLevel | null = null;
      let bestRank = Number.POSITIVE_INFINITY;
      for (const l of levels) {
        if (l.level === null) continue;
        const r = rankOf(l.level, performanceLevels);
        if (best === null || r <= bestRank) { best = l; bestRank = r; }
      }
      const level = best!.level as string;
      grades[a.id] = { level, stars: starMap[level] ?? "", source: best!.key, levels };
      subjectLevels.push(level);
    }

    // Overall award derived from the rolled-up levels via the existing rule. The
    // safeguard is per sitting and is NOT re-run here (d3Pass: true).
    const outcome = deriveAward(
      { subjectLevels, d3Pass: true },
      { performanceLevels, awardLevels },
    );

    rows.push({
      id: sid,
      studentId: sid,
      label,
      grades,
      award: outcome.award,
      presentIn: sittings.filter((_, i) => found[i] !== null).map((s) => s.key),
    });
  }
  return rows;
}

export interface OrderedRollupArgs {
  /**
   * The sittings' grades OLDEST → NEWEST, one per period in `keys` (default: the registry's
   * periods in order); a sitting that is absent or not counted is `null`. Ties go to the
   * NEWEST sitting.
   */
  sittings: readonly (GradesModel | null)[];
  /** The period of each entry of `sittings`, parallel to it. Default: `SITTING_ORDER`. */
  keys?: readonly SittingKey[];
  assessments: AssessmentRef[];
  performanceLevels: readonly string[];
  awardLevels: readonly string[];
  starMap: Record<string, string>;
}

/**
 * `rollupOverall` for sittings supplied as a positional list (the shape callers hold when
 * they walk the registry in order), so they never name the periods. Entry `i` is the
 * sitting of period `keys[i]` (the registry's i-th period by default). Any number of
 * sittings works as long as each has a period.
 */
export function rollupOrdered(args: OrderedRollupArgs): OverallGradeRow[] {
  const { sittings, keys = SITTING_ORDER, ...rest } = args;
  if (sittings.length > keys.length) {
    throw new Error(`rollupOrdered: ${sittings.length} sittings but only ${keys.length} periods — pass \`keys\` naming each sitting's period.`);
  }
  return rollupOverall({ ...rest, sittings: sittings.map((grades, i) => ({ key: keys[i]!, grades })) });
}

/**
 * Re-key a sitting's grades by a canonical SUBJECT key instead of its assessment id.
 *
 * Every sitting has its own assessment rows (own uuids), so the same subject in two
 * sittings has two different ids and rolling them up by id would never line the subjects
 * up. `keyOf` supplies the stable key (the subject, not the row). The returned model's
 * assessments carry the key as their `id`; nothing else about them changes.
 */
export function canonicalizeSubjects(model: GradesModel, keyOf: (a: AssessmentRef) => string): GradesModel {
  const keyByAssessment = new Map(model.assessments.map((a) => [a.id, keyOf(a)] as const));
  const seen = new Set<string>();
  const assessments: AssessmentRef[] = [];
  for (const a of model.assessments) {
    const key = keyByAssessment.get(a.id)!;
    if (seen.has(key)) continue;
    seen.add(key);
    assessments.push({ ...a, id: key });
  }
  const rows: GradeMatrixRow[] = model.rows.map((r) => {
    const grades: Record<string, GradeCell> = {};
    for (const [assessmentId, cell] of Object.entries(r.grades)) {
      const key = keyByAssessment.get(assessmentId);
      if (key) grades[key] = cell;
    }
    return { ...r, grades };
  });
  return { ...model, assessments, rows };
}

export interface ReconcileArgs {
  /** Subjects the award is derived over. */
  assessments: AssessmentRef[];
  performanceLevels: readonly string[];
  awardLevels: readonly string[];
}

/**
 * Reconcile each Overall row's stated award against the award RE-DERIVED from its
 * own best-of-two per-subject levels. The certificate states the overall award,
 * so this guards against issuing off a corrupted/mismatched score: if any row's
 * award no longer equals what its subject levels imply, the exports do not
 * reconcile to truth and official issuance must be blocked. Pure — no provider or
 * engine state beyond the shared `deriveAward` rule.
 */
export function overallAwardsReconcile(rows: OverallGradeRow[], args: ReconcileArgs): boolean {
  const { assessments, performanceLevels, awardLevels } = args;
  for (const r of rows) {
    const subjectLevels = assessments.map((a) => r.grades[a.id]?.level ?? "");
    const { award } = deriveAward(
      { subjectLevels, d3Pass: true },
      { performanceLevels, awardLevels },
    );
    if (award !== r.award) return false;
  }
  return true;
}
