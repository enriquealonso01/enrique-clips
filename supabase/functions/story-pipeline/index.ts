import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { callStructured, callText, callImage, MODELS, Image503RetryableError, setImageServiceTier } from "../_shared/openai.ts";
import { r2Upload, mediaPublicUrl } from "../_shared/r2.ts";

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

// ── Stories pipeline tuning constants ──
// Target a 25-30s reel by default — short-form sweet spot. Hard-clamped in
// stage1 so a stale story_projects row with target_duration_sec=60 (the old
// default) still produces a tight video.
const STORY_TARGET_DURATION_DEFAULT = 28;
const STORY_TARGET_DURATION_MIN = 22;
const STORY_TARGET_DURATION_MAX = 32;

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
      Authorization: `Bearer ${Deno.env.get("INTERNAL_FN_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
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
      Authorization: `Bearer ${Deno.env.get("INTERNAL_FN_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function fetchImageAsBase64(url: string): Promise<string | undefined> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
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

async function uploadAndStoreAsset(sb: SB, runId: string, path: string, data: Uint8Array, type: string, metadata: any = {}, sceneIndex?: number, cost_usd?: number) {
  const { publicUrl } = await r2Upload(path, data, type.includes("image") ? "image/png" : "video/mp4");
  await sb.from("story_assets").insert({
    run_id: runId,
    type: type as any,
    supabase_path: path,
    signed_url_last: publicUrl,
    metadata,
    scene_index: sceneIndex ?? null,
    ...(cost_usd != null ? { cost_usd } : {}),
  });
  return publicUrl;
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
  const rawTargetDuration = Number(project?.target_duration_sec) || STORY_TARGET_DURATION_DEFAULT;
  const targetDuration = Math.max(
    STORY_TARGET_DURATION_MIN,
    Math.min(STORY_TARGET_DURATION_MAX, rawTargetDuration),
  );

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

async function stage2(sb: SB, runId: string, lastTitles: string[], targetDuration: number = STORY_TARGET_DURATION_DEFAULT, storySearchPrompt: string = "") {
  await updateRun(sb, runId, { status: "researching_story", current_stage: "researching_story", progress_pct: 8 });
  await log(sb, runId, "info", `Stage 2: Discovering story via AI${storySearchPrompt ? ` (category: ${storySearchPrompt})` : ""}`);

  const titlesBlock = lastTitles.length > 0
    ? `\n\nPREVIOUSLY USED TITLES (DO NOT reuse):\n${lastTitles.map((t, i) => `${i + 1}. ${t}`).join("\n")}` : "";

  // 25-30s short-form: one beat per ~4-5s of finished narration.
  // The narration script step (stage 6) is the source of truth for final beat
  // count; this just gives the discovery model a sane budget so the SUMMARY
  // is sized for a Reel, not a YouTube long-form.
  const minBeats = Math.max(4, Math.round(targetDuration / 6));
  const maxBeats = Math.max(6, Math.round(targetDuration / 4));

  const categoryInstruction = storySearchPrompt
    ? `\n- CATEGORY REQUIREMENT: The story MUST match this category/topic: "${storySearchPrompt}". Only pick stories that fit this requirement.`
    : "";

  return await callStructured({
    messages: [
      { role: "system", content: `You are a senior story producer for a faceless emotional short-form video channel. Your only job is to find ONE real-world story that has the raw material to be told as a ${targetDuration}-second vertical Reel that LANDS emotionally and gets shared. You think like a peak-end-rule editor: every choice serves the final 3 seconds. Return ONLY valid JSON.

NON-NEGOTIABLE STORY-SELECTION RULES:
1. SINGULARITY — ONE identifiable protagonist, ONE relationship, ONE pivotal moment. No "many people", no statistics, no montage of cases. (Identifiable-victim effect: a single person out-moves any group.)
2. RESOLVES UPWARD — the story MUST end higher than it started (warmth, honoring, reunion, restoration, vindication). Pure sadness without recovery is the under-shared quadrant. The emotional target is BEING MOVED ("lump in the throat, warmth in the chest"), NOT being sad.
3. KAMA MUTA TRIGGER — there must be a "sudden intensification of love or connection" moment: a reunion, an unknown sacrifice revealed, an act of devotion across time, an honoring of someone lost. That moment is the reason this story exists.
4. CONCRETE TEXTURE — one specific detail that no other story has (an age, an exact object, a duration, an engraving, a specific habit). NOT a verifiable famous person's full identity (we are not running a news clip — we're telling a story).
5. VISUAL RAW MATERIAL — the story can be told with ${minBeats}-${maxBeats} discrete moments that an image+animation pipeline can render. Avoid stories whose punch is purely verbal/abstract.
6. AVOIDS RAGEBAIT — no "the family abandoned her", no villain-coded relatives, no exploitation framing. Quiet dignity > melodrama.` },
      { role: "user", content: `Find ONE new story for a ${targetDuration}-second vertical Reel.${categoryInstruction}

HOOK LINE (≤14 words, the opening sentence the viewer reads/hears in the first 2 seconds):
- Hits at least TWO psychological levers. The strongest archetypes for emotional micro-stories are:
  • In Medias Res — drop the viewer mid-action: "And that's when she opened the box."
  • Specificity — concrete number/date/place: "Forty-one years. Then the watch stopped."
  • Curiosity Gap — narrow, resolvable: "Nobody understood the note until they translated it."
  • Stakes Reframe — tiny act, huge consequence: "She mailed one letter. It found him in 1974."
- NO "Hey guys", NO "Today I want to talk about", NO context dump, NO hedging.
- Reads SHARP at 0.0s muted, on a 9:16 screen.

REWARD MOMENT (the peak — the kama-muta beat):
- The single moment of "sudden connection" that the whole video is built to reach. NOT "everything worked out" — the SPECIFIC visible thing that makes the viewer feel the lump in the throat.

DRAFT BEATS (${minBeats}-${maxBeats} beats):
- Each beat is ONE narrated moment, ${Math.floor(targetDuration / maxBeats)}-${Math.ceil(targetDuration / minBeats)}s of finished video.
- Beat 0 carries the hook. The LAST beat is the BUTTON — a recontextualizing closer that makes the whole story land harder than the literal facts ("And ever since then, he keeps it on his nightstand").
- Causal spine: every beat connects to the next with BUT (turn) or THEREFORE (consequence). If "and then" fits naturally between two beats, that seam is dead — rewrite.

Return JSON:
{
  "title": "...",
  "source_url": "...",
  "summary": "3-4 sentence detailed summary",
  "hook": "the ≤14-word opening line",
  "reward_moment": "the specific kama-muta beat the video is built to reach",
  "button_line": "the recontextualizing closer (the LAST thing the viewer hears, ≤12 words, present tense if possible)",
  "event_date": "e.g. 'March 2023' — or '' if unknown",
  "event_location": "e.g. 'Austin, Texas' — or '' if unknown",
  "characters": [{"name":"...","role":"...","appearance_notes":"..."}],
  "groups": [{"name":"...","description":"..."}],
  "locations": [{"name":"...","description":"..."}],
  "draft_beats": [{"text":"narration text","purpose":"hook|build|turn|peak|button","visual_intent":"the one specific thing on screen"}],
  "image_search_guidance": "..."
}

IMPORTANT: For event_date and event_location, only include if verifiable. Use "" when unknown — do not guess.
IMPORTANT: Provide EXACTLY ${minBeats}-${maxBeats} draft beats. More is worse — short-form punishes over-length.${titlesBlock}` },
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
  let resp: Response;
  try {
    resp = await fetch(`https://api.search.brave.com/res/v1/images/search?${params}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.error(`Brave image search fetch error: ${(e as Error).message}`);
    return [];
  }
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
  let resp: Response;
  try {
    resp = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.error(`Brave web search fetch error: ${(e as Error).message}`);
    return [];
  }
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
    const headResp = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8_000) });
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
      signal: AbortSignal.timeout(8_000),
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
      model: "gemini-2.5-flash-lite",
      endpoint: "story_image_relevance",
      noRetryOn503: true,
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
    prompt, model: MODELS.IMAGE_FINAL, size: "9:16", quality: "medium",
    endpoint: "story_real_image_fallback",
  });

  const path = `story-runs/${runId}/real_image.png`;
  const bytes = Uint8Array.from(atob(imageResult.b64_json), c => c.charCodeAt(0));
  const signedUrl = await uploadAndStoreAsset(sb, runId, path, bytes, "real_image", {
    image_type: "generated_photorealistic",
    image_description: `AI-generated photorealistic image for "${story.title}"`,
    characters_visible: (story.characters || []).map((c: any) => c.name),
    source: "gemini_generation",
  }, undefined, imageResult.cost_usd);

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
    prompt, model: MODELS.IMAGE_FINAL, size: "9:16", quality: "medium",
    endpoint: "story_cast_image", referenceImage: refData,
  });

  const path = `story-runs/${runId}/cast_reference.png`;
  const bytes = Uint8Array.from(atob(imageResult.b64_json), c => c.charCodeAt(0));
  const url = await uploadAndStoreAsset(sb, runId, path, bytes, "cast_reference_image", { story_title: story.title }, undefined, imageResult.cost_usd);
  return { path, signedUrl: url };
}

// ══════════════════════════════════════════════════════════
// STAGE 6: Final Narration Script
// ══════════════════════════════════════════════════════════

async function stage6(sb: SB, runId: string, story: any, targetDuration: number = STORY_TARGET_DURATION_DEFAULT) {
  await updateRun(sb, runId, { current_stage: "narration_script", progress_pct: 28 });
  await log(sb, runId, "info", `Stage 6: Generating final narration script (target: ${targetDuration}s)`);

  // 25-30s short-form: 4-6 beats. One beat = one Vidu clip ≈ 4-6s.
  const minBeats = 4;
  const maxBeats = 6;

  // Word-budget math.
  // Conversational narration runs ~2.5-3 wps (~150-180 wpm). Aggressive
  // silenceremove between beats removes ~25-35% of raw audio. We target ~3.8
  // wps measured on the final stitched MP3 — punchy, kinetic. For 28s that
  // is ~106 words. We write ~110 words (a hair more) so the trimmed result
  // lands at target instead of falling short.
  const WORDS_PER_SEC_AFTER_TRIM = 3.8;
  const targetWords = Math.round(targetDuration * WORDS_PER_SEC_AFTER_TRIM);
  const minWords = Math.round(targetDuration * 3.4);
  const maxWords = Math.round(targetDuration * 4.2);

  const buttonHint = story.button_line || story.reward_moment || "";

  const result = await callStructured({
    messages: [
      { role: "system", content: `You are the senior scriptwriter for a faceless emotional short-form video channel. Your only job is to write the spoken narration for ONE ${targetDuration}-second vertical Reel. You write for the EAR and for a muted scroller's EYE. The cadence is punchy, conversational, and never lulls.

NON-NEGOTIABLE RULES — a script that breaks any of these is rejected:

1. EMOTIONAL TARGET = "MOVED," NOT "SAD."
   The dominant final feeling must be warmth, honoring, or sudden connection (lump in the throat, tears of warmth) — NEVER deflated sadness. Loss is BACKDROP only. The story MUST resolve UPWARD. End higher than it began. Never end in the sad trough.

2. BUTTON FIRST.
   Write the LAST line first. It must RECONTEXTUALIZE the whole story (the "for sale: baby shoes" turn). Make it short, present tense if possible, falling intonation. The button is the story.

3. CAUSAL SPINE — BUT / THEREFORE TEST.
   Every beat connects to the next with BUT (a reversal) or THEREFORE (a consequence) — NEVER "and then". Read your beats aloud inserting "and then" at each seam; if it fits, the seam is dead — rewrite.

4. SINGULARITY.
   ONE protagonist, ONE relationship, ONE pivotal moment. No plurals, no statistics, no shop credentials, no "people often…". Numbers KILL the feeling. The only allowed numbers are concrete textures (an age, "forty-one years", an engraving) — not aggregates.

5. SHOW, DON'T TELL (iceberg).
   Never state the emotion ("heartbreaking", "devastated", "tragic"). Imply it through concrete fact ("the watch stopped the week he died"). NO adjective stacks. Trust the detail.

6. PACE — NO LULLS.
   Short declarative sentences. Most beats 8-14 words. Every beat earns its place: if a beat doesn't advance OR raise emotional voltage, cut it.

7. UNDERSTATED.
   Restraint reads real. Melodrama reads fake AND tips viewers into aversive distress (they scroll away). Underplay it.

8. NO CTA in narration.
   The narration ends on the BUTTON. Never end with "follow for more", "comment below", "tag a friend".

VOICE: First-person narrator who is the WITNESS — the protagonist and their relationship are the subject, not the narrator. Plain, warm, unhurried, sincere. Past tense for the story; PRESENT tense at the reveal — that tense shift IS the resurrection.

Return ONLY valid JSON, no markdown fences.` },
      { role: "user", content: `Write the narration for this story.

TITLE: ${story.title}
HOOK (from discovery): ${story.hook}
REWARD MOMENT: ${story.reward_moment}
${buttonHint ? `BUTTON HINT: ${buttonHint}` : ""}
SUMMARY: ${story.summary}
DRAFT BEATS (from discovery — may need consolidation): ${JSON.stringify(story.draft_beats)}

HARD CONSTRAINTS:

• TARGET DURATION: ${targetDuration}s (range ${STORY_TARGET_DURATION_MIN}-${STORY_TARGET_DURATION_MAX}s). Anything past ${STORY_TARGET_DURATION_MAX}s is rejected.
• WORD COUNT: ${minWords}-${maxWords} words total. AIM for ~${targetWords} words. Count your words before returning.
• BEAT COUNT: ${minBeats}-${maxBeats} beats. Each beat = ONE Vidu clip of ~${Math.floor(targetDuration / maxBeats)}-${Math.ceil(targetDuration / minBeats)}s. Roughly even in length.
• BEAT WORDS: 8-14 words per beat (the punchy short-form rhythm). Beat 0 (the hook) can drop to 6 words; the final beat (button) can drop to 5.

STRUCTURE (the 5-beat spine — adapt for 4 or 6 beats by collapsing or splitting MIDDLE beats only; never collapse the hook or the button):

  BEAT 0 — HOOK (≤14 words)
    The opening line. Hits at least TWO of: in-medias-res, specificity, curiosity gap, stakes.
    Reads SHARP at 0s. NO "Hey", "Today", "So", "Okay".

  BEAT 1 — RELATIONSHIP / SETUP (10-14 words)
    The bond, the stakes, ONE concrete texture. Plant the essence that the reveal will reactivate.

  BEAT 2 — THE TURN (10-14 words)
    The pivot. "But..." or the moment everything changed. Restrained — implied, not wallowed.

  BEAT 3 — THE WORK / BUILD (8-12 words)
    Brief. The doing/searching/fixing. Sparse VO over visuals.

  BEAT 4 — REVEAL / PEAK (6-10 words)
    The kama-muta moment. Present tense. The moment of sudden connection. Land it on a single specific image.

  BEAT 5 — BUTTON (≤10 words, ≤8 if possible)
    The recontextualizing closer. Falls in pitch. Present tense if possible. RECONTEXTUALIZES — does not just summarize.

If using ${minBeats} beats: collapse beats 2-3 into one "turn + work" beat. If using ${maxBeats} beats: split beat 3 (work) into "search" + "find". NEVER drop the hook or the button.

CRITICAL — THE BUTTON (the closer):
- The LAST beat MUST be a complete declarative sentence ending with "." or "!".
- It MUST RECONTEXTUALIZE — re-cast the meaning of what came before. Example: hook says "He pawned his father's watch." Button says "He finally had the time." (the inscription re-fires).
- NEVER end with a question, comma, dash, ellipsis, semicolon.
- NEVER start with "and", "but", "so", "because", "while", "until", "then" used as a hanging fragment.
- NEVER end with prepositions implying continuation ("...waiting for…").

CRITICAL — THE HOOK (beat 0):
- ≤14 words. The viewer reads/hears it in the first 2 seconds.
- Hits at least TWO psychological levers (in-medias-res, specificity, curiosity gap, stakes-reframe).
- Sets up an "open loop" the rest of the script closes.
- Must read SHARP muted at 0s.

CAUSAL SEAM CHECK (do this before returning):
- Read beats 0→1, 1→2, 2→3, 3→4, 4→5 aloud. If "and then" fits naturally at ANY seam, REWRITE the second beat to make it BUT or THEREFORE.

EMOTIONAL ARC CHECK:
- The viewer should END on UPWARD warmth, not downward sadness. If your final beat leaves them deflated, rewrite the button.

Return JSON ONLY (no prose, no markdown):
{
  "button_line": "the closer — write this FIRST and use it verbatim as the LAST beat's text",
  "full_script": "the complete narration as one flowing block (concatenation of beat texts with spaces)",
  "beats": [
    {"index": 0, "text": "<words>", "purpose": "hook", "visual_intent": "the ONE specific thing on screen for this beat"},
    {"index": 1, "text": "<words>", "purpose": "build", "visual_intent": "..."},
    {"index": 2, "text": "<words>", "purpose": "turn", "visual_intent": "..."},
    {"index": 3, "text": "<words>", "purpose": "work", "visual_intent": "..."},
    {"index": 4, "text": "<words>", "purpose": "peak", "visual_intent": "..."},
    {"index": 5, "text": "<button_line verbatim>", "purpose": "button", "visual_intent": "..."}
  ],
  "word_count": <integer>,
  "emotion_check": "<one sentence: the warm upward feeling the button leaves>"
}` },
    ],
    model: MODELS.TEXT_DEFAULT, parseJSON: true, endpoint: "story_narration_script",
  });

  const wordsOut = (result.full_script || "").split(/\s+/).filter(Boolean).length;
  await log(sb, runId, "info", `Narration script: ${result.beats?.length || 0} beats, ${wordsOut} words, button="${(result.button_line || "").substring(0, 60)}"`);
  return result;
}

// ══════════════════════════════════════════════════════════
// STAGE 7: Generate Narrator MP3 (ElevenLabs)
// ══════════════════════════════════════════════════════════

// Default voice — used when project.config_json.narration.voice is absent.
// Tuned for emotional micro-stories: lower stability + higher style = more
// expressive variation (the engagement lever); slightly faster speed = the
// punchy short-form tempo. Per-project override via config_json.narration.voice.
const DEFAULT_ELEVENLABS_VOICE_ID = "3RbK5MAeB6NkutT3d6qF";
const DEFAULT_ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.45,
  similarity_boost: 0.75,
  style: 0.55,
  use_speaker_boost: true,
  speed: 1.10,
};

type ElevenLabsVoiceSettings = {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
};

type ElevenLabsVoiceConfig = {
  voiceId: string;
  settings: ElevenLabsVoiceSettings;
};

function resolveVoiceConfig(projectConfig: any): ElevenLabsVoiceConfig {
  const narration = (projectConfig?.narration as any) || {};
  const voice = (narration.voice as any) || {};
  const settings = (voice.settings as any) || {};
  return {
    voiceId: typeof voice.voice_id === "string" && voice.voice_id.trim() ? voice.voice_id.trim() : DEFAULT_ELEVENLABS_VOICE_ID,
    settings: {
      stability: typeof settings.stability === "number" ? settings.stability : DEFAULT_ELEVENLABS_VOICE_SETTINGS.stability,
      similarity_boost: typeof settings.similarity_boost === "number" ? settings.similarity_boost : DEFAULT_ELEVENLABS_VOICE_SETTINGS.similarity_boost,
      style: typeof settings.style === "number" ? settings.style : DEFAULT_ELEVENLABS_VOICE_SETTINGS.style,
      use_speaker_boost: typeof settings.use_speaker_boost === "boolean" ? settings.use_speaker_boost : DEFAULT_ELEVENLABS_VOICE_SETTINGS.use_speaker_boost,
      speed: typeof settings.speed === "number" ? settings.speed : DEFAULT_ELEVENLABS_VOICE_SETTINGS.speed,
    },
  };
}

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

async function callElevenLabsWithTimestamps(text: string, voiceCfg: ElevenLabsVoiceConfig, prev?: string, next?: string): Promise<{ audioBytes: Uint8Array; alignment: any }> {
  const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
  if (!ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY not configured");

  const body: any = {
    text,
    model_id: "eleven_multilingual_v2",
    voice_settings: voiceCfg.settings,
  };
  if (prev) body.previous_text = prev;
  if (next) body.next_text = next;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceCfg.voiceId}/with-timestamps?output_format=mp3_44100_128`,
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
//
// IMPORTANT: The Rendi stitch step applies `silenceremove` to each segment, stripping the
// leading silence and any trailing silence longer than ~600ms below -40dB. ElevenLabs'
// reported duration (`seg.duration` = end time of last char) includes the spoken portion,
// but ElevenLabs often appends extra trailing silence/breath to the MP3 itself that is NOT
// reflected in the alignment data. The alignment is already a tight upper bound on the
// spoken portion, so we use it directly: the stitched timeline equals the sum of
// (last_char_end_time) per segment + inter-segment gaps. This keeps downstream beat
// durations aligned with the trimmed audio that scene clips are planned around.
function mergeAlignments(
  perSegment: { alignment: any; duration: number }[],
  gapSeconds: number,
  actualStitchedDuration?: number,
) {
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  // Per-segment "effective" (post-trim, pre-scale) durations.
  const effectives: number[] = [];
  const leadingSilences: number[] = [];
  for (const seg of perSegment) {
    const a = seg.alignment;
    const spokenDur = (a?.character_end_times_seconds && a.character_end_times_seconds.length > 0)
      ? a.character_end_times_seconds[a.character_end_times_seconds.length - 1]
      : seg.duration;
    const leadingSilence = (a?.character_start_times_seconds && a.character_start_times_seconds.length > 0)
      ? a.character_start_times_seconds[0]
      : 0;
    effectives.push(Math.max(0, spokenDur - leadingSilence));
    leadingSilences.push(leadingSilence);
  }

  // Compute proportional scale so the SUM of (scaled effective durations + inter-segment gaps)
  // exactly equals the actual stitched MP3 duration. This matches what scene clips will be
  // planned around (Vidu targets), guaranteeing total clip length == final narration length.
  const totalEffective = effectives.reduce((a, b) => a + b, 0);
  const totalGaps = Math.max(0, perSegment.length - 1) * gapSeconds;
  let scale = 1;
  if (actualStitchedDuration && totalEffective > 0) {
    const targetForSegments = Math.max(0.001, actualStitchedDuration - totalGaps);
    scale = targetForSegments / totalEffective;
  }

  let offset = 0;
  for (let i = 0; i < perSegment.length; i++) {
    const seg = perSegment[i];
    const a = seg.alignment;
    const leadingSilence = leadingSilences[i];
    const scaledEffective = effectives[i] * scale;

    if (a?.characters && a?.character_start_times_seconds && a?.character_end_times_seconds) {
      for (let j = 0; j < a.characters.length; j++) {
        characters.push(a.characters[j]);
        starts.push(Math.max(0, (a.character_start_times_seconds[j] - leadingSilence) * scale) + offset);
        ends.push(Math.max(0, (a.character_end_times_seconds[j] - leadingSilence) * scale) + offset);
      }
    }
    if (i < perSegment.length - 1) {
      characters.push(" ");
      starts.push(offset + scaledEffective);
      ends.push(offset + scaledEffective + gapSeconds);
    }
    offset += scaledEffective + (i < perSegment.length - 1 ? gapSeconds : 0);
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
}

async function stage7Segmented(sb: SB, runId: string, script: any, gapMs: number, voiceCfg: ElevenLabsVoiceConfig): Promise<{ path: string; signedUrl: string | undefined; alignment: any }> {
  const RENDI_API_KEY = Deno.env.get("RENDI_API_KEY");
  if (!RENDI_API_KEY) throw new Error("RENDI_API_KEY not configured (required for segmented narration stitching)");

  const fullText: string = script.full_script;
  // Segment by NARRATIVE BEATS, not by sentence punctuation. Beats are the unit
  // of meaning the script writer composed; splitting on internal punctuation
  // (e.g. "...heartbeat, then hid that sound...") causes silenceremove to glue
  // the two halves with an unnatural cut. One beat = one ElevenLabs call.
  const beatTexts: string[] = Array.isArray(script.beats)
    ? script.beats
        .map((b: any) => (typeof b?.text === "string" ? b.text.replace(/\s+/g, " ").trim() : ""))
        .filter((s: string) => s.length > 0)
    : [];
  const segments = beatTexts.length > 0 ? beatTexts : splitIntoSegments(fullText);
  await log(sb, runId, "info", `Segmented narration: ${segments.length} segments (beat-based=${beatTexts.length > 0}) from ${fullText.length} chars`);

  if (segments.length < 2) {
    await log(sb, runId, "info", "Only one segment — falling back to single-call narration");
    const { audioBytes, alignment } = await callElevenLabsWithTimestamps(fullText, voiceCfg);
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
    // For the final segment, pass an explicit terminal cue as next_text so ElevenLabs
    // applies a falling, finished intonation instead of an upward "more coming" lift.
    const next = i < segments.length - 1
      ? segments[i + 1]
      : "[End of narration. Silence follows.]";
    const { audioBytes, alignment } = await callElevenLabsWithTimestamps(ttsText, voiceCfg, prev, next);
    const duration = alignment?.character_end_times_seconds?.slice(-1)?.[0] ?? 0;
    const uploadPath = `story-runs/${runId}/narration-segments/seg-${String(i).padStart(3, "0")}.mp3`;
    await r2Upload(uploadPath, audioBytes, "audio/mpeg");
    perSegment.push({ audioBytes, alignment, duration, uploadPath });
    await log(sb, runId, "info", `  Seg ${i + 1}/${segments.length}: ${duration.toFixed(2)}s, ${(audioBytes.length / 1024).toFixed(0)}KB${isLast ? "" : " (period stripped)"}`);
  }

  // Build signed URLs for each segment for Rendi
  const segUrls: string[] = perSegment.map((seg) => mediaPublicUrl(seg.uploadPath));

  // Build Rendi FFmpeg command:
  // LAYER A: aggressive silenceremove on each segment (strip leading silence completely
  // and trailing silence >600ms). This produces the tight, punchy narration pace the
  // user prefers. To compensate for length loss, the script writer is instructed to
  // produce many short beats with extra word count.
  const gapSeconds = Math.max(0, gapMs / 1000);
  const inputFiles: Record<string, string> = {};
  const outputFiles: Record<string, string> = { out_narration: "narration_stitched.mp3" };
  segUrls.forEach((url, i) => { inputFiles[`in_seg${i}`] = url; });

  const SILENCE_TRIM = "silenceremove=start_periods=1:start_duration=0:start_threshold=-40dB:stop_periods=1:stop_duration=0.6:stop_threshold=-40dB:detection=peak";

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

  // Estimate the ACTUAL duration of the stitched MP3 (post silenceremove).
  // Output is libmp3lame CBR at 128 kbps → bytes * 8 / 128000 ≈ seconds (very accurate for CBR).
  // We use this to proportionally scale per-segment durations in mergeAlignments so beat
  // timings (and downstream Vidu scene-clip targets) sum to the real final narration length.
  const BITRATE_BPS = 128_000;
  const ID3_OVERHEAD_BYTES = 1024; // small constant to discount tag bytes
  const measuredStitchedDuration = Math.max(
    0.1,
    ((stitchedBytes.length - ID3_OVERHEAD_BYTES) * 8) / BITRATE_BPS,
  );

  // Sum of original per-segment effective spoken durations (pre-trim-aware).
  const sumOriginalSpoken = perSegment.reduce((acc, seg) => {
    const a = seg.alignment;
    const spoken = a?.character_end_times_seconds?.slice(-1)?.[0] ?? seg.duration;
    const lead = a?.character_start_times_seconds?.[0] ?? 0;
    return acc + Math.max(0, spoken - lead);
  }, 0);
  const totalGaps = Math.max(0, perSegment.length - 1) * gapSeconds;
  const reductionRatio = sumOriginalSpoken > 0
    ? (measuredStitchedDuration - totalGaps) / sumOriginalSpoken
    : 1;
  await log(sb, runId, "info",
    `Stitched audio: measured=${measuredStitchedDuration.toFixed(2)}s, ` +
    `sum(original spoken)=${sumOriginalSpoken.toFixed(2)}s, ` +
    `gaps=${totalGaps.toFixed(2)}s, scale=${reductionRatio.toFixed(3)}`);

  // Build merged alignment scaled so beat timings sum to the real stitched duration.
  const alignment = mergeAlignments(perSegment, gapSeconds, measuredStitchedDuration);
  const totalDuration = alignment.character_end_times_seconds.slice(-1)[0] || measuredStitchedDuration;

  const path = `story-runs/${runId}/narration.mp3`;
  const url = await uploadAndStoreAsset(sb, runId, path, stitchedBytes, "narration_audio", {
    duration_estimate: totalDuration,
    measured_stitched_duration: measuredStitchedDuration,
    sum_original_spoken: sumOriginalSpoken,
    silence_trim_scale: reductionRatio,
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
  // Segmented narration (per-beat ElevenLabs calls + Rendi stitch with
  // silence-trim) is THE engine for the punchy short-form pace. Default it ON
  // unless a project explicitly opts out via narration.segmented_enabled=false.
  const segmentedEnabled = narrationCfg.segmented_enabled !== false;
  const gapMs = typeof narrationCfg.segment_gap_ms === "number" ? narrationCfg.segment_gap_ms : 60;
  const voiceCfg = resolveVoiceConfig(projCfg);

  await log(sb, runId, "info", `Stage 7: Generating narrator MP3 (voice=${voiceCfg.voiceId}, speed=${voiceCfg.settings.speed}, mode=${segmentedEnabled ? `segmented gap=${gapMs}ms` : "single-call"})`);

  if (segmentedEnabled) {
    return await stage7Segmented(sb, runId, script, gapMs, voiceCfg);
  }

  const fullText = script.full_script;
  const { audioBytes, alignment } = await callElevenLabsWithTimestamps(fullText, voiceCfg);
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
      { role: "system", content: `You are a visual director for a faceless emotional short-form video channel. Each beat is ONE static-camera clip (~3-6 seconds) that an image-to-video model will animate from a still keyframe. The viewer must understand EVERY clip in under 2 seconds and feel the narrated line literally play out on screen.

ART STYLE (apply to EVERY scene, identically):
- Warm semi-realistic cinematic style — soft facial features, expressive eyes, natural skin texture, slightly stylized proportions.
- Cinematic lighting, shallow depth of field, 35mm lens look, soft contrast, warm color grading.
- NOT cartoon, NOT anime, NOT 3D render, NOT hyper-realistic stock photo.
- SAME character design across every beat — identical face shape, hair color, outfit colors, distinguishing features. Treat it as a locked character sheet.
- NO text, logos, watermarks, or typography in the frame (overlays come from a separate system).

CAMERA — THE STABILITY RULE (this is the engagement-killer if violated):
- LOCKED TRIPOD camera. The camera DOES NOT MOVE.
- NO push-in, NO pull-back, NO pan, NO tilt, NO zoom, NO dolly, NO rack-focus, NO handheld, NO drone.
- The composition of the keyframe is the composition for the entire clip — only the SUBJECT and ENVIRONMENT inside the frame change.

MOTION — WHAT ANIMATES:
- ONLY: character gesture, facial expression, object movement, lighting/weather shifts, paper unfolding, hands working, eyes widening.
- The motion must LITERALLY depict the narration line of that beat. If the narration says "she opened the envelope", the hands open an envelope on screen — not a moody face shot.
- ONE action per beat. No second action. No scene change inside the clip.
- The keyframe captures the BEGINNING of the action (the "before"). The clip animates INTO the moment.

CONTINUITY:
- Identical character design in every beat. Same hair color, same outfit, same age.
- The HOOK beat (beat 0) carries the strongest, most informative single frame — the viewer must understand the story setup from this frame alone with sound off.
- The BUTTON beat (final beat) is the warm payoff frame — a quiet held image. Often a close-up of the object that recontextualized the story.

Return ONLY valid JSON, no markdown fences.` },
      { role: "user", content: `Generate ONE visual scene prompt + ONE motion prompt per narration beat.

Story: "${story.title}"
Summary: ${story.summary}
Characters: ${JSON.stringify(story.characters)}
Locations: ${JSON.stringify(story.locations)}

Beats (each becomes ONE locked-camera clip — the on-screen action must illustrate the narrated text inside its duration):
${timedBeats.map((b: any, i: number) => `Beat ${i} (${b.duration?.toFixed(1)}s, purpose=${b.purpose}):
  Narration: "${b.text}"
  Visual intent: ${b.visual_intent}`).join("\n\n")}

For each beat return:

1. "prompt" — detailed still-image description, used to generate the LOCKED keyframe. Must begin with "Warm semi-realistic cinematic style, locked tripod composition:" and include:
   - The exact character(s) in frame (NAMES + identical appearance to other beats)
   - The exact location
   - The character's POSE at the START of the narrated action (their position BEFORE the motion happens)
   - Composition (close-up / medium / wide; what's in the foreground vs. background)
   - Lighting + color grading
   - Vertical 9:16 framing implied

2. "motion_prompt" — 1-2 short sentences in this STRUCTURE:
   "SUBJECT performs ACTION. <one specific micro-detail of how>."
   - The motion must LITERALLY depict the narration line.
   - NO camera moves. NO "the camera pushes in", NO "pull-back", NO "pan", NO "zoom".
   - Locked-frame subject motion only.
   - Examples:
     • Narration "She opened the letter with trembling hands" → "Hands tremble as they tear open the envelope; paper unfolds upward into the frame."
     • Narration "He found the engraving inside the watch" → "Thumb opens the caseback; engraved text rises into focus as the case lifts away."
     • Narration "The crowd erupted in cheers" → "Crowd raises arms and shouts in unison; mouths open mid-cheer, hands punch upward."
     • Narration "Years passed in silence" → "Light slowly shifts from morning to dusk across the empty room; dust motes drift across the still air."

Return JSON:
{
  "scenes": [
    {
      "beat_index": 0,
      "prompt": "Warm semi-realistic cinematic style, locked tripod composition: <detailed still-image scene with character pose at the START of the action>",
      "motion_prompt": "<SUBJECT performs ACTION literally depicting the narration. One micro-detail. NO camera moves.>",
      "characters_in_scene": ["names"],
      "location": "where",
      "target_duration": 4.5
    }
  ]
}` },
    ],
    model: MODELS.TEXT_DEFAULT, parseJSON: true, endpoint: "story_scene_prompts",
  });

  const scenes = result.scenes || [];
  // Merge durations + narration context from timed beats
  return scenes.map((s: any, i: number) => ({
    ...s,
    target_duration: timedBeats[i]?.duration || s.target_duration || 4,
    beat_text: timedBeats[i]?.text,
    visual_intent: timedBeats[i]?.visual_intent,
    purpose: timedBeats[i]?.purpose,
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
  const castRef = await fetchImageAsBase64(mediaPublicUrl(castImagePath));

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
      const stylePrefix = "Warm semi-realistic cinematic style, LOCKED tripod composition (no camera move will follow). Soft facial features, expressive eyes, natural skin texture, slightly stylized proportions, cinematic lighting, shallow depth of field, 35mm lens, soft contrast, warm color grading, highly detailed but not hyper-realistic, consistent character design. ";
      const imgResult = await callImage({
        prompt: `${stylePrefix}${scene.prompt}\n\nIMPORTANT: Warm semi-realistic cinematic style — NOT cartoon, NOT anime, NOT 3D render, NOT hyper-realistic. Use the cast reference image for character design consistency (same face shape, hair, outfit colors). Vertical 9:16 format. Cinematic warm lighting, shallow depth of field, 35mm lens look. The character should be posed at the BEGINNING of the narrated action (the "before" frame) — the clip animates INTO the moment. NO text, words, letters, watermarks, or typography in the image.`,
        model: MODELS.IMAGE_FINAL, size: "9:16", quality: "medium",
        endpoint: `story_scene_image_${i}`,
        referenceImage: castRef,
      });

      const path = `story-runs/${runId}/scene_${i}.png`;
      const bytes = Uint8Array.from(atob(imgResult.b64_json), c => c.charCodeAt(0));
      const url = await uploadAndStoreAsset(sb, runId, path, bytes, "scene_image", { beat_index: i, prompt: scene.prompt.substring(0, 200) }, i, imgResult.cost_usd);
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

      const message = `Scene image ${i + 1}/${scenes.length} failed: ${(err as Error).message}`;
      const { data: cur } = await sb.from("story_runs").select("generated_metadata").eq("id", runId).single();
      const existingMeta = (cur?.generated_metadata as any) || {};
      const retryCounts = { ...(existingMeta.scene_image_retry_counts || {}) };
      retryCounts[i] = (retryCounts[i] || 0) + 1;

      if (retryCounts[i] < 3) {
        await updateRun(sb, runId, {
          generated_metadata: {
            ...existingMeta,
            scene_image_retry_counts: retryCounts,
            scene_image_retry: { scene_index: i, reason: (err as Error).message, at: new Date().toISOString() },
          },
          progress_pct: 48 + Math.round((i / scenes.length) * 12),
        });
        await log(sb, runId, "warn", `${message}; retrying via re-chain (${retryCounts[i]}/3)`);
        return { partial: true, completed: i, imageUrls };
      }

      await failRun(sb, runId, `${message} after ${retryCounts[i]} attempts`);
      throw err;
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

  if (!sceneAssets?.length) {
    await failRun(sb, runId, "No scene images found");
    throw new Error("No scene images found");
  }

  const sceneAssetByIndex = new Map<number, any>();
  for (const asset of sceneAssets) {
    if (asset.scene_index != null) sceneAssetByIndex.set(asset.scene_index, asset);
  }
  const missingImages = scenes.map((_: any, idx: number) => idx).filter((idx: number) => !sceneAssetByIndex.has(idx));
  if (missingImages.length > 0) {
    const message = `Missing scene images for beat(s): ${missingImages.map((i: number) => i + 1).join(", ")}; refusing to generate a partial story video`;
    await failRun(sb, runId, message);
    throw new Error(message);
  }

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

  for (let i = 0; i < scenes.length; i++) {
    // Skip already-submitted scenes
    if (submittedIndices.has(i)) {
      await log(sb, runId, "debug", `Scene ${i} already submitted, skipping`);
      continue;
    }

    // Check cancellation during long submission loops
    await checkCancelled(sb, runId);

    const asset = sceneAssetByIndex.get(i)!;
    const scene = scenes[i] || {};
    const targetDuration = scene.target_duration || 4;
    // For the LAST scene, request an extra second so story-finalize has
    // enough real footage to cover the end-card audio crossfade tail
    // (~0.8s) without the final narration word being clipped.
    const isLastScene = i === scenes.length - 1;
    const requestDuration = Math.ceil(targetDuration) + (isLastScene ? 1 : 0);

    const imageUrl = mediaPublicUrl(asset.supabase_path);
    if (!imageUrl) {
      const message = `No URL for scene image ${i + 1}`;
      await failRun(sb, runId, message);
      throw new Error(message);
    }

    // Narration-driven, LOCKED-CAMERA motion prompt. The shorter and more
    // imperative the prompt, the more faithfully Vidu Q3 Turbo follows it.
    // Stage 9 already produces a clean action-only "motion_prompt"; we add a
    // short narration anchor and a strict camera-lock negative.
    const narration = (scene.beat_text || "").toString().trim();
    const motionPrompt = (scene.motion_prompt || "").toString().trim();

    const actionLine = motionPrompt
      ? motionPrompt
      : (narration ? `Animate the subject to depict: ${narration}` : "Subtle subject motion only.");

    // Compact prompt — under 400 chars. Action first, locked-camera enforcement
    // second. Avoids the long context dump that previously made Vidu invent
    // generic camera moves and morphing artifacts.
    const viduPrompt = [
      actionLine,
      "Locked tripod camera. NO camera movement, NO pan, NO tilt, NO zoom, NO push-in, NO pull-back, NO dolly.",
      "Identical subject design throughout. NO morphing, NO new characters appearing, NO transformation, NO scene change.",
    ].join(" ").substring(0, 1500);

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
          prompt: viduPrompt,
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
        metadata: { vidu_task_id: taskId, status: "pending", target_duration: targetDuration, request_duration: requestDuration, scene_index: i, vidu_credits: viduData.credits ?? null },
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

    // Scheduled runs use Flex-tier image pricing; manual runs use default.
    setImageServiceTier(meta.use_flex_image_tier ? "flex" : null);

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
      const script = await stage6(sb, runId, story, meta.target_duration || STORY_TARGET_DURATION_DEFAULT);
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
      const script = await stage6(sb, runId, story, meta.target_duration || STORY_TARGET_DURATION_DEFAULT);
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
      const script = meta.script || await stage6(sb, runId, story, meta.target_duration || STORY_TARGET_DURATION_DEFAULT);
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
