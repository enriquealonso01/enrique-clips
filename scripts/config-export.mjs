// Export each non-archived project's prompt_config_json from the DB into a
// git-tracked file under config/projects/<profile_username>/<title-slug>.json,
// and (re)write config/manifest.json mapping files -> project ids.
//
// Usage:  node scripts/config-export.mjs   (or: npm run config:export)
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env or .env).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ROOT, getServiceClient, slugify } from "./_supabase.mjs";

const supabase = await getServiceClient();

const { data: projects, error } = await supabase
  .from("projects")
  .select("id, title, uploadpost_profile_username, prompt_config_json")
  .eq("is_archived", false)
  .order("uploadpost_profile_username", { ascending: true })
  .order("title", { ascending: true });

if (error) {
  console.error("Query failed:", error.message);
  process.exit(1);
}

const manifest = [];
for (const p of projects) {
  const profile = p.uploadpost_profile_username || "_unassigned";
  const relPath = `config/projects/${profile}/${slugify(p.title)}.json`;
  const absPath = join(ROOT, relPath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, JSON.stringify(p.prompt_config_json ?? null, null, 2) + "\n", "utf8");
  manifest.push({ project_id: p.id, title: p.title, profile_username: profile, path: relPath });
  console.log(`wrote ${relPath}`);
}

manifest.sort((a, b) =>
  (a.profile_username + "/" + a.title).localeCompare(b.profile_username + "/" + b.title)
);
await writeFile(
  join(ROOT, "config/manifest.json"),
  JSON.stringify({ generated_at: new Date().toISOString(), projects: manifest }, null, 2) + "\n",
  "utf8"
);
console.log(`\nwrote config/manifest.json (${manifest.length} projects)`);
