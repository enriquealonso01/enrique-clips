# Project prompt configs (git source of truth)

Each active project's `prompt_config_json` (the Style Bible: `global`, `metadata`,
`planning`, `keyframes`, `motion`, `audio`, `voiceover`, `overlays`, `memory`, …)
lives here as a version-controlled file. The repo is the **source of truth**; the
live DB (`projects.prompt_config_json` in Supabase `hvdvrqmrphbsouomjeqz`) is the
runtime copy the edge functions read.

A **channel** = a distinct Upload-Post profile (`uploadpost_profile_username`).
Files are grouped by channel; `Secret Backyard Builds 1/2/3` all share the
`secretBackyardBuilds` profile (one channel, three project rows).

```
config/
  manifest.json                       # file <-> project_id <-> channel index
  projects/
    <profile_username>/<title-slug>.json   # one file per project, raw prompt_config_json
```

These configs contain **no secrets** (API keys live in separate encrypted columns
/ Supabase Function Secrets), so they are safe to commit.

## Editing

1. Edit the JSON file for the project (e.g. ask Claude to edit it). The app shows
   this config **read-only** — it is not editable in the UI.
2. Commit + push to `main`.
3. Sync to the DB (see below). Until synced, the pipeline keeps using the old
   config already in the DB.

## Scripts

Both require `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (env or repo-root `.env`,
gitignored). The service-role key is needed because `projects` is RLS-protected.

```bash
# DB -> files: regenerate every file + manifest from the current DB state
npm run config:export

# files -> DB: push the repo configs into the DB (the repo is authoritative)
npm run config:push -- --dry-run            # preview changes, write nothing
npm run config:push                         # push all changed projects
npm run config:push -- --project <id>       # push one project
npm run config:push -- --profile mancavepro # push one channel
```

`config:push` compares key-insensitively, so it only writes projects whose config
actually differs.

> Auto-sync on push to `main` (GitHub Action) is intended to replace the manual
> `config:push` step — not wired up yet.
