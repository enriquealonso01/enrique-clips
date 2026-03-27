# Prompt Config JSON — Complete Reference for AI Agents

> **Purpose**: This document provides everything an AI agent (e.g. ChatGPT) needs to generate a valid `prompt_config_json` for any video idea. Paste this entire document as context when asking an AI to create a project configuration.

---

## 1. Pipeline Overview

This system generates short-form AI videos (TikTok, Reels, Shorts) through a fully automated 7-step pipeline:

| Step | Name | What Happens |
|------|------|-------------|
| 1 | **Plan** | AI generates an initial reference image, a Style Bible (visual consistency anchor), and a structured scene plan with behaviors and motion grammar. AI-generated overlay text is also produced here. |
| 2 | **Keyframes** | For each scene, AI generates a high-quality end-frame image using the Style Bible and scene prompts. Each keyframe builds on the previous one for visual continuity. |
| 3 | **Video Generation** | Each scene's keyframe is sent to a video generator (Kling, Pika, or Vidu) to produce a motion clip. |
| 4 | **Polling** | The system polls the video generator until all clips are ready. |
| 5 | **Stitch** | All clips are concatenated into one video. Background music is added. Overlays (text and images) are burned in via FFmpeg. |
| 6 | **Metadata** | AI generates a title, description, and hashtags for the video post. |
| 7 | **Publish** | The final video is optionally posted to connected platforms. |

### Key Concepts

- **Style Bible**: Auto-generated from your concept prompt. Defines character identity, outfit, environment, lighting, camera constraints, art style, and "do not change" anchors. Every keyframe and motion prompt references this.
- **Scene Behaviors**: Each scene is tagged with a behavior (`environment_idle`, `cinematic_action`, `timelapse_build`, `conversation`, `exploration`, `reveal`) that determines the motion grammar (camera moves + subject action).
- **Activity Density**: Each scene is tagged `low`, `medium`, or `high` to control how much movement/activity appears.
- **Motion Grammar**: Strict rules per behavior that the video generator prompt must follow. The AI planner assigns these automatically.

---

## 2. JSON Structure

The `prompt_config_json` is stored on the project and merged with system defaults at run time. You only need to include fields you want to **override** — everything else uses sensible defaults.

```jsonc
{
  "version": 1,

  "global": {
    "concept_prompt": "",        // The core idea for the video series
    "rules": [],                 // Array of rules the AI must follow
    "negative_prompt": "",       // Things to avoid in all generated content
    "style_notes": "",           // Additional style guidance (art style, mood, era)
    "content_type": ""           // Category hint: "transformation", "story", "tutorial", etc.
  },

  "planning": {
    "planner_system_prompt": "", // System prompt for the AI planner
    "planner_user_prompt_template": "", // Template for the user prompt (supports {scene_count}, {concept_prompt})
    "first_scene_hook_rules": [],      // Rules for making Scene 1 attention-grabbing
    "viral_pacing_rules": [],          // Rules for escalating energy across scenes
    "scene_progression_rules": [],     // Rules for logical continuity between scenes
    "start_state_rules": []            // Rules for the initial untouched state
  },

  "keyframes": {
    "prompt_template": "",       // Template for keyframe generation (supports {aspect_ratio}, {scene_index}, {total_scenes}, {style_bible}, {end_keyframe_prompt}, {composition_rules}, {continuity_rules})
    "composition_rules": [],     // Rules for framing, camera distance, subject position
    "continuity_rules": [],      // Rules for maintaining visual consistency across keyframes
    "single_shot_only": true     // If true, each keyframe is one continuous shot (no cuts)
  },

  "motion": {
    "prompt_template": "",       // Template for video generator prompt (supports {behavior}, {density}, {kling_prompt})
    "camera_rules": [],          // Rules for camera movement
    "motion_rules": [],          // Rules for subject motion
    "negative_prompt_extra": ""  // Extra negative prompt appended to video generation
  },

  "overlays": {
    "opening": {
      "enabled": false,          // Whether to generate an opening overlay
      "generation_prompt": ""    // Prompt for opening overlay content
    },
    "ending": {
      "enabled": true,           // Whether to generate an ending overlay
      "generation_prompt": ""    // Prompt for ending overlay content
    },
    "items": [                   // Array of overlay items (see Overlay Items section)
      // ... overlay definitions
    ]
  },

  "metadata": {
    "title_prompt": "",          // Prompt for generating the video title
    "description_prompt": "",    // Prompt for generating the video description
    "hashtag_prompt": ""         // Prompt for generating hashtags
  },

  "audio": {
    "strategy": "background_music",  // Audio strategy
    "enabled": true                  // Whether to include audio
  },

  "voiceover": {
    "enabled": false,                // Master toggle — must be true for any TTS to fire
    "voice_id": "JBFqnCBsd6RMkjVDRZzb", // ElevenLabs voice ID (default: George)
    "model": "eleven_multilingual_v2"    // ElevenLabs model
  },

  "pipeline": {
    "use_legacy_fallbacks": true     // Whether to fall back to legacy fields
  },

  "memory": {
    "enabled": false,                // Whether to inject past video topics into planner
    "instruction": "",               // How the planner should use the memory
    "lookback_count": 30             // How many past topics to include (1-100)
  }
}
```

