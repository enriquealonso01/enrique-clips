// Push git-tracked prompt config files back into the DB
// (projects.prompt_config_json). The repo is the source of truth.
//
// Usage:
//   node scripts/config-push.mjs --dry-run          # show what would change, write nothing
//   node scripts/config-push.mjs                    # push every changed project
//   node scripts/config-push.mjs --project <id>     # push a single project
//   node scripts/config-push.mjs --profile <name>   # push one channel (profile_username)
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env or .env).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, getServiceClient } from "./_supabase.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const projectFilter = flag("--project");
const profileFilter = flag("--profile");

const supabase = await getServiceClient();

const manifest = JSON.parse(await readFile(join(ROOT, "config/manifest.json"), "utf8"));
let entries = manifest.projects || [];
if (projectFilter) entries = entries.filter((e) => e.project_id === projectFilter);
if (profileFilter) entries = entries.filter((e) => e.profile_username === profileFilter);

if (entries.length === 0) {
  console.error("No matching entries in config/manifest.json.");
  process.exit(1);
}

let changed = 0;
let pushed = 0;
for (const e of entries) {
  let fileJson;
  try {
    fileJson = JSON.parse(await readFile(join(ROOT, e.path), "utf8"));
  } catch (err) {
    console.error(`! ${e.title}: cannot read/parse ${e.path}: ${err.message}`);
    continue;
  }

  const { data: row, error } = await supabase
    .from("projects")
    .select("prompt_config_json")
    .eq("id", e.project_id)
    .single();
  if (error) {
    console.error(`! ${e.title}: ${error.message}`);
    continue;
  }

  // Stable comparison so key order never causes false diffs.
  const norm = (v) => JSON.stringify(sortKeys(v));
  if (norm(row.prompt_config_json) === norm(fileJson)) {
    console.log(`= ${e.title} (no change)`);
    continue;
  }
  changed++;
  if (dryRun) {
    console.log(`~ ${e.title} WOULD update  (${e.path})`);
    continue;
  }
  const { error: upErr } = await supabase
    .from("projects")
    .update({ prompt_config_json: fileJson })
    .eq("id", e.project_id);
  if (upErr) {
    console.error(`! ${e.title}: ${upErr.message}`);
    continue;
  }
  pushed++;
  console.log(`✓ ${e.title} updated`);
}

console.log(`\n${dryRun ? "dry-run" : "push"} complete: ${changed} changed, ${pushed} pushed`);

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeys(v[k]);
        return acc;
      }, {});
  }
  return v;
}
