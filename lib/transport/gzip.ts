/**
 * Transport-only gzip helpers, built on the native `CompressionStream` /
 * `DecompressionStream` Web APIs — available in the browser and in both the
 * Node and Edge runtimes on Vercel — so this adds no dependency and pins no
 * runtime.
 *
 * Why this exists: the raw-export ingest payload (the cleaned response matrix +
 * canonical model) grows with the cohort. It no longer travels in the POST body
 * at all (see lib/transport/raw-ingest-storage.ts) — the client gzips it and
 * uploads it straight to Supabase Storage, and the ingest route downloads +
 * decompresses it server-side. Compressing it here still matters for that
 * upload/download, just not for Vercel's 4.5 MB request-body ceiling anymore.
 *
 * This is transport only. The bytes recovered on the server are byte-identical
 * to what the client sent, so everything downstream of decompression — parse,
 * detect, join, split, persist, validate — receives exactly the text it
 * receives today.
 */

/** Compress a UTF-8 string to a gzip `Blob` (client side). */
export async function gzipText(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).blob();
}

/** Compress a `Blob`/`File` to a gzip `Blob` (client side). */
export async function gzipBlob(input: Blob): Promise<Blob> {
  const stream = input.stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).blob();
}

/** Decompress gzip bytes back to a UTF-8 string (Node or Edge runtime). */
export async function gunzipToText(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const stream = new Blob([buf as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}
