// Cloudflare R2 storage helper (S3-compatible) for edge functions.
//
// Generated media (clips, final videos, keyframes, story scenes) is stored in R2
// instead of Supabase Storage to keep Supabase storage flat and serve video with
// zero egress cost. The object KEY mirrors the old Supabase path (e.g.
// "<projectId>/clips/<runId>/vidu-<id>.mp4"), so DB rows that hold `supabase_path`
// keep working once URLs are built from R2.
//
// Required Function Secrets (only the two credentials must be set; the rest default below):
//   R2_ACCESS_KEY_ID     (from an R2 API token) — REQUIRED
//   R2_SECRET_ACCESS_KEY (from an R2 API token) — REQUIRED
// Optional env overrides (sensible defaults baked in): R2_S3_ENDPOINT, R2_BUCKET, R2_PUBLIC_BASE
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID") ?? "";
const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "";
const endpoint = (Deno.env.get("R2_S3_ENDPOINT") ?? "https://cf46697f0e44e7385964c97ba90fd296.r2.cloudflarestorage.com").replace(/\/+$/, "");
const bucket = Deno.env.get("R2_BUCKET") ?? "enrique-clips-media";
const publicBase = (Deno.env.get("R2_PUBLIC_BASE") ?? "https://pub-b0d05ec11efd4d32acdb4987f29fb610.r2.dev").replace(/\/+$/, "");

const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });

// Percent-encode each path segment, preserving "/" separators.
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/** True only when every R2 secret is present. Lets callers fall back to Supabase. */
export function r2Configured(): boolean {
  return Boolean(accessKeyId && secretAccessKey && endpoint && bucket && publicBase);
}

/** Public URL the browser/app uses to fetch an object by its key. */
export function r2PublicUrl(key: string): string {
  return `${publicBase}/${encodeKey(key)}`;
}

/** Upload bytes to R2 under `key`. Returns the key and its public URL. */
export async function r2Upload(
  key: string,
  body: Uint8Array | ArrayBuffer | Blob,
  contentType: string,
): Promise<{ key: string; publicUrl: string }> {
  if (!r2Configured()) {
    throw new Error(
      "R2 not configured: set R2_S3_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_BASE",
    );
  }
  const url = `${endpoint}/${bucket}/${encodeKey(key)}`;
  const res = await client.fetch(url, {
    method: "PUT",
    body: body as BodyInit,
    headers: { "Content-Type": contentType },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`R2 upload failed ${res.status} for ${key}: ${detail}`);
  }
  return { key, publicUrl: r2PublicUrl(key) };
}

// Prefixes kept on Supabase Storage (small functional assets). Everything else is R2.
const SUPABASE_PREFIXES = ["tracks/", "fonts/", "defaults/", "overlays/", "story-projects/"];
const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");

export function isSupabaseAsset(key: string): boolean {
  return SUPABASE_PREFIXES.some((p) => key.startsWith(p));
}

/** Public URL for a stored media key: Supabase for kept assets, R2 for generated media. */
export function mediaPublicUrl(key: string): string {
  if (isSupabaseAsset(key)) {
    return `${supabaseUrl}/storage/v1/object/public/project-assets/${encodeKey(key)}`;
  }
  return r2PublicUrl(key);
}

