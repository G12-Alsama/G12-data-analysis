/**
 * Canonical G12++ subject catalog — the five assessments every cycle is built
 * from. This is the source of truth for the new-cycle assessment picker, so the
 * list is available even before any cycle exists in the database (the picker
 * must never depend on a loaded live cycle, or it shows "0 of 0").
 *
 * The `name` strings are the ones written to `assessments.name` when a cycle is
 * created; they are deliberately phrased so the hydration classifier
 * (supabase-hydrate.ts `classify`) maps each back to its subject code.
 */
/** Arabic Unicode block (U+0600–U+06FF) — the same script-aware test used in lib/data/essays.ts. */
const ARABIC_SCRIPT = /[؀-ۿ]/;

export interface SubjectCatalogEntry {
  /** Stable catalog id used by the picker + CreateCycleInput.assessmentIds. */
  id: string;
  /** Display + persisted assessment name. */
  name: string;
  /** Right-to-left script (Arabic) — drives the RTL badge in the picker. */
  rtl: boolean;
  /**
   * Does a raw/source assessment name (however the QM export happened to spell
   * or script it, e.g. "G12++ اللّغة العربيّة") belong to this catalog subject?
   * Script-aware for Arabic (a Latin-only `/arabic/i` regex never matches an
   * Arabic-script name) and a loose keyword match for the rest.
   */
  matchesRawName: (rawName: string) => boolean;
}

export const SUBJECT_CATALOG: SubjectCatalogEntry[] = [
  { id: "subj-applicable-maths", name: "Applicable Maths", rtl: false, matchesRawName: (n) => /applicable\s*math/i.test(n) },
  { id: "subj-scientific-thinking", name: "Scientific Thinking", rtl: false, matchesRawName: (n) => /scientific/i.test(n) },
  { id: "subj-arabic-1st-language", name: "Arabic 1st Language", rtl: true, matchesRawName: (n) => ARABIC_SCRIPT.test(n) || /arabic/i.test(n) },
  { id: "subj-english-2nd-language", name: "English 2nd Language", rtl: false, matchesRawName: (n) => /english/i.test(n) },
  { id: "subj-life-success-skills", name: "Life Success Skills", rtl: false, matchesRawName: (n) => /life/i.test(n) },
];

/**
 * Resolve a raw/source assessment name to its canonical catalog display name —
 * the SINGLE mapping step every downstream consumer (Class Performance's
 * per-subject headers, Student Summary/Profiles' canonical columns, and any
 * future one) should call, so they can never disagree on what a subject is
 * called or key data under two different names. Returns the raw name
 * unchanged when it matches no known subject (a genuinely unrecognised
 * assessment), so nothing crashes or silently disappears.
 */
export function canonicalSubjectName(rawName: string): string {
  return SUBJECT_CATALOG.find((s) => s.matchesRawName(rawName))?.name ?? rawName;
}

/** Resolve selected catalog ids → the assessment names to persist (order kept). */
export function catalogNamesFor(assessmentIds: string[]): string[] {
  return assessmentIds
    .map((id) => SUBJECT_CATALOG.find((s) => s.id === id)?.name)
    .filter((n): n is string => Boolean(n));
}

/**
 * True when an assessment is a non-exam SURVEY instrument rather than one of the
 * five scored exams. The cleaned data carries survey instruments (the "User
 * Experience Survey …" and per-subject "Survey-<subject>" sheets) that have no
 * correct answers and no scored denominator — including them would pollute cohort
 * averages / completion stats. Matched by name (case-insensitive) so it holds for
 * live data whose assessment names vary; the five real exams never match. Keep the
 * test broad ("survey" / "user experience") so a newly-named survey is still
 * caught without a code change.
 */
export function isSurveyAssessment(name: string | null | undefined): boolean {
  if (!name) return false;
  return /\bsurvey\b|user\s*experience/i.test(name);
}

/** Inverse of `isSurveyAssessment`: a scored exam that belongs in cohort stats. */
export function isScoredExamAssessment(name: string | null | undefined): boolean {
  return !isSurveyAssessment(name);
}
