/**
 * POST /api/cycles/:cycleId/ingest — raw-export ingest write path.
 *
 * Persists a cleaned, split combined export (assessments + items + participants +
 * the response matrix) for a cycle, then runs the engine write path so item_stats
 * and participant_scores are ready when the client re-hydrates. The browser parses
 * + cleans + validates the file (reusing lib/ingest) and uploads the cleaned
 * responses straight to Supabase Storage (migration 0046); this route is POSTed
 * only a small `{ filePath }` reference, downloads + decompresses the payload
 * itself, then runs the persist + engine work server-side (the engine never runs
 * in the browser, and these tables are not client-writable). See
 * lib/transport/raw-ingest-storage.ts for why: the payload no longer needs to fit
 * Vercel's 4.5 MB request-body ceiling at any cohort size.
 *
 * The caller is authorized as a lead_admin of the cycle via the RLS-scoped session
 * client; the privileged writes then use the secret-key admin client.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestCleanResponses } from "@/lib/server/ingest-write";
import { recomputeAndWrite } from "@/lib/server/engine-write";
import { checkSchemaHealth, describeSchemaHealth } from "@/lib/server/schema-health";
import { authorizeCycleAdmin } from "@/lib/auth/authorize-cycle";
import { gunzipToText } from "@/lib/transport/gzip";
import { RAW_INGEST_BUCKET } from "@/lib/transport/raw-ingest-storage";
import type { CleanResponse, ValidationReport } from "@/lib/ingest/types";
import type { CanonicalModel } from "@/lib/ingest/qm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The full pipeline (download + decompress the Storage payload, ingest_persist's
// 6 bulk/set-based table writes, then recomputeAndWrite's read-back + engine +
// score writes — no per-row round trips anywhere in it) is estimated at ~10-30s
// typical, ~45-60s worst case for a ~1,431-result / ~50k-row import. 120s leaves
// 2-4x headroom. Requires a Vercel plan whose maxDuration ceiling covers this
// (Hobby's hard ceiling is 60s) — confirm the project's plan before deploying.
export const maxDuration = 120;

/** The small POST body: a reference to the payload the client already uploaded
 *  to Storage (see lib/transport/raw-ingest-storage.ts), not the payload itself. */
interface IngestTriggerBody {
  filePath: string;
}

interface IngestBody {
  clean: CleanResponse[];
  report?: ValidationReport;
  fileName?: string;
  /** Combined size (MB) of the uploaded export set — recorded for the file-meta chip. */
  fileSizeMB?: number;
  /** Faithful 3-CSV canonical model (persists the richer intake — migration 0006). */
  canonical?: CanonicalModel;
  /** Source filenames for the three QM exports. */
  files?: { items?: string; assessments?: string; topics?: string };
}

export async function POST(req: Request, { params }: { params: { cycleId: string } }) {
  const cycleId = params.cycleId;

  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) return NextResponse.json({ error: "You must be signed in to upload" }, { status: 401 });

  // Authorize via the admin client (service role) so a workspace admin's
  // cycle_id = NULL membership is honoured even if the memberships RLS/helpers
  // have drifted — and surface the concrete reason, never a bare "forbidden".
  const admin = createAdminClient();
  const gate = await authorizeCycleAdmin(admin, user.id, cycleId);
  if (!gate.allowed) return NextResponse.json({ error: gate.reason }, { status: 403 });

  let trigger: IngestTriggerBody;
  try {
    trigger = JSON.parse(await req.text()) as IngestTriggerBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // Defense in depth beyond the Storage RLS policy (migration 0046): the admin
  // client below bypasses Storage RLS entirely, so this route must itself refuse
  // to read a path outside the authorized cycle — otherwise a lead_admin of one
  // cycle could reference another cycle's uploaded (PII-bearing) payload by path.
  if (typeof trigger.filePath !== "string" || !trigger.filePath.startsWith(`${cycleId}/`)) {
    return NextResponse.json({ error: "invalid or missing filePath" }, { status: 400 });
  }

  let body: IngestBody;
  try {
    const { data, error } = await admin.storage.from(RAW_INGEST_BUCKET).download(trigger.filePath);
    if (error || !data) throw new Error(error?.message ?? "uploaded file not found");
    const text = await gunzipToText(await data.arrayBuffer());
    body = JSON.parse(text) as IngestBody;
  } catch (e) {
    return NextResponse.json({ error: `Couldn't read the uploaded file: ${(e as Error).message}` }, { status: 400 });
  } finally {
    // Best-effort cleanup — the payload carries participant PII, so it never
    // needs to outlive this request regardless of how parsing went.
    await admin.storage.from(RAW_INGEST_BUCKET).remove([trigger.filePath]).catch(() => {});
  }
  if (!Array.isArray(body.clean) || body.clean.length === 0) {
    return NextResponse.json({ error: "no cleaned responses to ingest" }, { status: 400 });
  }

  try {
    // Fail loud + early if the live DB is behind the code (e.g. items.item_set
    // or ingest_persist missing) — an actionable "run migration NNNN" beats a
    // raw Postgres column error mid-persist. 503: the request is fine, the DB
    // needs migrating.
    const health = await checkSchemaHealth(admin);
    if (!health.ok) {
      return NextResponse.json({ error: describeSchemaHealth(health) }, { status: 503 });
    }
    const ingest = await ingestCleanResponses(admin, cycleId, body.clean, {
      fileRef: body.fileName,
      fileSizeMB: body.fileSizeMB,
      report: body.report,
      canonical: body.canonical,
      files: body.files,
      // Resolved from the session client above — the admin client has no session,
      // so import_batches.created_by must be set explicitly (NOT NULL).
      createdBy: user.id,
    });
    const compute = await recomputeAndWrite(admin, cycleId);
    // Mark the cycle as past the draft/upload stage now that data is in. The
    // typed client marks `status` non-client-writable, but the secret-key admin
    // client is the sanctioned privileged writer (it bypasses RLS).
    await (admin.from as unknown as (n: string) => {
      update(v: unknown): { eq(c: string, val: string): Promise<{ error: { message: string } | null }> };
    })("exam_cycles").update({ status: "in_review" }).eq("id", cycleId);
    return NextResponse.json({ ok: true, ingest, compute });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
