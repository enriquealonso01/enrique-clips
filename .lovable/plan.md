
# Phase 1: Social Media AI Creator Manager — UI + Database Foundation

## Overview
Build the web app shell and Supabase database schema for managing a chain of automated social media AI creator/poster projects. This phase focuses on the UI, data model, and project management — no pipeline execution yet.

## 1. Database Schema (Supabase Cloud)
Set up all core tables with proper relationships and RLS:
- **projects** — title, prompts, scene config, Kling config, Upload-Post config, scheduling, platform toggles, publish_defaults JSON, control token
- **runs** — status state machine (queued → running → paused → stopped → failed → completed), current_step, progress
- **scenes** — per-run scene data with prompts, status tracking
- **assets** — references to stored files (initial images, keyframes, clips, final videos) with type enum and metadata
- **publish_jobs** — Upload-Post tracking with request_id, job_id, per-platform results
- **run_logs** — structured logging with level, message, data
- Storage buckets for project assets (initial images, keyframes, clips, final videos)

## 2. Projects List Page
- Card/table view showing all projects with title, enabled/disabled toggle, last run status, next scheduled run
- Quick action buttons: Run Now, Pause/Resume, Stop
- Create new project button

## 3. Project Editor (Tabbed Interface)
**Series Tab:**
- Title, series prompt, series rules, negative prompt
- Scene count, clip duration, aspect ratio selector (9:16 / 16:9)
- Total duration estimate with Shorts/Reels length warnings (max 180s)

**Initial Image Tab:**
- Image upload to Supabase Storage
- Preview of current initial image
- Replace/remove functionality

**Kling Tab:**
- Model name, mode (pro/std), sound toggle

**Publish Tab:**
- Upload-Post API key field (stored securely, shows configured/not configured)
- Profile username input
- Platform toggles: TikTok, Instagram, YouTube, Facebook
- Per-platform settings panels matching the publish_defaults JSON schema (privacy, media type, AI disclosure flags, etc.)
- Facebook page ID field

**Schedule Tab:**
- Frequency type: manual, interval hours, or cron expression
- Timezone selector (default America/New_York)

**API Tab:**
- Generate/regenerate project control token
- Show token hint (last 4 chars)
- Display endpoint URLs for external automation

## 4. Run Monitor Page
- Step-by-step timeline visualization (Plan → Keyframes → Kling → Stitch → Metadata → Publish → Done)
- Per-scene table with columns for scene index, title, status, keyframe previews (placeholder), clip link (placeholder)
- Pause/Resume/Stop controls
- Logs panel with filterable log levels
- Publish results panel showing per-platform status

## 5. Global Settings Page
- API key configuration fields for: OpenAI, Gemini, Kling, Upload-Post (placeholder storage, marked as "will be stored securely")
- Webhook URL display for Upload-Post

## 6. Navigation & Layout
- Sidebar navigation: Projects, Settings
- Project detail pages accessible from the list
- Responsive layout with clean, professional design
- Toast notifications for actions

## Design Style
- Clean, modern dashboard aesthetic
- Dark-friendly with proper color tokens
- Status badges with color coding (green=completed, yellow=running, red=failed, gray=queued)
- Card-based layouts for project list, table-based for scenes/logs
