import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { callStructured, callText, callImage, MODELS } from "../_shared/openai.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function getSupabase() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

type SB = ReturnType<typeof getSupabase>;

async function log(sb: SB, runId: string, level: "debug" | "info" | "warn" | "error", message: string, data?: any) {
  console.log(`[STORY][${level}] ${message}`);
  await sb.from("story_run_logs").insert({ run_id: runId, level, message, data });
}

async function updateRun(sb: SB, runId: string, fields: Record<string, unknown>) {
  const { error } = await sb.from("story_runs").update(fields).eq("id", runId);
  if (error) console.error("Failed to update story run:", error);
}

async function failRun(sb: SB, runId: string, message: string) {
  await log(sb, runId, "error", message);
  await updateRun(sb, runId, { status: "failed", error_message: message, finished_at: new Date().toISOString() });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const PIPELINE_START = Date.now();
const GUARD_MS = 80_000; // self-chain before 150s timeout

function shouldChain(): boolean {
  return Date.now() - PIPELINE_START > GUARD_MS;
}

async function selfChain(runId: string, stage: string) {
  const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/story-pipeline`;
  await fetch(fnUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ run_id: runId, resume_stage: stage }),
  });
}

async function chainFunction(fnName: string, body: any) {
  const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/${fnName}`;
  await fetch(fnUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function fetchImageAsBase64(url: string): Promise<string | undefined> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return undefined;
    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    const mime = resp.headers.get("content-type") || "image/jpeg";
    return `data:${mime};base64,${b64}`;
  } catch { return undefined; }
}

async function uploadAndStoreAsset(sb: SB, runId: string, path: string, data: Uint8Array, type: string, metadata: any = {}, sceneIndex?: number) {
  await sb.storage.from("project-assets").upload(path, data, { contentType: type.includes("image") ? "image/png" : "video/mp4", upsert: true });
  const { data: urlData } = await sb.storage.from("project-assets").createSignedUrl(path, 60 * 60 * 24 * 7);
  await sb.from("story_assets").insert({
    run_id: runId,
    type: type as any,
    supabase_path: path,
    signed_url_last: urlData?.signedUrl || null,
    metadata,
    scene_index: sceneIndex ?? null,
  });
  return urlData?.signedUrl;
}

// ══════════════════════════════════════════════════════════
// STAGE 1: Create Run
// ══════════════════════════════════════════════════════════

async function stage1(sb: SB, runId: string) {
  await updateRun(sb, runId, { status: "queued", current_stage: "create_run", progress_pct: 2, started_at: new Date().toISOString() });
  await log(sb, runId, "info", "Stage 1: Loading project config and story memory");

  const { data: run } = await sb.from("story_runs").select("*, story_projects(*)").eq("id", runId).single();
  if (!run) throw new Error("Run not found");

  const { data: memory } = await sb.from("story_memory")
    .select("story_title, story_fingerprint")
    .eq("project_id", run.project_id)
    .order("created_at", { ascending: false }).limit(20);

  const lastTitles = (memory || []).map((m: any) => m.story_title);
  const fingerprints = (memory || []).map((m: any) => m.story_fingerprint).filter(Boolean);
  await log(sb, runId, "info", `Loaded ${lastTitles.length} previous story titles`);

  return { run, project: run.story_projects, lastTitles, fingerprints, projectId: run.project_id };
}

// ══════════════════════════════════════════════════════════
// STAGE 2: Story Discovery
// ══════════════════════════════════════════════════════════

async function stage2(sb: SB, runId: string, lastTitles: string[]) {
  await updateRun(sb, runId, { status: "researching_story", current_stage: "researching_story", progress_pct: 8 });
  await log(sb, runId, "info", "Stage 2: Discovering wholesome story via AI");

  const titlesBlock = lastTitles.length > 0
    ? `\n\nPREVIOUSLY USED TITLES (DO NOT reuse):\n${lastTitles.map((t, i) => `${i + 1}. ${t}`).join("\n")}` : "";

  return await callStructured({
    messages: [
      { role: "system", content: "You are a viral short-form video researcher. Find real, wholesome, feel-good stories with strong hooks and emotional payoffs. Return ONLY valid JSON." },
      { role: "user", content: `Find a NEW wholesome real-world story for a 60-90 second vertical video. Requirements:
- Strong hook in first sentence
- Emotional reward/payoff moment
- Real characters, real events
- Visual potential${titlesBlock}

Return JSON: {"title":"...","source_url":"...","summary":"3-5 sentence detailed summary","hook":"opening hook line","reward_moment":"emotional payoff","characters":[{"name":"...","role":"...","appearance_notes":"..."}],"groups":[{"name":"...","description":"..."}],"locations":[{"name":"...","description":"..."}],"draft_beats":[{"text":"narration text","purpose":"hook|build|climax|resolve","visual_intent":"what to show"}],"image_search_guidance":"..."}` },
    ],
    model: MODELS.TEXT_DEFAULT, parseJSON: true, endpoint: "story_discovery",
  });
}

// ══════════════════════════════════════════════════════════
// STAGE 3: Story Validation
// ══════════════════════════════════════════════════════════

async function stage3(sb: SB, runId: string, story: any, fingerprints: string[], lastTitles: string[]): Promise<boolean> {
  const normalized = story.title?.toLowerCase().trim();
  if (lastTitles.some(t => t.toLowerCase().trim() === normalized)) { await log(sb, runId, "warn", `Duplicate title: "${story.title}"`); return false; }
  const fp = (story.summary || "").substring(0, 100).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (fingerprints.includes(fp)) { await log(sb, runId, "warn", "Fingerprint too similar"); return false; }
  if (!story.title || !story.summary || !story.hook || !story.draft_beats?.length) { await log(sb, runId, "warn", "Invalid JSON structure"); return false; }
  await log(sb, runId, "info", "Story validated");
  return true;
}

// ══════════════════════════════════════════════════════════
// STAGE 4: Real Image Generation (photorealistic via Gemini)
// ══════════════════════════════════════════════════════════

async function stage4(sb: SB, runId: string, story: any) {
  await updateRun(sb, runId, { current_stage: "real_image", progress_pct: 18 });
  await log(sb, runId, "info", "Stage 4: Generating photorealistic real image");

  // Determine best subject for image
  const chars = (story.characters || []).map((c: any) => `${c.name} (${c.role}): ${c.appearance_notes || ""}`).join(", ");
  const locations = (story.locations || []).map((l: any) => `${l.name}: ${l.description || ""}`).join(", ");

  const prompt = `Photorealistic photograph, editorial quality, natural lighting. Story: "${story.title}". ${story.summary || ""}. ${chars ? `People: ${chars}.` : ""} ${locations ? `Setting: ${locations}.` : ""} Capture the key emotional moment. Vertical 9:16, shallow depth of field, candid documentary style.`;

  const imageResult = await callImage({
    prompt,
    model: MODELS.IMAGE_FINAL,
    size: "9:16",
    quality: "high",
    endpoint: "story_real_image",
  });

  const path = `story-runs/${runId}/real_image.png`;
  const bytes = Uint8Array.from(atob(imageResult.b64_json), c => c.charCodeAt(0));
  const signedUrl = await uploadAndStoreAsset(sb, runId, path, bytes, "real_image", {
    image_type: "generated_photorealistic",
    image_description: `Photorealistic image for "${story.title}"`,
    characters_visible: (story.characters || []).map((c: any) => c.name),
  });

  return {
    primary_url: signedUrl,
    fallback_url: signedUrl,
    image_type: "generated_photorealistic",
    image_description: `Photorealistic image for "${story.title}"`,
    characters_visible: (story.characters || []).map((c: any) => c.name),
    storage_path: path,
  };
}

// ══════════════════════════════════════════════════════════
// STAGE 5: Cast/Reference Image
// ══════════════════════════════════════════════════════════

async function stage5(sb: SB, runId: string, story: any, realImage: any) {
  await updateRun(sb, runId, { status: "cast_generated", current_stage: "cast_generated", progress_pct: 22 });
  await log(sb, runId, "info", "Stage 5: Generating cast/reference image");

  const chars = (story.characters || []).map((c: any) => `${c.name} (${c.role}): ${c.appearance_notes || "estimate"}`).join("\n");
  const prompt = `Create a character lineup/reference sheet for a short video. All characters side by side, full body, labeled with names. Vertical 9:16 format, clean illustration.\n\nStory: "${story.title}"\n${story.summary}\n\nCharacters:\n${chars || "Create generic representatives"}\n\nReal image description: ${realImage?.image_description || "N/A"}`;

  const refData = realImage?.primary_url ? await fetchImageAsBase64(realImage.primary_url) : undefined;

  const imageResult = await callImage({
    prompt, model: MODELS.IMAGE_FINAL, size: "9:16", quality: "high",
    endpoint: "story_cast_image", referenceImage: refData,
  });

  const path = `story-runs/${runId}/cast_reference.png`;
  const bytes = Uint8Array.from(atob(imageResult.b64_json), c => c.charCodeAt(0));
  const url = await uploadAndStoreAsset(sb, runId, path, bytes, "cast_reference_image", { story_title: story.title });
  return { path, signedUrl: url };
}

// ══════════════════════════════════════════════════════════
// STAGE 6: Final Narration Script
// ══════════════════════════════════════════════════════════

async function stage6(sb: SB, runId: string, story: any) {
  await updateRun(sb, runId, { current_stage: "narration_script", progress_pct: 28 });
  await log(sb, runId, "info", "Stage 6: Generating final narration script");

  const result = await callStructured({
    messages: [
      { role: "system", content: "You are a master short-form video scriptwriter. Create scripts that hook viewers in 2 seconds and keep them until the emotional payoff. Write for narration — one spoken idea per beat, clear emotional pacing. Return ONLY valid JSON." },
      { role: "user", content: `Write a final narration script for this story:

Title: "${story.title}"
Summary: ${story.summary}
Hook: ${story.hook}
Reward: ${story.reward_moment}
Draft beats: ${JSON.stringify(story.draft_beats)}

Requirements:
- Strong opening seconds (hook immediately)
- Clean emotional pacing
- One spoken idea per beat
- Clear payoff at end
- Optimized for 60-90 second short-form retention
- 8-14 beats total

Return JSON:
{
  "full_script": "the complete narration text as one block",
  "beats": [
    {"index": 0, "text": "narration text for this beat", "purpose": "hook|build|escalate|climax|resolve", "visual_intent": "what should be shown visually"}
  ]
}` },
    ],
    model: MODELS.TEXT_DEFAULT, parseJSON: true, endpoint: "story_narration_script",
  });

  await log(sb, runId, "info", `Narration script: ${result.beats?.length || 0} beats, ${result.full_script?.length || 0} chars`);
  return result;
}

// ══════════════════════════════════════════════════════════
// STAGE 7: Generate Narrator MP3 (ElevenLabs)
// ══════════════════════════════════════════════════════════

async function stage7(sb: SB, runId: string, script: any) {
  await updateRun(sb, runId, { status: "narration_generated", current_stage: "narration_generated", progress_pct: 34 });
  await log(sb, runId, "info", "Stage 7: Generating narrator MP3 with ElevenLabs");

  const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
  if (!ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY not configured");

  // Use a warm, storytelling voice
  const voiceId = "JBFqnCBsd6RMkjVDRZzb"; // George - warm narrator
  const fullText = script.full_script;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: fullText,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.7,
          style: 0.4,
          use_speaker_boost: true,
          speed: 0.9,
        },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${errText.substring(0, 300)}`);
  }

  const result = await response.json();
  const audioBase64 = result.audio_base64;
  const alignment = result.alignment; // { characters, character_start_times_seconds, character_end_times_seconds }

  if (!audioBase64) throw new Error("No audio_base64 in ElevenLabs response");

  // Decode and upload
  const audioBytes = Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0));
  const path = `story-runs/${runId}/narration.mp3`;
  const url = await uploadAndStoreAsset(sb, runId, path, audioBytes, "narration_audio", {
    duration_estimate: alignment?.character_end_times_seconds?.slice(-1)?.[0] || null,
    character_count: fullText.length,
  });

  await log(sb, runId, "info", `Narration MP3 generated: ${(audioBytes.length / 1024).toFixed(0)}KB`);
  return { path, signedUrl: url, alignment, audioBase64 };
}

// ══════════════════════════════════════════════════════════
// STAGE 8: Beat Timing Extraction
// ══════════════════════════════════════════════════════════

async function stage8(sb: SB, runId: string, script: any, alignment: any) {
  await updateRun(sb, runId, { status: "beats_extracted", current_stage: "beats_extracted", progress_pct: 38 });
  await log(sb, runId, "info", "Stage 8: Extracting beat timings from alignment data");

  const beats = script.beats || [];
  const fullText = script.full_script || "";

  if (!alignment?.characters || !alignment?.character_start_times_seconds) {
    // Fallback: estimate timings from text proportions
    await log(sb, runId, "warn", "No alignment data — estimating beat timings from text length");
    const totalChars = beats.reduce((s: number, b: any) => s + (b.text?.length || 0), 0);
    const estimatedDuration = totalChars / 14; // ~14 chars/sec for narration
    let cursor = 0;
    const timedBeats = beats.map((b: any, i: number) => {
      const charRatio = (b.text?.length || 1) / totalChars;
      const dur = charRatio * estimatedDuration;
      const beat = { ...b, start_time: cursor, end_time: cursor + dur, duration: dur };
      cursor += dur;
      return beat;
    });
    return timedBeats;
  }

  // Map each beat's text to character-level timestamps
  const chars = alignment.characters as string[];
  const startTimes = alignment.character_start_times_seconds as number[];
  const endTimes = alignment.character_end_times_seconds as number[];

  // Reconstruct full text from alignment chars and find beat boundaries
  const alignedText = chars.join("");
  let searchPos = 0;

  const timedBeats = beats.map((beat: any, idx: number) => {
    const beatText = beat.text || "";
    // Find this beat's text in the aligned text
    const beatStart = alignedText.indexOf(beatText.substring(0, 20), searchPos);
    const actualStart = beatStart >= 0 ? beatStart : searchPos;
    const actualEnd = Math.min(actualStart + beatText.length, chars.length - 1);

    const startTime = startTimes[actualStart] || 0;
    const endTime = endTimes[Math.min(actualEnd, endTimes.length - 1)] || startTime + 5;

    searchPos = actualEnd;

    return {
      ...beat,
      start_time: startTime,
      end_time: endTime,
      duration: endTime - startTime,
    };
  });

  await log(sb, runId, "info", `Beat timings extracted: ${timedBeats.length} beats, total duration: ${timedBeats[timedBeats.length - 1]?.end_time?.toFixed(1)}s`);
  return timedBeats;
}

// ══════════════════════════════════════════════════════════
// STAGE 9: Generate Scene Prompts
// ══════════════════════════════════════════════════════════

async function stage9(sb: SB, runId: string, story: any, timedBeats: any[]) {
  await updateRun(sb, runId, { current_stage: "scene_prompts", progress_pct: 42 });
  await log(sb, runId, "info", `Stage 9: Generating ${timedBeats.length} scene prompts`);

  const result = await callStructured({
    messages: [
      { role: "system", content: "You are a visual director for short-form emotional storytelling. Create scene descriptions optimized for AI image generation. Each scene must maintain character consistency and use the cast reference image style. Return ONLY valid JSON." },
      { role: "user", content: `Generate one visual scene prompt per beat for this story video.

Story: "${story.title}"
Summary: ${story.summary}
Characters: ${JSON.stringify(story.characters)}
Locations: ${JSON.stringify(story.locations)}

Beats:
${timedBeats.map((b: any, i: number) => `Beat ${i}: "${b.text}" (${b.purpose}, ${b.duration?.toFixed(1)}s) — Visual: ${b.visual_intent}`).join("\n")}

For each beat return a detailed image prompt. All characters must look consistent with the cast reference image.

Return JSON:
{
  "scenes": [
    {"beat_index": 0, "prompt": "detailed scene description for AI image generation, vertical 9:16, cinematic lighting...", "characters_in_scene": ["names"], "location": "where", "target_duration": 3.65}
  ]
}` },
    ],
    model: MODELS.TEXT_DEFAULT, parseJSON: true, endpoint: "story_scene_prompts",
  });

  const scenes = result.scenes || [];
  // Merge durations from timed beats
  return scenes.map((s: any, i: number) => ({
    ...s,
    target_duration: timedBeats[i]?.duration || s.target_duration || 4,
    beat_text: timedBeats[i]?.text,
  }));
}

// ══════════════════════════════════════════════════════════
// STAGE 10: Generate Scene Images (Gemini)
// ══════════════════════════════════════════════════════════

async function stage10(sb: SB, runId: string, scenes: any[], castImagePath: string) {
  // Check which scene images already exist (from prior chain)
  const { data: existingAssets } = await sb.from("story_assets")
    .select("scene_index").eq("run_id", runId).eq("type", "scene_image");
  const doneIndices = new Set((existingAssets || []).map((a: any) => a.scene_index));
  const remaining = scenes.filter((_: any, i: number) => !doneIndices.has(i));

  await updateRun(sb, runId, { status: "scene_images_generating", current_stage: "scene_images_generating", progress_pct: 48 });
  await log(sb, runId, "info", `Stage 10: Generating ${remaining.length} scene images (${doneIndices.size} already done)`);

  // Get cast reference image for consistency
  const { data: castUrl } = await sb.storage.from("project-assets").createSignedUrl(castImagePath, 3600);
  const castRef = castUrl?.signedUrl ? await fetchImageAsBase64(castUrl.signedUrl) : undefined;

  const imageUrls: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    if (shouldChain()) {
      // Merge progress into existing metadata (don't overwrite!)
      const { data: cur } = await sb.from("story_runs").select("generated_metadata").eq("id", runId).single();
      const existingMeta = (cur?.generated_metadata as any) || {};
      await updateRun(sb, runId, {
        generated_metadata: { ...existingMeta, scene_images_progress: i, total_scenes: scenes.length },
        progress_pct: 48 + Math.round((i / scenes.length) * 12),
      });
      await log(sb, runId, "info", `Timeout guard: chaining at scene image ${i}/${scenes.length}`);
      return { partial: true, completed: i, imageUrls };
    }

    const scene = scenes[i];
    try {
      const imgResult = await callImage({
        prompt: `${scene.prompt}\n\nIMPORTANT: Use the cast reference image for character appearance consistency. Vertical 9:16 format. Cinematic, emotional lighting.`,
        model: MODELS.IMAGE_FINAL, size: "9:16", quality: "high",
        endpoint: `story_scene_image_${i}`,
        referenceImage: castRef,
      });

      const path = `story-runs/${runId}/scene_${i}.png`;
      const bytes = Uint8Array.from(atob(imgResult.b64_json), c => c.charCodeAt(0));
      const url = await uploadAndStoreAsset(sb, runId, path, bytes, "scene_image", { beat_index: i, prompt: scene.prompt.substring(0, 200) }, i);
      imageUrls.push(url || path);
      await log(sb, runId, "info", `Scene image ${i + 1}/${scenes.length} generated`);
    } catch (err) {
      await log(sb, runId, "error", `Scene image ${i} failed: ${(err as Error).message}`);
      imageUrls.push(""); // placeholder
    }
  }

  return { partial: false, completed: scenes.length, imageUrls };
}

// ══════════════════════════════════════════════════════════
// STAGE 11: Animate Scene Clips (Vidu Q3 Turbo)
// ══════════════════════════════════════════════════════════

async function stage11(sb: SB, runId: string, scenes: any[]) {
  await updateRun(sb, runId, { status: "scenes_generating", current_stage: "scenes_generating", progress_pct: 62 });
  await log(sb, runId, "info", `Stage 11: Submitting ${scenes.length} scene clips to Vidu Q3 Turbo`);

  const VIDU_API_KEY = Deno.env.get("VIDU_API_KEY");
  if (!VIDU_API_KEY) throw new Error("VIDU_API_KEY not configured");

  // Get scene image URLs
  const { data: sceneAssets } = await sb.from("story_assets")
    .select("*").eq("run_id", runId).eq("type", "scene_image")
    .order("scene_index", { ascending: true });

  if (!sceneAssets?.length) throw new Error("No scene images found");

  const tasks: { sceneIndex: number; taskId: string; targetDuration: number }[] = [];

  for (let i = 0; i < sceneAssets.length; i++) {
    const asset = sceneAssets[i];
    const scene = scenes[i] || {};
    const targetDuration = scene.target_duration || 4;
    const requestDuration = Math.ceil(targetDuration); // Round up per Rule 3

    // Get public URL for the scene image
    const { data: signedData } = await sb.storage.from("project-assets")
      .createSignedUrl(asset.supabase_path, 3600);
    const imageUrl = signedData?.signedUrl;
    if (!imageUrl) { await log(sb, runId, "warn", `No URL for scene image ${i}`); continue; }

    try {
      // Submit to Vidu Q3 Turbo
      const viduResp = await fetch("https://api.vidu.com/ent/v2/tasks/image2video", {
        method: "POST",
        headers: {
          "Authorization": `Token ${VIDU_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "viduq3-turbo",
          images: [{ url: imageUrl, type: "subject_reference" }],
          prompt: `Subtle cinematic animation of scene: ${scene.prompt?.substring(0, 200) || "gentle motion"}. Slow emotional movements. No abrupt transitions.`,
          duration: Math.min(requestDuration, 8), // Vidu max per clip
          resolution: "720p",
          movement_amplitude: "auto",
        }),
      });

      if (!viduResp.ok) {
        const err = await viduResp.text();
        await log(sb, runId, "error", `Vidu submit failed for scene ${i}: ${err.substring(0, 200)}`);
        continue;
      }

      const viduData = await viduResp.json();
      const taskId = viduData.task_id || viduData.id;
      tasks.push({ sceneIndex: i, taskId, targetDuration });

      // Store clip asset placeholder with vidu task info
      await sb.from("story_assets").insert({
        run_id: runId,
        type: "scene_video_raw",
        supabase_path: `story-runs/${runId}/scene_${i}_raw.mp4`,
        metadata: { vidu_task_id: taskId, status: "pending", target_duration: targetDuration, request_duration: requestDuration, scene_index: i },
        scene_index: i,
      });

      await log(sb, runId, "info", `Vidu task submitted for scene ${i}: ${taskId} (${requestDuration}s requested, ${targetDuration.toFixed(2)}s target)`);
    } catch (err) {
      await log(sb, runId, "error", `Vidu submit error for scene ${i}: ${(err as Error).message}`);
    }
  }

  await log(sb, runId, "info", `All ${tasks.length} Vidu tasks submitted. Invoking poller.`);
  return tasks;
}

