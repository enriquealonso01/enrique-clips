## Problem

The Stories publish step (Stage 19 in `supabase/functions/story-finalize/index.ts`) has been re-engineered repeatedly and is now a tangle: direct binary uploads, per-attempt timeouts, in-flight chaining mid-publish, `publish_submitted_platforms` tracked inside `story_runs.generated_metadata`, and a watchdog (`scheduler`) that re-triggers `publish_only` retries.

Observed effects:
- The same final video was posted up to 10 times to the same platform.
- Runs deadlock in `publishing`, get re-triggered by the watchdog, and each retry inserts a new `publish_jobs` row (e.g. run `f77af2a2…` has 3; nothing prevents 10).
- Past-due `scheduled_date` makes Upload-Post reject submissions even after the post went through.
- The intra-invocation `alreadySubmitted` set is unreliable across re-triggers because its persistence is racy with timeouts.

The Projects pipeline (`finalize-video`, lines ~2743-2941) does NOT have these problems. It uses a single, much simpler model. We will replace Stories Stage 19 with that exact pattern.

## Changes

### 1. `supabase/functions/story-finalize/index.ts` — replace Stage 19

Delete:
- Constants `UPLOADPOST_TIMEOUT_MS`, `UPLOADPOST_MAX_ATTEMPTS`, `UPLOADPOST_RETRY_BACKOFF_MS`, `PUBLISH_CHAIN_AFTER_MS`.
- The video Blob download path (`fetch(signedUrl) → blob()`).
- The per-attempt `AbortController` retry loop.
- The mid-publish chaining branch (`fetch(chainUrl, … publish_only: true)`).
- All reads/writes of `publish_submitted_platforms`, `publish_last_request_id`, `publish_retry_required`, `publish_heartbeat_at`, `publish_current_platform`.

Keep the AI metadata generation block (it's good and platform-specific).

Replace the publish loop with the Projects pattern:

1. **Hard idempotency first.** Query `publish_jobs` for this run with status in (`submitted`, `polling`, `completed`). If any row exists → log "Publish job already exists — skipping duplicate publish" and skip publish entirely. This single check is what stops duplicate posts.
2. **One `publish_jobs` row per run.** Insert one row with status `submitted` before the first Upload-Post call. Never insert a second.
3. **Async URL upload.** `formData.append("video", publicUrl)` + `async_upload=true`. Let Upload-Post fetch the URL itself. No Blob, no client-side timeout, no chaining.
4. **Group platforms by identical title+description**, send one Upload-Post request per group, single attempt (no retry loop).
5. **Schedule handling**: only attach `scheduled_date` when `isFutureScheduledDate(...)` is true; otherwise post immediately.
6. **Final job state**: on any successful submission, update the publish_jobs row to `polling` with `uploadpost_request_id` / `uploadpost_job_id`. On total failure, mark `failed`. The existing `uploadpost-webhook` keeps working.

### 2. `supabase/functions/scheduler/index.ts` — stop watchdog from re-triggering publish

- Remove `"publishing"` from the stories `ACTIVE_STAGES` array.
- Remove the `case "publishing":` branch in the resume-stage switch and its associated `publish_only` / `skip_metadata_generation` body flags.

With hard idempotency this would already be safe, but eliminating the re-trigger removes the source of duplicate attempts entirely. A genuinely failed publish is marked `failed` by `story-finalize` and surfaced in the UI; the user retries via "Post Now".

### 3. `src/pages/StoryRunMonitor.tsx` — make "Post Now" safe

Update the existing `postNow` handler to mirror the Projects model:
1. Mark all existing `publish_jobs` rows for the run as `failed` so the idempotency check lets the next attempt through.
2. Clear `publish_scheduled_date` / `publish_timezone` from `generated_metadata` (so the new attempt posts immediately).
3. Invoke `story-finalize` with `{ publish_only: true, force_metadata: true, force_retry: true }`.

This is the only sanctioned re-publish path; because we always wipe prior publish_jobs first, it can never produce duplicates.

### 4. Database fix for the currently stuck run

For `f77af2a2-613e-4c7b-bfdd-1f91e0b223e7`:
- Mark its 3 existing `publish_jobs` rows as `failed`.
- Clear `publish_scheduled_date` / `publish_timezone` / `publish_submitted_platforms` from `generated_metadata`.
- Reset `status='ready_to_publish'` (or equivalent).
- Trigger publish once via the new Post Now flow.

## Acceptance criteria

- A single story run produces at most one `publish_jobs` row.
- A second invocation of `story-finalize` for the same run logs "Publish job already exists — skipping duplicate publish" and exits.
- No platform receives the same video more than once unless the user explicitly clicks "Post Now" (which resets the publish_jobs row first).
- Run `f77af2a2…` is published exactly once after the fix.

## Files touched

- `supabase/functions/story-finalize/index.ts` — replace the ~330-line Stage 19 block with the Projects-style ~80-line block.
- `supabase/functions/scheduler/index.ts` — remove `publishing` from stories watchdog.
- `src/pages/StoryRunMonitor.tsx` — `postNow` clears prior `publish_jobs` first.
- One Supabase update for the stuck run.
