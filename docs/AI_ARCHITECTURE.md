# AI Architecture — Hybrid OpenAI + Gemini Integration

## Overview

This project uses a **hybrid AI architecture**:
- **OpenAI `gpt-5.3-chat-latest`** for all text generation (planning, style bibles, overlays, metadata)
- **Google Gemini** for image generation only (`gemini-3-pro-image-preview`)

All API calls are made **server-side only** through Supabase Edge Functions.

## Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────┐
│   Frontend   │────▶│  Edge Functions      │────▶│  OpenAI API  │
│  (React)     │     │  (Deno / Supabase)   │     │  gpt-5.3     │
│              │     │                      │     └──────────────┘
│ aiClient.ts  │     │ _shared/openai.ts    │
│              │     │ ai-endpoints/        │     ┌──────────────┐
│              │     │ run-pipeline/        │────▶│  Google      │
│              │     │ finalize-video/      │     │  Gemini API  │
└──────────────┘     └─────────────────────┘     │  (images)    │
                                                  └──────────────┘
```

## Model Routing & Cost Strategy

| Task | Model | API | When Used |
|------|-------|-----|-----------|
| Scene planning | `gpt-5.3-chat-latest` | OpenAI | Every run |
| Style bible | `gpt-5.3-chat-latest` | OpenAI | Every run |
| Overlay content | `gpt-5.3-chat-latest` | OpenAI | When overlays have `ai_generated` mode |
| Platform metadata | `gemini-2.5-flash` | Google | Post-production metadata |
| Premium reasoning | `gpt-5.3-chat-latest` | OpenAI | Only when `premium=true` or validation fails |
| Draft keyframes | `gemini-3-pro-image-preview` | Google | During pipeline keyframe step |
| Final keyframes | `gemini-3-pro-image-preview` | Google | When explicitly requested |

### Model Selection Rationale

1. **`gpt-5.3-chat-latest` for text** — More reliable than `gemini-2.5-pro` for structured output and prompt following
2. **`gemini-2.5-flash` for metadata** — Classification/tagging doesn't need deep reasoning, cheap and fast
3. **`gemini-3-pro-image-preview` for images** — Native image generation with Flex pricing tier
4. **Automatic model detection** — `isOpenAIModel()` routes based on model name prefix (`gpt-` or `openai/`)

## Secret Management

- `OPENAI_API_KEY` is stored as a **backend secret** for text generation
- `GOOGLE_AI_API_KEY` is stored as a **backend secret** for image generation
- Neither key is exposed to the frontend
- Edge functions access them via `Deno.env.get()`

## Server-Side Modules

### `supabase/functions/_shared/openai.ts`

Central module with dual-API routing:

- **`callText()`** — Routes to OpenAI or Gemini based on model name
  - OpenAI models: direct OpenAI chat completions API (messages sent as-is)
  - Gemini models: converts OpenAI format to Gemini format
- **`callStructured()`** — JSON output with automatic retry & repair
- **`callImage()`** — Image generation via Gemini's native image generation (always Gemini)
- **`callAI()`** — Backward-compatible wrapper (maps old model names to current models)
- **Usage logging** — Every call is logged with model, latency, tokens, success/failure

### `supabase/functions/ai-endpoints/index.ts`

Standalone REST endpoints for direct AI calls from the frontend:

| Endpoint | Method | Model | Description |
|----------|--------|-------|-------------|
| `/plan` | POST | gpt-5.3-chat-latest | Generate scene plan |
| `/style-bible` | POST | gpt-5.3-chat-latest | Generate style bible |
| `/platform-metadata` | POST | gemini-2.5-flash | Generate platform metadata |
| `/overlay` | POST | gpt-5.3-chat-latest | Generate overlay content |
| `/image/draft` | POST | gemini-3-pro-image-preview | Draft keyframe image |
| `/image/final` | POST | gemini-3-pro-image-preview | Final keyframe image |
| `/usage` | GET | — | View usage log |

### Pipeline Integration

The main pipeline functions (`run-pipeline`, `finalize-video`) use the shared module via `callAI()`, which automatically maps old model references to the current models.

## Structured Output & Validation

- **OpenAI models**: Uses native OpenAI tool calling (`tools` + `tool_choice` passed directly)
- **Gemini models**: Converts to `functionDeclarations` + `functionCallingConfig` with `mode: "ANY"`
- `callStructured()` handles both paths transparently
- If JSON parsing fails, a **repair prompt** is sent once

## Error Handling

- **Rate limits (429)**: OpenAI 429 → wait 30s and retry automatically
- **503 errors**: Wait 60s and retry (unlimited, both APIs)
- **Payment required (402)**: Surfaced to frontend
- **Timeouts**: Handled via fetch AbortController
- **Premium escalation**: If `premium=true` and default fails, escalates

## Usage Logging

Every AI call is logged in-memory with:
- Endpoint name
- Model used (actual model, e.g. `gpt-5.3-chat-latest` or `gemini-2.5-flash`)
- Success/failure
- Latency (ms)
- Token counts

Access via `GET /ai-endpoints/usage` or `getAIUsage()` from the frontend.
