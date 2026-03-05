

## Diagnosis: Edge Function Wall-Clock Timeout

The run got stuck generating keyframe K6 because the edge function hit its **wall-clock timeout** (~150 seconds). The keyframe step started at 15:06:00 and reached K6 at 15:09:05 (3+ minutes). Each keyframe takes ~30-40 seconds via the AI gateway, and with 9 scenes, the total sequential time (~5-6 minutes) far exceeds the edge function limit.

K1 through K5 were saved successfully. K6 generation started but the function was killed before it could complete, leaving scenes 6-9 with `pending` status and no error logged.

## Root Cause

The keyframe loop processes **all** pending scenes in a single function invocation. There is no mid-step self-chaining or time-budget check.

## Plan

### 1. Add a time-budget guard to the keyframe loop

Inside the `for (const scene of pendingScenes)` loop in `run-pipeline/index.ts`, add a check at the top of each iteration:

- Track `const startTime = Date.now()` before the loop
- Before each keyframe generation, check if `Date.now() - startTime > 100_000` (100 seconds used, leaving ~50s buffer)
- If the budget is exceeded, log "Time budget reached, re-chaining for remaining keyframes", call `chainNextStep()`, and return early
- The next invocation will pick up where it left off thanks to the existing resumability logic (it checks `doneSceneIds`)

### 2. Apply the same pattern to the kling/pika/vidu submission loop

The video submission step also iterates over multiple scenes. Add the same time-budget guard there to prevent the same issue when submitting many clips.

### Changes

**File: `supabase/functions/run-pipeline/index.ts`**
- Add `const stepStartTime = Date.now();` before the keyframe loop (around line 581)
- Add a time check at the top of the loop body (after line 582): if elapsed > 100s, log + chain + return
- Add the same pattern in the kling step loop

This is a small, surgical fix. No database changes needed. The existing resumability logic already handles re-entry correctly.

