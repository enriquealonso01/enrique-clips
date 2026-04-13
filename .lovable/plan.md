

# Phase 1: Story Pipeline — Database, UI Shell, and Stages 1–5

## Summary

Create a completely separate "Stories" pipeline alongside the existing "Projects" pipeline. This phase delivers the database foundation, a new sidebar tab with dashboard UI, and the first 5 pipeline stages (run creation through cast/reference image generation). Nothing touches existing tables, edge functions, or pages.

## What the user will see

- A new "Stories" tab in the sidebar between Projects and Settings
- A Stories dashboard page listing story projects with create/run/upload controls
- A Story project editor with config fields (audio mix, emoji, upload slots)
- A Story run monitor showing stage progression through the first 5 stages
- Runs executing stages 1–5 automatically: story discovery, validation, real image retrieval, and cast image generation

---

## Technical Details

### 1. Database Schema (new tables, no changes to existing ones)

**New tables:**

- `story_projects` — title, is_enabled, config (audio_mix JSON, ending_audio config, publish settings, timezone, uploadpost keys), background_music_asset_id, ending_audio_asset_id, emoji_asset_id, created_at, updated_at
- `story_runs` — project_id (FK to story_projects), status (new enum `story_run_status` with all 16+ statuses), current_stage, progress_pct, error_message, generated_metadata (JSONB for story JSON, image URLs, etc.), started_at, finished_at, created_at
- `story_run_logs` — run_id, level, message, data, created_at
- `story_assets` — run_id, type (new enum `story_asset_type`: background_music, ending_audio, narration_audio, real_image, cast_reference_image, scene_image, scene_video_raw, scene_video_trimmed, captioned_story_video, ending_visual_clip, ending_audio_trimmed, final_video, emoji), supabase_path, metadata, created_at
- `story_memory` — project_id, run_id, story_title, story_fingerprint, source_url, created_at (for deduplication)

**New enums:**
- `story_run_status`: queued, researching_story, story_selected, cast_generated, narration_generated, beats_extracted, scene_images_generating, scenes_generating, audio_mixing, subtitles_processing, end_card_rendering, ready_to_publish, publishing, published, paused, failed, cancelled
- `story_asset_type`: background_music, ending_audio, narration_audio, real_image, cast_reference_image, scene_image, scene_video_raw, scene_video_trimmed, captioned_story_video, ending_visual_clip, ending_audio_trimmed, final_video, emoji

**RLS:** Same authenticated-access pattern as existing tables.

### 2. Frontend — New Pages and Sidebar

**Files to create:**
- `src/pages/StoriesIndex.tsx` — List story projects, create new, show latest run status, run controls (start/pause/stop)
- `src/pages/StoryProjectEditor.tsx` — Edit project config: title, audio mix settings, upload slots (background music, ending audio, emoji), publish platform toggles
- `src/pages/StoryRunMonitor.tsx` — Real-time stage display with status badges for each of the 16+ stages, log viewer, asset inspection (story JSON, real image, cast image)

**Files to modify:**
- `src/components/AppSidebar.tsx` — Add "Stories" nav item between Projects and Settings (icon: BookOpen or similar)
- `src/App.tsx` — Add routes: `/stories`, `/stories/:projectId`, `/story-runs/:runId`

### 3. Edge Functions — Phase 1 Pipeline (Stages 1–5)

**New edge function: `story-pipeline/index.ts`**

Handles stages 1–5 in sequence:

- **Stage 1 (Create run):** Load last 20 published story titles from `story_memory`, load project config and uploaded assets
- **Stage 2 (Story discovery):** Call OpenAI gpt-5.3-chat-latest with the 20 titles embedded in the prompt. Request structured JSON: title, source_url, summary, hook, reward, characters, groups, locations, draft beats, image retrieval guidance
- **Stage 3 (Validation):** Check title/fingerprint against `story_memory`. Retry if duplicate (up to 3 attempts)
- **Stage 4 (Real image retrieval):** Continue OpenAI conversation to get best real image URL (person > group > place). Store primary + fallback URLs
- **Stage 5 (Cast/reference image):** Call Gemini `gemini-3-pro-image-preview` with story context + real image to generate a character lineup/reference image. Upload to storage

Uses the existing `_shared/openai.ts` for AI calls. Does NOT import from or modify any existing pipeline functions.

### 4. Component Structure

- `src/components/story/StoryStatusBadge.tsx` — Badge component for the 16+ story statuses
- `src/components/story/StoryAssetUploader.tsx` — Upload component for background music, ending audio, emoji
- `src/components/story/StoryProjectCard.tsx` — Card for the stories list page
- `src/components/story/StoryRunStages.tsx` — Visual stage progression display

### 5. Isolation Guarantees

- All new tables prefixed with `story_`
- New edge function `story-pipeline` is completely separate from `run-pipeline`
- No modifications to existing `runs`, `scenes`, `assets`, `projects` tables
- No modifications to existing edge functions
- Separate routes under `/stories` and `/story-runs`

---

## Out of Scope (Future Phases)

- Stages 6–19 (narration, beat extraction, scene generation, stitching, subtitles, end card, publishing)
- ElevenLabs narration integration
- Vidu clip generation
- Submagic subtitles
- FFmpeg/Rendi stitching with dissolves
- Publishing integration

