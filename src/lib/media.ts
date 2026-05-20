import { supabase } from "@/integrations/supabase/client";

const R2_PUBLIC_BASE = ((import.meta.env.VITE_R2_PUBLIC_BASE as string | undefined) ??
  "https://pub-b0d05ec11efd4d32acdb4987f29fb610.r2.dev").replace(/\/+$/, "");

// Top-level prefixes that stay on Supabase Storage (small functional assets).
// Everything else — clips, keyframes, final videos, story-runs scenes — lives in R2.
const SUPABASE_PREFIXES = ["tracks/", "fonts/", "defaults/", "overlays/", "story-projects/"];

export function isSupabaseAsset(path: string): boolean {
  return SUPABASE_PREFIXES.some((p) => path.startsWith(p));
}

const encodeKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/");

/**
 * Public URL for a stored media path. Generated media is served from Cloudflare R2;
 * the small functional assets stay on Supabase Storage. Works for both newly generated
 * and backfilled media because the R2 object key mirrors the original Supabase path.
 */
export function mediaUrl(path: string | null | undefined): string {
  if (!path) return "";
  if (isSupabaseAsset(path)) {
    return supabase.storage.from("project-assets").getPublicUrl(path).data.publicUrl;
  }
  return R2_PUBLIC_BASE ? `${R2_PUBLIC_BASE}/${encodeKey(path)}` : "";
}
