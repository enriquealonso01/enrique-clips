

# Fix Three Story Pipeline Reliability Issues

## 1. Vidu Poller Self-Re-Invocation

**Problem**: `story-poll-vidu` polls once and exits. If clips aren't done, nothing re-triggers it.

**Fix**: After the `if (!allDone)` check, before returning, self-invoke with a 15-second delay. Use `setTimeout` + `fetch` to re-call itself with the same `run_id`.

```text
if (!allDone) {
  // update progress...
  // Fire-and-forget: re-invoke self after 15s delay
  setTimeout(() => fetch(selfUrl, { ... }), 15_000);
  return json({ status: "polling", ... });
}
```

**File**: `supabase/functions/story-poll-vidu/index.ts`

---

## 2. Add Stage 5 Resume Handler

**Problem**: The resume logic handles `stage6`, `stage7`, `stage9`, `stage10_continue` — but not `stage5`. When `shouldChain()` triggers after stage 4 (line 819), the self-chain sends `resume_stage: "stage5"` which falls through to re-running the full pipeline from stage 1.

**Fix**: Add a `if (resumeStage === "stage5")` block in the resume section (before line 789). It reads `meta.story` and `meta.real_image` from persisted metadata, calls `stage5()`, stores memory, updates metadata with `...meta` merge, then continues to stage 6+ or chains.

**File**: `supabase/functions/story-pipeline/index.ts` (~30 lines added around line 770)

---

## 3. Metadata Merge Instead of Overwrite

**Problem**: Lines 810, 817, 843, 852, 864, 873, 884 all rebuild `generated_metadata` manually as a new object literal. If a chain interrupt loses a field that was added by a previous stage but not included in the literal, it's gone.

**Fix**: Every `updateRun` call that sets `generated_metadata` should first read the current `meta` from DB (or use the already-fetched `meta` variable) and spread it:
- In the **main pipeline flow** (lines 810–884), change each `generated_metadata: { story, real_image, ... }` to `generated_metadata: { ...meta, story, real_image, ... }` where `meta` is re-fetched or accumulated.
- Simplest approach: maintain a running `meta` object that accumulates, and always spread it. Replace the explicit object literals with `{ ...meta, <new fields> }`.

Affected lines in `supabase/functions/story-pipeline/index.ts`:
- Line 810: `{ story, target_duration }` → `{ ...meta, story, target_duration: context.targetDuration }`
- Line 817: `{ story, real_image, target_duration }` → `{ ...meta, story, real_image: realImage, target_duration: context.targetDuration }`
- Line 843: full rebuild → `{ ...meta, story, real_image: realImage, cast_image: castResult, target_duration: context.targetDuration }`
- Line 852, 864, 873, 884: same pattern — spread `meta` first, then overlay new fields

After each `updateRun`, re-read meta: `Object.assign(meta, { <new fields> })` to keep the running state consistent.

---

## Deployment

Deploy both updated edge functions:
- `story-pipeline`
- `story-poll-vidu`