// ══════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const runId = body.run_id;
    const resumeStage = body.resume_stage || null;
    if (!runId) return new Response(JSON.stringify({ error: "run_id required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const sb = getSupabase();

    // Check if run is cancelled/failed
    const { data: currentRun } = await sb.from("story_runs").select("status, generated_metadata").eq("id", runId).single();
    if (currentRun && ["cancelled", "failed"].includes(currentRun.status)) {
      return new Response(JSON.stringify({ status: "aborted", reason: currentRun.status }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const meta = (currentRun?.generated_metadata as any) || {};

    // ── Resume logic for self-chaining ──
    if (resumeStage === "stage10_continue") {
      await log(sb, runId, "info", "Resuming stage 10 (scene images) from chain");
      const scenes = meta.scenes || [];
      const castPath = meta.cast_image?.path;
      const result = await stage10(sb, runId, scenes, castPath);
      if (result.partial) {
        await selfChain(runId, "stage10_continue");
        return new Response(JSON.stringify({ status: "chaining_stage10" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      // Continue to stage 11
      const tasks = await stage11(sb, runId, scenes);
      await updateRun(sb, runId, { generated_metadata: { ...meta, vidu_tasks: tasks } });
      await chainFunction("story-poll-vidu", { run_id: runId });
      return new Response(JSON.stringify({ status: "scenes_generating" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (resumeStage === "stage6") {
      await log(sb, runId, "info", "Resuming from stage 6 (narration)");
      const story = meta.story;
      const script = await stage6(sb, runId, story);
      await updateRun(sb, runId, { generated_metadata: { ...meta, script } });

      if (shouldChain()) { await selfChain(runId, "stage7"); return new Response(JSON.stringify({ status: "chaining" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

      // Fall through to stage 7
      const narration = await stage7(sb, runId, script);
      const timedBeats = await stage8(sb, runId, script, narration.alignment);
      await updateRun(sb, runId, { generated_metadata: { ...meta, script, narration: { path: narration.path }, timed_beats: timedBeats } });

      if (shouldChain()) { await selfChain(runId, "stage9"); return new Response(JSON.stringify({ status: "chaining" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

      const scenes = await stage9(sb, runId, story, timedBeats);
      await updateRun(sb, runId, { generated_metadata: { ...meta, script, narration: { path: narration.path }, timed_beats: timedBeats, scenes } });

      const imgResult = await stage10(sb, runId, scenes, meta.cast_image?.path);
      if (imgResult.partial) {
        await selfChain(runId, "stage10_continue");
        return new Response(JSON.stringify({ status: "chaining_stage10" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const tasks = await stage11(sb, runId, scenes);
      await updateRun(sb, runId, { generated_metadata: { ...meta, script, narration: { path: narration.path }, timed_beats: timedBeats, scenes, vidu_tasks: tasks } });
      await chainFunction("story-poll-vidu", { run_id: runId });
      return new Response(JSON.stringify({ status: "scenes_generating" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (resumeStage === "stage7") {
      const story = meta.story;
      const script = meta.script || await stage6(sb, runId, story);
      const narration = await stage7(sb, runId, script);
      const timedBeats = await stage8(sb, runId, script, narration.alignment);
      await updateRun(sb, runId, { generated_metadata: { ...meta, script, narration: { path: narration.path }, timed_beats: timedBeats } });
      await selfChain(runId, "stage9");
      return new Response(JSON.stringify({ status: "chaining_stage9" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (resumeStage === "stage9") {
      const story = meta.story;
      const timedBeats = meta.timed_beats;
      const scenes = await stage9(sb, runId, story, timedBeats);
      await updateRun(sb, runId, { generated_metadata: { ...meta, scenes } });

      const imgResult = await stage10(sb, runId, scenes, meta.cast_image?.path);
      if (imgResult.partial) {
        await selfChain(runId, "stage10_continue");
        return new Response(JSON.stringify({ status: "chaining_stage10" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const tasks = await stage11(sb, runId, scenes);
      await updateRun(sb, runId, { generated_metadata: { ...meta, scenes, vidu_tasks: tasks } });
      await chainFunction("story-poll-vidu", { run_id: runId });
      return new Response(JSON.stringify({ status: "scenes_generating" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Full pipeline from stage 1 ──
    let context: any;
    try { context = await stage1(sb, runId); } catch (err) {
      await failRun(sb, runId, `Stage 1 failed: ${(err as Error).message}`);
      return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Stages 2+3: Story discovery with retry
    let story: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        story = await stage2(sb, runId, context.lastTitles);
        if (await stage3(sb, runId, story, context.fingerprints, context.lastTitles)) break;
        story = null;
      } catch (err) {
        await log(sb, runId, "error", `Story attempt ${attempt}: ${(err as Error).message}`);
        if (attempt === 3) { await failRun(sb, runId, `Story discovery failed: ${(err as Error).message}`); return new Response(JSON.stringify({ error: "Story failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      }
    }
    if (!story) { await failRun(sb, runId, "No valid story found after 3 attempts"); return new Response(JSON.stringify({ error: "No story" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

    await updateRun(sb, runId, { status: "story_selected", current_stage: "story_selected", progress_pct: 14, generated_metadata: { story } });

    // Stage 4: Real image
    let realImage: any = null;
    try { realImage = await stage4(sb, runId, story); } catch (err) {
      await log(sb, runId, "warn", `Real image failed: ${(err as Error).message}`);
    }
    await updateRun(sb, runId, { generated_metadata: { story, real_image: realImage }, progress_pct: 20 });

    if (shouldChain()) {
      await selfChain(runId, "stage5");
      return new Response(JSON.stringify({ status: "chaining" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Stage 5: Cast image
    let castResult: any;
    try {
      castResult = await stage5(sb, runId, story, realImage);
    } catch (err) {
      await failRun(sb, runId, `Cast image failed: ${(err as Error).message}`);
      return new Response(JSON.stringify({ error: "Cast failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Store story in memory
    const fp = (story.summary || "").substring(0, 100).toLowerCase().replace(/[^a-z0-9]/g, "");
    await sb.from("story_memory").insert({ project_id: context.projectId, run_id: runId, story_title: story.title, story_fingerprint: fp, source_url: story.source_url || null });

    await updateRun(sb, runId, { status: "cast_generated", current_stage: "cast_generated", progress_pct: 25, generated_metadata: { story, real_image: realImage, cast_image: castResult } });

    if (shouldChain()) {
      await selfChain(runId, "stage6");
      return new Response(JSON.stringify({ status: "chaining_stage6" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Stage 6: Narration script
    const script = await stage6(sb, runId, story);
    await updateRun(sb, runId, { generated_metadata: { story, real_image: realImage, cast_image: castResult, script } });

    if (shouldChain()) {
      await selfChain(runId, "stage7");
      return new Response(JSON.stringify({ status: "chaining_stage7" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Stage 7: Narrator MP3
    const narration = await stage7(sb, runId, script);

    // Stage 8: Beat timing
    const timedBeats = await stage8(sb, runId, script, narration.alignment);
    await updateRun(sb, runId, { generated_metadata: { story, real_image: realImage, cast_image: castResult, script, narration: { path: narration.path }, timed_beats: timedBeats } });

    if (shouldChain()) {
      await selfChain(runId, "stage9");
      return new Response(JSON.stringify({ status: "chaining_stage9" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Stage 9: Scene prompts
    const scenes = await stage9(sb, runId, story, timedBeats);
    await updateRun(sb, runId, { generated_metadata: { story, real_image: realImage, cast_image: castResult, script, narration: { path: narration.path }, timed_beats: timedBeats, scenes } });

    // Stage 10: Scene images
    const imgResult = await stage10(sb, runId, scenes, castResult.path);
    if (imgResult.partial) {
      await selfChain(runId, "stage10_continue");
      return new Response(JSON.stringify({ status: "chaining_stage10" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Stage 11: Animate clips
    const tasks = await stage11(sb, runId, scenes);
    await updateRun(sb, runId, { generated_metadata: { story, real_image: realImage, cast_image: castResult, script, narration: { path: narration.path }, timed_beats: timedBeats, scenes, vidu_tasks: tasks } });

    // Hand off to poller
    await chainFunction("story-poll-vidu", { run_id: runId });

    return new Response(JSON.stringify({ success: true, stage: "scenes_generating", story_title: story.title }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("Story pipeline error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
