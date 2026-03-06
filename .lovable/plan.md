

# Prompt Config JSON Architecture — Implementation Plan

## Overview

Replace the hardcoded `series_prompt`, `series_rules`, and `negative_prompt` fields with a single `prompt_config_json` JSONB column on the `projects` table. The pipeline will resolve a final config at run start by merging system defaults → content-type defaults → project JSON → legacy fallbacks, then snapshot it onto the run's `generated_metadata` for reproducibility.

---

## 1. Database Migration

Add one nullable JSONB column to `projects`:

```sql
ALTER TABLE public.projects
  ADD COLUMN prompt_config_json jsonb DEFAULT NULL;
```

No other schema changes. Legacy fields (`series_prompt`, `series_rules`, `negative_prompt`) remain untouched. The `generated_metadata` JSONB on `runs` already exists and will store the resolved config snapshot — no migration needed there.

---

## 2. TypeScript Types & Validation (shared file)

Create `src/lib/promptConfig.ts` containing:

- **`PromptConfig` interface** — typed shape matching the JSON architecture (version, global, planning, keyframes, motion, overlays, metadata, audio, pipeline sections).
- **`DEFAULT_PROMPT_CONFIG`** — a generic transformation/build template (not bunker-specific).
- **`getDefaultPromptConfig(contentType?: string)`** — returns defaults, optionally themed.
- **`validatePromptConfig(config: unknown): { valid: boolean; errors: string[] }`** — structural validation using manual checks (no Zod in edge functions; keep it isomorphic).
- **`mergePromptConfig(defaults, overrides)`** — deep merge with defaults as base.
- **`legacyFieldsToPromptConfig(project)`** — maps `series_prompt` → `global.concept_prompt`, `series_rules` → `global.rules`, `negative_prompt` → `global.negative_prompt`.
- **`buildResolvedPromptConfig(project)`** — orchestrates: system defaults → legacy fallback → `prompt_config_json` override → merge.

