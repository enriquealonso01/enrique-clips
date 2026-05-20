import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { r2Upload, mediaPublicUrl } from "../_shared/r2.ts";
import { callStructured, MODELS } from "../_shared/openai.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DEFAULT_STORY_EMOJI_PATH = "defaults/emoji-heart-bandage.png";
const DEFAULT_STORY_FPS = 24;
const DEFAULT_STORY_AUDIO_RATE = 48000;
const DEFAULT_END_CARD_DURATION_SEC = 5;
const SUBMAGIC_TRANSCRIPTION_MAX_AGE_MS = 45 * 60 * 1000;
const SUBMAGIC_MAX_TRANSCRIPTION_ATTEMPTS = 2;
// Publishing intentionally mirrors the Projects pipeline (finalize-video):
// async URL upload + hard idempotency on publish_jobs. No retry loop, no
// chaining, no per-attempt timeouts. One publish_jobs row per run, ever.

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Naive wall-clock strings ("2026-04-29T08:20:00") have no TZ suffix and
// must be interpreted in the project's IANA timezone — NOT as UTC.
// JavaScript's Date.parse treats such ISO date-times as UTC, which silently
// shifts a US/Eastern 8:20 AM schedule into 4:20 AM ET and makes it look
// "in the past". This helper resolves the wall-clock components inside the
// supplied timezone using Intl.DateTimeFormat as the offset oracle.
function resolveScheduledDateMs(
  scheduledDate: string,
  timezone?: string | null,
): number | null {
  if (!scheduledDate) return null;
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(scheduledDate.trim());
  if (hasTz) {
    const t = Date.parse(scheduledDate);
    return isNaN(t) ? null : t;
  }
  const m = scheduledDate.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!m) {
    const t = Date.parse(scheduledDate);
    return isNaN(t) ? null : t;
  }
  const [, y, mo, d, h, mi, s] = m;
  const tz = timezone && timezone.trim() ? timezone.trim() : "UTC";
  const guessUtcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(guessUtcMs))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asLocal = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour === 24 ? 0 : +parts.hour,
    +parts.minute, +parts.second,
  );
  const offsetMs = asLocal - guessUtcMs;
  return guessUtcMs - offsetMs;
}

