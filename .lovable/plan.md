

## Plan: Facebook Image Post Step

### Summary
Add a new optional pipeline step that publishes the last keyframe as a Facebook image post with an AI-generated caption, after the video publish step. Failures in this step never fail the run. A per-project toggle controls whether it runs.

### Database Changes

**Migration: Add `facebook_image_post_enabled` column to `projects`**
```sql
ALTER TABLE public.projects
  ADD COLUMN facebook_image_post_enabled boolean NOT NULL DEFAULT false;
```

No new tables needed — this step is fire-and-forget and logs results to `run_logs`.

### Backend Changes (finalize-video/index.ts)

Insert a new **Step 6b: Facebook Image Post** between the current publish step (Step 6) and the DONE block (~line 2519):

1. **Guard checks** (wrapped in try/catch that never throws to the outer scope):
   - `project.facebook_image_post_enabled` must be `true`
   - Facebook must be enabled in `publish_platforms`
   - Upload-Post API key must be configured
   - A `facebook_page_id` must exist in `publish_defaults.facebook`

2. **Find last keyframe**: Query `assets` for `type = 'keyframe'` on this run, ordered by `created_at DESC`, take the first one. Get its public URL from storage.

3. **Build image description**: Use the run's `topic_summary`, last scene's `scene_description`, and the keyframe prompt from the last scene to compose a concise image description for the AI.

4. **Generate Facebook caption**: Call `callText()` (using `MODELS.TEXT_CHEAP` / gemini-2.5-flash) with:
   - **System prompt**: The full "Facebook Post Text Rules" provided by the user (the compact version)
   - **User prompt**: The image description assembled above
   - Parse the response as plain text (no structured output needed)

5. **Upload to Facebook via Upload-Post API**: 
   - `POST https://api.upload-post.com/api/upload_photos`
   - `Authorization: Apikey <key>`
   - Form data: `photos[]` = keyframe image URL, `platform[]` = `facebook`, `title` = generated caption, `user` = profile username, `facebook_page_id` from publish defaults, `facebook_media_type` = `POSTS`, `async_upload` = `true`

6. **Log result**: Log success/failure to `run_logs`. Never throw.

### Frontend Changes (ProjectEditor.tsx)

In the Facebook Settings card (visible when `platforms.facebook !== false`, ~line 712-731), add a Switch toggle:

```
Facebook Image Post: [ON/OFF]
```

Label: "Post last keyframe as image post"
Maps to `form.facebook_image_post_enabled`.

### Technical Details

- The caption generation uses `MODELS.TEXT_CHEAP` (gemini-2.5-flash) since this is a simple creative writing task — no deep reasoning needed.
- The Upload-Post `/api/upload_photos` endpoint accepts a URL in `photos[]` — we pass the Supabase public URL of the keyframe image directly.
- The entire step is wrapped in a try/catch that logs errors but never propagates them, ensuring the run always completes successfully regardless of image post outcome.
- No schema changes to `publish_jobs` — this is a lightweight side-effect, not a tracked job.