---

## 3. Section-by-Section Guide

### 3.1 `global` — The Core Identity

This is the most important section. The `concept_prompt` drives the entire video.

| Field | Type | Purpose | Best Practices |
|-------|------|---------|---------------|
| `concept_prompt` | string | **The video idea.** Everything flows from this. | Be specific and visual. "A medieval castle being built stone by stone on a clifftop overlooking a stormy sea" is far better than "castle construction". Include the setting, subject, mood, and transformation arc. |
| `rules` | string[] | Hard constraints the AI must follow in all steps. | Use for enforcing specific requirements: `["No people visible", "Always golden hour lighting", "Architecture must be Gothic style"]`. Each rule should be one clear instruction. |
| `negative_prompt` | string | Things to actively avoid in generated images/videos. | Comma-separated: `"text, watermark, logo, blurry, low quality, anime style, cartoon"`. The system already includes a default negative prompt for motion artifacts. |
| `style_notes` | string | Additional style direction. | Describe the artistic feel: `"Wes Anderson color palette, symmetrical compositions, pastel tones, whimsical but precise"`. |
| `content_type` | string | Category hint for the planner. | Options: `"transformation"` (before→after), `"story"` (narrative arc), `"tutorial"` (step-by-step), `"showcase"` (product/place highlight), `"nature"` (natural processes). |

#### Prompting Tips for `concept_prompt`:
- **Be cinematically descriptive**: Think of it as a movie pitch, not a search query.
- **Include the arc**: What changes from beginning to end?
- **Specify the setting**: Time of day, weather, location, era.
- **Name materials/textures**: "weathered oak beams", "polished marble", "rust-colored steel".
- **Avoid abstract concepts**: The AI generates images, so everything must be visually representable.

### 3.2 `planning` — Scene Structure Control

Controls how the AI planner breaks down your concept into scenes.

| Field | Type | Purpose | When to Override |
|-------|------|---------|-----------------|
| `planner_system_prompt` | string | The AI planner's identity/persona. | Override to change the creative direction: e.g., make it a documentary director vs. a music video director. |
| `planner_user_prompt_template` | string | Template for the planning request. Uses `{scene_count}` and `{concept_prompt}`. | Rarely needs changing. Override if you want to inject extra context into the planning request. |
| `first_scene_hook_rules` | string[] | Rules for making Scene 1 grab attention. | Override for different content styles: e.g., slow-burn documentaries might relax the "2-second hook" rule. |
| `viral_pacing_rules` | string[] | Rules for energy escalation across scenes. | Override for non-viral content: educational content might use steady pacing instead of escalation. |
| `scene_progression_rules` | string[] | Rules for logical continuity between scenes. | Add domain-specific rules: `"Architectural elements must follow real structural engineering logic"`. |
| `start_state_rules` | string[] | Rules for the initial/opening state. | Override when Scene 1 shouldn't be "untouched" — e.g., stories that start in media res. |

