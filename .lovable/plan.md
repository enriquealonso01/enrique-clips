## Problem

The Stories publish step (Stage 19 in `story-finalize`) has been re-engineered repeatedly and is now a tangle of: direct binary uploads, per-attempt retries with 120s timeouts, in-flight chaining mid-publish, `publish_submitted_platforms` tracked in `story_runs.generated_metadata`, and a watchdog (`scheduler`) that re-triggers `publish_only`/`post_now` retries.

Side effects observed:
- The same final video was posted up to 10 times to the same platform.
- Runs deadlock in `publishing` then get re-triggered, each retry creating a new `publish_jobs` row (e.g. run `f77af2a2…` has 3 rows; nothing prevents 10).
- Past-due `scheduled_date` causes Upload-Post errors that mark attempts as failed even when the post actually went through.
- The intra-invocation `alreadySubmitted` set is rebuilt from `generated_metadata.publish_submitted_platforms`, but each re-trigger goes back through "Stage 19" and re-submits all platforms because that flag is unreliable when timeouts abort before the metadata write.

The Projects pipeline (`finalize-video`) does NOT have this problem. It uses a single, much simpler model that we should mirror.

## Solution: copy the Projects publish model verbatim

Rip out the entire Stage 19 block in `supabase/functions/story-finalize/index.ts` and replace it with the exact pattern used in `supabase/functions/finalize-video/index.ts` (lines ~2743-2941).

### The Projects pattern (what we will copy)

1. **Hard idempotency check first.** Query `publish_jobs` for the run with status in (`submitted`, `polling`, `completed`). If any row exists → log "Publish job already exists — skipping duplicate publish" and return. This single check is what prevents repeat posts.
2. **One `publish_jobs` row per run.** Insert one row with status `submitted` before any Upload-Post call. Never insert another for the same run.
3. **Async URL upload.** Use `formData.append("video", videoUrl)` + `async_upload=true` and let Upload-Post fetch the public URL itself. No `Blob` download, no 120s client timeouts, no in-flight chaining.
4. **Group platforms by identical title+description**, send one Upload-Post request per group, fire-and-forget (single attempt, no per-platform retry loop).
5. **Schedule handling**: only attach `scheduled_date` when `isFutureScheduledDate(...)` is true; otherwise post immediately. Same helper already used in `finalize-video`.
6. **Final job state**: on any successful submission, update the publish_jobs row to `polling` with `uploadpost_request_id`/`uploadpost_job_id`. On total failure, mark `failed`. The existing `uploadpost-webhook` and the polling logic continue from there — no changes needed.

### What we delete from `story-finalize`

- The direct binary download / `Blob` upload path.
- `UPLOADPOST_TIMEOUT_MS`, `UPLOADPOST_MAX_ATTEMPTS`, `UPLOADPOST_RETRY_BACKOFF_MS`, the per-attempt `AbortController`, and the retry/backoff loop.
- `PUBLISH_CHAIN_AFTER_MS` and the mid-publish chaining branch (`fetch(chainUrl, … publish_only: true)`).
- `publish_submitted_platforms`, `publish_last_request_id`, `publish_retry_required`, `publish_heartbeat_at`, `publish_current_platform` reads/writes inside Stage 19.
- The `force_metadata` / `post_now` / `publish_only` re-entry logic specific to publish (the "Post Now" UI button keeps working, see below).

### Watchdog change (`supabase/functions/scheduler/index.ts`)

Remove `publishing` from `ACTIVE_STAGES` for stories so the watchdog stops re-triggering publish-only retries. With hard idempotency in place this would be safe anyway, but removing it eliminates the source of the duplicate-row attempts entirely. A run that genuinely fails publish will be marked `failed` by `story-finalize` and surfaced in the UI; the user can use the "Post Now" button.

### "Post Now" button (`src/pages/StoryRunMonitor.tsx`)

Keep the button, but change its behavior to match the Projects flow:
1. Delete (or mark `failed`) any existing `publish_jobs` rows for the run so the idempotency check lets the next attempt through.
2. Clear `publish_scheduled_date` in `generated_metadata`.
3. Invoke `story-finalize` with `{ publish_only: true, force_metadata: true }`.

This is the only sanctioned path to re-publish, and because we wipe the prior publish_jobs row first, it can never produce duplicates by accident.

### Database cleanup

For the currently-stuck run `f77af2a2-613e-4c7b-bfdd-1f91e0b223e7`, after deploying the new code:
- Mark its 3 existing publish_jobs rows as `failed`.
- Clear `publish_scheduled_date` / `publish_timezone` / `publish_submitted_platforms` from `generated_metadata`.
- Reset `status='ready_to_publish'` (or equivalent) and use the "Post Now" button to publish once with the new code path.

## Files to edit

- `supabase/functions/story-finalize/index.ts` — replace Stage 19 block (~lines 780-1100) with the Projects-style publish block.
- `supabase/functions/scheduler/index.ts` — remove `publishing` from stories `ACTIVE_STAGES`.
- `src/pages/StoryRunMonitor.tsx` — "Post Now" handler clears prior publish_jobs + scheduled date before invoking.
- One data migration / SQL update to fix the stuck run.

## Acceptance criteria

- A single story run produces at most one `publish_jobs` row.
- A second invocation of `story-finalize` for the same run logs "Publish job already exists — skipping duplicate publish" and exits.
- No platform receives the same video more than once unless the user explicitly clicks "Post Now" (which resets the publish_jobs row first).
- Run `f77af2a2…` is published exactly once after the fix.
