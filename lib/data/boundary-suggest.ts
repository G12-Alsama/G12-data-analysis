/**
 * Should the Cut Scores page auto-seed a backsolved suggestion for this scope?
 *
 * Only for a genuinely fresh scope: scored data to backsolve, not locked, no scheme a
 * person already committed, and no suggestion adopted yet. `schemeStored` is the key
 * guard — `suggestedCuts` is NOT persisted (`grade_schemes` stores only
 * `{scope, method, bands}`), so it is null on every reload, and keying on it alone made
 * the page overwrite confirmed cuts with a fresh backsolve each time it opened.
 */
import type { BoundaryModel } from "./types";

export function needsAutoSuggestion(
  model: Pick<BoundaryModel, "locked" | "n" | "suggestedCuts" | "schemeStored"> | null | undefined,
): boolean {
  return !!model && !model.locked && model.n > 0 && !model.schemeStored && model.suggestedCuts == null;
}