### 3.3 `keyframes` — Image Generation Control

Controls how each scene's end-frame image is generated.

| Field | Type | Purpose | When to Override |
|-------|------|---------|-----------------|
| `prompt_template` | string | Full template for the keyframe prompt. | Advanced only. Override to restructure how the AI receives keyframe instructions. |
| `composition_rules` | string[] | Framing and layout rules. | Add specific rules: `"Always include the horizon line in the lower third"`, `"Subject must occupy at least 40% of frame"`. |
| `continuity_rules` | string[] | Visual consistency rules between keyframes. | Add rules for your specific content: `"The same 5 buildings must be visible in every scene"`. |
| `single_shot_only` | boolean | Whether each keyframe must be a single continuous shot. | Set to `false` only if you want split-screen or montage-style keyframes. |

### 3.4 `motion` — Video Generation Control

Controls how the video generator (Kling/Pika/Vidu) animates each keyframe.

| Field | Type | Purpose | When to Override |
|-------|------|---------|-----------------|
| `prompt_template` | string | Template for the motion prompt. Uses `{behavior}`, `{density}`, `{kling_prompt}`. | Rarely needs changing. |
| `camera_rules` | string[] | Camera movement constraints. | Add specific rules: `"Never use handheld shake"`, `"All camera moves must be under 15 degrees"`. |
| `motion_rules` | string[] | Subject motion constraints. | Add physics rules: `"Water must flow downhill"`, `"Smoke must rise"`, `"No objects floating"`. |
| `negative_prompt_extra` | string | Extra terms to avoid in video generation. | Add to the default: `"split screen, picture-in-picture, text overlay"`. The default already covers common artifacts. |

### 3.5 `overlays` — On-Screen Graphics

Controls text and image overlays burned into the final video.

#### Slot Controls (`opening` / `ending`)
These are legacy slot-based controls. Keep `opening.enabled: false` and `ending.enabled: true` unless you have a reason to change.

#### `items` — Full Overlay Control (Recommended)

This is where you define specific overlays with complete parameter control. **These are additive** — they are inserted alongside any overlays already configured manually in the project UI.

```jsonc
{
  "overlays": {
    "items": [
      {
        "overlay_type": "text",           // "text" or "image"
        "content_mode": "ai_generated",   // "exact" (static text) or "ai_generated" (AI writes it)
        "content_text": "SUBSCRIBE!",     // Used when content_mode = "exact"
        "content_prompt": "Generate a short provocative question about the topic that makes viewers want to comment", // Used when content_mode = "ai_generated"
        "image_path": "",                 // Storage path for image overlays (content_mode irrelevant for images)
        "position": "bottom_center",      // Where on screen (see position options below)
        "style": "engagement",            // Visual style preset (see style options below)
        "start_pct": 85,                  // When overlay appears (0-100% of video duration)
        "end_pct": 100,                   // When overlay disappears (0-100% of video duration)
        "font_size": 20,                  // Font size (540p baseline, auto-scaled for higher res)
        "font_color": "#FFFFFF",          // Text color (hex)
        "bg_color": "rgba(0,0,0,0.5)",    // Background color (rgba for transparency)
        "z_index": 1,                     // Stacking order (higher = on top)
        "sort_order": 0                   // Render order
      }
    ]
  }
}
```

#### Position Options
| Value | Location |
|-------|----------|
| `top_left` | Top-left corner |
| `top_center` | Top center |
| `top_right` | Top-right corner |
| `center` | Dead center of frame |
| `bottom_left` | Bottom-left corner |
| `bottom_center` | Bottom center |
| `bottom_right` | Bottom-right corner |

