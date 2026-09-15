# enrique-clips

Faceless AI video pipeline: short-form videos (TikTok / Reels / Shorts)
generated end to end — planning, keyframes, video generation, stitching,
subtitles, metadata, publishing — from a single prompt config.

## How it works

A 7-step pipeline runs server-side in Supabase Edge Functions:

1. **Plan** — AI writes a Style Bible and a structured scene plan
2. **Keyframes** — chained AI-generated end-frames per scene (K0–Kn)
3. **Video generation** — each keyframe drives a motion clip (Kling / Pika / Vidu)
4. **Polling** — wait for every clip to finish
5. **Stitch** — concatenate, add music, burn overlays (FFmpeg, via Rendi)
6. **Metadata** — AI generates title / description / hashtags
7. **Publish** — optionally post to connected platforms

Details: [docs/AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md) (model routing,
secrets) and [docs/PROMPT_CONFIG_REFERENCE.md](docs/PROMPT_CONFIG_REFERENCE.md)
(the full `prompt_config_json` contract).

## Stack

- Vite + React 18 + TypeScript + Tailwind + shadcn-ui (frontend)
- Supabase Edge Functions (`supabase/functions/`) — pipeline stages, scheduling, webhooks
- OpenAI for text, Google Gemini for images, ElevenLabs for narration,
  Submagic/OpusClip for subtitles

## Development

```sh
npm install
npm run dev        # local dev server
npm run build      # production build
npm run test       # vitest
npm run lint       # eslint
npm run config:export   # export project configs from the database
npm run config:push     # push project configs back
```

Deployment is via Netlify (`netlify.toml`); Edge Functions deploy with the
Supabase CLI.
