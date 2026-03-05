
Goal: fix why final output is missing selected music/overlays even though logs show those steps ran.

What I found (from code + latest run data)
1) The stitch remux is failing for selected-music runs
- In `supabase/functions/finalize-video/index.ts`, `concatenateMP4(..., { videoOnly: true })` filters tracks to video-only, but later rebuilds `moov` by iterating original `trak` boxes from file 1.
- That creates an out-of-bounds access (`rebuiltTraks[trakIndex++]` becomes `undefined`) and then `.length` is read during `moov` assembly.
- This matches your exact log: `MP4 remux failed: Cannot read properties of undefined (reading 'length') — using first clip as fallback.`

2) Music is added before overlays, but overlay rendering likely strips audio
- Current order is: concat → mux music → apply overlays via fal compose.
- Your run logs show size dropping from `2.9MB` after music mux to `1.3MB` after overlay step, which strongly indicates the overlay output is video-only (audio removed).
- So even when music mux succeeds, overlay stage can remove it.

3) Why overlays may also appear “missing”
- Because remux failure falls back to only the first clip.
- Overlay timing uses full expected duration (`scene_count * clip_duration`), so overlays can become mistimed or visually less obvious on fallback output.

Implementation plan
1) Fix the MP4 remux crash in `concatenateMP4`
- File: `supabase/functions/finalize-video/index.ts`
- Change moov rebuild logic to use only the selected track list (video-only filtered set) when constructing `trak` children.
- Do not iterate original `moov` trak sequence blindly when filtered tracks are in use.
- Add defensive guard: if a trak replacement is missing, throw a descriptive error before any `.length` access.

2) Reorder pipeline operations so final output keeps music
- File: `supabase/functions/finalize-video/index.ts`
- New order:
  - concatenate clips (video-first stitch)
  - apply overlays
  - mux selected MP3 as the last media mutation
- This ensures that even if overlay compose returns video-only output, selected track is added afterward and preserved in final asset.

3) Handle single-clip + selected-track case correctly
- File: `supabase/functions/finalize-video/index.ts`
- Today `concatenateMP4` returns early for 1 file, so video-only filtering is skipped.
- Add explicit “strip to video track first” path (or equivalent) before final music mux when `selected_track_id` exists and clip count is 1.
- Prevents original generator audio from competing with selected track.

4) Strengthen observability to verify correctness
- File: `supabase/functions/finalize-video/index.ts`
- Add structured logs:
  - post-concat track mode (`videoOnly=true/false`)
  - post-overlay size
  - post-mux size
  - explicit “music mux applied as final step”
- Keep existing idempotency behavior unchanged.

5) Validation pass after deploy
- Trigger one new run and verify logs in this order:
  - `MP4 remux succeeded...` (no fallback warning)
  - `Applying ... overlay(s)...`
  - `Overlays applied...`
  - `Adding music track...`
  - `Music track muxed. Final size: ...`
  - `Final video uploaded successfully.`
- Confirm run has one `final_video` asset and playback contains:
  - selected background music
  - visible overlay text at configured time window.

Technical details (for implementation)
```text
Primary bug location:
- finalize-video/index.ts
- concatenateMP4(): moov rebuild section uses first-file moov child traversal
  while rebuiltTraks length reflects filtered track set (video-only mode).
- This creates undefined trak replacement and crashes on .length.

Behavioral fix:
- Build moov trak list from filtered track set, not original child count.
- Move muxMP3IntoMP4() call to AFTER overlay compose result assignment.
```

Scope and risk
- No database schema or policy changes required.
- No frontend schema changes required.
- Changes are isolated to `supabase/functions/finalize-video/index.ts`.
- Expected user-visible result: final videos include both selected music and overlays reliably.