> **Note**: Top-aligned positions have 160px vertical padding to clear YouTube's UI elements.

#### Style Presets
| Value | Description |
|-------|-------------|
| `lower_third` | Classic news/documentary lower-third bar |
| `full_width` | Full-width banner across the screen |
| `minimal` | Clean, minimal text with subtle shadow |
| `engagement` | Bold, attention-grabbing style designed to provoke interaction |

#### Overlay Best Practices
- **Font size 20 works well for most overlays** at the 540p baseline. It scales proportionally to higher resolutions (720p, 1080p).
- **AI-generated overlays receive full context**: The AI agent knows the concept prompt AND the full scene plan, so it generates contextually relevant text (e.g., if the video is about the Eiffel Tower, the engagement overlay might say "HOW MUCH DID IT COST?").
- **The project already has a manual overlay for the brand icon/logo** — you do NOT need to add one via JSON. Any JSON overlays are additive on top of existing manual overlays.
- **Engagement overlays** work best at `start_pct: 85, end_pct: 100` — appearing in the final moments to drive comments.
- **Use `content_mode: "ai_generated"` with a `content_prompt`** for dynamic text that adapts to whatever the AI planner decides to create. The prompt should describe the *type* of text you want, not the literal text.

### 3.6 `metadata` — Per-Platform Post Metadata

The system generates **platform-specific metadata** automatically. Each enabled platform (Instagram, TikTok, YouTube Shorts, Facebook) receives uniquely optimized titles, descriptions, and hashtags following 2026 best practices. The AI never produces content that appears AI-generated.

