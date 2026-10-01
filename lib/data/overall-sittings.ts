/**
 * Aligning two REAL sittings for the Overall rollup.
 *
 * Each sitting is its own exam_cycle, so its subjects are distinct `assessments`
 * rows with distinct ids. `rollupOverall` (never-touch) matches a student's two
 * sittings per `AssessmentRef.id`, so before the rollup both sittings' grade
 * cells are re-keyed onto ONE canonical subject key (`subjectKeyOf`, the same key
 * the analytics read-model uses: am / st / esl / afl / ls). Pure presentation
 * plumbing — no level, award or score is changed.
 */
import { subjectKeyOf } from "./overall-analytics";
import type { AssessmentRef, GradesModel } from "./types";

export interface CanonicalSubjects {
  /** Canonical subject refs (id = subject key), May's order first, then February-only subjects. */
  refs: AssessmentRef[];
  /** Per-cycle assessment id → canonical subject key. */
  keyOf: Map<string, string>;
  /** Set when two subjects of ONE sitting share a key (would merge two results). */
  collision: string | null;
}

/** Union of the sittings' subjects under canonical keys. Pass May first. */
export function canonicalSubjects(sittings: (GradesModel | null)[]): CanonicalSubjects {
  const refs: AssessmentRef[] = [];
  const seen = new Set<string>();
  const keyOf = new Map<string, string>();
  let collision: string | null = null;
  for (const g of sittings) {
    if (!g) continue;
    const inThisSitting = new Set<string>();
    for (const a of g.assessments) {
      const key = subjectKeyOf(a.name || a.shortName);
      if (inThisSitting.has(key) && collision === null) collision = `${a.name} → ${key}`;
      inThisSitting.add(key);
      keyOf.set(a.id, key);
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ ...a, id: key });
      }
    }
  }
  return { refs, keyOf, collision };
}

/** The same sitting with every grade cell keyed by canonical subject key. */
export function rekeyGrades(model: GradesModel, keyOf: Map<string, string>): GradesModel {
  return {
    ...model,
    assessments: model.assessments.map((a) => ({ ...a, id: keyOf.get(a.id) ?? a.id })),
    rows: model.rows.map((r) => ({
      ...r,
      grades: Object.fromEntries(Object.entries(r.grades).map(([id, cell]) => [keyOf.get(id) ?? id, cell])),
    })),
  };
}
