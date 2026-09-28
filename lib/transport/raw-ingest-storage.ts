/**
 * Shared constants for the raw-ingest Storage handoff (migration 0046).
 *
 * The client gzips the full ingest payload (cleaned responses + the 3-CSV
 * canonical model — lib/ingest) and uploads it directly to this bucket instead of
 * sending it in the POST body. Vercel caps request bodies at a hard 4.5 MB
 * platform-wide regardless of compression, so a large-enough cohort still 413s
 * even gzipped (the prior fix, commit 63288db, only pushed that ceiling further
 * out). Supabase Storage has no such ceiling for payloads this size, so this
 * removes payload size as a class of failure at any cohort size, not just a
 * larger one. The ingest route is then POSTed only a small `{ filePath }`
 * reference, downloads the object with the admin client (bypasses Storage RLS,
 * same trust boundary as the table writes it already performs), and deletes it
 * immediately after reading — see app/api/cycles/[cycleId]/ingest/route.ts.
 */
export const RAW_INGEST_BUCKET = "raw-ingest";

/**
 * One object per upload, under the cycle's own path prefix. The Storage RLS
 * policies (migration 0046) scope INSERT/SELECT on this bucket to a lead_admin of
 * exactly this `cycle_id` — the first path segment is read by `app.path_cycle_id`.
 * Client-only (uses the Web Crypto global); the server never constructs a path,
 * only validates the one the client sent.
 */
export function rawIngestPath(cycleId: string): string {
  return `${cycleId}/${crypto.randomUUID()}.json.gz`;
}
