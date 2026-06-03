// test-pov-hook — isolated POV-hook generator + compositor.
//
// Lets Enrique fire JUST the POV-hook portion of a channel's pipeline (no
// planner, no scene gen, no full-pipeline run, no publish), so the hook
// beat can be iterated on without burning a paid full-pipeline render.
//
// Two actions, both POST {action, ...} to /functions/v1/test-pov-hook:
//
// 1. action="submit" — body: { project_id, variant_index? }
//      Generates K0_hook + K1_hook via Gemini, submits the Vidu pair task
//      (off_peak=false for faster turnaround), writes a hook_test_runs row.
//      Returns: { hook_test_run_id, k0_url, k1_url, vidu_task_id, ... }
//
// 2. action="compose" — body: { hook_test_run_id }
//      Polls the Vidu task. If still running, returns vidu_pending.
//      If complete, downloads the clip, builds a tiny Rendi command to
//      composite the snap caption (drawbox + drawtext + emoji overlays,
//      via _shared/snapOverlay.ts), uploads the final artifact to R2,
//      updates the row, returns: { final_video_url, hook_clip_url, ... }.
//
// Hook config is read from the project's resolved prompt_config.pov_hook
// block (same source the production pipeline uses). All paid-API calls
// happen server-side; Enrique just polls this endpoint until composed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { r2Upload, mediaPublicUrl } from "../_shared/r2.ts";
import { buildResolvedPromptConfig } from "../_shared/promptConfig.ts";
import { callAI } from "../_shared/openai.ts";
import { buildSnapCaptionFilter, KNOWN_EMOJIS } from "../_shared/snapOverlay.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const RESOLUTION_HEIGHT: Record<string, number> = { "540p": 540, "720p": 720, "1080p": 1080 };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const action = body.action || "submit";

  if (action === "submit") return await handleSubmit(supabase, body);
  if (action === "compose") return await handleCompose(supabase, body);
  return json({ error: `unknown action '${action}' — use 'submit' or 'compose'` }, 400);
});

// ────────────────────────────────────────────────────────────────────
// action=submit
// ────────────────────────────────────────────────────────────────────