#### Platform-Specific Behavior (Automatic)
| Platform | Title Style | Description Style | Hashtags |
|----------|------------|-------------------|----------|
| **Instagram** | Hook in first 125 chars, curiosity/outcome-driven | 2-3 short paragraphs, keywords, CTA at end | 3-8 (niche + medium + broad) |
| **TikTok** | Exact search phrase, question/problem style | Short (80-150 chars), natural keywords | 3-5 (niche + industry + broad) |
| **YouTube Shorts** | 40-60 chars, search keyword, curiosity-driven | 1-2 sentences, keyword repeated | 3-5 (always includes #shorts) |
| **Facebook** | Clear and descriptive, topic keywords | 1-2 sentences explaining the reel | 3-5 |

#### Fields

| Field | Type | Purpose | When to Override |
|-------|------|---------|-----------------|
| `title_prompt` | string | Additional instructions for title generation (augments platform rules). | Override to add brand voice or specific constraints. |
| `description_prompt` | string | Additional instructions for description generation. | Override for brand voice: `"Write in first person, casual tone, include 'Link in bio'"`. |
| `hashtag_prompt` | string | Additional instructions for hashtag generation. | Override for niche targeting: `"Always include #architecture and #design"`. |
| `per_platform_prompts` | object | Per-platform overrides for title/description/hashtag prompts. | Use to give platform-specific additional instructions beyond the automatic rules. |

#### Per-Platform Prompt Example
```json
{
  "metadata": {
    "title_prompt": "Always mention the city name",
    "per_platform_prompts": {
      "tiktok": {
        "title_prompt": "Use Gen-Z slang and trending phrases",
        "hashtag_prompt": "Include at least one trending TikTok hashtag"
      },
      "youtube": {
        "title_prompt": "Make the title SEO-optimized for search",
        "hashtag_prompt": "Always include #shorts"
      }
    }
  }
}
```

> **Important**: The `title_prompt`, `description_prompt`, and `hashtag_prompt` fields are *additional guidance* that augments the built-in platform-specific best practices — they do NOT replace them. The system already knows the optimal format for each platform.

### 3.7 `audio` — Sound Configuration

| Field | Type | Purpose |
|-------|------|---------|
| `strategy` | string | Audio strategy (currently: `"background_music"`). |
| `enabled` | boolean | Whether to include background music. |

> Music tracks are managed separately at the project level (uploaded MP3s). The JSON controls whether audio is included, not which track.

### 3.8 `voiceover` — AI Narration (ElevenLabs TTS)

Controls text-to-speech narration for video overlays. When enabled, overlays with `voiceover_enabled: true` will be read aloud by an AI voice, timed to appear when the overlay appears on screen.

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `enabled` | boolean | `false` | **Master toggle.** Must be `true` for any voiceover to be generated. Even if individual overlays have `voiceover_enabled: true`, nothing happens unless this is `true`. |
| `voice_id` | string | `"JBFqnCBsd6RMkjVDRZzb"` | ElevenLabs voice ID. Default is "George" (deep narrator). See [Voice Library](https://elevenlabs.io/voice-library) for options. |
| `model` | string | `"eleven_multilingual_v2"` | ElevenLabs model. Options: `eleven_multilingual_v2` (highest quality, 29 languages), `eleven_turbo_v2_5` (faster). |

#### Per-Overlay Activation

Voiceover is activated on individual overlays using the `voiceover_enabled` field:

```jsonc
"overlays": {
  "items": [
    {
      "overlay_type": "text",
      "content_mode": "exact",
      "content_text": "The Colosseum, Rome",
      "position": "top_left",
      "voiceover_enabled": true,    // ← This overlay will be narrated
      // ... other fields
    },
    {
      "overlay_type": "text",
      "content_text": "Subscribe!",
      "voiceover_enabled": false,   // ← This overlay will NOT be narrated (default)
      // ...
    }
  ]
}
```

Manual overlays can also toggle voiceover via the UI switch in the overlay editor.

#### How It Works

1. During finalization (Step 5), the pipeline checks which overlays have `voiceover_enabled: true`.
2. For each, it calls ElevenLabs TTS with the overlay's resolved `content_text`.
3. The resulting audio clips are delayed (via FFmpeg `adelay`) to sync with each overlay's `start_pct` timing.
4. All VO clips are mixed with the background music using `amix` (music at 60% volume, VO at 100%).

#### Best Practices

- Keep narrated text SHORT — 2-8 words works best for short-form video pacing.
- Use `voiceover_enabled` only on key overlays (landmark names, chapter titles) — not decorative text.
- AI sequence overlays: each frame's text will be narrated individually if the parent has `voiceover_enabled`.
- Choose a voice that matches your content's tone (documentary → George/Brian, casual → Chris/Liam).

### 3.9 `pipeline` — Technical Settings

| Field | Type | Purpose |
|-------|------|---------|
| `use_legacy_fallbacks` | boolean | Whether to read from legacy fields (`series_prompt`, `series_rules`, `negative_prompt`) as fallbacks. Keep `true` unless you're fully migrated to JSON. |

### 3.10 `memory` — Series Memory (Topic History)

Controls whether the planner receives memory of past video topics for this project. When enabled, the pipeline fetches the last N `topic_summary` values from completed runs and injects them into the planner's system prompt. This prevents repetition and enables thematic continuity across a video series.

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `enabled` | boolean | `false` | Whether to activate series memory. When `false`, no history is fetched or injected. |
| `instruction` | string | `""` | How the planner should use the memory. This is the directive that tells the AI planner what to do with the list of past topics. |
| `lookback_count` | number | `30` | How many past video topics to include (1–100). Higher values give more context but use more tokens. |

#### How It Works

1. **Topic extraction**: After each run's scene plan is generated, the pipeline asks an AI model to produce a short one-line `topic_summary` describing what the video is about (e.g., `"Construction of the Pont du Gard aqueduct in southern France"`). This summary is saved to the `runs.topic_summary` column.
2. **Memory injection**: On the next run, if `memory.enabled` is `true`, the pipeline queries the last N completed runs (ordered by `created_at DESC`) and collects their `topic_summary` values.
3. **Prompt augmentation**: The collected topics are formatted as a numbered list and appended to the planner's system prompt inside a `=== SERIES MEMORY ===` block, along with the `instruction` field. The planner sees something like:

```
=== SERIES MEMORY ===
The following topics have been covered in previous videos for this series:
1. Construction of the Pont du Gard aqueduct in southern France
2. Building of the Colosseum in Rome
3. Construction of Angkor Wat in Cambodia
...

Instruction: Do not repeat any landmark that appears in the previous videos.
```

4. **Planner compliance**: The AI planner uses this context to choose a new, non-overlapping subject (or continue a theme, depending on your instruction).

#### When to Enable Memory

- **Repetitive series**: Any project that generates many videos from the same concept prompt (e.g., "famous historical constructions") should enable memory to avoid duplicates.
- **Thematic series**: Projects where each video should build on or reference the previous one (e.g., "continue the storyline from last video").
- **Diverse content**: When you want to guarantee geographic, temporal, or categorical variety across runs.

#### `instruction` — Best Practices

The `instruction` field is critical — it tells the planner *how* to use the memory. Be specific and actionable:

| Goal | Example Instruction |
|------|-------------------|
| **Avoid repeats** | `"Do not repeat any landmark, building, or structure that appears in the previous videos. Always pick a completely different famous landmark."` |
| **Geographic diversity** | `"Do not repeat any country or region from the previous videos. Ensure global geographic diversity."` |
| **Thematic continuity** | `"Continue the narrative arc from the last video. Reference events or outcomes from prior episodes."` |
| **Category rotation** | `"Rotate through different landmark categories: pyramid, cathedral, castle, bridge, monument. Do not repeat a category used in the last 5 videos."` |
| **Era diversity** | `"Ensure each video covers a different historical era. Alternate between ancient, medieval, renaissance, and industrial-era constructions."` |

> **Tip**: You can combine multiple constraints in one instruction: `"Do not repeat any landmark from previous videos. Also ensure geographic diversity — do not pick the same country as the last 3 videos."`

#### `lookback_count` — Choosing the Right Value

| Value | Use Case |
|-------|----------|
| `5–10` | Short memory — only avoids very recent repeats. Good for projects with a small subject pool. |
| `20–30` | Standard memory — covers roughly a month of daily videos. Recommended default. |
| `50–100` | Long memory — prevents repeats across months of content. Use for projects with a large subject pool (e.g., "any famous landmark in world history"). |

> **Note**: Setting `lookback_count` higher than the number of completed runs has no negative effect — the pipeline simply returns however many summaries exist.

#### Example Configurations

**Anti-repetition (most common)**:
```json
{
  "memory": {
    "enabled": true,
    "instruction": "Do not repeat any landmark that appears in the previous videos. Always pick a new, different famous landmark from world history.",
    "lookback_count": 30
  }
}
```

**Thematic continuity**:
```json
{
  "memory": {
    "enabled": true,
    "instruction": "Continue the story from where the last video left off. Reference the previous location and advance the journey to the next destination.",
    "lookback_count": 5
  }
}
```

**Category rotation with geographic diversity**:
```json
{
  "memory": {
    "enabled": true,
    "instruction": "Rotate through landmark categories (temple, castle, bridge, monument, palace, cathedral). Do not repeat a category from the last 4 videos. Also avoid repeating a country from the last 6 videos.",
    "lookback_count": 30
  }
}
```

#### Important Notes

- Memory only works for **completed runs** that have a `topic_summary`. Failed or stopped runs without a summary are skipped.
- The `topic_summary` is generated automatically by an AI model — you do not need to write it manually.
- Memory is **per-project** — each project has its own independent topic history.
- If memory is disabled (`enabled: false`), the pipeline skips all memory-related queries and prompt injection, even if `instruction` and `lookback_count` are set.

---

## 4. Scene Behaviors Reference

The AI planner automatically assigns these based on your concept. Understanding them helps you write better concept prompts.

| Behavior | Camera | Action | Best For |
|----------|--------|--------|----------|
| `environment_idle` | Slow pan or static wide shot | Natural ambient movement (wind, water, clouds) | Opening/establishing shots, calm moments |
| `cinematic_action` | One cinematic move (dolly/orbit/tracking) | One clear dramatic subject action | Story beats, dramatic moments |
| `timelapse_build` | Fixed tripod or very slow push-in | Continuous parallel activity (workers, machines) | Construction, growth, manufacturing |
| `conversation` | Shot/reverse-shot or slow push-in | Subtle character gestures and expressions | Dialogue, character interaction |
| `exploration` | Forward tracking following subject | Walking, observing, discovering | Travel, discovery, walkthroughs |
| `reveal` | Slow dolly/crane/pull-back | Environment activation (lights, doors, fog) | Final payoff, dramatic unveiling |

---

## 5. Project Settings (Set Outside JSON)

These are configured on the project itself, not in the JSON:

| Setting | Description | Options |
|---------|-------------|---------|
| `scene_count` | Number of scenes in the video | 3-8 (typically 4-6) |
| `clip_duration_sec` | Duration of each scene clip | 5 or 10 seconds |
| `aspect_ratio` | Video aspect ratio | `16:9`, `9:16`, `1:1` |
| `video_generator` | Which AI video model to use | `kling`, `pika`, `vidu` |
| `selected_track_id` | Background music track | Selected from uploaded MP3 library |

---

## 6. Example Configurations

### Example 1: Transformation Video (City Being Built)
```json
{
  "version": 1,
  "global": {
    "concept_prompt": "A sprawling futuristic city being built from scratch in the middle of a vast desert. Starting from empty sand dunes at dawn, construction crews and autonomous robots work together to erect gleaming glass towers, solar panel farms, and elevated mag-lev railways. The city grows scene by scene until a magnificent metropolis glows under a sunset sky.",
    "rules": [
      "Architecture must be futuristic but plausible — no fantasy or sci-fi elements",
      "Desert landscape must remain visible in every scene as context",
      "Construction progress must be incremental and believable between scenes",
      "Golden hour lighting throughout the entire sequence"
    ],
    "negative_prompt": "cartoon, anime, fantasy, magic, unrealistic physics, text, watermark",
    "style_notes": "Cinematic drone photography style, warm desert tones with cool glass/steel contrast, Denis Villeneuve aesthetic",
    "content_type": "transformation"
  },
  "overlays": {
    "items": [
      {
        "overlay_type": "text",
        "content_mode": "ai_generated",
        "content_prompt": "Generate a short, provocative question about whether humanity could actually build a city this fast, designed to spark debate in comments",
        "position": "bottom_center",
        "style": "engagement",
        "start_pct": 85,
        "end_pct": 100,
        "font_size": 20,
        "font_color": "#FFFF00",
        "bg_color": "rgba(0,0,0,0.6)"
      }
    ]
  },
  "metadata": {
    "title_prompt": "Generate a clickbait-style title about a futuristic city rising from the desert. Max 80 chars. Use an emoji.",
    "hashtag_prompt": "Generate 10 hashtags mixing architecture, future tech, and viral trending tags"
  }
}
```

### Example 2: Nature Documentary Style
```json
{
  "version": 1,
  "global": {
    "concept_prompt": "The life cycle of a giant sequoia tree, from a tiny seed falling to the forest floor to a 300-foot ancient giant towering over the Sierra Nevada. Show the seasons changing around it as centuries pass — snow, wildfire survival, wildlife nesting in its branches, humans arriving to marvel at its scale.",
    "rules": [
      "The same tree must be recognizable in every scene (distinctive trunk shape)",
      "Seasons must transition naturally",
      "Scale reference must be maintained — show the tree growing relative to surroundings"
    ],
    "negative_prompt": "urban, buildings, modern technology, text, watermark",
    "style_notes": "BBC Earth / Planet Earth cinematography, rich saturated nature colors, atmospheric depth",
    "content_type": "transformation"
  },
  "planning": {
    "first_scene_hook_rules": [
      "Open with an extreme close-up of a tiny seed on dark forest soil — intimate and mysterious",
      "The opening should feel like the beginning of an epic story"
    ],
    "scene_progression_rules": [
      "Each scene must represent a clear passage of time (years to centuries)",
      "The tree must be noticeably larger in each subsequent scene",
      "Surrounding vegetation and wildlife should evolve with the time period"
    ]
  },
  "overlays": {
    "items": [
      {
        "overlay_type": "text",
        "content_mode": "ai_generated",
        "content_prompt": "Generate a single awe-inspiring fact about giant sequoia trees that would make viewers stop scrolling",
        "position": "bottom_center",
        "style": "minimal",
        "start_pct": 0,
        "end_pct": 20,
        "font_size": 20,
        "font_color": "#FFFFFF",
        "bg_color": "rgba(0,0,0,0.4)"
      },
      {
        "overlay_type": "text",
        "content_mode": "ai_generated",
        "content_prompt": "Generate a thought-provoking question about nature and time that encourages comments",
        "position": "bottom_center",
        "style": "engagement",
        "start_pct": 85,
        "end_pct": 100,
        "font_size": 20,
        "font_color": "#FFFF00",
        "bg_color": "rgba(0,0,0,0.6)"
      }
    ]
  }
}
```

### Example 3: Minimal Override (Just the Idea)
```json
{
  "version": 1,
  "global": {
    "concept_prompt": "A cozy Japanese ramen shop on a rainy evening in Tokyo. A chef prepares a steaming bowl of tonkotsu ramen from scratch — slicing chashu, boiling noodles, ladling golden broth, adding toppings with precision. The final reveal shows the perfect bowl under warm lantern light.",
    "style_notes": "Warm, intimate, food photography meets cinema. Studio Ghibli color warmth with photorealistic detail.",
    "content_type": "showcase"
  }
}
```

---

## 7. Important Notes for AI Agents

1. **You only need to include fields you want to override.** The system has comprehensive defaults for everything. A minimal JSON with just `global.concept_prompt` will produce a complete video.

2. **The `concept_prompt` is THE most important field.** Spend 80% of your effort crafting a vivid, cinematically descriptive concept prompt. Everything else is tuning.

3. **The brand logo overlay is already configured manually on the project.** Do NOT add a logo/brand overlay in the JSON — it would duplicate.

4. **Font size 20 is the recommended default** for overlay text. It renders well at 540p and scales proportionally.

5. **AI-generated overlay text receives full context** — the AI knows the concept prompt AND what the planner decided to create for each scene. Write `content_prompt` as an instruction for *what kind of text to write*, not the literal text.

6. **Overlays defined in JSON are synced fresh every run** — old JSON overlays are deleted and re-created. Manual (UI) overlays persist across runs.

7. **The `rules` array is powerful.** Use it to enforce consistency that the AI might otherwise miss: specific colors, architectural styles, character appearances, physics constraints.

8. **Scene count and clip duration are project-level settings**, not in the JSON. Typical setups: 4-6 scenes × 5 seconds each = 20-30 second video.

9. **The video generators (Kling/Pika/Vidu) have a ~10 second max clip duration.** Don't expect a single scene to cover complex multi-step actions.

10. **The merge behavior**: JSON values override defaults. Empty strings and empty arrays are ignored (defaults preserved). Non-empty arrays fully replace the default array.

11. **Metadata is generated per-platform automatically.** The system produces uniquely optimized titles, descriptions, and hashtags for Instagram, TikTok, YouTube Shorts, and Facebook — following each platform's 2026 best practices. The `title_prompt`, `description_prompt`, and `hashtag_prompt` fields in `metadata` are *additional guidance* that augments (not replaces) the built-in platform rules.

12. **Content must NEVER appear AI-generated.** All metadata, captions, overlay text, and descriptions are written to sound like authentic human-created content. Never mention AI, algorithms, prompts, or generation tools in any user-facing text.
