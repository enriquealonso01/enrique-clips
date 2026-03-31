# AI Architecture — Google Gemini Integration

## Overview

This project uses **Google Gemini directly** for all AI-driven text and image generation. All API calls are made **server-side only** through Supabase Edge Functions. The frontend never touches the API key.

## Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────┐
│   Frontend   │────▶│  Edge Functions      │────▶│  Google      │
│  (React)     │     │  (Deno / Supabase)   │     │  Gemini API  │
│              │     │                      │     │              │
│ aiClient.ts  │     │ _shared/openai.ts    │     │ gemini-2.5   │
│              │     │ ai-endpoints/        │     │ gemini-3-pro │
│              │     │ run-pipeline/        │     │              │
│              │     │ finalize-video/      │     │              │
└──────────────┘     └─────────────────────┘     └──────────────┘
```

## Model Routing & Cost Strategy

| Task | Model | Cost Tier | When Used |
|------|-------|-----------|-----------|
| Scene planning | `gemini-2.5-pro` | Standard | Every run |
| Style bible | `gemini-2.5-pro` | Standard | Every run |
| Overlay content | `gemini-2.5-pro` | Standard | When overlays have `ai_generated` mode |
| Platform metadata | `gemini-2.5-flash` | Low | Post-production metadata |
| Premium reasoning | `gemini-2.5-pro` | Standard | Only when `premium=true` or validation fails |
| Draft keyframes | `gemini-3-pro-image-preview` | Standard | During pipeline keyframe step |
| Final keyframes | `gemini-3-pro-image-preview` | Standard | When explicitly requested |

### Cost Optimization Rules

1. **Default to `gemini-2.5-pro`** — strong reasoning for planning and overlays
2. **Use `gemini-2.5-flash` for metadata** — classification/tagging doesn't need deep reasoning
3. **Use `gemini-3-pro-image-preview` for images** — supports text-to-image and image-to-image natively
4. **Prefer one high-quality response** over multiple chained requests
5. **Reuse prior outputs** (style bible, plan) instead of regenerating

## Secret Management

- `GOOGLE_AI_API_KEY` is stored as a **backend secret** in Lovable Cloud
- It is **never** exposed to the frontend
- Edge functions access it via `Deno.env.get("GOOGLE_AI_API_KEY")`
- The API is called via REST (`generativelanguage.googleapis.com`)

## Server-Side Modules

### `supabase/functions/_shared/openai.ts`

Central module used by all edge functions (name kept for backward compatibility):

- **`callText()`** — Text completion with tool calling support (converts OpenAI format to Gemini)
- **`callStructured()`** — JSON output with automatic retry & repair
- **`callImage()`** — Image generation via Gemini's native image generation
- **`callAI()`** — Backward-compatible wrapper (maps old model names to Gemini models)
- **Usage logging** — Every call is logged with model, latency, tokens, success/failure

### Gemini-Specific Features

- **Image-to-image**: Supports reference images via `inlineData` parts for keyframe chaining
- **Native tool calling**: Uses Gemini's `functionDeclarations` format (auto-converted from OpenAI format)
- **System instructions**: Uses Gemini's `systemInstruction` field for system prompts
- **Configurable resolution**: Maps quality tiers to Gemini's `imageSize` (512, 1K, 2K, 4K)
- **Aspect ratio support**: Full range of aspect ratios (1:1, 9:16, 16:9, 2:3, 3:2, etc.)

### `supabase/functions/ai-endpoints/index.ts`

Standalone REST endpoints for direct AI calls from the frontend:

| Endpoint | Method | Model | Description |
|----------|--------|-------|-------------|
| `/plan` | POST | gemini-2.5-pro | Generate scene plan |
| `/style-bible` | POST | gemini-2.5-pro | Generate style bible |
| `/platform-metadata` | POST | gemini-2.5-flash | Generate platform metadata |
| `/overlay` | POST | gemini-2.5-pro | Generate overlay content |
| `/image/draft` | POST | gemini-3-pro-image-preview | Draft keyframe image |
| `/image/final` | POST | gemini-3-pro-image-preview | Final keyframe image |
| `/usage` | GET | — | View usage log |

### Pipeline Integration

The main pipeline functions (`run-pipeline`, `finalize-video`) use the shared `_shared/openai.ts` module via the backward-compatible `callAI()` wrapper, which automatically maps old model references to the Gemini models.

## Frontend Client

### `src/lib/aiClient.ts`

Typed client with functions matching each endpoint:

```typescript
import { generatePlan, generateStyleBible, generateDraftKeyframe } from "@/lib/aiClient";

// Generate a plan
const plan = await generatePlan({
  concept_prompt: "A luxury pool construction timelapse",
  scene_count: 5,
});

// Generate a style bible
const bible = await generateStyleBible({
  user_prompt: "Create a style bible for a construction timelapse series",
});

// Generate a draft keyframe
const image = await generateDraftKeyframe({
  prompt: "Aerial view of an empty backyard, cinematic lighting, 9:16",
});
```

## Structured Output & Validation

All structured outputs use Gemini **function calling** to enforce schemas:

1. `functionDeclarations` define the JSON schema
2. `functionCallingConfig` with `mode: "ANY"` forces the model to use the specified function
3. `callStructured()` parses the function call arguments automatically
4. If JSON parsing fails, a **repair prompt** is sent once
5. If both attempts fail, the error propagates to the caller

## Error Handling

- **Rate limits (429)**: Surfaced to frontend with friendly message
- **Payment required (402)**: User directed to add credits
- **Timeouts**: Handled via fetch timeout
- **Retries**: 1 automatic retry via repair prompt for structured output
- **Premium escalation**: If `premium=true` and the default model fails, automatically escalates

## Usage Logging

Every AI call is logged in-memory with:
- Endpoint name
- Model used
- Success/failure
- Latency (ms)
- Token counts (prompt, completion, total)

Access via `GET /ai-endpoints/usage` or `getAIUsage()` from the frontend.