function isFutureScheduledDate(scheduledDate: unknown, timezone?: string | null): boolean {
  if (!scheduledDate || typeof scheduledDate !== "string") return false;
  const t = resolveScheduledDateMs(scheduledDate, timezone);
  return t !== null && t > Date.now() + 60_000;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const RENDI_API_KEY = Deno.env.get("RENDI_API_KEY");
  const SUBMAGIC_API_KEY = Deno.env.get("SUBMAGIC_API_KEY");

  let runId: string;
  let forceRetry = false;
  let publishOnly = false;
  let skipMetadataGeneration = false;
  let forceMetadata = false;
  let postNow = false;
  try {
    const body = await req.json();
    runId = body.run_id;
    forceRetry = !!body.force_retry;
    publishOnly = !!body.publish_only;
    skipMetadataGeneration = !!body.skip_metadata_generation;
    forceMetadata = !!body.force_metadata;
    postNow = !!body.post_now;
  } catch { return json({ error: "run_id required" }, 400); }
  if (!runId) return json({ error: "run_id required" }, 400);

  async function log(level: string, message: string, data?: unknown) {
    console.log(`[STORY-FINAL][${level}] ${message}`);
    await sb.from("story_run_logs").insert({ run_id: runId, level: level as any, message, data: data || null });
  }

  async function updateRun(fields: Record<string, unknown>) {
    await sb.from("story_runs").update(fields).eq("id", runId);
  }

  async function failRun(message: string) {
    await log("error", message);
    await updateRun({ status: "failed", error_message: message, finished_at: new Date().toISOString() });
  }

  async function checkCancelled(): Promise<boolean> {
    const { data } = await sb.from("story_runs").select("status").eq("id", runId).single();
    if (data && (data.status === "cancelled" || (data.status === "failed" && !forceRetry))) {
      await log("info", `Finalize aborted: run is ${data.status}`);
      return true;
    }
    return false;
  }

  try {
    // Check cancellation before starting
    const { data: statusCheck } = await sb.from("story_runs").select("status").eq("id", runId).single();
    if (statusCheck && (statusCheck.status === "cancelled" || (statusCheck.status === "failed" && !forceRetry))) {
      await log("info", `Finalize aborted: run is ${statusCheck.status}`);
      return json({ status: "aborted", reason: statusCheck.status });
    }

    const { data: run } = await sb.from("story_runs").select("*, story_projects(*)").eq("id", runId).single();
    if (!run) return json({ error: "Run not found" }, 404);

    const project = run.story_projects as any;
    let meta = (run.generated_metadata as any) || {};
    const config = project?.config_json || {};
    const audioMix = config.audio_mix || {};
    const endingConfig = config.ending_audio || {};
    const endCardDurationSec = endingConfig.target_duration_sec ?? DEFAULT_END_CARD_DURATION_SEC;

    // ── Check for already-completed finalization (idempotency) ──
    const { data: existingFinal } = await sb.from("story_assets")
      .select("supabase_path, metadata")
      .eq("run_id", runId)
      .eq("type", "final_video")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!publishOnly && !forceRetry && existingFinal?.supabase_path) {
      await log("info", "Final video already exists — skipping duplicate finalization");
      return json({ status: "already_finalized", run_id: runId });
    }

    // ── Resume shortcut: if captioned video already exists, skip clip download + Rendi + Submagic ──
    const { data: existingCaptioned } = await sb.from("story_assets")
      .select("supabase_path").eq("run_id", runId).eq("type", "captioned_story_video").limit(1).maybeSingle();
    const resumeFromEndCard = !!existingCaptioned?.supabase_path;
    if (resumeFromEndCard) {
      await log("info", `Resume detected: captioned video already exists at ${existingCaptioned!.supabase_path}. Skipping to end card.`);
    }

    // ── Resume shortcut #2: Submagic project already submitted but not yet downloaded ──
    const { data: priorRun } = await sb.from("story_runs").select("generated_metadata").eq("id", runId).single();
    const priorMeta = (priorRun?.generated_metadata as any) || {};
    const existingSubmagicId: string | null = !resumeFromEndCard && priorMeta.submagic_project_id ? priorMeta.submagic_project_id : null;
    const existingSubmagicStoryPath: string | null = !resumeFromEndCard && priorMeta.submagic_story_path ? priorMeta.submagic_story_path : null;
    const resumeFromAssembledStory = !!existingSubmagicStoryPath;
    const resumeFromSubmagic = !!existingSubmagicId && resumeFromAssembledStory;
    if (resumeFromSubmagic) {
      await log("info", `Resume detected: Submagic project ${existingSubmagicId} already submitted. Skipping Rendi, polling Submagic.`);
    } else if (resumeFromAssembledStory) {
      await log("info", `Resume detected: assembled story video already exists at ${existingSubmagicStoryPath}. Skipping Rendi, creating a fresh Submagic project.`);
    }

    // ── Get all scene clips (completed) ──
    const { data: clipAssets } = await sb.from("story_assets")
      .select("*").eq("run_id", runId).eq("type", "scene_video_raw")
      .order("scene_index", { ascending: true });

    const completedClips = (clipAssets || []).filter(a => (a.metadata as any)?.status === "completed");
    if (completedClips.length === 0) {
      await failRun("No completed scene clips found");
      return json({ error: "No clips" }, 500);
    }

    await log("info", `Starting finalization with ${completedClips.length} clips`);

    // ── Get narration audio URL ──
    const { data: narrationAsset } = await sb.from("story_assets")
      .select("*").eq("run_id", runId).eq("type", "narration_audio").single();

    let narrationUrl: string | null = null;
    if (narrationAsset) {
      narrationUrl = mediaPublicUrl(narrationAsset.supabase_path);
    }

    // ── Get clip URLs (skip on resume — captioned video already built) ──
    const clipUrls: string[] = [];
    if (!resumeFromEndCard && !resumeFromAssembledStory) {
      for (const clip of completedClips) {
        clipUrls.push(mediaPublicUrl(clip.supabase_path));
      }
      if (clipUrls.length === 0) {
        await failRun("No clip URLs available");
        return json({ error: "No clip URLs" }, 500);
      }
    }

    // ── Get background music URL if uploaded ──
    let bgMusicUrl: string | null = null;
    if (project?.background_music_path) {
      bgMusicUrl = mediaPublicUrl(project.background_music_path);
    }

    // ── Get real image for end card ──
    const realImageUrl = meta.real_image?.primary_url || meta.real_image?.fallback_url || null;

    // ── Get ending audio URL if uploaded ──
    let endingAudioUrl: string | null = null;
    if (project?.ending_audio_path) {
      endingAudioUrl = mediaPublicUrl(project.ending_audio_path);
    }

    // ══════════════════════════════════════════════════════
    // STAGE 12-13: Assemble story video with Rendi
    // ══════════════════════════════════════════════════════

    let storyPath = existingCaptioned?.supabase_path || existingFinal?.supabase_path || "";
    let captionedPath = existingCaptioned?.supabase_path || existingFinal?.supabase_path || "";
    let storyVideoDurationSec: number;
    let finalPath: string | null = publishOnly ? existingFinal?.supabase_path ?? null : null;
    let finalSignedUrl: { signedUrl?: string } | null = null;
    let storyBytes: Uint8Array | null = null;

    // Compute clip durations (needed for end-card xfade offset even on resume)
    const timedBeats = meta.timed_beats || [];
    const dissolveDuration = 0.3;
    // Tail buffer added to the LAST clip so the end-card audio crossfade
    // doesn't eat the final word of narration. Includes the end-card
    // acrossfade duration (0.5s) plus a small safety margin.
    const lastClipTailBufferSec = 0.8;
    const lastClipIndex = completedClips.length - 1;
    const clipDurations = completedClips.map((clip: any, i: number) => {
      const m = (clip.metadata as any) || {};
      const beatIndex = typeof clip.scene_index === "number" ? clip.scene_index : i;
      const targetDuration = Math.max(0.5, Number(m.target_duration) || Number(timedBeats[beatIndex]?.duration) || Number(timedBeats[i]?.duration) || 4);
      const requestedDuration = Math.max(targetDuration, Number(m.request_duration) || Math.ceil(targetDuration));
      const isLast = i === lastClipIndex;
      // Non-first clips get +dissolveDuration of overlap material for the xfade.
      // The last clip additionally gets a tail buffer to protect end-of-narration.
      const desiredTail = (i === 0 ? 0 : dissolveDuration) + (isLast ? lastClipTailBufferSec : 0);
      return Math.min(requestedDuration, targetDuration + desiredTail);
    });
    storyVideoDurationSec = Math.max(0.5, clipDurations.reduce((sum: number, duration: number) => sum + duration, 0) - (clipDurations.length - 1) * dissolveDuration);

    if (publishOnly) {
      if (!finalPath) {
        await failRun("Publish-only retry requested but no final video exists");
        return json({ error: "No final video to publish" }, 400);
      }
      captionedPath = existingCaptioned?.supabase_path || finalPath;
      storyPath = captionedPath;
      await log("info", `Publish-only retry: reusing final video at ${finalPath}`);
    } else if (resumeFromEndCard) {
      captionedPath = existingCaptioned!.supabase_path;
      storyPath = captionedPath;
      await log("info", `Resume: skipping Rendi assembly + Submagic (story_duration=${storyVideoDurationSec.toFixed(2)}s).`);
    } else if (resumeFromSubmagic) {
      storyPath = existingSubmagicStoryPath!;
      captionedPath = storyPath; // will be overwritten by Submagic download below
      await log("info", `Resume: skipping Rendi (story_video at ${storyPath}), going straight to Submagic poll.`);
    } else if (resumeFromAssembledStory) {
      storyPath = existingSubmagicStoryPath!;
      captionedPath = storyPath;
      await log("info", `Resume: skipping Rendi (story_video at ${storyPath}), creating a fresh Submagic project.`);
    } else {
    await updateRun({ current_stage: "video_stitching", progress_pct: 74 });
    await log("info", "Stage 12-13: Assembling story video with dissolves, narration, and optional BGM");

    if (!RENDI_API_KEY) {
      await failRun("RENDI_API_KEY not configured");
      return json({ error: "No Rendi key" }, 500);
    }

    // Build FFmpeg command for story portion
    // Rendi requires input keys to start with "in_" and be referenced as {{in_*}}
    const inputFiles: Record<string, string> = {};
    const inputArgs: string[] = [];

    // Add clip inputs: in_clip0, in_clip1, ...
    for (let i = 0; i < clipUrls.length; i++) {
      inputFiles[`in_clip${i}`] = clipUrls[i];
      inputArgs.push(`-i {{in_clip${i}}}`);
    }

    // Add narration input
    let narrationIdx = -1;
    if (narrationUrl) {
      narrationIdx = clipUrls.length;
      inputFiles[`in_narration`] = narrationUrl;
      inputArgs.push(`-i {{in_narration}}`);
    }

    // Add background music input
    let bgmIdx = -1;
    if (bgMusicUrl) {
      bgmIdx = narrationIdx >= 0 ? narrationIdx + 1 : clipUrls.length;
      inputFiles[`in_bgm`] = bgMusicUrl;
      inputArgs.push(`-i {{in_bgm}}`);
    }

    // Build filter_complex with dissolves between clips (durations already computed above).
    // For the LAST clip we also tpad (clone last frame) up to its desired duration so that
    // if Vidu returned fewer seconds than we need for the end-card crossfade tail, the
    // timeline still extends — protecting the final word of narration from being clipped.
    const lastIdx = completedClips.length - 1;
    let filterParts: string[] = completedClips.map((_: any, i: number) => {
      const dur = clipDurations[i].toFixed(3);
      if (i === lastIdx) {
        return `[${i}:v]scale=1080:1920,setsar=1,fps=${DEFAULT_STORY_FPS},tpad=stop_mode=clone:stop_duration=${dur},trim=duration=${dur},setpts=PTS-STARTPTS[vclip${i}]`;
      }
      return `[${i}:v]scale=1080:1920,setsar=1,fps=${DEFAULT_STORY_FPS},trim=duration=${dur},setpts=PTS-STARTPTS[vclip${i}]`;
    });
    let lastLabel = "[vclip0]";
    let cumulativeOffset = 0;

    // Trim each generated clip to its narration beat, then xfade the bounded clips.
    for (let i = 1; i < clipUrls.length; i++) {
      const outLabel = i < clipUrls.length - 1 ? `[v${i}]` : "[vout]";
      const clipDuration = clipDurations[i - 1];
      cumulativeOffset += clipDuration - dissolveDuration;
      const safeOffset = Math.max(0.1, cumulativeOffset);
      filterParts.push(`${lastLabel}[vclip${i}]xfade=transition=fade:duration=${dissolveDuration}:offset=${safeOffset.toFixed(2)}${outLabel}`);
      lastLabel = outLabel;
    }

    if (clipUrls.length === 1) {
      filterParts.push(`[vclip0]copy[vout]`);
    }

    // Audio mixing
    let audioFilter = "";
    const bgmGain = audioMix.background_music_gain_db ?? -22;

    if (narrationIdx >= 0 && bgmIdx >= 0) {
      audioFilter = `;[${bgmIdx}:a]volume=${bgmGain}dB[bgm_low];[${narrationIdx}:a][bgm_low]amix=inputs=2:duration=first:dropout_transition=2,apad=whole_dur=${storyVideoDurationSec.toFixed(3)}[aout]`;
    } else if (narrationIdx >= 0) {
      audioFilter = `;[${narrationIdx}:a]apad=whole_dur=${storyVideoDurationSec.toFixed(3)}[aout]`;
    } else {
      audioFilter = `;anullsrc=r=${DEFAULT_STORY_AUDIO_RATE}:cl=stereo:d=${storyVideoDurationSec.toFixed(3)}[aout]`;
    }

    const fullFilter = filterParts.join(";") + audioFilter;
    // Use the narration-beat visual duration as the authoritative cap so Rendi cannot encode past
    // the intended story body or let end-card audio start before the end-card visuals.
    const storyCmd = `${inputArgs.join(" ")} -filter_complex "${fullFilter}" -map "[vout]" -map "[aout]" -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p -r ${DEFAULT_STORY_FPS} -c:a aac -ar ${DEFAULT_STORY_AUDIO_RATE} -ac 2 -b:a 128k -t ${storyVideoDurationSec.toFixed(3)} -movflags +faststart {{out_1}}`;

    await log("info", `Rendi story FFmpeg: ${storyCmd.substring(0, 500)}...`);

    // Submit to Rendi
    const rendiResp = await fetch("https://api.rendi.dev/v1/run-ffmpeg-command", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": RENDI_API_KEY },
      body: JSON.stringify({
        ffmpeg_command: storyCmd,
        input_files: inputFiles,
        output_files: { out_1: "story_video.mp4" },
        max_command_run_seconds: 60,
        vcpu_count: 8,
      }),
    });

    if (!rendiResp.ok) {
      const err = await rendiResp.text();
      await failRun(`Rendi story assembly failed: ${err.substring(0, 300)}`);
      return json({ error: "Rendi failed" }, 500);
    }

    const { command_id: storyCommandId } = await rendiResp.json();
    await log("info", `Rendi story command: ${storyCommandId}`);

    // Poll for completion
    let storyVideoUrl: string | null = null;
    for (let poll = 0; poll < 80; poll++) {
      await sleep(3000);
      const pollResp = await fetch(`https://api.rendi.dev/v1/commands/${storyCommandId}`, {
        headers: { "X-API-KEY": RENDI_API_KEY },
      });
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json();

      if (pollData.status === "SUCCESS") {
        storyVideoUrl = pollData.output_files?.out_1?.storage_url;
        if (!storyVideoUrl) throw new Error("Rendi succeeded but no output URL");
        await log("info", "Story video assembled successfully");
        break;
      }
      if (pollData.status === "FAILED" || pollData.status === "ERROR") {
        throw new Error(`Rendi story assembly failed: ${JSON.stringify(pollData).substring(0, 300)}`);
      }
    }

    if (!storyVideoUrl) {
      await failRun("Story video assembly timed out");
      return json({ error: "Timeout" }, 500);
    }

    // Download and store story video
    const storyDl = await fetch(storyVideoUrl);
        storyBytes = new Uint8Array(await storyDl.arrayBuffer());
    storyPath = `story-runs/${runId}/story_video.mp4`;
    await r2Upload(storyPath, storyBytes, "video/mp4");

    await updateRun({ progress_pct: 80 });
    if (await checkCancelled()) return json({ status: "cancelled" });
    } // end Rendi else (skipped on resumeFromEndCard / resumeFromSubmagic)

    // ══════════════════════════════════════════════════════
    // STAGE 14: Subtitles via Submagic API
    // ══════════════════════════════════════════════════════

    if (!resumeFromEndCard) {
    await updateRun({ current_stage: "subtitles_processing", progress_pct: 82 });

    captionedPath = storyPath; // fallback: use uncaptioned video

    if (SUBMAGIC_API_KEY) {
      await log("info", "Stage 14: Adding subtitles via Submagic API");

      try {
        let subProjectId: string;
        if (existingSubmagicId) {
          subProjectId = existingSubmagicId;
          await log("info", `Reusing existing Submagic project: ${subProjectId}`);
        } else {
          // Get a public signed URL for the story video (Submagic needs a public URL)
          const videoUrl = mediaPublicUrl(storyPath);
          if (!videoUrl) throw new Error("Could not get URL for story video");

          const createResp = await fetch("https://api.submagic.co/v1/projects", {
            method: "POST",
            headers: { "x-api-key": SUBMAGIC_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              title: (meta.story?.title || "Story Video").substring(0, 100),
              language: "en",
              videoUrl: videoUrl,
              userThemeId: "8ef61dce-7589-48ff-b269-8623a3a5179e",
            }),
          });
          if (!createResp.ok) {
            const errText = await createResp.text();
            throw new Error(`Submagic create project failed: ${createResp.status} ${errText.substring(0, 200)}`);
          }
          const subProject = await createResp.json();
          subProjectId = subProject.id;
          await log("info", `Submagic project created: ${subProjectId}`);
        }

        // Persist project ID immediately so chained invocations can resume polling without re-creating
        const { data: curRunMeta } = await sb.from("story_runs").select("generated_metadata").eq("id", runId).single();
        const metaBeforeSubmagic = ((curRunMeta?.generated_metadata as any) || {});
        const nowIso = new Date().toISOString();
        const submittedAt = existingSubmagicId
          ? (metaBeforeSubmagic.submagic_submitted_at || run.started_at || run.created_at || nowIso)
          : nowIso;
        const attempts = Number(metaBeforeSubmagic.submagic_transcription_attempts || (existingSubmagicId ? 1 : 0)) || 1;
        const mergedMeta = {
          ...metaBeforeSubmagic,
          submagic_project_id: subProjectId,
          submagic_story_path: storyPath,
          submagic_submitted_at: submittedAt,
          submagic_transcription_attempts: attempts,
          submagic_last_polled_at: nowIso,
        };
        await sb.from("story_runs").update({ generated_metadata: mergedMeta }).eq("id", runId);

        const existingElapsedMs = existingSubmagicId ? Date.now() - Date.parse(submittedAt) : 0;
        if (existingSubmagicId && Number.isFinite(existingElapsedMs) && existingElapsedMs > SUBMAGIC_TRANSCRIPTION_MAX_AGE_MS) {
          if (attempts < SUBMAGIC_MAX_TRANSCRIPTION_ATTEMPTS) {
            const nextAttempts = attempts + 1;
            await log("warn", `Submagic transcription stuck after ${Math.round(existingElapsedMs / 60000)}m — abandoning stale project and creating a fresh Submagic project (attempt ${nextAttempts}/${SUBMAGIC_MAX_TRANSCRIPTION_ATTEMPTS})`);
            await sb.from("story_runs").update({
              generated_metadata: {
                ...mergedMeta,
                submagic_project_id: null,
                submagic_story_path: storyPath,
                submagic_submitted_at: null,
                submagic_transcription_attempts: nextAttempts,
                submagic_stuck_project_id: subProjectId,
              },
            }).eq("id", runId);
            const retryUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/story-finalize`;
            const retryPromise = fetch(retryUrl, {
              method: "POST",
              headers: { "Authorization": `Bearer ${Deno.env.get("INTERNAL_FN_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
              body: JSON.stringify({ run_id: runId, force_retry: true }),
            }).catch(() => {});
            // @ts-ignore EdgeRuntime is available in Supabase Edge Runtime
            if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(retryPromise);
            return json({ status: "chained_submagic_recreate", run_id: runId });
          }
          throw new Error(`Submagic transcription stuck for ${Math.round(existingElapsedMs / 60000)} minutes after ${attempts} attempt(s)`);
        }

        // Step 2: Poll for transcription completion
        let transcribed = false;
        const t0 = Date.now();
        // Cap polling at 70s per invocation to leave room for export+download+endcard or chaining
        for (let poll = 0; poll < 60 && (Date.now() - t0) < 70000; poll++) {
          await sleep(5000);
          const getResp = await fetch(`https://api.submagic.co/v1/projects/${subProjectId}`, {
            headers: { "x-api-key": SUBMAGIC_API_KEY },
          });
          if (!getResp.ok) continue;
          const proj = await getResp.json();

          if (proj.status === "completed" || proj.transcriptionStatus === "COMPLETED") {
            transcribed = true;
            await log("info", "Submagic transcription completed");
            break;
          }
          if (proj.status === "failed") {
            throw new Error(`Submagic transcription failed: ${proj.failedReason || "unknown"}`);
          }
          if (poll % 6 === 0) {
            await log("debug", `Submagic status: ${proj.status} / transcription: ${proj.transcriptionStatus}`);
          }
        }

        if (!transcribed) {
          const elapsedMs = Date.now() - Date.parse(submittedAt);
          if (Number.isFinite(elapsedMs) && elapsedMs > SUBMAGIC_TRANSCRIPTION_MAX_AGE_MS) {
            if (attempts < SUBMAGIC_MAX_TRANSCRIPTION_ATTEMPTS) {
              const nextAttempts = attempts + 1;
              await log("warn", `Submagic transcription stuck after ${Math.round(elapsedMs / 60000)}m — creating a fresh Submagic project (attempt ${nextAttempts}/${SUBMAGIC_MAX_TRANSCRIPTION_ATTEMPTS})`);
              await sb.from("story_runs").update({
                generated_metadata: {
                  ...mergedMeta,
                  submagic_project_id: null,
                  submagic_story_path: storyPath,
                  submagic_submitted_at: null,
                  submagic_last_polled_at: nowIso,
                  submagic_transcription_attempts: nextAttempts,
                  submagic_stuck_project_id: subProjectId,
                },
              }).eq("id", runId);
              const retryUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/story-finalize`;
              const retryPromise = fetch(retryUrl, {
                method: "POST",
                headers: { "Authorization": `Bearer ${Deno.env.get("INTERNAL_FN_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
                body: JSON.stringify({ run_id: runId, force_retry: true }),
              }).catch(() => {});
              // @ts-ignore EdgeRuntime is available in Supabase Edge Runtime
              if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(retryPromise);
              return json({ status: "chained_submagic_recreate", run_id: runId });
            }
            throw new Error(`Submagic transcription stuck for ${Math.round(elapsedMs / 60000)} minutes after ${attempts} attempt(s)`);
          }

          // Chain to a fresh invocation to keep polling without hitting edge timeout
          await log("info", "Submagic still transcribing — chaining to fresh invocation to continue polling");
          const chainUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/story-finalize`;
          const chainPromise1 = fetch(chainUrl, {
            method: "POST",
            headers: { "Authorization": `Bearer ${Deno.env.get("INTERNAL_FN_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
            body: JSON.stringify({ run_id: runId, force_retry: true }),
          }).catch(() => {});
          // @ts-ignore EdgeRuntime is available in Supabase Edge Runtime
          if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(chainPromise1);
          return json({ status: "chained_submagic_transcribe", run_id: runId });
        }

        // Step 3: Export project (render captioned video)
        const exportResp = await fetch(`https://api.submagic.co/v1/projects/${subProjectId}/export`, {
          method: "POST",
          headers: {
            "x-api-key": SUBMAGIC_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            width: 1080,
            height: 1920,
            fps: 30,
          }),
        });

        if (!exportResp.ok) {
          const errText = await exportResp.text();
          throw new Error(`Submagic export failed: ${exportResp.status} ${errText.substring(0, 200)}`);
        }

        await log("info", "Submagic export triggered, polling for completion...");

        // Step 4: Poll for export completion
        let captionedVideoUrl: string | null = null;
        const tExp = Date.now();
        for (let poll = 0; poll < 120 && (Date.now() - tExp) < 60000; poll++) {
          await sleep(5000);
          const getResp = await fetch(`https://api.submagic.co/v1/projects/${subProjectId}`, {
            headers: { "x-api-key": SUBMAGIC_API_KEY },
          });
          if (!getResp.ok) continue;
          const proj = await getResp.json();

          if (proj.status === "completed" && proj.downloadUrl) {
            captionedVideoUrl = proj.downloadUrl;
            await log("info", `Submagic captioned video ready: ${(captionedVideoUrl || "").substring(0, 80)}...`);
            break;
          }
          if (proj.status === "failed") {
            throw new Error(`Submagic export failed: ${proj.failedReason || "unknown"}`);
          }
          if (poll % 12 === 0) {
            await log("debug", `Submagic export status: ${proj.status}`);
          }
        }

        if (!captionedVideoUrl) {
          await log("info", "Submagic still exporting — chaining to fresh invocation");
          const chainUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/story-finalize`;
          const chainPromise2 = fetch(chainUrl, {
            method: "POST",
            headers: { "Authorization": `Bearer ${Deno.env.get("INTERNAL_FN_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
            body: JSON.stringify({ run_id: runId, force_retry: true }),
          }).catch(() => {});
          // @ts-ignore EdgeRuntime is available in Supabase Edge Runtime
          if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(chainPromise2);
          return json({ status: "chained_submagic_export", run_id: runId });
        }

        // Step 5: Download captioned video and store
        const captDl = await fetch(captionedVideoUrl);
        if (!captDl.ok) throw new Error(`Failed to download captioned video: ${captDl.status}`);
        const captBytes = new Uint8Array(await captDl.arrayBuffer());
        captionedPath = `story-runs/${runId}/captioned_story_video.mp4`;
        await r2Upload(captionedPath, captBytes, "video/mp4");

        // Store as asset
        const captSignedUrl = { signedUrl: mediaPublicUrl(captionedPath) };
        await sb.from("story_assets").insert({
          run_id: runId,
          type: "captioned_story_video",
          supabase_path: captionedPath,
          signed_url_last: captSignedUrl?.signedUrl || null,
          metadata: { submagic_project_id: subProjectId, size_bytes: captBytes.length },
        });

        await log("info", `Captioned video stored: ${(captBytes.length / 1024 / 1024).toFixed(1)}MB`);

        // ── Chain: re-invoke self to continue with end card stage (avoid 150s timeout) ──
        await log("info", "Chaining: re-invoking story-finalize for end card stage");
        const chainUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/story-finalize`;
        const chainPromise3 = fetch(chainUrl, {
          method: "POST",
          headers: { "Authorization": `Bearer ${Deno.env.get("INTERNAL_FN_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
          body: JSON.stringify({ run_id: runId, force_retry: true }),
        }).catch(() => {});
        // @ts-ignore EdgeRuntime is available in Supabase Edge Runtime
        if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(chainPromise3);
        return json({ status: "chained_to_endcard", run_id: runId });
      } catch (subErr) {
        const errMsg = (subErr as Error).message;
        await log("error", `Submagic subtitles failed: ${errMsg}. Pausing run for manual review.`);
        await updateRun({
          status: "paused",
          error_message: `Submagic transcription failed: ${errMsg}`,
        });
        return json({ status: "paused", reason: "submagic_failed", run_id: runId });
      }
    } else {
      await log("info", "Stage 14: Subtitles skipped (SUBMAGIC_API_KEY not configured)");
    }
    } // end if (!resumeFromEndCard)

    // ══════════════════════════════════════════════════════
    // STAGE 15-17: End Card
    // ══════════════════════════════════════════════════════

    if (publishOnly) {
      await updateRun({ current_stage: "publishing", progress_pct: 94, error_message: null });
      finalSignedUrl = { signedUrl: mediaPublicUrl(finalPath!) };
    } else if (await checkCancelled()) return json({ status: "cancelled" });
    if (!publishOnly) {
      await updateRun({ current_stage: "end_card_rendering", progress_pct: 85 });
      await log("info", "Stage 15-17: Building 5-second grayscale end card");
    }

    let endCardUrl: string | null = null;
    let endCardUsedEmoji = false;

    if (!publishOnly && realImageUrl) {
      // Build end card with Rendi: grayscale real image, slow zoom, emoji overlay, 5 seconds
      const endCardInputs: Record<string, string> = { in_real_img: realImageUrl };
      let endCardAudioInput = "";
      let endCardAudioFilter = "";
      let endCardAudioMap = "";
      let emojiInput = "";
      let emojiOverlayFilter = "";
      const endCardDurationSec = endingConfig.target_duration_sec ?? DEFAULT_END_CARD_DURATION_SEC;
      const endCardFrameCount = Math.max(1, Math.round(endCardDurationSec * DEFAULT_STORY_FPS));

      // Emoji overlay
      let emojiUrl: string | null = null;
      const emojiPath = project?.emoji_path || DEFAULT_STORY_EMOJI_PATH;
      if (!project?.emoji_path) {
        await log("info", `No project emoji configured; falling back to ${DEFAULT_STORY_EMOJI_PATH}`);
      }
      if (emojiPath) {
        emojiUrl = mediaPublicUrl(emojiPath);
      }
      if (emojiUrl) {
        endCardInputs["in_emoji"] = emojiUrl;
        endCardUsedEmoji = true;
      }

      // Ending audio selection
      if (endingAudioUrl) {
        endCardInputs["in_end_audio"] = endingAudioUrl;
        endCardAudioInput = " -i {{in_end_audio}}";
        const fadeIn = endingConfig.fade_in_ms ?? 250;
        const fadeOut = endingConfig.fade_out_ms ?? 400;
        const audioIdx = 1;
        endCardAudioFilter = `;[${audioIdx}:a]atrim=0:${endCardDurationSec},asetpts=N/SR/TB,aresample=${DEFAULT_STORY_AUDIO_RATE},aformat=channel_layouts=stereo,volume=0.5,afade=t=in:st=0:d=${fadeIn / 1000},afade=t=out:st=${Math.max(0, endCardDurationSec - fadeOut / 1000)}:d=${fadeOut / 1000}[aend]`;
        endCardAudioMap = ` -map "[aend]"`;
      } else if (bgMusicUrl) {
        endCardInputs["in_end_audio"] = bgMusicUrl;
        endCardAudioInput = " -i {{in_end_audio}}";
        const audioIdx = 1;
        endCardAudioFilter = `;[${audioIdx}:a]atrim=0:${endCardDurationSec},asetpts=N/SR/TB,aresample=${DEFAULT_STORY_AUDIO_RATE},aformat=channel_layouts=stereo,volume=0.5,afade=t=in:st=0:d=0.3,afade=t=out:st=${Math.max(0, endCardDurationSec - 0.4)}:d=0.4[aend]`;
        endCardAudioMap = ` -map "[aend]"`;
      } else {
        endCardAudioFilter = `;anullsrc=r=${DEFAULT_STORY_AUDIO_RATE}:cl=stereo:d=${endCardDurationSec}[aend]`;
        endCardAudioMap = ` -map "[aend]"`;
      }

      // Emoji overlay filter - emoji input index depends on whether audio is present
      if (emojiUrl) {
        const emojiIdx = endCardAudioInput ? 2 : 1;
        emojiInput = " -i {{in_emoji}}";
        emojiOverlayFilter = `;[${emojiIdx}:v]scale=220:-1,rotate=-15*PI/180:fillcolor=none:ow=rotw(-15*PI/180):oh=roth(-15*PI/180)[emoji];[vend][emoji]overlay=(W-w)/2:(H-h)/2:enable='between(t\\,0\\,${endCardDurationSec})'[vfinal]`;
      }

      const vOutLabel = emojiUrl ? "vfinal" : "vend";

      // FFmpeg: loop image for 5s, grayscale, slow zoom, optional emoji overlay
      // Use scale+pad to fit image into 9:16 without cropping — remaining space is black
      // zoom=0.00042 gives ~5% zoom over 120 frames (5s @ 24fps) without hitting the 1.05 cap
      const endCardCmd = `-loop 1 -i {{in_real_img}}${endCardAudioInput}${emojiInput} -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=gray,setsar=1,zoompan=z='min(zoom+0.00042\\,1.05)':d=${endCardFrameCount}:s=1080x1920:fps=${DEFAULT_STORY_FPS}[vend]${emojiOverlayFilter}${endCardAudioFilter}" -map "[${vOutLabel}]"${endCardAudioMap} -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -r ${DEFAULT_STORY_FPS} -c:a aac -ar ${DEFAULT_STORY_AUDIO_RATE} -ac 2 -b:a 128k -t ${endCardDurationSec} -movflags +faststart {{out_1}}`;

      await log("info", `End card FFmpeg: ${endCardCmd.substring(0, 400)}...`);

      const endResp = await fetch("https://api.rendi.dev/v1/run-ffmpeg-command", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": RENDI_API_KEY },
        body: JSON.stringify({
          ffmpeg_command: endCardCmd,
          input_files: endCardInputs,
          output_files: { out_1: "end_card.mp4" },
          max_command_run_seconds: 30,
          vcpu_count: 4,
        }),
      });

      if (endResp.ok) {
        const { command_id: endCmdId } = await endResp.json();
        for (let poll = 0; poll < 40; poll++) {
          await sleep(2000);
          const p = await fetch(`https://api.rendi.dev/v1/commands/${endCmdId}`, { headers: { "X-API-KEY": RENDI_API_KEY } });
          if (!p.ok) continue;
          const pd = await p.json();
          if (pd.status === "SUCCESS") {
            endCardUrl = pd.output_files?.out_1?.storage_url;
            await log("info", endCardUsedEmoji ? "End card rendered with emoji overlay" : "End card rendered successfully");
            break;
          }
          if (pd.status === "FAILED" || pd.status === "ERROR") {
            await log("warn", `End card render failed: ${JSON.stringify(pd).substring(0, 200)}`);
            break;
          }
        }
      } else {
        await log("warn", `End card Rendi submit failed: ${endResp.status}`);
      }
    }

    // ══════════════════════════════════════════════════════
    // STAGE 18: Final Assembly
    // ══════════════════════════════════════════════════════

    if (!publishOnly && await checkCancelled()) return json({ status: "cancelled" });
    if (!publishOnly) await updateRun({ current_stage: "final_assembly", progress_pct: 90 });

    let finalVideoBytes: Uint8Array | null = null;
    let finalIncludesEndCard = publishOnly ? !!existingFinal?.metadata?.has_end_card : false;

    if (publishOnly) {
      await log("info", "Publish-only retry: skipping final assembly and reusing stored final video");
    } else if (endCardUrl) {
      await log("info", "Stage 18: Concatenating captioned story video + end card");

      // Get captioned story video URL
      const captUrl = { signedUrl: mediaPublicUrl(captionedPath) };

      // Reliability-first final assembly: normalize both inputs, then hard-concatenate.
      // Captioned videos from Submagic can arrive with odd timebases, which makes xfade brittle.
      // A strict concat after normalization is far more stable and publishing must only happen
      // when that true final-with-end-card file exists.
      const totalStoryDuration = storyVideoDurationSec;
      const finalDurationSec = totalStoryDuration + endCardDurationSec;
      const normVideo = `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${DEFAULT_STORY_FPS},settb=AVTB,format=yuv420p`;
      const normAudio = `aresample=${DEFAULT_STORY_AUDIO_RATE}:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=${DEFAULT_STORY_AUDIO_RATE}:channel_layouts=stereo`;
      const concatCmd = `-i {{in_story}} -i {{in_endcard}} -filter_complex "[0:v]${normVideo}[v0];[1:v]${normVideo}[v1];[0:a]${normAudio}[a0];[1:a]${normAudio}[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[vf][af]" -map "[vf]" -map "[af]" -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p -r ${DEFAULT_STORY_FPS} -c:a aac -ar ${DEFAULT_STORY_AUDIO_RATE} -ac 2 -b:a 128k -t ${finalDurationSec.toFixed(3)} -movflags +faststart {{out_1}}`;
      await log("info", `Final assembly FFmpeg: ${concatCmd.substring(0, 400)}`);

      const concatResp = await fetch("https://api.rendi.dev/v1/run-ffmpeg-command", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": RENDI_API_KEY },
        body: JSON.stringify({
          ffmpeg_command: concatCmd,
          input_files: { in_story: captUrl?.signedUrl || "", in_endcard: endCardUrl },
          output_files: { out_1: "final_video.mp4" },
          max_command_run_seconds: 60,
          vcpu_count: 8,
        }),
      });

      if (concatResp.ok) {
        const { command_id: concatCmdId } = await concatResp.json();
        let finalUrl: string | null = null;

        for (let poll = 0; poll < 60; poll++) {
          await sleep(3000);
          const p = await fetch(`https://api.rendi.dev/v1/commands/${concatCmdId}`, { headers: { "X-API-KEY": RENDI_API_KEY } });
          if (!p.ok) continue;
          const pd = await p.json();
          if (pd.status === "SUCCESS") {
            finalUrl = pd.output_files?.out_1?.storage_url;
            break;
          }
          if (pd.status === "FAILED" || pd.status === "ERROR") {
            await log("warn", `Final concat failed: ${JSON.stringify(pd).substring(0, 200)}`);
            break;
          }
        }

        if (finalUrl) {
          const dl = await fetch(finalUrl);
          finalVideoBytes = new Uint8Array(await dl.arrayBuffer());
          finalIncludesEndCard = true;
        } else {
          // HARD FAIL: never publish without the end card. Run can be retried;
          // captioned video is preserved so retry skips straight back here.
          const msg = "Final concat failed/timed out — refusing to publish without end card. Re-trigger the run to retry concat only.";
          await log("error", msg);
          await updateRun({ status: "failed", current_stage: "final_assembly", error_message: msg, finished_at: new Date().toISOString() });
          return json({ status: "failed", error: msg }, 500);
        }
      } else {
        const submitErr = await concatResp.text().catch(() => "");
        const msg = `Final concat submit failed (${concatResp.status}) — refusing to publish without end card.`;
        await log("error", msg, { body: submitErr.substring(0, 400) });
        await updateRun({ status: "failed", current_stage: "final_assembly", error_message: msg, finished_at: new Date().toISOString() });
        return json({ status: "failed", error: msg }, 500);
      }
    } else {
      await log("info", "No end card — using captioned video as final");
      // Re-read captioned video from storage
      const captSignedUrl = { signedUrl: mediaPublicUrl(captionedPath) };
      if (captSignedUrl?.signedUrl) {
        const dl = await fetch(captSignedUrl.signedUrl);
        finalVideoBytes = new Uint8Array(await dl.arrayBuffer());
      } else {
        if (!storyBytes) {
          throw new Error("Captioned video unavailable and story video bytes missing");
        }
        finalVideoBytes = storyBytes;
      }
    }

    // Upload final video
    if (!publishOnly) {
      const ts = Date.now();
      finalPath = `story-runs/${runId}/final_video_${ts}.mp4`;
      await r2Upload(finalPath, finalVideoBytes!, "video/mp4");
      finalSignedUrl = { signedUrl: mediaPublicUrl(finalPath) };

      await sb.from("story_assets").insert({
        run_id: runId,
        type: "final_video",
        supabase_path: finalPath,
        signed_url_last: finalSignedUrl?.signedUrl || null,
         metadata: { size_bytes: finalVideoBytes!.length, has_end_card: finalIncludesEndCard, has_subtitles: captionedPath !== storyPath },
      });

      await log("info", `Final video stored: ${(finalVideoBytes!.length / 1024 / 1024).toFixed(1)}MB`);
    }

    // ══════════════════════════════════════════════════════
    // STAGE 19: Publish via Upload-Post (if configured)
    // ══════════════════════════════════════════════════════

    await updateRun({ status: "publishing" as any, current_stage: "publishing", progress_pct: 94 });
    await log("info", "Stage 19: Publishing via Upload-Post");

    let publishStatus = "published";

    const uploadpostApiKey = (project as any).uploadpost_api_key_encrypted;
    const uploadpostConfigured = (project as any).uploadpost_api_key_configured;
    const uploadpostUsername = (project as any).uploadpost_profile_username;
    const platforms = (project?.publish_platforms as Record<string, boolean>) || {};
    const projPublishDefaults = ((project as any).publish_defaults as Record<string, any>) || {};
    const enabledPlatforms = Object.entries(platforms).filter(([_, v]) => v).map(([k]) => k);

    if (!uploadpostConfigured || !uploadpostApiKey) {
      await log("info", "Upload-Post not configured — skipping publish.");
    } else if (enabledPlatforms.length === 0) {
      await log("info", "No platforms enabled — skipping publish.");
    } else {
      // ── HARD IDEMPOTENCY GUARD ──
      // If any non-failed publish_jobs row already exists for this run, the
      // video has already been submitted. Never re-submit. This is THE check
      // that prevents duplicate posts.
      const { data: existingJobs } = await sb.from("publish_jobs")
        .select("id, status, uploadpost_request_id")
        .eq("run_id", runId)
        .in("status", ["submitted", "polling", "completed"] as any);
      if (existingJobs && existingJobs.length > 0) {
        await log("info", `Publish job already exists (${existingJobs[0].status}) — skipping duplicate publish.`, { existing_job_id: existingJobs[0].id });
      } else {
      try {
        if (!finalPath) {
          throw new Error("Final video path missing before publish");
        }
        // Async URL upload: Upload-Post fetches the video itself. No Blob, no
        // client-side timeout, no chaining. Mirrors the Projects pipeline.
        const finalDownloadUrl = { signedUrl: mediaPublicUrl(finalPath) };
        if (!finalDownloadUrl?.signedUrl) {
          throw new Error("Could not create signed URL for final story video");
        }
        const videoUrl = finalDownloadUrl.signedUrl;
        await log("info", "Prepared async Upload-Post submission (URL fetch by Upload-Post).");

        // ── Insert ONE publish_jobs row UP-FRONT (before any slow work) ──
        // If the function dies during AI metadata generation or any later
        // step, this row keeps idempotency working and gives the UI / "Post
        // Now" something to reset. Mirrors the Projects pipeline order.
        const { data: jobRow, error: jobInsertErr } = await sb.from("publish_jobs")
          .insert({ run_id: runId, status: "submitted" as any, platform_results: {} })
          .select("id")
          .single();
        if (jobInsertErr || !jobRow) {
          throw new Error(`Could not create publish_jobs row: ${jobInsertErr?.message || "unknown"}`);
        }
        const publishJobId = jobRow.id;
        await log("info", `publish_jobs row created up-front: ${publishJobId}`);

        // Generate metadata for the story
        const storyTitle = meta.story?.title || "Story Video";
        const baseSummary = meta.story?.hook || meta.story?.summary || "";
        const eventDate = (meta.story?.event_date || "").toString().trim();
        const eventLocation = (meta.story?.event_location || "").toString().trim();
        // Prepend date + place when available, e.g. "March 2023 — Austin, Texas\n\n<summary>"
        let prefix = "";
        if (eventDate && eventLocation) prefix = `${eventDate} — ${eventLocation}`;
        else if (eventDate) prefix = eventDate;
        else if (eventLocation) prefix = eventLocation;
        const fallbackDescription = prefix ? `${prefix}\n\n${baseSummary}` : baseSummary;

        // ── AI per-platform metadata generation (mirrors finalize-video pattern) ──
        const story = meta.story || {};
        const beats = Array.isArray(meta.timed_beats) ? meta.timed_beats : (Array.isArray(meta.script?.beats) ? meta.script.beats : []);
        const beatsSummary = beats.slice(0, 12).map((b: any, i: number) => `${i + 1}. ${b.text || b.narration || ""}`).filter((s: string) => s.trim().length > 3).join("\n");

        const platformGuidelines: Record<string, string> = {
          instagram: `INSTAGRAM REELS metadata rules:
- "title" IS the first line of the caption (the hook). Max 125 chars. Curiosity-driven, story-led.
- Good hook structures for stories: emotional reveal ("She had no idea who was at the door…"), stakes ("They had 24 hours to save him"), mystery ("Nobody believed her until…").
- "description" is the caption body. 2-3 short paragraphs. Tease the emotional payoff. End with a CTA like "Follow for more true stories" or "Save this".
- Hashtags: 3-8. Mix niche (storytelling, truestory, emotional) + broader. NO #fyp #viral.`,
          tiktok: `TIKTOK metadata rules:
- "title" IS the first line of the caption — must hook in 3 seconds. Use story-curiosity formula.
- "description" stays under 150 chars total. Conversational, like you're telling a friend.
- Hashtags: 3-5. Mix: 1 niche (storytime/truestory), 1 broad (fyp ok IF natural), 1 emotional (heartwarming, shocking). Avoid spammy stacks.`,
          youtube: `YOUTUBE SHORTS metadata rules:
- "title" is a real title field. 40-70 chars. Curiosity-driven, searchable. Avoid clickbait caps.
- Good formats: "The True Story of…", "What She Did Next Shocked Everyone", "He Didn't Know Until It Was Too Late".
- "description" 1-3 sentences. Restate the hook + tease the resolution. Include the main keyword.
- Hashtags: 3-5. Always include #shorts. Add #truestory when relevant.`,
          facebook: `FACEBOOK REELS metadata rules:
- "title" is the first line. Clear, descriptive, emotional. Facebook audiences skew older — be direct, not cryptic.
- Example: "A small-town nurse made one phone call that changed everything."
- "description" 1-2 sentences explaining the story without spoiling the ending.
- Hashtags: 3-5.`,
        };

        const UNIVERSAL_RULES = `
CRITICAL RULES FOR ALL PLATFORMS:
- NEVER hint that the video is AI-generated. No mentions of AI, prompts, models, or generated content.
- Write as a human storyteller sharing a true story.
- The description MUST begin with the date+place prefix (provided below) on its own line, followed by a blank line, then the actual caption body. This is mandatory for every platform.
- First line of caption = hook. Shorter is better.
- Each platform's metadata must feel native — NOT copy-pasted across platforms.
- Do NOT spoil the ending; tease the emotional payoff.`;

        const platformsToGenerate = enabledPlatforms.length > 0 ? enabledPlatforms : ["instagram", "tiktok", "youtube", "facebook"];
        const platformProperties: Record<string, any> = {};
        for (const p of platformsToGenerate) {
          platformProperties[p] = {
            type: "object",
            properties: {
              title: { type: "string", description: `Platform-optimized title/hook for ${p}` },
              description: { type: "string", description: `Platform-optimized caption body for ${p}. MUST start with the provided date+place prefix on its own line if a prefix is provided.` },
              hashtags: { type: "array", items: { type: "string" }, description: `Hashtags without # prefix for ${p}` },
            },
            required: ["title", "description", "hashtags"],
          };
        }

        let platformMetadata: Record<string, { title: string; description: string; hashtags: string[] }> =
          (meta.platform_metadata && typeof meta.platform_metadata === "object") ? meta.platform_metadata : {};
        // When the user clicks "Post Now" with force_metadata, regenerate fresh metadata
        // even on a publish-only retry. Otherwise honor skip flags as before.
        if (forceMetadata || (!skipMetadataGeneration && !publishOnly)) {
        try {
          const perPlatformGuidelines = platformsToGenerate.map(p => platformGuidelines[p] || `${p.toUpperCase()}: Generate appropriate title, description, and hashtags.`).join("\n\n");
          const prefixInstruction = prefix
            ? `MANDATORY DESCRIPTION PREFIX (must appear as the first line of every platform's description, followed by a blank line):\n"${prefix}"`
            : `No date/place prefix is available — write descriptions normally.`;

          const messages = [
            { role: "system", content: `You are an elite social media strategist specializing in true-story short-form video. You write platform-native metadata as a human creator. Captions feel authentic, emotional, and tuned to each platform.${UNIVERSAL_RULES}` },
            { role: "user", content: `Generate platform-specific metadata for this true-story video.

STORY TITLE: ${storyTitle}
EVENT DATE: ${eventDate || "(unknown)"}
EVENT LOCATION: ${eventLocation || "(unknown)"}
HOOK: ${story.hook || ""}
REWARD MOMENT: ${story.reward_moment || ""}
SUMMARY: ${story.summary || baseSummary}

SCRIPT BEATS:
${beatsSummary || "(no beats available)"}

${prefixInstruction}

=== PLATFORM-SPECIFIC GUIDELINES ===
${perPlatformGuidelines}

Generate metadata for these platforms: ${platformsToGenerate.join(", ")}` },
          ];

          // Hard 30s ceiling so a slow/stuck AI call can never block the
          // actual Upload-Post submission. If the timeout fires we fall back
          // to the universal title/description and proceed to publish.
          const META_TIMEOUT_MS = 75_000;
          const result: any = await Promise.race([
            callStructured({
              messages: messages as any,
              model: MODELS.TEXT_CHEAP,
              tools: [{
                type: "function",
                function: {
                  name: "generate_platform_metadata",
                  description: "Generate per-platform video post metadata for a true-story short video",
                  parameters: { type: "object", properties: platformProperties, required: platformsToGenerate, additionalProperties: false },
                },
              }],
              tool_choice: { type: "function", function: { name: "generate_platform_metadata" } } as any,
              endpoint: "story_platform_metadata",
              noRetryOn503: true,
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`AI metadata generation exceeded ${META_TIMEOUT_MS}ms`)), META_TIMEOUT_MS),
            ),
          ]);
          if (result && typeof result === "object") {
            platformMetadata = result;
            await log("info", "Per-platform story metadata generated", { platforms: Object.keys(platformMetadata) });
          }
        } catch (metaErr) {
          await log("warn", `Per-platform metadata generation failed: ${(metaErr as Error).message}. Using fallback title/description.`);
        }
        } else {
          await log("info", Object.keys(platformMetadata).length > 0
            ? "Skipping AI metadata generation for publish retry; reusing stored platform metadata."
            : "Skipping AI metadata generation for publish retry; using fallback platform text.");
        }

        // Persist generated metadata onto the run for visibility
        try {
          const { data: curMeta } = await sb.from("story_runs").select("generated_metadata").eq("id", runId).single();
          meta = { ...((curMeta?.generated_metadata as any) || meta), ...(Object.keys(platformMetadata).length > 0 ? { platform_metadata: platformMetadata } : {}), metadata_prefix: prefix };
          await sb.from("story_runs").update({ generated_metadata: meta }).eq("id", runId);
        } catch {}

        const buildPlatformPayload = (platform: string): { title: string; description: string } => {
          const pm = platformMetadata[platform];
          if (pm && pm.title && pm.description) {
            const hashtags = (pm.hashtags || []).map((h: string) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
            // Safety net: ensure prefix is at the top of the description if available and missing
            let desc = pm.description;
            if (prefix && !desc.includes(prefix)) desc = `${prefix}\n\n${desc}`;
            return { title: pm.title, description: desc + (hashtags ? `\n\n${hashtags}` : "") };
          }
          return { title: storyTitle, description: fallbackDescription };
        };

        // Group enabled platforms by identical title+description so we send
        // one Upload-Post request per group (mirrors finalize-video).
        const scheduledDateIsFuture = isFutureScheduledDate(meta.publish_scheduled_date, meta.publish_timezone);
        const shouldUseScheduledDate = scheduledDateIsFuture && !publishOnly && !postNow;
        if (shouldUseScheduledDate) {
          await log("info", `Scheduling post for ${meta.publish_scheduled_date} (${meta.publish_timezone || "UTC"})`);
        } else if (meta.publish_scheduled_date && !scheduledDateIsFuture) {
          await log("warn", `Scheduled time ${meta.publish_scheduled_date} is in the past — posting immediately.`);
        }

        const publishGroups = new Map<string, { title: string; description: string; platforms: string[] }>();
        for (const platform of enabledPlatforms) {
          const payload = buildPlatformPayload(platform);
          const key = `${payload.title}\n---\n${payload.description}`;
          const group = publishGroups.get(key);
          if (group) group.platforms.push(platform);
          else publishGroups.set(key, { ...payload, platforms: [platform] });
        }

        const submissionResults: any[] = [];
        let anySuccess = false;
        let lastRequestId: string | null = null;

        for (const group of publishGroups.values()) {
          const formData = new FormData();
          // Async URL upload — Upload-Post fetches the video itself.
          formData.append("video", videoUrl);
          formData.append("async_upload", "true");
          formData.append("title", group.title);
          formData.append("description", group.description);
          if (uploadpostUsername) formData.append("user", uploadpostUsername);
          if (shouldUseScheduledDate) {
            formData.append("scheduled_date", meta.publish_scheduled_date);
            if (meta.publish_timezone) formData.append("timezone", meta.publish_timezone);
          }
          for (const platform of group.platforms) formData.append("platform[]", platform);
          for (const platform of group.platforms) {
            const defaults = projPublishDefaults[platform] || {};
            for (const [key, value] of Object.entries(defaults)) {
              if (value !== undefined && value !== null && value !== "") {
                formData.append(key, String(value));
              }
            }
          }

          let uploadResult: any = {};
          let uploadOk = false;
          try {
            const uploadResp = await fetch("https://api.upload-post.com/api/upload", {
              method: "POST",
              headers: { Authorization: `Apikey ${uploadpostApiKey}` },
              body: formData,
            });
            uploadResult = await uploadResp.json().catch(() => ({}));
            uploadOk = uploadResp.ok && !!uploadResult.request_id;
            await log("info", `Upload-Post response [${group.platforms.join(",")}]`, uploadResult);
          } catch (e) {
            uploadResult = { error: (e as Error).message };
            await log("error", `Upload-Post threw [${group.platforms.join(",")}]: ${(e as Error).message}`);
          }

          submissionResults.push({ platforms: group.platforms, ok: uploadOk, response: uploadResult });
          if (uploadOk) {
            anySuccess = true;
            lastRequestId = uploadResult.request_id || lastRequestId;
            await log("info", `Upload-Post submitted [${group.platforms.join(",")}]: ${uploadResult.request_id}`);
          } else {
            await log("error", `Upload-Post failed [${group.platforms.join(",")}]: ${JSON.stringify(uploadResult).substring(0, 300)}`);
          }
        }

        // Update the single publish_jobs row with the outcome.
        await sb.from("publish_jobs").update({
          status: (anySuccess ? "polling" : "failed") as any,
          uploadpost_request_id: lastRequestId,
          platform_results: { submissions: submissionResults },
        }).eq("id", publishJobId);

        if (!anySuccess) {
          publishStatus = "failed";
          await log("error", "All Upload-Post submissions failed.");
        }
      } catch (pubErr) {
        publishStatus = "failed";
        await log("error", `Publishing failed: ${(pubErr as Error).message}`);
      }
      } // end idempotency-guard else
    }

    await updateRun({
      status: publishStatus as any,
      current_stage: publishStatus === "failed" ? "publishing" : "published",
      progress_pct: publishStatus === "failed" ? 94 : 100,
      ...(publishStatus === "failed" ? { error_message: "Upload-Post submission failed; retry with publish_only=true" } : {}),
      finished_at: new Date().toISOString(),
      generated_metadata: {
        ...meta,
        final_video: { path: finalPath, signed_url: finalSignedUrl?.signedUrl ?? null },
        has_end_card: finalIncludesEndCard,
        has_subtitles: captionedPath !== storyPath,
        publish_heartbeat_at: null,
        publish_current_platform: null,
        publish_retry_required: publishStatus === "failed",
        completed_at: new Date().toISOString(),
      },
    });

    await log("info", "Story pipeline completed successfully! 🎉");

    // Send notification
    try {
      const notifyUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-notification`;
      await fetch(notifyUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("INTERNAL_FN_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ run_id: runId, type: "completed" }),
      });
    } catch {}

    return json({ status: "published", run_id: runId });
  } catch (err) {
    await failRun(`Finalize failed: ${(err as Error).message}`);
    return json({ error: (err as Error).message }, 500);
  }
});
