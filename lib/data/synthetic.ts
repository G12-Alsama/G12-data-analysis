/**
 * The single definition of SYNTHETIC (non-real) data on the live database.
 *
 * Migration 0043 seeded an analytics sample under test centres whose slug begins
 * `seed-ov-` (names carry a "△ Sample" marker); migration 0046 adds the durable
 * `test_centres.is_synthetic` flag and backfills it for those centres. A centre is
 * synthetic when EITHER marker is present, so the guard holds on a database that
 * has 0043 but not yet 0046.
 *
 * Synthetic centres — and every year / cycle under them — never appear in a real
 * year, never become the live cycle, and never feed an Overall. Nothing here
 * deletes data: 0043's own rollback remains the way to remove the sample.
 */

export const SYNTHETIC_SLUG_PREFIX = "seed-ov-";

export interface CentreMarker {
  slug?: string | null;
  is_synthetic?: boolean | null;
}

export function isSyntheticCentre(c: CentreMarker | null | undefined): boolean {
  if (!c) return false;
  return c.is_synthetic === true || (c.slug ?? "").startsWith(SYNTHETIC_SLUG_PREFIX);
}

/**
 * Opt-in only: show the 0043 analytics sample on the analytics page (tagged
 * `synthetic`). Off unless `NEXT_PUBLIC_SHOW_SYNTHETIC_ANALYTICS=1`. Never affects
 * a year's Overall or certificates.
 */
export function showSyntheticAnalytics(): boolean {
  return process.env.NEXT_PUBLIC_SHOW_SYNTHETIC_ANALYTICS === "1";
}
