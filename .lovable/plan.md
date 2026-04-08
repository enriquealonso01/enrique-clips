

## Plan: AI-Powered JSON Config Feedback + Re-run (No Publish)

### Summary
Add a "Fix with AI" button in the Prompt Config JSON section of the Series tab. The user writes feedback about what went wrong, Claude Opus 4.6 (via fal.ai OpenRouter) rewrites the JSON, and optionally re-runs the pipeline with publishing disabled.

### Components

**1. New Edge Function: `fix-config/index.ts`**
- Accepts: `{ project_id, user_feedback, current_json, documentation }`
- Uses the fal.ai `@fal-ai/client` (already used in `run-pipeline`) with `openrouter/router` model endpoint
- Model: `anthropic/claude-opus-4-6` 
- System prompt: the full "surgical JSON editor" prompt from the user's request
- User prompt: combines the PROMPT_CONFIG_REFERENCE.md documentation, the user's feedback, and current JSON
- Returns the corrected JSON string
- Validates the returned JSON before sending back; if invalid, returns an error instead of the broken JSON
- Uses `FAL_KEY` secret (already configured)

**2. Frontend Changes (`ProjectEditor.tsx`)**

Add a collapsible "AI Config Fix" section below the Prompt Config JSON editor card:
- A `Textarea` for user feedback ("What went wrong?")
- A "Fix with AI" button that:
  1. Calls the `fix-config` edge function with the current `promptConfigText` and user feedback
  2. Shows loading state
  3. On success: replaces `promptConfigText` with the AI-corrected JSON, validates it, and shows a success toast
  4. On error: shows the error in a toast (does not update JSON)
- A checkbox: "Re-run without publishing after fix" (default: checked)
- If checked and fix succeeds: automatically saves the project with the new JSON, then triggers `run-pipeline` with a new `skip_publish: true` flag

**3. Pipeline Changes (`run-pipeline/index.ts`)**

Add support for a `skip_publish` boolean in the request body. When true:
- Set `publish_platforms` to all-false internally for this run
- Skip the Facebook image post step
- The run completes at the metadata step without publishing

**4. Pipeline Changes (`finalize-video/index.ts`)**

Read `skip_publish` from the run's metadata (stored by run-pipeline). When true:
- Skip Step 6 (video publish) entirely
- Skip Step 6b (Facebook image post) entirely
- Mark run as done after metadata generation

### Technical Details

- fal.ai OpenRouter endpoint: `fal.subscribe("openrouter/router", { input: { prompt, system_prompt, model: "anthropic/claude-opus-4-6", max_tokens: 16000 } })` returns `{ data: { output: string } }`
- The documentation (PROMPT_CONFIG_REFERENCE.md) will be stored as a constant string in the edge function to avoid reading files at runtime
- The `skip_publish` flag will be stored in the run's `generated_metadata` field as `{ skip_publish: true }` so `finalize-video` can read it
- JSON validation happens both server-side (edge function) and client-side (before saving)

### Flow

```text
User writes feedback → "Fix with AI" button
  → Edge function calls Claude via fal.ai
  → Returns corrected JSON
  → Frontend validates & shows in editor
  → If "Re-run" checked: saves project → triggers run-pipeline(skip_publish=true)
  → Pipeline runs plan→keyframes→video→stitch→metadata→DONE (no publish)
```

### Files Changed
- `supabase/functions/fix-config/index.ts` (new)
- `src/pages/ProjectEditor.tsx` (add AI fix UI)
- `supabase/functions/run-pipeline/index.ts` (accept `skip_publish`, store in metadata)
- `supabase/functions/finalize-