

## Analysis: Why overlays and music keep disappearing

The root cause is clear from the logs: **fal.ai's `ffmpeg-api/compose` endpoint is unreliable for this use case**. Every run shows the same pattern:

1. Primary compose (video + overlay SVGs + audio) → fails with "Compose completed without video URL"
2. Overlay-only fallback → also fails the same way
3. Music-only merge fallback → sometimes works, sometimes doesn't
4. Local mux fallback → may succeed for audio but overlays are already lost

The SVG-as-video-track approach is fundamentally fragile because fal.ai's compose endpoint treats SVGs inconsistently -- sometimes cropping them, sometimes failing to process them entirely. We have been patching the same brittle pipeline for multiple iterations.

## Alternative approaches (ranked by reliability)

### Option A: Two sequential fal.ai calls instead of one compose (Recommended)

Instead of cramming everything into one compose call, use two separate, well-understood fal.ai endpoints sequentially:

1. **Step 1 -- Burn overlay via `fal-ai/ffmpeg-api` (raw ffmpeg command)**: Use a direct ffmpeg filter command (`overlay` filter with a PNG input) instead of the compose endpoint. Render text overlays as **PNG images** (not SVG -- better compatibility) using a canvas-like approach, upload them, then run a single ffmpeg command: `ffmpeg -i video.mp4 -i overlay.png -filter_complex "[0:v][1:v]overlay=0:0:enable='between(t,start,end)'" output.mp4`

2. **Step 2 -- Mux audio via `fal-ai/ffmpeg-api/merge-audio-video`**: This endpoint has worked before. Use it as the final step after overlays are burned in.

**Why this is better**: Each step does one thing. If overlay burning fails, we still get video+audio. If audio mux fails, we still get video+overlay. No single-point-of-failure compose call.

### Option B: Use fal.ai `ffmpeg-api` with raw command string

Instead of the higher-level `compose` endpoint, use the lower-level fal.ai ffmpeg endpoint that accepts raw ffmpeg command strings. This gives full control over filter chains:

```
ffmpeg -i input.mp4 -i overlay.png -i music.mp3 \
  -filter_complex "[0:v][1:v]overlay=0:0:enable='between(t,2,8)'" \
  -map "[v]" -map 2:a -shortest output.mp4
```

This handles overlay + audio in one call but with explicit ffmpeg syntax rather than the abstracted `compose` API.

### Option C: Local-only processing (no fal.ai for post-production)

Do everything in the edge function using the existing local MP4 muxer:
- **Overlays**: Skip burning into video entirely. Instead, store overlay metadata and render them **client-side** using an HTML5 `<video>` element with absolutely-positioned DOM overlays on top during playback. For publishing, use a simple ffmpeg drawtext command via fal.ai as a single call.
- **Audio**: Already have `muxMP3IntoMP4` working locally.

**Tradeoff**: Overlays won't be in the raw MP4 file for social media publishing, but would be visible in-app. A single ffmpeg call for publishing is simpler than the current multi-fallback chain.

## Recommended plan: Option A (two sequential calls)

### Changes in `supabase/functions/finalize-video/index.ts`:

1. **Replace SVG overlay rendering with PNG rendering**
   - Generate overlay as a PNG using an offscreen canvas approach (or a simpler SVG-to-PNG via fal.ai's image processing)
   - Upload the PNG to storage

2. **Replace the unified compose call with two sequential fal.ai calls**
   - Call 1: `fal-ai/ffmpeg-api` with raw command to overlay PNG onto video using ffmpeg's `overlay` filter
   - Call 2: `fal-ai/ffmpeg-api/merge-audio-video` to add the music track
   - Each call is polled independently with the existing robust polling logic

3. **Simplify fallback logic**
   - If overlay call fails → continue with base video (log warning)
   - If audio mux call fails → fall back to local `muxMP3IntoMP4` (already working)
   - Remove the complex nested try/catch fallback chain

4. **Keep the hard audio guarantee**
   - The `hasAudioTrack` check + local mux fallback stays as the final safety net

### What gets removed:
- The `runFalCompose` function (no longer needed)
- The SVG rendering code (replaced with PNG)
- The triple-nested fallback chain

### Risk:
- Low -- each fal.ai call is simple and well-understood
- Audio has a proven local fallback
- Overlay failure is graceful (video still publishes)