This file will be duplicated into the edge function (since edge functions can't import from `src/`). A copy will live at `supabase/functions/_shared/promptConfig.ts` and be imported by both `run-pipeline` and `finalize-video`.

---

## 3. Default Template (excerpt)

```json
{
  "version": 1,
  "global": {
    "concept_prompt": "",
    "rules": [],
    "negative_prompt": "",
    "style_notes": "",
    "content_type": "transformation"
  },
  "planning": {
    "planner_system_prompt": "You are a creative director for short-form video...",
    "first_scene_hook_rules": ["Scene 1 must grab attention within 2 seconds..."],
    "viral_pacing_rules": ["Each scene must escalate visually..."],
    "scene_progression_rules": ["Maintain temporal continuity...", "No sudden jumps..."],
    "start_state_rules": ["The world begins untouched..."]
  },
  "keyframes": {
    "prompt_template": "Generate a high-quality {aspect_ratio} image for scene {scene_index}...",
    "composition_rules": ["Include composition anchors: camera distance, subject position..."],
    "continuity_rules": ["Maintain identical character appearance..."],
    "single_shot_only": true
  },
  "motion": {
    "prompt_template": "[{behavior}/{density}] {kling_prompt}",
    "camera_rules": ["Follow motion grammar for assigned behavior"],
    "motion_rules": ["No morphing, no teleportation"],
    "negative_prompt_extra": "flicker, jitter, warping, morphing face, melting, extra limbs"
  },
  "overlays": {
    "opening": { "enabled": false, "generation_prompt": "" },
    "ending": { "enabled": true, "generation_prompt": "" }
  },
  "metadata": {
    "title_prompt": "Generate a catchy title (max 100 chars)...",
    "description_prompt": "Generate an engaging description (max 500 chars)...",
    "hashtag_prompt": "Generate relevant hashtags..."
  },
  "audio": {
    "strategy": "background_music",
    "enabled": true
  },
  "pipeline": {
    "use_legacy_fallbacks": true
  }
}
```

---

## 4. Pipeline Integration (`run-pipeline/index.ts`)

### At the top of the main handler (after loading project):
1. Call `buildResolvedPromptConfig(project)` to get the resolved config.
2. Store it in `generated_metadata.resolved_prompt_config` on the run record immediately (snapshot).

### Plan step changes:
- Replace hardcoded system prompt strings with `resolvedConfig.planning.planner_system_prompt` + injected rules from `planning.first_scene_hook_rules`, `planning.scene_progression_rules`, etc.
- Replace `project.series_prompt` references with `resolvedConfig.global.concept_prompt`.
- Replace `project.series_rules` with `resolvedConfig.global.rules.join("\n")`.
- Replace `project.negative_prompt` with `resolvedConfig.global.negative_prompt`.
- The initial image prompt uses `resolvedConfig.global.concept_prompt`.
- The style bible prompt uses `resolvedConfig.global.*`.

### Keyframe step changes:
- Use `resolvedConfig.keyframes.prompt_template` (with `{aspect_ratio}`, `{scene_index}`, `{total_scenes}` placeholders) instead of the hardcoded prompt string.
- Inject `resolvedConfig.keyframes.composition_rules` and `resolvedConfig.keyframes.continuity_rules`.

### Motion/Kling step changes:
- Use `resolvedConfig.motion.negative_prompt_extra` combined with `resolvedConfig.global.negative_prompt` instead of `KLING_NEGATIVE_TEMPLATE`.
- The motion grammar stays hardcoded (it's structural, not content-specific), but `resolvedConfig.motion.camera_rules` and `resolvedConfig.motion.motion_rules` get appended.

### Overlay generation:
- Check `resolvedConfig.overlays.opening.enabled` / `resolvedConfig.overlays.ending.enabled` — skip disabled overlays.
- Use their `generation_prompt` as additional context.

### Metadata step (`finalize-video/index.ts`):
- Use `resolvedConfig.metadata.title_prompt`, `description_prompt`, `hashtag_prompt` instead of the generic hardcoded system prompt.
- Read `resolved_prompt_config` from `run.generated_metadata`.

---

## 5. UI Changes (`ProjectEditor.tsx`)

### Series tab restructure:

**A. Legacy Fields section** — keep existing fields as-is (series_prompt, series_rules, negative_prompt, scene_count, clip_duration, aspect_ratio).

**B. New "Prompt Config" section** below legacy fields:
- A large `<textarea>` with monospace font for JSON editing (no heavy code editor dependency needed).
- "Pretty Print" button — formats the JSON.
- "Reset to Default" button — loads `getDefaultPromptConfig()`.
- "Generate from Legacy Fields" button — calls `legacyFieldsToPromptConfig(form)` and populates the textarea.
- Validation on save: parse JSON, run `validatePromptConfig()`, show errors inline. Block save if invalid JSON.
- Store valid JSON into `form.prompt_config_json`.

**C. Resolved Config Preview** (collapsible):
- Read-only prettified JSON showing the merged result of defaults + legacy + config JSON.
- Uses `buildResolvedPromptConfig(form)` computed client-side.

---

## 6. Backward Compatibility

- If `prompt_config_json` is `null`, `buildResolvedPromptConfig()` calls `legacyFieldsToPromptConfig()` automatically, so existing projects work unchanged.
- Legacy fields remain editable and continue to feed into the resolved config when no JSON config is set.
- `pipeline.use_legacy_fallbacks: true` (default) tells the resolver to prefer legacy fields when they exist and JSON sections are empty.

---

## 7. File Changes Summary

| File | Change |
|---|---|
| **Migration SQL** | Add `prompt_config_json` JSONB column |
| `src/lib/promptConfig.ts` | **New** — types, defaults, validation, merge, legacy adapter |
| `supabase/functions/_shared/promptConfig.ts` | **New** — copy of above for edge function context |
| `supabase/functions/run-pipeline/index.ts` | Import shared config; resolve + snapshot at start; replace hardcoded prompts with config values |
| `supabase/functions/finalize-video/index.ts` | Read resolved config from run metadata for metadata generation step |
| `src/pages/ProjectEditor.tsx` | Add Prompt Config JSON editor section + resolved preview |

---

## 8. Estimated Scope

This is a large refactor touching 2 edge functions (~2700 lines combined) and the main editor page. The implementation will proceed in this order:

1. Database migration
2. Shared prompt config module (types + helpers)
3. UI editor section
4. Pipeline integration (run-pipeline)
5. Finalize-video integration
6. Deploy both edge functions

