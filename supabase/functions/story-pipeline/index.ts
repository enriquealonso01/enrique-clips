import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { callStructured, callText, callImage, MODELS, Image503RetryableError } from "../_shared/openai.ts";

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

class CancelledError extends Error {
  constructor() { super("Run cancelled by user"); this.name = "CancelledError"; }
}

async function checkCancelled(sb: SB, runId: string) {
  const { data } = await sb.from("story_runs").select("status").eq("id", runId).single();
  if (data && ["cancelled", "failed"].includes(data.status)) {
    await log(sb, runId, "info", `Pipeline aborted: status is ${data.status}`);
    throw new CancelledError();
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

let PIPELINE_START = Date.now();
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
    // Use chunk-based encoding to avoid stack overflow on large images
    const CHUNK = 32768;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
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

// Helper: get project config for a run
async function getProjectConfig(sb: SB, runId: string): Promise<any> {
  const { data: run } = await sb.from("story_runs").select("project_id").eq("id", runId).single();
  if (!run) return {};
  const { data: project } = await sb.from("story_projects").select("config_json").eq("id", run.project_id).single();
  return (project as any)?.config_json || {};
}

// Helper: handle post-stage11 (off-peak pause or poll)
async function postStage11(sb: SB, runId: string, tasks: any[], offPeak: boolean) {
  if (offPeak && tasks.length > 0) {
    // Read current metadata once
    const { data: cur } = await sb.from("story_runs").select("generated_metadata").eq("id", runId).single();
    const meta = (cur?.generated_metadata as any) || {};
    await log(sb, runId, "info", `All ${tasks.length} Vidu off-peak clips submitted. Pausing run for background polling.`);
    await updateRun(sb, runId, {
      status: "paused" as any,
      progress_pct: 62,
      generated_metadata: { ...meta, vidu_tasks: tasks, waiting_for: "vidu_off_peak", off_peak_submitted_at: new Date().toISOString() },
    });
    return "vidu_off_peak_paused";
  }
  await chainFunction("story-poll-vidu", { run_id: runId });
  return "scenes_generating";
}


// ══════════════════════════════════════════════════════════
// STAGE 1: Create Run
// ══════════════════════════════════════════════════════════

async function stage1(sb: SB, runId: string) {
  await updateRun(sb, runId, { status: "queued", current_stage: "create_run", progress_pct: 2, started_at: new Date().toISOString() });
  await log(sb, runId, "info", "Stage 1: Loading project config and story memory");

  const { data: run } = await sb.from("story_runs").select("*, story_projects(*)").eq("id", runId).single();
  if (!run) throw new Error("Run not found");

  const project = run.story_projects as any;
  const targetDuration = project?.target_duration_sec || 60;

  const { data: memory } = await sb.from("story_memory")
    .select("story_title, story_fingerprint")
    .eq("project_id", run.project_id)
    .order("created_at", { ascending: false }).limit(20);

  const lastTitles = (memory || []).map((m: any) => m.story_title);
  const fingerprints = (memory || []).map((m: any) => m.story_fingerprint).filter(Boolean);
  await log(sb, runId, "info", `Loaded ${lastTitles.length} previous story titles. Target duration: ${targetDuration}s`);

  const storySearchPrompt = project?.story_search_prompt || "";

  return { run, project, lastTitles, fingerprints, projectId: run.project_id, targetDuration, storySearchPrompt };
}

// ══════════════════════════════════════════════════════════
// STAGE 2: Story Discovery
// ══════════════════════════════════════════════════════════

async function stage2(sb: SB, runId: string, lastTitles: string[], targetDuration: number = 60, storySearchPrompt: string = "") {
  await updateRun(sb, runId, { status: "researching_story", current_stage: "researching_story", progress_pct: 8 });
  await log(sb, runId, "info", `Stage 2: Discovering story via AI${storySearchPrompt ? ` (category: ${storySearchPrompt})` : ""}`);

  const titlesBlock = lastTitles.length > 0
    ? `\n\nPREVIOUSLY USED TITLES (DO NOT reuse):\n${lastTitles.map((t, i) => `${i + 1}. ${t}`).join("\n")}` : "";

  // Adapt beat count to target duration
  const minBeats = Math.max(4, Math.round(targetDuration / 12));
  const maxBeats = Math.max(6, Math.round(targetDuration / 5));

  const categoryInstruction = storySearchPrompt
    ? `\n- CATEGORY REQUIREMENT: The story MUST match this category/topic: "${storySearchPrompt}". Only pick stories that fit this requirement.`
    : "";

  return await callStructured({
    messages: [
      { role: "system", content: "You are a viral short-form video researcher. Find real, wholesome, feel-good stories with strong hooks and emotional payoffs. Return ONLY valid JSON." },
      { role: "user", content: `Find a NEW wholesome real-world story for a ${targetDuration}-second vertical video. Requirements:
- Strong hook in first sentence
- Emotional reward/payoff moment
- Real characters, real events
- Visual potential${categoryInstruction}
- Story depth should match a ${targetDuration}s video (${targetDuration <= 60 ? "concise and punchy" : targetDuration <= 120 ? "moderate depth with good pacing" : "deeper narrative with multiple beats"})${titlesBlock}

Return JSON: {"title":"...","source_url":"...","summary":"3-5 sentence detailed summary","hook":"opening hook line","reward_moment":"emotional payoff","characters":[{"name":"...","role":"...","appearance_notes":"..."}],"groups":[{"name":"...","description":"..."}],"locations":[{"name":"...","description":"..."}],"draft_beats":[{"text":"narration text","purpose":"hook|build|climax|resolve","visual_intent":"what to show"}],"image_search_guidance":"..."}

IMPORTANT: Provide ${minBeats}-${maxBeats} draft beats to fill ~${targetDuration} seconds of narration.` },
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
// STAGE 4: Real Image Retrieval — Brave Search + AI Validation
// ══════════════════════════════════════════════════════════

async function braveImageSearch(query: string, count = 5): Promise<Array<{ url: string; title: string }>> {
  const key = Deno.env.get("BRAVE_SEARCH_API_KEY");
  if (!key) return [];
  const params = new URLSearchParams({ q: query, count: String(count), safesearch: "off" });
  const resp = await fetch(`https://api.search.brave.com/res/v1/images/search?${params}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Brave image search failed: ${resp.status} — ${body.substring(0, 300)}`);
    return [];
  }
  const data = await resp.json();
  console.log(`Brave image search: ${data.results?.length || 0} results for "${query.substring(0, 60)}"`);
  const mapped = (data.results || []).map((r: any) => ({
    url: r.properties?.url || r.thumbnail?.src || r.url || "",
    title: r.title || "",
  })).filter((r: any) => r.url && r.url.startsWith("http"));
  return mapped;
}

// Fallback: Brave Web Search returns pages with thumbnail images
async function braveWebSearchImages(query: string, count = 8): Promise<Array<{ url: string; title: string }>> {
  const key = Deno.env.get("BRAVE_SEARCH_API_KEY");
  if (!key) return [];
  const params = new URLSearchParams({ q: query, count: String(count) });
  const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  if (!resp.ok) { await resp.text(); return []; }
  const data = await resp.json();
  const images: Array<{ url: string; title: string }> = [];
  for (const r of data.web?.results || []) {
    if (r.thumbnail?.src) images.push({ url: r.thumbnail.src, title: r.title || "" });
  }
  console.log(`Brave web search: ${images.length} thumbnail images for "${query.substring(0, 60)}"`);
  return images;
}

async function validateImageUrl(url: string): Promise<boolean> {
  try {
    const headResp = await fetch(url, { method: "HEAD", redirect: "follow" });
    const headType = headResp.headers.get("content-type") || "";
    if (headResp.ok && headType.startsWith("image")) return true;
  } catch {
    // Some CDNs reject HEAD requests; fall through to GET validation.
  }

  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "image/*,*/*;q=0.8",
        Range: "bytes=0-0",
      },
    });
    const contentType = resp.headers.get("content-type") || "";
    return resp.ok && (
      contentType.startsWith("image") ||
      /\.(png|jpe?g|webp|gif|avif|bmp|svg)(\?|$)/i.test(resp.url)
    );
  } catch {
    return false;
  }
}

async function aiRelevanceCheck(sb: SB, runId: string, imageUrl: string, story: any): Promise<boolean> {
  try {
    const imageDataUrl = await fetchImageAsBase64(imageUrl);
    if (!imageDataUrl) {
      await log(sb, runId, "debug", `AI relevance skipped; could not fetch image bytes: ${imageUrl.substring(0, 120)}`);
      return false;
    }

    const resp = await callText({
      messages: [
        {
          role: "system",
          content: `You are an image-story relevance judge. You will see an image and a story summary. Determine if the image is relevant to the story — it should depict the people, event, or setting described. Reply with ONLY JSON: {"relevant": true or false, "reason": "brief explanation"}`
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Story: "${story.title}"\nSummary: ${story.summary}\nCharacters: ${(story.characters || []).map((c: any) => c.name).join(", ")}` },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ] as any,
        },
      ],
      model: MODELS.TEXT_CHEAP,
      endpoint: "story_image_relevance",
    });
    const text = typeof resp === "string" ? resp : resp?.content || resp?.text || JSON.stringify(resp);
    const jsonMatch = text.match(/\{[\s\S]*?"relevant"[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      await log(sb, runId, "debug", `AI relevance check: relevant=${parsed.relevant}, reason=${parsed.reason}`);
      return !!parsed.relevant;
    }
    await log(sb, runId, "debug", `AI relevance returned non-JSON: ${text.substring(0, 180)}`);
    return false;
  } catch (e) {
    await log(sb, runId, "warn", `AI relevance check error: ${(e as Error).message}`);
    return false;
  }
}

async function stage4(sb: SB, runId: string, story: any) {
  await updateRun(sb, runId, { current_stage: "real_image", progress_pct: 18 });
  await log(sb, runId, "info", "Stage 4: Finding real image via Brave Search");

  // Build 3 query variations
  const charNames = (story.characters || []).map((c: any) => c.name).join(" ");
  const locationNames = (story.locations || []).map((l: any) => l.name).join(" ");
  const queries = [
    `${story.title} photo`,
    `${charNames} ${locationNames}`.trim() || `${story.title} real`,
    `${story.hook || story.title} real photo`,
  ];

  // ── Step 1: Brave Image Search with AI validation ──
  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi];
    await log(sb, runId, "info", `Brave search query ${qi + 1}/3: "${query}"`);
    const results = await braveImageSearch(query, 5);
    if (results.length === 0) {
      await log(sb, runId, "debug", `No Brave results for query ${qi + 1}`);
      continue;
    }

    for (const candidate of results) {
      const valid = await validateImageUrl(candidate.url);
      if (!valid) {
        await log(sb, runId, "debug", `Rejected Brave image candidate (invalid image URL): ${candidate.url.substring(0, 120)}`);
        continue;
      }

      const relevant = await aiRelevanceCheck(sb, runId, candidate.url, story);
      if (!relevant) {
        await log(sb, runId, "debug", `Rejected Brave image candidate (not relevant): ${candidate.url.substring(0, 120)}`);
        continue;
      }

      await log(sb, runId, "info", `Relevant image found: ${candidate.url.substring(0, 120)}`);
      try {
        const imgResp = await fetch(candidate.url);
        if (imgResp.ok) {
          const bytes = new Uint8Array(await imgResp.arrayBuffer());
          const path = `story-runs/${runId}/real_image.png`;
          const signedUrl = await uploadAndStoreAsset(sb, runId, path, bytes, "real_image", {
            image_type: "search_result",
            image_description: candidate.title || `Image for "${story.title}"`,
            characters_visible: [],
            original_url: candidate.url,
            source: "brave_search",
            query_used: query,
          });
          return {
            primary_url: signedUrl,
            image_type: "search_result",
            image_description: candidate.title || `Image for "${story.title}"`,
            characters_visible: [],
            storage_path: path,
          };
        }
      } catch (e) {
        await log(sb, runId, "warn", `Failed to download image: ${(e as Error).message}`);
      }
    }
  }

  // ── Step 2: Fallback — Brave Web Search (larger index, thumbnail images) ──
  await log(sb, runId, "info", "No image results from Brave Image Search. Trying Brave Web Search thumbnails...");
  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi];
    const webResults = await braveWebSearchImages(query, 8);
    if (webResults.length === 0) continue;
    await log(sb, runId, "debug", `Web search query ${qi + 1}: ${webResults.length} thumbnails`);

    for (const candidate of webResults) {
      const valid = await validateImageUrl(candidate.url);
      if (!valid) {
        await log(sb, runId, "debug", `Rejected web thumbnail (invalid image URL): ${candidate.url.substring(0, 120)}`);
        continue;
      }

      const relevant = await aiRelevanceCheck(sb, runId, candidate.url, story);
      if (!relevant) {
        await log(sb, runId, "debug", `Rejected web thumbnail (not relevant): ${candidate.url.substring(0, 120)}`);
        continue;
      }
      await log(sb, runId, "info", `Relevant web thumbnail found: ${candidate.url.substring(0, 120)}`);
      try {
        const imgResp = await fetch(candidate.url);
        if (imgResp.ok) {
          const bytes = new Uint8Array(await imgResp.arrayBuffer());
          const path = `story-runs/${runId}/real_image.png`;
          const signedUrl = await uploadAndStoreAsset(sb, runId, path, bytes, "real_image", {
            image_type: "search_result",
            image_description: candidate.title || `Image for "${story.title}"`,
            characters_visible: [],
            original_url: candidate.url,
            source: "brave_web_search",
            query_used: query,
          });
          return {
            primary_url: signedUrl,
            image_type: "search_result",
            image_description: candidate.title || `Image for "${story.title}"`,
            characters_visible: [],
            storage_path: path,
          };
        }
      } catch (e) {
        await log(sb, runId, "warn", `Failed to download web image: ${(e as Error).message}`);
      }
    }
  }

  // ── Step 3: Fallback — generate photorealistic image with Gemini ──
  await log(sb, runId, "info", "No relevant image found via any search. Generating photorealistic fallback with Gemini.");
  const chars = (story.characters || []).map((c: any) => `${c.name} (${c.role}): ${c.appearance_notes || ""}`).join(", ");
  const locations = (story.locations || []).map((l: any) => `${l.name}: ${l.description || ""}`).join(", ");
  const prompt = `Photorealistic photograph, editorial quality, natural lighting. Story: "${story.title}". ${story.summary || ""}. ${chars ? `People: ${chars}.` : ""} ${locations ? `Setting: ${locations}.` : ""} Capture the key emotional moment. Vertical 9:16, shallow depth of field, candid documentary style. NO text, words, letters, watermarks, or typography in the image.`;

  const imageResult = await callImage({
    prompt, model: MODELS.IMAGE_FINAL, size: "9:16", quality: "high",
    endpoint: "story_real_image_fallback",
  });

  const path = `story-runs/${runId}/real_image.png`;
  const bytes = Uint8Array.from(atob(imageResult.b64_json), c => c.charCodeAt(0));
  const signedUrl = await uploadAndStoreAsset(sb, runId, path, bytes, "real_image", {
    image_type: "generated_photorealistic",
    image_description: `AI-generated photorealistic image for "${story.title}"`,
    characters_visible: (story.characters || []).map((c: any) => c.name),
    source: "gemini_generation",
  });

  return {
    primary_url: signedUrl,
    fallback_url: signedUrl,
    image_type: "generated_photorealistic",
    image_description: `Photorealistic image for "${story.title}"`,
    characters_visible: [],
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
  const prompt = `Create a character lineup/reference sheet for a short cinematic story video. All characters side by side, full body, labeled with names. Vertical 9:16 format.\n\nCORE CHARACTER STYLE (apply to every character):\nWarm, semi-realistic human characters, soft facial features, expressive eyes, natural skin texture, slightly stylized proportions, cinematic lighting, shallow depth of field, 35mm lens look, soft contrast, warm color grading, highly detailed but NOT hyper-realistic. Consistent character design across the lineup. NOT cartoon, NOT anime, NOT 3D render, NOT photorealistic stock photo.\n\nStory: "${story.title}"\n${story.summary}\n\nCharacters:\n${chars || "Create generic representatives"}\n\nDesign each character with distinctive, memorable features (unique hair color/style, outfit color, accessories) so they remain recognizable across all scenes.`;

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

async function stage6(sb: SB, runId: string, story: any, targetDuration: number = 60) {
  await updateRun(sb, runId, { current_stage: "narration_script", progress_pct: 28 });
  await log(sb, runId, "info", `Stage 6: Generating final narration script (target: ${targetDuration}s)`);

  const minBeats = Math.max(4, Math.round(targetDuration / 12));
  const maxBeats = Math.max(6, Math.round(targetDuration / 5));
  // Estimate words: ~2.5 words/sec for narration
  const targetWords = Math.round(targetDuration * 2.5);

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
- Target video duration: ${targetDuration} seconds (aim for ~${targetWords} words total)
- Strong opening seconds (hook immediately)
- Clean emotional pacing
- One spoken idea per beat
- Clear payoff at end
- ${minBeats}-${maxBeats} beats total
- ${targetDuration <= 60 ? "Keep it tight and punchy — every word counts" : targetDuration <= 120 ? "Standard pacing with room for emotional beats" : "Allow deeper storytelling with more descriptive beats"}

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

  await log(sb, runId, "info", `Narration script: ${result.beats?.length || 0} beats, ${result.full_script?.length || 0} chars (~${Math.round((result.full_script?.split(/\s+/).length || 0) / 2.5)}s estimated)`);
  return result;
}

// ══════════════════════════════════════════════════════════
// STAGE 7: Generate Narrator MP3 (ElevenLabs)
// ══════════════════════════════════════════════════════════

const ELEVENLABS_VOICE_ID = "3RbK5MAeB6NkutT3d6qF";
const ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.55,
  similarity_boost: 0.7,
  style: 0.4,
  use_speaker_boost: true,
  speed: 1.05,
};

// Split a script into sentence-like segments. Handles common abbreviations.
function splitIntoSegments(text: string): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  // Protect common abbreviations
  const protectedText = cleaned
    .replace(/\b(Mr|Mrs|Ms|Dr|Sr|Jr|St|Mt|Prof|Sgt|Capt|Lt|Gen|Rev|Hon|vs|etc|i\.e|e\.g)\./g, "$1<DOT>");
  const parts = protectedText.split(/(?<=[.!?])\s+(?=[A-Z"'(])/);
  const segments = parts
    .map(s => s.replace(/<DOT>/g, ".").trim())
    .filter(s => s.length > 0);
  // Merge tiny fragments (<8 chars) into the previous segment so we don't pay for sub-word calls
  const merged: string[] = [];
  for (const s of segments) {
    if (merged.length > 0 && s.length < 8) {
      merged[merged.length - 1] += " " + s;
    } else {
      merged.push(s);
    }
  }
  return merged;
}

async function callElevenLabsWithTimestamps(text: string, prev?: string, next?: string): Promise<{ audioBytes: Uint8Array; alignment: any }> {
  const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
  if (!ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY not configured");

  const body: any = {
    text,
    model_id: "eleven_multilingual_v2",
    voice_settings: ELEVENLABS_VOICE_SETTINGS,
  };
  if (prev) body.previous_text = prev;
  if (next) body.next_text = next;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${errText.substring(0, 300)}`);
  }
  const result = await response.json();
  if (!result.audio_base64) throw new Error("No audio_base64 in ElevenLabs response");
  const audioBytes = Uint8Array.from(atob(result.audio_base64), c => c.charCodeAt(0));
  return { audioBytes, alignment: result.alignment };
}

// Concatenate per-segment alignments into one global alignment, shifted by cumulative offsets.
// gapSeconds is the silent gap inserted between segments by the FFmpeg concat.
function mergeAlignments(perSegment: { alignment: any; duration: number }[], gapSeconds: number) {
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (let i = 0; i < perSegment.length; i++) {
    const seg = perSegment[i];
    const a = seg.alignment;
    if (a?.characters && a?.character_start_times_seconds && a?.character_end_times_seconds) {
      for (let j = 0; j < a.characters.length; j++) {
        characters.push(a.characters[j]);
        starts.push(a.character_start_times_seconds[j] + offset);
        ends.push(a.character_end_times_seconds[j] + offset);
      }
    }
    // Insert a space char to represent the inter-segment gap (so beat-text matching still works)
    if (i < perSegment.length - 1) {
      characters.push(" ");
      starts.push(offset + seg.duration);
      ends.push(offset + seg.duration + gapSeconds);
    }
    offset += seg.duration + (i < perSegment.length - 1 ? gapSeconds : 0);
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
}

async function stage7Segmented(sb: SB, runId: string, script: any, gapMs: number): Promise<{ path: string; signedUrl: string | undefined; alignment: any }> {
  const RENDI_API_KEY = Deno.env.get("RENDI_API_KEY");
  if (!RENDI_API_KEY) throw new Error("RENDI_API_KEY not configured (required for segmented narration stitching)");

  const fullText: string = script.full_script;
  const segments = splitIntoSegments(fullText);
  await log(sb, runId, "info", `Segmented narration: ${segments.length} segments from ${fullText.length} chars`);

  if (segments.length < 2) {
    await log(sb, runId, "info", "Only one segment — falling back to single-call narration");
    const { audioBytes, alignment } = await callElevenLabsWithTimestamps(fullText);
    const path = `story-runs/${runId}/narration.mp3`;
    const url = await uploadAndStoreAsset(sb, runId, path, audioBytes, "narration_audio", {
      duration_estimate: alignment?.character_end_times_seconds?.slice(-1)?.[0] || null,
      character_count: fullText.length,
      segmented: false,
    });
    return { path, signedUrl: url, alignment };
  }

  // Generate each segment with ElevenLabs request stitching context (sequential to keep ordering safe)
  // LAYER B: Strip trailing sentence punctuation (.!?) from non-final segments so ElevenLabs doesn't
  // generate a long end-of-sentence pause. Context (previous_text/next_text) keeps prosody seamless.
  const stripTrailingPunct = (s: string) => s.replace(/[.!?]+\s*$/u, "").trim();
  const perSegment: { audioBytes: Uint8Array; alignment: any; duration: number; uploadPath: string }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const ttsText = isLast ? segments[i] : stripTrailingPunct(segments[i]);
    const prev = i > 0 ? segments[i - 1] : undefined;
    const next = i < segments.length - 1 ? segments[i + 1] : undefined;
    const { audioBytes, alignment } = await callElevenLabsWithTimestamps(ttsText, prev, next);
    const duration = alignment?.character_end_times_seconds?.slice(-1)?.[0] ?? 0;
    const uploadPath = `story-runs/${runId}/narration-segments/seg-${String(i).padStart(3, "0")}.mp3`;
    const { error: upErr } = await sb.storage.from("project-assets").upload(uploadPath, audioBytes, {
      contentType: "audio/mpeg",
      upsert: true,
    });
    if (upErr) throw new Error(`Failed to upload narration segment ${i}: ${upErr.message}`);
    perSegment.push({ audioBytes, alignment, duration, uploadPath });
    await log(sb, runId, "info", `  Seg ${i + 1}/${segments.length}: ${duration.toFixed(2)}s, ${(audioBytes.length / 1024).toFixed(0)}KB${isLast ? "" : " (period stripped)"}`);
  }

  // Build signed URLs for each segment for Rendi
  const segUrls: string[] = [];
  for (const seg of perSegment) {
    const { data } = await sb.storage.from("project-assets").createSignedUrl(seg.uploadPath, 60 * 60);
    if (!data?.signedUrl) throw new Error(`Failed to sign URL for ${seg.uploadPath}`);
    segUrls.push(data.signedUrl);
  }

  // Build Rendi FFmpeg command:
  // LAYER A: silenceremove on each segment to strip leading + trailing silence below -40dB.
  //   start_periods=1 → strip leading silence completely
  //   stop_periods=-1 stop_duration=0.05 → strip every trailing silence chunk ≥50ms (recursive at end)
  // Then optionally pad each non-last segment with the configured inter-segment gap.
  const gapSeconds = Math.max(0, gapMs / 1000);
  const inputFiles: Record<string, string> = {};
  const outputFiles: Record<string, string> = { out_narration: "narration_stitched.mp3" };
  segUrls.forEach((url, i) => { inputFiles[`in_seg${i}`] = url; });

  const SILENCE_TRIM = "silenceremove=start_periods=1:start_duration=0:start_threshold=-40dB:stop_periods=-1:stop_duration=0.05:stop_threshold=-40dB";

  let filter = "";
  const labels: string[] = [];
  segUrls.forEach((_, i) => {
    const isLast = i === segUrls.length - 1;
    if (!isLast && gapSeconds > 0) {
      filter += `[${i}:a]${SILENCE_TRIM},apad=pad_dur=${gapSeconds.toFixed(3)}[a${i}];`;
    } else {
      filter += `[${i}:a]${SILENCE_TRIM}[a${i}];`;
    }
    labels.push(`[a${i}]`);
  });
  filter += `${labels.join("")}concat=n=${segUrls.length}:v=0:a=1[outa]`;

  const inputArgs = segUrls.map((_, i) => `-i {{in_seg${i}}}`).join(" ");
  const ffmpegCmd = `${inputArgs} -filter_complex "${filter}" -map "[outa]" -c:a libmp3lame -b:a 128k -ar 44100 {{out_narration}}`;

  await log(sb, runId, "info", `Stitching ${segUrls.length} segments via Rendi (gap=${gapMs}ms)`);
  const rendiResp = await fetch("https://api.rendi.dev/v1/run-ffmpeg-command", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": RENDI_API_KEY },
    body: JSON.stringify({ ffmpeg_command: ffmpegCmd, input_files: inputFiles, output_files: outputFiles, max_command_run_seconds: 60, vcpu_count: 4 }),
  });
  if (!rendiResp.ok) throw new Error(`Rendi stitch submit failed: ${await rendiResp.text()}`);
  const { command_id } = await rendiResp.json();

  // Poll
  let stitchedUrl: string | null = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const p = await fetch(`https://api.rendi.dev/v1/commands/${command_id}`, { headers: { "X-API-KEY": RENDI_API_KEY } });
    const pj = await p.json();
    if (pj.status === "SUCCESS") { stitchedUrl = pj.output_files?.out_narration?.storage_url; break; }
    if (pj.status === "FAILED") throw new Error(`Rendi stitch failed: ${pj.error_message || JSON.stringify(pj).substring(0, 300)}`);
  }
  if (!stitchedUrl) throw new Error("Rendi stitch timed out after 180s");

  // Download stitched MP3
  const stitchedResp = await fetch(stitchedUrl);
  if (!stitchedResp.ok) throw new Error(`Failed to download stitched MP3: ${stitchedResp.status}`);
  const stitchedBytes = new Uint8Array(await stitchedResp.arrayBuffer());

  // Build merged alignment so stage 8 can derive beat timings from text matching
  const alignment = mergeAlignments(perSegment, gapSeconds);
  const totalDuration = alignment.character_end_times_seconds.slice(-1)[0] || 0;

  const path = `story-runs/${runId}/narration.mp3`;
  const url = await uploadAndStoreAsset(sb, runId, path, stitchedBytes, "narration_audio", {
    duration_estimate: totalDuration,
    character_count: fullText.length,
    segmented: true,
    segment_count: segments.length,
    gap_ms: gapMs,
  });

  await log(sb, runId, "info", `Segmented narration stitched: ${segments.length} segments → ${(stitchedBytes.length / 1024).toFixed(0)}KB, ${totalDuration.toFixed(2)}s`);
  return { path, signedUrl: url, alignment };
}

async function stage7(sb: SB, runId: string, script: any) {
  await updateRun(sb, runId, { status: "narration_generated", current_stage: "narration_generated", progress_pct: 34 });

  const projCfg = await getProjectConfig(sb, runId);
  const narrationCfg = projCfg?.narration || {};
  const segmentedEnabled = !!narrationCfg.segmented_enabled;
  const gapMs = typeof narrationCfg.segment_gap_ms === "number" ? narrationCfg.segment_gap_ms : 80;

  await log(sb, runId, "info", `Stage 7: Generating narrator MP3 (mode=${segmentedEnabled ? `segmented gap=${gapMs}ms` : "single-call"})`);

  if (segmentedEnabled) {
    return await stage7Segmented(sb, runId, script, gapMs);
  }

  const fullText = script.full_script;
  const { audioBytes, alignment } = await callElevenLabsWithTimestamps(fullText);
  const path = `story-runs/${runId}/narration.mp3`;
  const url = await uploadAndStoreAsset(sb, runId, path, audioBytes, "narration_audio", {
    duration_estimate: alignment?.character_end_times_seconds?.slice(-1)?.[0] || null,
    character_count: fullText.length,
    segmented: false,
  });

  await log(sb, runId, "info", `Narration MP3 generated: ${(audioBytes.length / 1024).toFixed(0)}KB`);
  return { path, signedUrl: url, alignment };
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
      { role: "system", content: `You are a visual director for short-form emotional storytelling videos in a CONSISTENT WARM SEMI-REALISTIC CINEMATIC STYLE.

Art style rules (apply to EVERY scene):
- Warm, semi-realistic human characters, soft facial features, expressive eyes, natural skin texture
- Slightly stylized proportions (not cartoon, not hyper-realistic)
- Cinematic lighting, shallow depth of field, 35mm lens look, soft contrast, warm color grading
- Highly detailed but NOT hyper-realistic; NOT cartoon, NOT anime, NOT 3D render, NOT stock photo
- Maintain the SAME character design (face shape, hair, outfit colors, distinguishing features) in every scene

Return ONLY valid JSON.` },
      { role: "user", content: `Generate one visual scene prompt per beat for this story video. Every prompt MUST describe the scene in the consistent warm semi-realistic cinematic style defined above.

Story: "${story.title}"
Summary: ${story.summary}
Characters: ${JSON.stringify(story.characters)}
Locations: ${JSON.stringify(story.locations)}

Beats:
${timedBeats.map((b: any, i: number) => `Beat ${i}: "${b.text}" (${b.purpose}, ${b.duration?.toFixed(1)}s) — Visual: ${b.visual_intent}`).join("\n")}

For each beat return a detailed image prompt. Start every prompt with "Warm semi-realistic cinematic style:" and include character appearance details (hair color, outfit, distinguishing features) to ensure consistency across scenes.

Return JSON:
{
  "scenes": [
    {"beat_index": 0, "prompt": "Warm semi-realistic cinematic style: [detailed scene]...", "characters_in_scene": ["names"], "location": "where", "target_duration": 3.65}
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
    if (doneIndices.has(i)) { imageUrls.push(`story-runs/${runId}/scene_${i}.png`); continue; }
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
      const stylePrefix = "Warm, semi-realistic human character, soft facial features, expressive eyes, natural skin texture, slightly stylized proportions, cinematic lighting, shallow depth of field, 35mm lens, soft contrast, warm color grading, highly detailed but not hyper-realistic, consistent character design. ";
      const imgResult = await callImage({
        prompt: `${stylePrefix}${scene.prompt}\n\nIMPORTANT: Warm semi-realistic cinematic style — NOT cartoon, NOT anime, NOT 3D render, NOT hyper-realistic. Use the cast reference image for character design consistency (same face shape, hair, outfit colors). Vertical 9:16 format. Cinematic warm lighting, shallow depth of field, 35mm lens look. NO text, words, letters, watermarks, or typography in the image.`,
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
      if (err instanceof Image503RetryableError) {
        const { data: cur } = await sb.from("story_runs").select("generated_metadata").eq("id", runId).single();
        const existingMeta = (cur?.generated_metadata as any) || {};
        await updateRun(sb, runId, {
          generated_metadata: {
            ...existingMeta,
            scene_images_progress: i,
            total_scenes: scenes.length,
            scene_image_retry: {
              scene_index: i,
              reason: err.reason,
              at: new Date().toISOString(),
            },
          },
          progress_pct: 48 + Math.round((i / scenes.length) * 12),
        });
        await log(sb, runId, "warn", `Scene image ${i + 1}/${scenes.length} retriable (${err.reason}), re-chaining...`);
        return { partial: true, completed: i, imageUrls };
      }

      await log(sb, runId, "error", `Scene image ${i + 1}/${scenes.length} failed: ${(err as Error).message}`);
      imageUrls.push(""); // placeholder
    }
  }

  return { partial: false, completed: scenes.length, imageUrls };
}

// ══════════════════════════════════════════════════════════
// STAGE 11: Animate Scene Clips (Vidu Q3 Turbo)
// ══════════════════════════════════════════════════════════

async function stage11(sb: SB, runId: string, scenes: any[], offPeak = false) {
  await updateRun(sb, runId, { status: "scenes_generating", current_stage: "scenes_generating", progress_pct: 62 });
  await log(sb, runId, "info", `Stage 11: Submitting ${scenes.length} scene clips to Vidu Q3 Turbo${offPeak ? " (off-peak)" : ""}`);

  const VIDU_API_KEY = Deno.env.get("VIDU_API_KEY");
  if (!VIDU_API_KEY) throw new Error("VIDU_API_KEY not configured");

  // Get scene image URLs
  const { data: sceneAssets } = await sb.from("story_assets")
    .select("*").eq("run_id", runId).eq("type", "scene_image")
    .order("scene_index", { ascending: true });

  if (!sceneAssets?.length) throw new Error("No scene images found");

  // Check for already-submitted clips (idempotency on re-chain)
  const { data: existingClips } = await sb.from("story_assets")
    .select("scene_index, metadata").eq("run_id", runId).eq("type", "scene_video_raw");
  const submittedIndices = new Set(
    (existingClips || [])
      .filter(c => {
        const m = c.metadata as any;
        return m?.vidu_task_id && m.status !== "failed";
      })
      .map(c => c.scene_index)
  );

  const tasks: { sceneIndex: number; taskId: string; targetDuration: number }[] = [];

  // Include already-submitted tasks in the return value so metadata stays accurate
  for (const existing of (existingClips || [])) {
    const m = existing.metadata as any;
    if (m?.vidu_task_id && m.status !== "failed" && existing.scene_index != null) {
      tasks.push({ sceneIndex: existing.scene_index, taskId: m.vidu_task_id, targetDuration: m.target_duration || 4 });
    }
  }

  for (let i = 0; i < sceneAssets.length; i++) {
    // Skip already-submitted scenes
    if (submittedIndices.has(i)) {
      await log(sb, runId, "debug", `Scene ${i} already submitted, skipping`);
      continue;
    }

    // Check cancellation during long submission loops
    await checkCancelled(sb, runId);

    const asset = sceneAssets[i];
    const scene = scenes[i] || {};
    const targetDuration = scene.target_duration || 4;
    const requestDuration = Math.ceil(targetDuration);

    const { data: signedData } = await sb.storage.from("project-assets")
      .createSignedUrl(asset.supabase_path, 3600);
    const imageUrl = signedData?.signedUrl;
    if (!imageUrl) { await log(sb, runId, "warn", `No URL for scene image ${i}`); continue; }

    try {
      const viduResp = await fetch("https://api.vidu.com/ent/v2/img2video", {
        method: "POST",
        headers: {
          "Authorization": `Token ${VIDU_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "viduq3-turbo",
          images: [imageUrl],
          prompt: `Snappy, dynamic cinematic animation of scene: ${scene.prompt?.substring(0, 200) || "energetic motion"}. Sudden, decisive action — quick character gestures, fast head turns, expressive reactions. Punchy camera moves: rapid push-ins, snap pans, whip-tilts, quick rack-focus. High energy pacing with clear motion beats. Avoid slow drifts or static holds.`,
          duration: Math.min(requestDuration, 16),
          audio: false,
          resolution: "720p",
          ...(offPeak ? { off_peak: true } : {}),
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

  await log(sb, runId, "info", `All ${tasks.length} Vidu tasks tracked. Invoking poller.`);
  return tasks;
}

// ══════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  PIPELINE_START = Date.now(); // Reset per-request to avoid stale warm-start values
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
      const _projCfg = await getProjectConfig(sb, runId);
      const _offPeak = !!_projCfg?.vidu_off_peak;
      const tasks = await stage11(sb, runId, scenes, _offPeak);
      await updateRun(sb, runId, { generated_metadata: { ...meta, vidu_tasks: tasks } });
      await postStage11(sb, runId, tasks, _offPeak);
      return new Response(JSON.stringify({ status: "scenes_generating" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (resumeStage === "stage6") {
      await log(sb, runId, "info", "Resuming from stage 6 (narration)");
      const story = meta.story;
      const script = await stage6(sb, runId, story, meta.target_duration || 60);
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

      const _projCfg = await getProjectConfig(sb, runId);
      const _offPeak = !!_projCfg?.vidu_off_peak;
      const tasks = await stage11(sb, runId, scenes, _offPeak);
      await updateRun(sb, runId, { generated_metadata: { ...meta, script, narration: { path: narration.path }, timed_beats: timedBeats, scenes, vidu_tasks: tasks } });
      await postStage11(sb, runId, tasks, _offPeak);
      return new Response(JSON.stringify({ status: "scenes_generating" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (resumeStage === "stage5") {
      await log(sb, runId, "info", "Resuming from stage 5 (cast image)");
      const story = meta.story;
      const realImage = meta.real_image || null;

      let castResult: any;
      try {
        castResult = await stage5(sb, runId, story, realImage);
      } catch (err) {
        if ((err as any)?.name === "Image503RetryableError") {
          await log(sb, runId, "warn", "Cast image timed out on resume, re-chaining...");
          await selfChain(runId, "stage5");
          return new Response(JSON.stringify({ status: "chaining_retry" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        await failRun(sb, runId, `Cast image failed: ${(err as Error).message}`);
        return new Response(JSON.stringify({ error: "Cast failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Store story in memory
      const projectId = meta.project_id || (await sb.from("story_runs").select("project_id").eq("id", runId).single()).data?.project_id;
      const fp = (story.summary || "").substring(0, 100).toLowerCase().replace(/[^a-z0-9]/g, "");
      await sb.from("story_memory").insert({ project_id: projectId, run_id: runId, story_title: story.title, story_fingerprint: fp, source_url: story.source_url || null });

      await updateRun(sb, runId, { status: "cast_generated", current_stage: "cast_generated", progress_pct: 25, generated_metadata: { ...meta, cast_image: castResult } });

      if (shouldChain()) { await selfChain(runId, "stage6"); return new Response(JSON.stringify({ status: "chaining_stage6" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

      // Continue to stage 6+
      const script = await stage6(sb, runId, story, meta.target_duration || 60);
      await updateRun(sb, runId, { generated_metadata: { ...meta, cast_image: castResult, script } });

      if (shouldChain()) { await selfChain(runId, "stage7"); return new Response(JSON.stringify({ status: "chaining_stage7" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

      const narration = await stage7(sb, runId, script);
      const timedBeats = await stage8(sb, runId, script, narration.alignment);
      await updateRun(sb, runId, { generated_metadata: { ...meta, cast_image: castResult, script, narration: { path: narration.path }, timed_beats: timedBeats } });

      if (shouldChain()) { await selfChain(runId, "stage9"); return new Response(JSON.stringify({ status: "chaining_stage9" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

      const scenes = await stage9(sb, runId, story, timedBeats);
      await updateRun(sb, runId, { generated_metadata: { ...meta, cast_image: castResult, script, narration: { path: narration.path }, timed_beats: timedBeats, scenes } });

      const imgResult = await stage10(sb, runId, scenes, castResult.path);
      if (imgResult.partial) { await selfChain(runId, "stage10_continue"); return new Response(JSON.stringify({ status: "chaining_stage10" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

      const _projCfg = await getProjectConfig(sb, runId);
      const _offPeak = !!_projCfg?.vidu_off_peak;
      const tasks = await stage11(sb, runId, scenes, _offPeak);
      await updateRun(sb, runId, { generated_metadata: { ...meta, cast_image: castResult, script, narration: { path: narration.path }, timed_beats: timedBeats, scenes, vidu_tasks: tasks } });
      await postStage11(sb, runId, tasks, _offPeak);
      return new Response(JSON.stringify({ status: "scenes_generating" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (resumeStage === "stage7") {
      const story = meta.story;
      const script = meta.script || await stage6(sb, runId, story, meta.target_duration || 60);
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

      const _projCfg = await getProjectConfig(sb, runId);
      const _offPeak = !!_projCfg?.vidu_off_peak;
      const tasks = await stage11(sb, runId, scenes, _offPeak);
      await updateRun(sb, runId, { generated_metadata: { ...meta, scenes, vidu_tasks: tasks } });
      await postStage11(sb, runId, tasks, _offPeak);
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
        story = await stage2(sb, runId, context.lastTitles, context.targetDuration, context.storySearchPrompt);
        if (await stage3(sb, runId, story, context.fingerprints, context.lastTitles)) break;
        story = null;
      } catch (err) {
        await log(sb, runId, "error", `Story attempt ${attempt}: ${(err as Error).message}`);
        if (attempt === 3) { await failRun(sb, runId, `Story discovery failed: ${(err as Error).message}`); return new Response(JSON.stringify({ error: "Story failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      }
    }
    if (!story) { await failRun(sb, runId, "No valid story found after 3 attempts"); return new Response(JSON.stringify({ error: "No story" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

    await checkCancelled(sb, runId);
    await updateRun(sb, runId, { status: "story_selected", current_stage: "story_selected", progress_pct: 14, generated_metadata: { ...meta, story, target_duration: context.targetDuration } });

    // Stage 4: Real image
    let realImage: any = null;
    try { realImage = await stage4(sb, runId, story); } catch (err) {
      if ((err as any)?.name === "CancelledError") throw err;
      await log(sb, runId, "warn", `Real image failed: ${(err as Error).message}`);
    }
    await checkCancelled(sb, runId);
    await updateRun(sb, runId, { generated_metadata: { ...meta, story, real_image: realImage, target_duration: context.targetDuration }, progress_pct: 20 });

    if (shouldChain()) {
      await selfChain(runId, "stage5");
      return new Response(JSON.stringify({ status: "chaining" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Stage 5: Cast image (retryable on timeout/503)
    let castResult: any;
    try {
      castResult = await stage5(sb, runId, story, realImage);
    } catch (err) {
      if ((err as any)?.name === "CancelledError") throw err;
      if ((err as any)?.name === "Image503RetryableError") {
        await log(sb, runId, "warn", `Cast image timed out, re-chaining to retry...`);
        await selfChain(runId, "stage5");
        return new Response(JSON.stringify({ status: "chaining_retry" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      await failRun(sb, runId, `Cast image failed: ${(err as Error).message}`);
      return new Response(JSON.stringify({ error: "Cast failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Store story in memory
    const fp = (story.summary || "").substring(0, 100).toLowerCase().replace(/[^a-z0-9]/g, "");
    await sb.from("story_memory").insert({ project_id: context.projectId, run_id: runId, story_title: story.title, story_fingerprint: fp, source_url: story.source_url || null });

    await checkCancelled(sb, runId);
    await updateRun(sb, runId, { status: "cast_generated", current_stage: "cast_generated", progress_pct: 25, generated_metadata: { ...meta, story, real_image: realImage, cast_image: castResult, target_duration: context.targetDuration } });

    if (shouldChain()) {
      await selfChain(runId, "stage6");
      return new Response(JSON.stringify({ status: "chaining_stage6" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Stage 6: Narration script
    await checkCancelled(sb, runId);
    const script = await stage6(sb, runId, story, context.targetDuration);
    await updateRun(sb, runId, { generated_metadata: { ...meta, story, real_image: realImage, cast_image: castResult, script, target_duration: context.targetDuration } });

    if (shouldChain()) {
      await selfChain(runId, "stage7");
      return new Response(JSON.stringify({ status: "chaining_stage7" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Stage 7: Narrator MP3
    await checkCancelled(sb, runId);
    const narration = await stage7(sb, runId, script);

    // Stage 8: Beat timing
    const timedBeats = await stage8(sb, runId, script, narration.alignment);
    await checkCancelled(sb, runId);
    await updateRun(sb, runId, { generated_metadata: { ...meta, story, real_image: realImage, cast_image: castResult, script, narration: { path: narration.path }, timed_beats: timedBeats } });

    if (shouldChain()) {
      await selfChain(runId, "stage9");
      return new Response(JSON.stringify({ status: "chaining_stage9" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Stage 9: Scene prompts
    await checkCancelled(sb, runId);
    const scenes = await stage9(sb, runId, story, timedBeats);
    await updateRun(sb, runId, { generated_metadata: { ...meta, story, real_image: realImage, cast_image: castResult, script, narration: { path: narration.path }, timed_beats: timedBeats, scenes } });

    // Stage 10: Scene images
    await checkCancelled(sb, runId);
    const imgResult = await stage10(sb, runId, scenes, castResult.path);
    if (imgResult.partial) {
      await selfChain(runId, "stage10_continue");
      return new Response(JSON.stringify({ status: "chaining_stage10" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Stage 11: Animate clips
    await checkCancelled(sb, runId);
    const _projCfg = await getProjectConfig(sb, runId);
    const _offPeak = !!_projCfg?.vidu_off_peak;
    const tasks = await stage11(sb, runId, scenes, _offPeak);
    await updateRun(sb, runId, { generated_metadata: { ...meta, story, real_image: realImage, cast_image: castResult, script, narration: { path: narration.path }, timed_beats: timedBeats, scenes, vidu_tasks: tasks } });

    // Hand off to poller
    await postStage11(sb, runId, tasks, _offPeak);

    return new Response(JSON.stringify({ success: true, stage: "scenes_generating", story_title: story.title }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    if ((err as any)?.name === "CancelledError") {
      return new Response(JSON.stringify({ status: "cancelled" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    console.error("Story pipeline error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
