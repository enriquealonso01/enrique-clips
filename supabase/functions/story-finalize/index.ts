import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DEFAULT_STORY_EMOJI_PATH = "defaults/emoji-heart-bandage.png";
const DEFAULT_STORY_FPS = 24;
const DEFAULT_STORY_AUDIO_RATE = 48000;
const DEFAULT_END_CARD_DURATION_SEC = 5;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const RENDI_API_KEY = Deno.env.get("RENDI_API_KEY");
  const SUBMAGIC_API_KEY = Deno.env.get("SUBMAGIC_API_KEY");

  let runId: string;
  let forceRetry = false;
  try {
    const body = await req.json();
    runId = body.run_id;
    forceRetry = !!body.force_retry;
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
    const meta = (run.generated_metadata as any) || {};
    const config = project?.config_json || {};
    const audioMix = config.audio_mix || {};
    const endingConfig = config.ending_audio || {};
    const endCardDurationSec = endingConfig.target_duration_sec ?? DEFAULT_END_CARD_DURATION_SEC;

    // ── Check for already-completed finalization (idempotency) ──
    const { data: existingFinal } = await sb.from("story_assets")
      .select("id").eq("run_id", runId).eq("type", "final_video").limit(1);
    if (!forceRetry && existingFinal && existingFinal.length > 0) {
      await log("info", "Final video already exists — skipping duplicate finalization");
      return json({ status: "already_finalized", run_id: runId });
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
      const { data: nUrl } = await sb.storage.from("project-assets").createSignedUrl(narrationAsset.supabase_path, 3600);
      narrationUrl = nUrl?.signedUrl || null;
    }

    // ── Get clip URLs ──
    const clipUrls: string[] = [];
    for (const clip of completedClips) {
      const { data: cUrl } = await sb.storage.from("project-assets").createSignedUrl(clip.supabase_path, 3600);
      if (cUrl?.signedUrl) clipUrls.push(cUrl.signedUrl);
    }

    if (clipUrls.length === 0) {
      await failRun("No clip URLs available");
      return json({ error: "No clip URLs" }, 500);
    }

    // ── Get background music URL if uploaded ──
    let bgMusicUrl: string | null = null;
    if (project?.background_music_path) {
      const { data: bgUrl } = await sb.storage.from("project-assets").createSignedUrl(project.background_music_path, 3600);
      bgMusicUrl = bgUrl?.signedUrl || null;
    }

    // ── Get real image for end card ──
    const realImageUrl = meta.real_image?.primary_url || meta.real_image?.fallback_url || null;

    // ── Get ending audio URL if uploaded ──
    let endingAudioUrl: string | null = null;
    if (project?.ending_audio_path) {
      const { data: eUrl } = await sb.storage.from("project-assets").createSignedUrl(project.ending_audio_path, 3600);
      endingAudioUrl = eUrl?.signedUrl || null;
    }

    // ══════════════════════════════════════════════════════
    // STAGE 12-13: Assemble story video with Rendi
    // ══════════════════════════════════════════════════════

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

    // Build filter_complex with dissolves between clips
    const timedBeats = meta.timed_beats || [];
    const dissolveDuration = 0.3;
    const clipDurations = completedClips.map((clip: any, i: number) => {
      const m = (clip.metadata as any) || {};
      const beatIndex = typeof clip.scene_index === "number" ? clip.scene_index : i;
      const targetDuration = Math.max(0.5, Number(m.target_duration) || Number(timedBeats[beatIndex]?.duration) || Number(timedBeats[i]?.duration) || 4);
      const requestedDuration = Math.max(targetDuration, Number(m.request_duration) || Math.ceil(targetDuration));
      return Math.min(requestedDuration, targetDuration + (i === 0 ? 0 : dissolveDuration));
    });
    const storyVideoDurationSec = Math.max(0.5, clipDurations.reduce((sum, duration) => sum + duration, 0) - (clipDurations.length - 1) * dissolveDuration);
    let filterParts: string[] = completedClips.map((_: any, i: number) =>
      `[${i}:v]scale=1080:1920,setsar=1,fps=${DEFAULT_STORY_FPS},trim=duration=${clipDurations[i].toFixed(3)},setpts=PTS-STARTPTS[vclip${i}]`
    );
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
    const storyBytes = new Uint8Array(await storyDl.arrayBuffer());
    const storyPath = `story-runs/${runId}/story_video.mp4`;
    await sb.storage.from("project-assets").upload(storyPath, storyBytes, { contentType: "video/mp4", upsert: true });

    await updateRun({ progress_pct: 80 });
    if (await checkCancelled()) return json({ status: "cancelled" });

    // ══════════════════════════════════════════════════════
    // STAGE 14: Subtitles via Submagic API
    // ══════════════════════════════════════════════════════

    await updateRun({ current_stage: "subtitles_processing", progress_pct: 82 });

    let captionedPath = storyPath; // fallback: use uncaptioned video

    if (SUBMAGIC_API_KEY) {
      await log("info", "Stage 14: Adding subtitles via Submagic API");

      try {
        // Get a public signed URL for the story video (Submagic needs a public URL)
        const { data: storySignedUrl } = await sb.storage.from("project-assets").createSignedUrl(storyPath, 3600);
        const videoUrl = storySignedUrl?.signedUrl;

        if (!videoUrl) throw new Error("Could not get signed URL for story video");

        // Step 1: Create project in Submagic
        const createResp = await fetch("https://api.submagic.co/v1/projects", {
          method: "POST",
          headers: {
            "x-api-key": SUBMAGIC_API_KEY,
            "Content-Type": "application/json",
          },
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
        const subProjectId = subProject.id;
        await log("info", `Submagic project created: ${subProjectId}`);

        // Step 2: Poll for transcription completion
        let transcribed = false;
        for (let poll = 0; poll < 60; poll++) {
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

        if (!transcribed) throw new Error("Submagic transcription timed out after 5 minutes");

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
        for (let poll = 0; poll < 120; poll++) {
          await sleep(5000);
          const getResp = await fetch(`https://api.submagic.co/v1/projects/${subProjectId}`, {
            headers: { "x-api-key": SUBMAGIC_API_KEY },
          });
          if (!getResp.ok) continue;
          const proj = await getResp.json();

          if (proj.status === "completed" && proj.downloadUrl) {
            captionedVideoUrl = proj.downloadUrl;
            await log("info", `Submagic captioned video ready: ${captionedVideoUrl.substring(0, 80)}...`);
            break;
          }
          if (proj.status === "failed") {
            throw new Error(`Submagic export failed: ${proj.failedReason || "unknown"}`);
          }
          if (poll % 12 === 0) {
            await log("debug", `Submagic export status: ${proj.status}`);
          }
        }

        if (!captionedVideoUrl) throw new Error("Submagic export timed out after 10 minutes");

        // Step 5: Download captioned video and store
        const captDl = await fetch(captionedVideoUrl);
        if (!captDl.ok) throw new Error(`Failed to download captioned video: ${captDl.status}`);
        const captBytes = new Uint8Array(await captDl.arrayBuffer());
        captionedPath = `story-runs/${runId}/captioned_story_video.mp4`;
        await sb.storage.from("project-assets").upload(captionedPath, captBytes, { contentType: "video/mp4", upsert: true });

        // Store as asset
        const { data: captSignedUrl } = await sb.storage.from("project-assets").createSignedUrl(captionedPath, 60 * 60 * 24 * 7);
        await sb.from("story_assets").insert({
          run_id: runId,
          type: "captioned_story_video",
          supabase_path: captionedPath,
          signed_url_last: captSignedUrl?.signedUrl || null,
          metadata: { submagic_project_id: subProjectId, size_bytes: captBytes.length },
        });

        await log("info", `Captioned video stored: ${(captBytes.length / 1024 / 1024).toFixed(1)}MB`);
      } catch (subErr) {
        await log("warn", `Submagic subtitles failed: ${(subErr as Error).message}. Continuing without subtitles.`);
        captionedPath = storyPath; // fallback
      }
    } else {
      await log("info", "Stage 14: Subtitles skipped (SUBMAGIC_API_KEY not configured)");
    }

    // ══════════════════════════════════════════════════════
    // STAGE 15-17: End Card
    // ══════════════════════════════════════════════════════

    if (await checkCancelled()) return json({ status: "cancelled" });
    await updateRun({ current_stage: "end_card_rendering", progress_pct: 85 });
    await log("info", "Stage 15-17: Building 5-second grayscale end card");

    let endCardUrl: string | null = null;
    let endCardUsedEmoji = false;

    if (realImageUrl) {
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
        const { data: eUrl } = await sb.storage.from("project-assets").createSignedUrl(emojiPath, 3600);
        emojiUrl = eUrl?.signedUrl || null;
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
      const endCardCmd = `-loop 1 -i {{in_real_img}}${endCardAudioInput}${emojiInput} -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=gray,setsar=1,zoompan=z='min(zoom+0.001\\,1.05)':d=${endCardFrameCount}:s=1080x1920:fps=${DEFAULT_STORY_FPS}[vend]${emojiOverlayFilter}${endCardAudioFilter}" -map "[${vOutLabel}]"${endCardAudioMap} -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -r ${DEFAULT_STORY_FPS} -c:a aac -ar ${DEFAULT_STORY_AUDIO_RATE} -ac 2 -b:a 128k -t ${endCardDurationSec} -movflags +faststart {{out_1}}`;

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

    if (await checkCancelled()) return json({ status: "cancelled" });
    await updateRun({ current_stage: "final_assembly", progress_pct: 90 });

    let finalVideoBytes: Uint8Array;
    let finalIncludesEndCard = false;

    if (endCardUrl) {
      await log("info", "Stage 18: Concatenating captioned story video + end card");

      // Get captioned story video URL
      const { data: captUrl } = await sb.storage.from("project-assets").createSignedUrl(captionedPath, 3600);

      // Re-encode both inputs to matching specs. Use xfade dissolve for smooth transition.
      // Use ultrafast to stay within Rendi's 60s account limit.
      // Both are scaled to 1080x1920 and normalized to the same audio sample rate.
      // xfade offset = bounded story-body duration - dissolve duration.
      const totalStoryDuration = storyVideoDurationSec;
      const dissolveSec = 0.5;
      const xfadeOffset = Math.max(0.5, totalStoryDuration - dissolveSec);
      const finalDurationSec = totalStoryDuration + endCardDurationSec - dissolveSec;
      const concatCmd = `-i {{in_story}} -i {{in_endcard}} -filter_complex "[0:v]scale=1080:1920,setsar=1,format=yuv420p[v0];[1:v]scale=1080:1920,setsar=1,format=yuv420p[v1];[v0][v1]xfade=transition=fade:duration=${dissolveSec}:offset=${xfadeOffset.toFixed(2)}[vf];[0:a]aresample=${DEFAULT_STORY_AUDIO_RATE},aformat=channel_layouts=stereo[a0];[1:a]aresample=${DEFAULT_STORY_AUDIO_RATE},aformat=channel_layouts=stereo[a1];[a0][a1]acrossfade=d=${dissolveSec}[af]" -map "[vf]" -map "[af]" -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p -r ${DEFAULT_STORY_FPS} -c:a aac -ar ${DEFAULT_STORY_AUDIO_RATE} -ac 2 -b:a 128k -t ${finalDurationSec.toFixed(3)} -movflags +faststart {{out_1}}`;

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
          await log("warn", "Final concat timed out — using captioned video without end card");
          const { data: fallbackUrl } = await sb.storage.from("project-assets").createSignedUrl(captionedPath, 3600);
          if (fallbackUrl?.signedUrl) {
            const fallbackDl = await fetch(fallbackUrl.signedUrl);
            finalVideoBytes = new Uint8Array(await fallbackDl.arrayBuffer());
          } else {
            finalVideoBytes = storyBytes;
          }
        }
      } else {
        await log("warn", "Final concat submit failed — using captioned video");
        const { data: fallbackUrl2 } = await sb.storage.from("project-assets").createSignedUrl(captionedPath, 3600);
        if (fallbackUrl2?.signedUrl) {
          const fallbackDl = await fetch(fallbackUrl2.signedUrl);
          finalVideoBytes = new Uint8Array(await fallbackDl.arrayBuffer());
        } else {
          finalVideoBytes = storyBytes;
        }
      }
    } else {
      await log("info", "No end card — using captioned video as final");
      // Re-read captioned video from storage
      const { data: captSignedUrl } = await sb.storage.from("project-assets").createSignedUrl(captionedPath, 3600);
      if (captSignedUrl?.signedUrl) {
        const dl = await fetch(captSignedUrl.signedUrl);
        finalVideoBytes = new Uint8Array(await dl.arrayBuffer());
      } else {
        finalVideoBytes = storyBytes;
      }
    }

    // Upload final video
    const ts = Date.now();
    const finalPath = `story-runs/${runId}/final_video_${ts}.mp4`;
    await sb.storage.from("project-assets").upload(finalPath, finalVideoBytes, { contentType: "video/mp4", upsert: true });
    const { data: finalSignedUrl } = await sb.storage.from("project-assets").createSignedUrl(finalPath, 60 * 60 * 24 * 7);

    await sb.from("story_assets").insert({
      run_id: runId,
      type: "final_video",
      supabase_path: finalPath,
      signed_url_last: finalSignedUrl?.signedUrl || null,
      metadata: { size_bytes: finalVideoBytes.length, has_end_card: !!endCardUrl, has_subtitles: captionedPath !== storyPath },
    });

    await log("info", `Final video stored: ${(finalVideoBytes.length / 1024 / 1024).toFixed(1)}MB`);

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
      try {
        const { data: urlData } = sb.storage.from("project-assets").getPublicUrl(finalPath);
        const videoUrl = urlData.publicUrl;

        // Generate metadata for the story
        const storyTitle = meta.story?.title || "Story Video";
        const storySummary = meta.story?.hook || meta.story?.summary || "";

        const formData = new FormData();
        formData.append("video", videoUrl);
        formData.append("title", storyTitle);
        formData.append("description", storySummary);
        formData.append("async_upload", "true");

        if (uploadpostUsername) formData.append("user", uploadpostUsername);

        // Add scheduled_date if set in run metadata
        if (meta.publish_scheduled_date) {
          formData.append("scheduled_date", meta.publish_scheduled_date);
          if (meta.publish_timezone) formData.append("timezone", meta.publish_timezone);
          await log("info", `Scheduling video post for ${meta.publish_scheduled_date} (${meta.publish_timezone || "UTC"})`);
        }

        for (const platform of enabledPlatforms) {
          formData.append("platform[]", platform);
          const defaults = projPublishDefaults[platform] || {};
          for (const [key, value] of Object.entries(defaults)) {
            if (value !== undefined && value !== null && value !== "") {
              formData.append(key, String(value));
            }
          }
        }

        const uploadResp = await fetch("https://api.upload-post.com/api/upload", {
          method: "POST",
          headers: { Authorization: `Apikey ${uploadpostApiKey}` },
          body: formData,
        });

        const uploadResult = await uploadResp.json();
        await log("info", `Upload-Post response`, uploadResult);

        if (uploadResp.ok && uploadResult.request_id) {
          await log("info", `Upload-Post submitted: ${uploadResult.request_id}`);
        } else {
          await log("error", `Upload-Post failed: ${JSON.stringify(uploadResult).substring(0, 300)}`);
        }
      } catch (pubErr) {
        await log("error", `Publishing failed: ${(pubErr as Error).message}`);
      }
    }

    await updateRun({
      status: publishStatus as any,
      current_stage: "published",
      progress_pct: 100,
      finished_at: new Date().toISOString(),
      generated_metadata: {
        ...meta,
        final_video: { path: finalPath, signed_url: finalSignedUrl?.signedUrl },
        has_end_card: finalIncludesEndCard,
        has_subtitles: captionedPath !== storyPath,
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
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
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
