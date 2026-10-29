/**
 * Manual mark adjustment — shared constants and error wording.
 *
 * The cap itself lives in the database (`adjust_participant_mark_bounded`, migration
 * 0052); the client mirrors it only to give feedback before a round trip.
 */

/** The largest change, in marks, the Score page may make to a mark. */
export const SCORE_PAGE_MAX_MARK_DELTA = 5;

/**
 * A server refusal turned into a sentence for the user. Unknown messages pass through
 * (they are the database's own, already written to be read — e.g. the ±5 cap names the
 * current and requested marks).
 */
export function friendlyMarkAdjustError(message: string): string {
  const m = message.trim();
  if (/not authorized/i.test(m)) return "You don’t have permission to adjust marks.";
  if (/could not find the function|schema cache|does not exist/i.test(m)) {
    return "The database hasn’t been updated for this yet (migration 0052). Ask an admin to apply it.";
  }
  return m.charAt(0).toUpperCase() + m.slice(1);
}
