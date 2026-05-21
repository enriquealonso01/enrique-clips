// Export project prompt_config_json from the DB into git-tracked files under
// config/projects/<profile_username>/<title-slug>.json, and (re)write
// config/manifest.json mapping files -> project ids.
//
// Modes:
//   node scripts/config-export.mjs              full snapshot: (over)write every
//                                               active project's file from the DB
//   node scripts/config-export.mjs --new-only   only write files for projects NOT
//                                               already in the manifest; never
//                                               overwrite an existing file
//                                               (the repo stays source of truth
//                                               for existing projects). Used by
//                                               the scheduled capture workflow.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env or .env).
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, getServiceClient, slugify } from "./_supabase.mjs";

const newOnly = process.argv.slice(2).includes("--new-only");

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

// Load the existing manifest so --new-only knows which projects are already
// tracked (by id) and which file paths are already taken.
let existingById = new Map();
const usedPaths = new Set();
const manifestPath = join(ROOT, "config/manifest.json");
if (existsSync(manifestPath)) {
  try {
    const prev = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const e of prev.projects || []) {
      existingById.set(e.project_id, e);
      usedPaths.add(e.path);
    }
  } catch {
    /* ignore a malformed manifest; treat as empty */
  }
}

function uniquePath(profile, title, id) {
  const base = `config/projects/${profile}/${slugify(title)}`;
  let path = `${base}.json`;
  // Collision-safe: if the slug path is already used by a different project
  // (e.g. a duplicate with the same title), append a short id suffix.
  if (usedPaths.has(path) || existsSync(join(ROOT, path))) {
    path = `${base}-${String(id).slice(0, 8)}.json`;
  }
  return path;
}

const manifest = [];
let added = 0;
for (const p of projects) {
  const profile = p.uploadpost_profile_username || "_unassigned";
  const known = existingById.get(p.id);

  let relPath;
  if (newOnly && known) {
    // Existing project: keep its file and path untouched (repo is source of truth).
    relPath = known.path;
  } else if (newOnly) {
    // New project: write a fresh, collision-safe file.
    relPath = uniquePath(profile, p.title, p.id);
    usedPaths.add(relPath);
    const absPath = join(ROOT, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, JSON.stringify(p.prompt_config_json ?? null, null, 2) + "\n", "utf8");
    added++;
    console.log(`+ new: ${relPath}`);
  } else {
    // Full snapshot: (over)write from the DB.
    relPath = `config/projects/${profile}/${slugify(p.title)}.json`;
    const absPath = join(ROOT, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, JSON.stringify(p.prompt_config_json ?? null, null, 2) + "\n", "utf8");
    console.log(`wrote ${relPath}`);
  }

  manifest.push({ project_id: p.id, title: p.title, profile_username: profile, path: relPath });
}

// In --new-only mode, only touch the manifest when we actually added a project,
// so a no-op run produces zero file changes (no empty scheduled commit).
if (!newOnly || added > 0) {
  manifest.sort((a, b) =>
    (a.profile_username + "/" + a.title).localeCompare(b.profile_username + "/" + b.title)
  );
  await writeFile(
    manifestPath,
    JSON.stringify({ generated_at: new Date().toISOString(), projects: manifest }, null, 2) + "\n",
    "utf8"
  );
}

if (newOnly) {
  console.log(
    added > 0
      ? `\nnew-only export: ${added} new file(s); manifest updated (${manifest.length} projects)`
      : `\nnew-only export: 0 new files; nothing to commit`
  );
} else {
  console.log(`\nwrote config/manifest.json (${manifest.length} projects)`);
}
