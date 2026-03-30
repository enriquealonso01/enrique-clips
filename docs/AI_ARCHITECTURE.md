# AI Architecture — OpenAI Integration

## Overview

This project uses **OpenAI directly** for all AI-driven text and image generation. All API calls are made **server-side only** through Supabase Edge Functions. The frontend never touches the OpenAI API key.

## Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────┐
│   Frontend   │────▶│  Edge Functions      │────▶│  OpenAI  │
│  (React)     │     │  (Deno / Supabase)   │     │  API     │
│              │     │                      │     │          │
│ aiClient.ts  │     │ _shared/openai.ts    │     │ GPT-5.4  │
│              │     │ ai-endpoints/        │     │ GPT-IMG  │
│              │     │ run-pipeline/        │     │          │
│              │     │ finalize-video/      │     │          │
└──────────────┘     └─────────────────────┘     └──────────┘
```

## Model Routing & Cost Strategy

| Task | Model | Cost Tier | When Used |
|------|-------|-----------|-----------|
| Scene planning | `gpt-5.4-mini` | Low | Every run |
| Style bible | `gpt-5.4-mini` | Low | Every run |
| Overlay content | `gpt-5.4-mini` | Low | When overlays have `ai_generated` mode |
| Platform metadata | `gpt-5.4-nano` | Cheapest | Post-production metadata |
| Premium reasoning | `gpt-5.4` | High | Only when `premium=true` or validation fails |
| Draft keyframes | `gpt-image-1-mini` | Low | During pipeline keyframe step |
| Final keyframes | `gpt-image-1.5` | Higher | When explicitly requested |

### Cost Optimization Rules

1. **Default to `gpt-5.4-mini`** — covers 90% of use cases at low cost
2. **Use `gpt-5.4-nano` for metadata** — classification/tagging doesn't need reasoning
3. **Only escalate to `gpt-5.4`** when a `premium=true` flag is set or when JSON validation fails after retry
4. **Use `gpt-image-1-mini` for drafts** — save `gpt-image-1.5` for final approved renders
5. **Prefer one high-quality response** over multiple chained requests
6. **Reuse prior outputs** (style bible, plan) instead of regenerating

## Secret Management

- `OPENAI_API_KEY` is stored as a **backend secret** in Lovable Cloud
- It is **never** exposed to the frontend
- Edge functions access it via `Deno.env.get("OPENAI_API_KEY")`
- The OpenAI SDK is initialized lazily in `_shared/openai.ts`

## Server-Side Modules

### `supabase/functions/_shared/openai.ts`

Central module used by all edge functions:

- **`callText()`** — Text completion with tool calling support
- **`callStructured()`** — JSON output with automatic retry & repair
- **`callImage()`** — Image generation via OpenAI Images API
- **`callAI()`** — Backward-compatible wrapper (maps old model names to new ones)
- **Usage logging** — Every call is logged with model, latency, tokens, success/failure

### `supabase/functions/ai-endpoints/index.ts`

Standalone REST endpoints for direct AI calls from the frontend:

| Endpoint | Method | Model | Description |
|----------|--------|-------|-------------|
| `/plan` | POST | gpt-5.4-mini | Generate scene plan |
| `/style-bible` | POST | gpt-5.4-mini | Generate style bible |
| `/platform-metadata` | POST | gpt-5.4-nano | Generate platform metadata |
| `/overlay` | POST | gpt-5.4-mini | Generate overlay content |
| `/image/draft` | POST | gpt-image-1-mini | Draft keyframe image |
| `/image/final` | POST | gpt-image-1.5 | Final keyframe image |
| `/usage` | GET | — | View usage log |

### Pipeline Integration

The main pipeline functions (`run-pipeline`, `finalize-video`) use the shared `_shared/openai.ts` module via the backward-compatible `callAI()` wrapper, which automatically maps old model references to the new OpenAI models.

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

All structured outputs use OpenAI **tool calling** (function calling) to enforce schemas:

1. Tools define the JSON schema with `additionalProperties: false`
2. `tool_choice` forces the model to use the specified function
3. `callStructured()` parses the tool call arguments automatically
4. If JSON parsing fails, a **repair prompt** is sent once
5. If both attempts fail, the error propagates to the caller

## Error Handling

- **Rate limits (429)**: Surfaced to frontend with friendly message
- **Payment required (402)**: User directed to add credits
- **Timeouts**: 120s default timeout via OpenAI SDK
- **Retries**: 1 automatic retry on transient failures
- **Premium escalation**: If `premium=true` and the default model fails, automatically escalates to `gpt-5.4`

## Usage Logging

Every AI call is logged in-memory with:
- Endpoint name
- Model used
- Success/failure
- Latency (ms)
- Token counts (prompt, completion, total)

Access via `GET /ai-endpoints/usage` or `getAIUsage()` from the frontend.
