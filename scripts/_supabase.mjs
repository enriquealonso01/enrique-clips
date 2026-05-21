// Shared helpers for the config export/push scripts.
// Resolves the repo root, loads env (process.env first, then repo-root .env),
// and builds a service-role Supabase client.
import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadEnv() {
  const env = { ...process.env };
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    const txt = await readFile(envPath, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

export async function getServiceClient() {
  const env = await loadEnv();
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
        "Set them in the environment or in enrique-clips/.env (gitignored).\n" +
        "The service-role key is required because projects.* is RLS-protected."
    );
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}