async function handleSubmit(supabase: any, body: any): Promise<Response> {
  const project_id = body.project_id;
  if (!project_id) return json({ error: "project_id required" }, 400);

  const { data: project, error: projErr } = await supabase
    .from("projects").select("*").eq("id", project_id).single();
  if (projErr || !project) return json({ error: "project not found" }, 404);

  const resolved = buildResolvedPromptConfig(project) as any;
  const povHookCfg = resolved.pov_hook;
  const variants: any[] = Array.isArray(povHookCfg?.variants) ? povHookCfg.variants : [];
  if (!povHookCfg?.enabled || variants.length === 0) {
    return json({ error: "project has no enabled pov_hook variants" }, 400);
  }

  // Variant pick (explicit or crypto-uniform).
  let variantIdx: number;
  if (typeof body.variant_index === "number" && Number.isInteger(body.variant_index)) {
    variantIdx = body.variant_index;
    if (variantIdx < 0 || variantIdx >= variants.length) {
      return json({ error: `variant_index out of range (0..${variants.length - 1})` }, 400);
    }
  } else {
    const rand = new Uint32Array(1);
    crypto.getRandomValues(rand);
    variantIdx = rand[0] % variants.length;
  }
  const variant = variants[variantIdx];

  // Create the tracking row up front so failures still leave an audit trail.
  const { data: testRun, error: insErr } = await supabase
    .from("hook_test_runs")
    .insert({
      project_id,
      variant_index: variantIdx,
      variant_name: variant?.name || `variant_${variantIdx}`,
      snap_text: variant?.snap_overlay?.text || "",
      status: "generating_keyframes",
    })
    .select().single();
  if (insErr || !testRun) {
    return json({ error: `hook_test_runs insert failed: ${insErr?.message}` }, 500);
  }
  const testRunId: string = testRun.id;

  try {
    // K0_hook
    if (!variant?.keyframe_prompt_start) throw new Error("variant.keyframe_prompt_start missing");
    const k0 = await genHookKeyframe(
      supabase,
      variant.keyframe_prompt_start,
      null,
      `${project_id}/test-pov-hook/${testRunId}/k0`,
      "pov_hook_k0_test",
      testRunId,
    );

    // K1_hook chained from K0_hook
    if (!variant?.keyframe_prompt_end) throw new Error("variant.keyframe_prompt_end missing");
    const k1 = await genHookKeyframe(
      supabase,
      variant.keyframe_prompt_end,
      k0.url,
      `${project_id}/test-pov-hook/${testRunId}/k1`,
      "pov_hook_k1_test",
      testRunId,
    );

    // Vidu pair submit — off_peak=false for faster test turnaround.
    const VIDU_API_KEY = Deno.env.get("VIDU_API_KEY");
    if (!VIDU_API_KEY) throw new Error("VIDU_API_KEY not configured");
    const viduResolution = (project as any).pika_resolution || "720p";
    const enableAudio = (project as any).kling_sound || false;
    const hookDuration = Math.max(2, Math.min(8, Math.round(Number(povHookCfg.duration_sec) || 4)));
    const viduBody: Record<string, unknown> = {
      model: "viduq3-turbo",
      images: [k0.url, k1.url],
      prompt: variant?.motion_prompt
        || "amateur phone selfie-camera POV, slow zoom in, slight handheld wobble",
      duration: hookDuration,
      resolution: viduResolution,
      audio: enableAudio,
      movement_amplitude: "auto",
      off_peak: false,
    };
    const viduResp = await fetch("https://api.vidu.com/ent/v2/start-end2video", {
      method: "POST",
      headers: { "Authorization": `Token ${VIDU_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(viduBody),
    });
    if (!viduResp.ok) {
      const errText = await viduResp.text();
      throw new Error(`Vidu submit failed (${viduResp.status}): ${errText.substring(0, 300)}`);
    }
    const viduResult = await viduResp.json();
    const viduTaskId = viduResult.task_id;
    if (!viduTaskId) throw new Error(`Vidu returned no task_id: ${JSON.stringify(viduResult).substring(0, 200)}`);

    await supabase.from("hook_test_runs").update({
      vidu_task_id: viduTaskId,
      k0_asset_id: k0.asset_id,
      k1_asset_id: k1.asset_id,
      status: "vidu_submitted",
      updated_at: new Date().toISOString(),
    }).eq("id", testRunId);

    return json({
      status: "vidu_submitted",
      hook_test_run_id: testRunId,
      project_id,
      variant_index: variantIdx,
      variant_name: variant?.name || `variant_${variantIdx}`,
      snap_text: variant?.snap_overlay?.text || "",
      hook_duration_sec: hookDuration,
      k0_url: k0.url,
      k1_url: k1.url,
      vidu_task_id: viduTaskId,
      vidu_credits: viduResult.credits ?? null,
      next: `POST /functions/v1/test-pov-hook with { action: 'compose', hook_test_run_id: '${testRunId}' } to poll Vidu + render the final clip.`,
    });
  } catch (err) {
    const errMsg = (err as Error).message;
    await supabase.from("hook_test_runs").update({
      status: "failed",
      error_message: errMsg,
      updated_at: new Date().toISOString(),
    }).eq("id", testRunId);
    return json({ error: errMsg, hook_test_run_id: testRunId }, 500);
  }
}

// ────────────────────────────────────────────────────────────────────
// action=compose
// ────────────────────────────────────────────────────────────────────

async function handleCompose(supabase: any, body: any): Promise<Response> {
  const hook_test_run_id = body.hook_test_run_id;
  if (!hook_test_run_id) return json({ error: "hook_test_run_id required" }, 400);

  const { data: testRun } = await supabase
    .from("hook_test_runs").select("*").eq("id", hook_test_run_id).single();
  if (!testRun) return json({ error: "hook_test_run not found" }, 404);

  // Already composed — return cached result.
  if (testRun.status === "composed" && testRun.final_video_url) {
    return json({
      status: "composed",
      hook_test_run_id,
      final_video_url: testRun.final_video_url,
      snap_text: testRun.snap_text,
      variant_index: testRun.variant_index,
      variant_name: testRun.variant_name,
      cached: true,
    });
  }
  if (testRun.status === "failed") {
    return json({ status: "failed", error: testRun.error_message, hook_test_run_id });
  }
  if (!testRun.vidu_task_id) {
    return json({ error: "no vidu_task_id on this row — was submit successful?" }, 400);
  }

  // Poll Vidu task status.
  const VIDU_API_KEY = Deno.env.get("VIDU_API_KEY");
  if (!VIDU_API_KEY) return json({ error: "VIDU_API_KEY not configured" }, 500);
  let statusResp = await fetch(
    `https://api.vidu.com/ent/v2/tasks/${testRun.vidu_task_id}/creations`,
    { headers: { "Authorization": `Token ${VIDU_API_KEY}` } },
  );
  if (statusResp.status === 404) {
    statusResp = await fetch(
      `https://api.vidu.com/ent/v2/tasks/${testRun.vidu_task_id}`,
      { headers: { "Authorization": `Token ${VIDU_API_KEY}` } },
    );
  }
  if (!statusResp.ok) {
    return json({
      status: "vidu_poll_failed",
      http: statusResp.status,
      hook_test_run_id,
    });
  }
  const statusData = await statusResp.json();
  const taskState = statusData.state || statusData.status;

  if (taskState === "failed" || taskState === "cancelled") {
    await supabase.from("hook_test_runs").update({
      status: "failed",
      error_message: `Vidu task ${taskState}: ${JSON.stringify(statusData).substring(0, 200)}`,
      updated_at: new Date().toISOString(),
    }).eq("id", hook_test_run_id);
    return json({ status: "vidu_failed", vidu_state: taskState, hook_test_run_id });
  }
  if (taskState !== "success") {
    return json({
      status: "vidu_pending",
      vidu_state: taskState || "unknown",
      hook_test_run_id,
      retry_hint: "POST again in ~15s.",
    });
  }

  // Vidu success — fetch the clip URL and download it (if not already).
  let hookClipUrl: string;
  let hookClipAssetId = testRun.hook_clip_asset_id as string | null;

  if (!hookClipAssetId) {
    const videoUrl = statusData.creations?.[0]?.url || statusData.video_url || statusData.url;
    if (!videoUrl) return json({ error: "Vidu success but no video URL", statusData }, 500);

    const videoResp = await fetch(videoUrl);
    if (!videoResp.ok) return json({ error: `Vidu clip download failed: ${videoResp.status}` }, 500);
    const bytes = new Uint8Array(await videoResp.arrayBuffer());
    const hookPath = `${testRun.project_id}/test-pov-hook/${hook_test_run_id}/hook.mp4`;
    let publicUrl = "";
    try {
      ({ publicUrl } = await r2Upload(hookPath, bytes, "video/mp4"));
    } catch (e) {
      return json({ error: `R2 upload failed: ${(e as Error).message}` }, 500);
    }
    const { data: clipAsset } = await supabase.from("assets").insert({
      supabase_path: hookPath,
      type: "clip" as any,
      metadata: {
        is_pov_hook: true,
        test_pov_hook_run: hook_test_run_id,
        status: "completed",
        generator: "vidu_direct",
        vidu_task_id: testRun.vidu_task_id,
      },
    }).select().single();
    hookClipAssetId = clipAsset?.id ?? null;
    hookClipUrl = publicUrl;
    await supabase.from("hook_test_runs").update({
      hook_clip_asset_id: hookClipAssetId,
      status: "clip_ready",
      updated_at: new Date().toISOString(),
    }).eq("id", hook_test_run_id);
  } else {
    const { data: ca } = await supabase
      .from("assets").select("supabase_path").eq("id", hookClipAssetId).single();
    if (!ca?.supabase_path) return json({ error: "hook clip asset row missing supabase_path" }, 500);
    hookClipUrl = mediaPublicUrl(ca.supabase_path);
  }

  // ── Compose: hook clip + snap caption via Rendi (ffmpeg primitives) ──
  const { data: project } = await supabase
    .from("projects").select("*").eq("id", testRun.project_id).single();
  if (!project) return json({ error: "project disappeared mid-compose" }, 500);
  const resolved = buildResolvedPromptConfig(project) as any;
  const povHookCfg = resolved.pov_hook;
  const variant = povHookCfg?.variants?.[testRun.variant_index];
  if (!variant) return json({ error: "variant gone from config" }, 500);

  const hookDuration = Math.max(2, Math.min(8, Math.round(Number(povHookCfg.duration_sec) || 4)));
  const snapText: string = testRun.snap_text || variant?.snap_overlay?.text || "";
  const snapFontSize = Math.round(Number(variant?.snap_overlay?.font_size_px) || 48);
  const snapPositionPct = Number(variant?.snap_overlay?.position_y_pct);
  const snapBandAlpha = typeof variant?.snap_overlay?.band_alpha === "number"
    ? variant.snap_overlay.band_alpha : 0.55;

  const shortSide = RESOLUTION_HEIGHT[(project as any).pika_resolution || "1080p"] || 1080;
  const frameW = shortSide;
  const frameH = Math.round(shortSide * 16 / 9);

  // Build Rendi inputs.
  const inputFiles: Record<string, string> = {
    in_clip: hookClipUrl,
    in_font_snap: mediaPublicUrl("fonts/Inter-Regular.ttf"),
  };
  const seen = new Set<string>();
  const snapEmojiCodepoints: string[] = [];
  for (const ch of snapText) {
    const cp = (KNOWN_EMOJIS as Record<string, string>)[ch];
    if (cp && !seen.has(cp)) {
      seen.add(cp);
      snapEmojiCodepoints.push(cp);
      inputFiles[`in_emoji_${cp}`] = mediaPublicUrl(`overlays/apple-emoji/${cp}.png`);
    }
  }
  const mediaInputKeys = Object.keys(inputFiles);
  const getInputIndex = (k: string): number => mediaInputKeys.indexOf(k);

  // Filter graph: normalize the clip → snap caption → output.
  const filterParts: string[] = [
    `[${getInputIndex("in_clip")}:v]scale=${frameW}:${frameH}:force_original_aspect_ratio=decrease,pad=${frameW}:${frameH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v_norm]`,
  ];
  let currentLabel = "v_norm";

  if (snapText.trim()) {
    try {
      const snapLayout = await buildSnapCaptionFilter({
        text: snapText,
        fontSize: snapFontSize,
        frameW,
        frameH,
        positionPct: Number.isFinite(snapPositionPct) ? snapPositionPct : 30,
        bandAlpha: snapBandAlpha,
        // For the test fn the entire clip IS the hook window, so enable spans
        // the full hook duration. between(t,0,hookDur) keeps the snap on for
        // the whole clip (and still gates against any tail beyond hookDur).
        enableExpr: `between(t\\,0\\,${hookDuration.toFixed(1)})`,
        inputVideoLabel: currentLabel,
        fontInputIndex: getInputIndex("in_font_snap"),
        emojiInputIndex: (cp) => getInputIndex(`in_emoji_${cp}`),
        startIdx: 0,
      });
      for (const p of snapLayout.filterParts) filterParts.push(p);
      currentLabel = snapLayout.outputVideoLabel;
    } catch (snapErr) {
      return json({ error: `snap layout build failed: ${(snapErr as Error).message}` }, 500);
    }
  }

  // Font files are referenced inside drawtext via `fontfile={{key}}` — they
  // must NOT be added as `-i` streams or ffmpeg tries to demux the TTF and
  // dies with "Invalid data found when processing input". Rendi still
  // downloads the file (since the key is in input_files) and substitutes
  // the placeholder anywhere it appears in the command, including the
  // fontfile= reference.
  const streamInputKeys = mediaInputKeys.filter((k) => !k.startsWith("in_font"));
  const inputArgs = streamInputKeys.map((k) => `-i {{${k}}}`).join(" ");
  // The indices we computed via getInputIndex were over mediaInputKeys
  // (which INCLUDED the font). After dropping fonts from -i, each stream
  // input's ffmpeg index shifts. Re-issue the filter chain using the new
  // stream-only index map.
  const streamInputIdx: Record<string, number> = {};
  streamInputKeys.forEach((k, i) => { streamInputIdx[k] = i; });
  const fixedFilterParts = filterParts.map((p) => {
    return p.replace(/\[(\d+):v\]/g, (_, oldIdxStr) => {
      const oldIdx = parseInt(oldIdxStr, 10);
      const key = mediaInputKeys[oldIdx];
      const newIdx = streamInputIdx[key];
      if (newIdx == null) {
        throw new Error(`filter referenced non-stream input ${key} as [${oldIdx}:v]`);
      }
      return `[${newIdx}:v]`;
    });
  });
  const ffmpegCmd =
    `${inputArgs} -filter_complex "${fixedFilterParts.join(";")}" -map "[${currentLabel}]" ` +
    `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -movflags +faststart {{out_1}}`;

  // Submit + poll Rendi.
  const RENDI_API_KEY = Deno.env.get("RENDI_API_KEY");
  if (!RENDI_API_KEY) return json({ error: "RENDI_API_KEY not configured" }, 500);

  const rendiResp = await fetch("https://api.rendi.dev/v1/run-ffmpeg-command", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": RENDI_API_KEY },
    body: JSON.stringify({
      ffmpeg_command: ffmpegCmd,
      input_files: inputFiles,
      output_files: { out_1: "hook_with_snap.mp4" },
      max_command_run_seconds: 60,
      vcpu_count: 4,
    }),
  });
  if (!rendiResp.ok) {
    const errText = await rendiResp.text();
    return json({
      error: `Rendi submit failed (${rendiResp.status}): ${errText.substring(0, 300)}`,
      ffmpeg_command: ffmpegCmd,
    }, 500);
  }
  const { command_id } = await rendiResp.json();

  let outputUrl: string | null = null;
  let rendiFailMsg: string | null = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollResp = await fetch(`https://api.rendi.dev/v1/commands/${command_id}`, {
      headers: { "X-API-KEY": RENDI_API_KEY },
    });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    if (pollData.status === "SUCCESS") {
      outputUrl = pollData.output_files?.out_1?.storage_url || null;
      break;
    }
    if (pollData.status === "FAILED" || pollData.status === "ERROR") {
      rendiFailMsg = pollData.error_message || JSON.stringify(pollData).substring(0, 300);
      break;
    }
  }
  if (rendiFailMsg) {
    return json({
      error: `Rendi command failed: ${rendiFailMsg}`,
      command_id,
      ffmpeg_command: ffmpegCmd,
    }, 500);
  }
  if (!outputUrl) {
    return json({ error: "Rendi timed out after ~2 min" }, 500);
  }

  // Download Rendi output and store in R2 for a stable public URL.
  const dlResp = await fetch(outputUrl);
  if (!dlResp.ok) return json({ error: `Rendi output download failed: ${dlResp.status}` }, 500);
  const finalBytes = new Uint8Array(await dlResp.arrayBuffer());
  const finalPath = `${testRun.project_id}/test-pov-hook/${hook_test_run_id}/final.mp4`;
  let finalUrl = "";
  try {
    ({ publicUrl: finalUrl } = await r2Upload(finalPath, finalBytes, "video/mp4"));
  } catch (e) {
    return json({ error: `R2 final upload failed: ${(e as Error).message}` }, 500);
  }

  await supabase.from("hook_test_runs").update({
    final_video_url: finalUrl,
    status: "composed",
    updated_at: new Date().toISOString(),
  }).eq("id", hook_test_run_id);

  // Pull k0/k1 URLs for the response so Enrique can preview every stage.
  const k0Url = await assetPublicUrl(supabase, testRun.k0_asset_id);
  const k1Url = await assetPublicUrl(supabase, testRun.k1_asset_id);

  return json({
    status: "composed",
    hook_test_run_id,
    variant_index: testRun.variant_index,
    variant_name: testRun.variant_name,
    snap_text: snapText,
    k0_url: k0Url,
    k1_url: k1Url,
    hook_clip_url: hookClipUrl,
    final_video_url: finalUrl,
    final_size_bytes: finalBytes.length,
  });
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

async function assetPublicUrl(supabase: any, assetId: string | null): Promise<string | null> {
  if (!assetId) return null;
  const { data } = await supabase
    .from("assets").select("supabase_path").eq("id", assetId).single();
  return data?.supabase_path ? mediaPublicUrl(data.supabase_path) : null;
}

/**
 * Generate one Gemini keyframe + upload to R2 + insert an assets row.
 * Mirrors run-pipeline's extractAndUploadImage but stripped of run/scene
 * coupling (this is a standalone test asset).
 */
async function genHookKeyframe(
  supabase: any,
  promptText: string,
  refImageUrl: string | null,
  storagePathBase: string,
  purpose: string,
  testRunId: string,
): Promise<{ asset_id: string | null; url: string }> {
  const userContent: any[] = [{ type: "text", text: promptText }];
  if (refImageUrl) userContent.push({ type: "image_url", image_url: { url: refImageUrl } });

  const result = await callAI(
    [{ role: "user", content: userContent }],
    undefined, undefined,
    "google/gemini-3.1-flash-image-preview",
    ["image", "text"],
  );
  const msg = (result as any).choices?.[0]?.message;
  // Prefer the `images[0].image_url.url` shape (what production sees ~always);
  // fall back to scanning content[] for image_url parts.
  let imgUrl: string | undefined =
    msg?.images?.[0]?.image_url?.url ?? undefined;
  if (!imgUrl && Array.isArray(msg?.content)) {
    for (const part of msg.content) {
      if (part?.type === "image_url" && part.image_url?.url) {
        imgUrl = part.image_url.url;
        break;
      }
    }
  }
  if (!imgUrl) throw new Error(`Gemini returned no image for ${purpose}`);

  const m = imgUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) throw new Error(`Gemini image was not a data URI for ${purpose}`);
  const mime = m[1];
  const raw = atob(m[2]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
  const fullPath = `${storagePathBase}.${ext}`;
  const { publicUrl } = await r2Upload(fullPath, bytes, mime);

  const { data: asset } = await supabase.from("assets").insert({
    supabase_path: fullPath,
    type: "keyframe" as any,
    metadata: {
      purpose,
      test_pov_hook_run: testRunId,
    },
    ...(typeof (result as any)._image_cost_usd === "number"
      ? { cost_usd: (result as any)._image_cost_usd }
      : {}),
  }).select().single();

  return { asset_id: asset?.id ?? null, url: publicUrl };
}
