import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { callStructured, callImage, MODELS } from "../_shared/openai.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

async function log(
  sb: ReturnType<typeof getSupabase>,
  runId: string,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  data?: any
) {
  console.log(`[STORY][${level}] ${message}`);
  await sb.from("story_run_logs").insert({ run_id: runId, level, message, data });
}

async function updateRun(
  sb: ReturnType<typeof getSupabase>,
  runId: string,
  fields: Record<string, unknown>
) {
  const { error } = await sb.from("story_runs").update(fields).eq("id", runId);
  if (error) console.error("Failed to update story run:", error);
}

async function failRun(
  sb: ReturnType<typeof getSupabase>,
  runId: string,
  message: string
) {
  await log(sb, runId, "error", message);
  await updateRun(sb, runId, {
    status: "failed",
    error_message: message,
    finished_at: new Date().toISOString(),
  });
}

// ── Stage 1: Create Run ──────────────────────────────────

async function stage1_createRun(sb: ReturnType<typeof getSupabase>, runId: string) {
  await updateRun(sb, runId, { status: "queued", current_stage: "create_run", progress_pct: 5, started_at: new Date().toISOString() });
  await log(sb, runId, "info", "Stage 1: Loading project config and story memory");

  const { data: run } = await sb.from("story_runs").select("*, story_projects(*)").eq("id", runId).single();
  if (!run) throw new Error("Run not found");

  const projectId = run.project_id;

  // Load last 20 published story titles
  const { data: memory } = await sb
    .from("story_memory")
    .select("story_title, story_fingerprint")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(20);

  const lastTitles = (memory || []).map((m: any) => m.story_title);
  const fingerprints = (memory || []).map((m: any) => m.story_fingerprint).filter(Boolean);

  await log(sb, runId, "info", `Loaded ${lastTitles.length} previous story titles`);

  return { run, project: run.story_projects, lastTitles, fingerprints, projectId };
}

// ── Stage 2: Story Discovery ─────────────────────────────

async function stage2_storyDiscovery(
  sb: ReturnType<typeof getSupabase>,
  runId: string,
  lastTitles: string[]
) {
  await updateRun(sb, runId, { status: "researching_story", current_stage: "researching_story", progress_pct: 15 });
  await log(sb, runId, "info", "Stage 2: Discovering wholesome story via AI");

  const titlesBlock = lastTitles.length > 0
    ? `\n\nPREVIOUSLY USED TITLES (DO NOT reuse or closely repeat):\n${lastTitles.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
    : "";

  const result = await callStructured({
    messages: [
      {
        role: "system",
        content: `You are a viral short-form video researcher. Find real, wholesome, feel-good stories that have strong hooks and emotional payoffs. Stories should be verifiable and come from real events, real people, or real communities. Return ONLY valid JSON.`,
      },
      {
        role: "user",
        content: `Find a NEW wholesome real-world story that would make a compelling 60-90 second vertical video. The story must have:
- A strong hook in the first sentence
- An emotional reward/payoff moment
- Real characters, real events
- Visual potential (describable scenes)${titlesBlock}

Return JSON with this exact structure:
{
  "title": "short catchy title",
  "source_url": "URL where this story was reported (or best guess)",
  "summary": "detailed 3-5 sentence summary",
  "hook": "the opening hook line for the video",
  "reward_moment": "the emotional payoff moment",
  "characters": [{"name": "...", "role": "...", "appearance_notes": "..."}],
  "groups": [{"name": "...", "description": "..."}],
  "locations": [{"name": "...", "description": "..."}],
  "draft_beats": [{"text": "narration text", "purpose": "hook|build|climax|resolve", "visual_intent": "what to show"}],
  "image_search_guidance": "description of the best real image to find for this story"
}`,
      },
    ],
    model: MODELS.TEXT_DEFAULT,
    parseJSON: true,
    endpoint: "story_discovery",
  });

  await log(sb, runId, "info", `Story discovered: "${result.title}"`);
  return result;
}

// ── Stage 3: Story Validation ────────────────────────────

async function stage3_validate(
  sb: ReturnType<typeof getSupabase>,
  runId: string,
  story: any,
  fingerprints: string[],
  lastTitles: string[]
): Promise<boolean> {
  await updateRun(sb, runId, { current_stage: "story_validation", progress_pct: 25 });
  await log(sb, runId, "info", `Stage 3: Validating story "${story.title}"`);

  const normalizedTitle = story.title?.toLowerCase().trim();
  const isDuplicate = lastTitles.some(
    (t) => t.toLowerCase().trim() === normalizedTitle
  );

  if (isDuplicate) {
    await log(sb, runId, "warn", `Story title is a duplicate: "${story.title}"`);
    return false;
  }

  // Simple fingerprint: first 100 chars of summary
  const fp = (story.summary || "").substring(0, 100).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (fingerprints.includes(fp)) {
    await log(sb, runId, "warn", `Story fingerprint is too similar`);
    return false;
  }

  if (!story.title || !story.summary || !story.hook || !story.draft_beats?.length) {
    await log(sb, runId, "warn", `Story JSON structure invalid`);
    return false;
  }

  await log(sb, runId, "info", "Story validated successfully");
  return true;
}

// ── Stage 4: Real Image Retrieval ────────────────────────

async function stage4_realImage(
  sb: ReturnType<typeof getSupabase>,
  runId: string,
  story: any
) {
  await updateRun(sb, runId, { current_stage: "real_image", progress_pct: 40 });
  await log(sb, runId, "info", "Stage 4: Finding real image for the story");

  const result = await callStructured({
    messages: [
      {
        role: "system",
        content: `You are an image researcher. Given a story, find the best real image URL that relates to this story. Prioritize: 1) real person from story, 2) group/event, 3) location, 4) related contextual image. Return ONLY valid JSON.`,
      },
      {
        role: "user",
        content: `Story: "${story.title}"
Summary: ${story.summary}
Characters: ${JSON.stringify(story.characters || [])}
Locations: ${JSON.stringify(story.locations || [])}
Image search guidance: ${story.image_search_guidance || "Find a relevant real image"}

Return JSON:
{
  "primary_url": "direct URL to the best real image",
  "fallback_url": "backup image URL",
  "image_type": "person|group|place|contextual",
  "image_description": "what the image shows",
  "characters_visible": ["names of any story characters visible"]
}`,
      },
    ],
    model: MODELS.TEXT_DEFAULT,
    parseJSON: true,
    endpoint: "story_real_image",
  });

  await log(sb, runId, "info", `Real image found: ${result.image_type} - ${result.image_description}`);
  return result;
}

// ── Stage 5: Cast/Reference Image ────────────────────────

async function stage5_castImage(
  sb: ReturnType<typeof getSupabase>,
  runId: string,
  story: any,
  realImage: any,
  projectId: string
) {
  await updateRun(sb, runId, { status: "cast_generated", current_stage: "cast_generated", progress_pct: 55 });
  await log(sb, runId, "info", "Stage 5: Generating cast/reference image with Gemini");

  const characters = (story.characters || [])
    .map((c: any) => `${c.name} (${c.role}): ${c.appearance_notes || "estimate from context"}`)
    .join("\n");

  const groups = (story.groups || [])
    .map((g: any) => `${g.name}: ${g.description}`)
    .join("\n");

  const prompt = `Create a character lineup/reference sheet for a short video. Show all characters side by side, full body, labeled with their names below each person. Style: clean illustration suitable for animation reference.

Story: "${story.title}"
${story.summary}

Characters:
${characters || "No specific characters - create generic representatives"}

Groups:
${groups || "None"}

Real image description: ${realImage?.image_description || "No reference available"}

Requirements:
- All characters present and clearly distinguishable
- Names written under each individual
- Group labels if applicable
- Vertical 9:16 format
- Clean, well-lit, neutral background`;

  let referenceImageData: string | undefined;

  // Try to fetch real image for reference
  if (realImage?.primary_url) {
    try {
      const resp = await fetch(realImage.primary_url);
      if (resp.ok) {
        const buffer = await resp.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64 = btoa(binary);
        const mime = resp.headers.get("content-type") || "image/jpeg";
        referenceImageData = `data:${mime};base64,${b64}`;
        await log(sb, runId, "info", "Using real image as reference for cast generation");
      }
    } catch (e) {
      await log(sb, runId, "warn", `Could not fetch real image: ${(e as Error).message}`);
    }
  }

  const imageResult = await callImage({
    prompt,
    model: MODELS.IMAGE_FINAL,
    size: "9:16",
    quality: "high",
    endpoint: "story_cast_image",
    referenceImage: referenceImageData,
  });

  // Upload to storage
  const path = `story-runs/${runId}/cast_reference.png`;
  const imageBytes = Uint8Array.from(atob(imageResult.b64_json), (c) => c.charCodeAt(0));

  const { error: uploadError } = await sb.storage
    .from("project-assets")
    .upload(path, imageBytes, { contentType: "image/png", upsert: true });

  if (uploadError) {
    await log(sb, runId, "warn", `Cast image upload error: ${uploadError.message}`);
  }

  // Get signed URL
  const { data: urlData } = await sb.storage
    .from("project-assets")
    .createSignedUrl(path, 60 * 60 * 24 * 7); // 7 days

  // Store as asset
  await sb.from("story_assets").insert({
    run_id: runId,
    type: "cast_reference_image",
    supabase_path: path,
    signed_url_last: urlData?.signedUrl || null,
    metadata: { story_title: story.title, characters: story.characters },
  });

  await log(sb, runId, "info", "Cast/reference image generated and stored");
  return { path, signedUrl: urlData?.signedUrl };
}

// ── Main Pipeline Handler ────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { run_id } = await req.json();
    if (!run_id) {
      return new Response(JSON.stringify({ error: "run_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sb = getSupabase();

    // Stage 1: Create Run
    let context: any;
    try {
      context = await stage1_createRun(sb, run_id);
    } catch (err) {
      await failRun(sb, run_id, `Stage 1 failed: ${(err as Error).message}`);
      return new Response(JSON.stringify({ error: (err as Error).message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Stage 2 + 3: Story Discovery with retry
    let story: any = null;
    const MAX_STORY_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_STORY_ATTEMPTS; attempt++) {
      try {
        await log(sb, run_id, "info", `Story discovery attempt ${attempt}/${MAX_STORY_ATTEMPTS}`);
        story = await stage2_storyDiscovery(sb, run_id, context.lastTitles);

        const valid = await stage3_validate(sb, run_id, story, context.fingerprints, context.lastTitles);
        if (valid) break;

        story = null;
        if (attempt < MAX_STORY_ATTEMPTS) {
          await log(sb, run_id, "info", `Retrying story discovery...`);
        }
      } catch (err) {
        await log(sb, run_id, "error", `Story attempt ${attempt} error: ${(err as Error).message}`);
        if (attempt === MAX_STORY_ATTEMPTS) {
          await failRun(sb, run_id, `Story discovery failed after ${MAX_STORY_ATTEMPTS} attempts: ${(err as Error).message}`);
          return new Response(JSON.stringify({ error: "Story discovery failed" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    if (!story) {
      await failRun(sb, run_id, "Could not find a valid non-duplicate story after 3 attempts");
      return new Response(JSON.stringify({ error: "No valid story found" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update run with story data
    await updateRun(sb, run_id, {
      status: "story_selected",
      current_stage: "story_selected",
      progress_pct: 30,
      generated_metadata: { story },
    });

    // Stage 4: Real Image
    let realImage: any;
    try {
      realImage = await stage4_realImage(sb, run_id, story);
      await updateRun(sb, run_id, {
        generated_metadata: { story, real_image: realImage },
        progress_pct: 45,
      });
    } catch (err) {
      await log(sb, run_id, "warn", `Real image retrieval failed: ${(err as Error).message}. Continuing without.`);
      realImage = null;
    }

    // Stage 5: Cast Image
    try {
      const castResult = await stage5_castImage(sb, run_id, story, realImage, context.projectId);
      await updateRun(sb, run_id, {
        status: "cast_generated",
        current_stage: "cast_generated",
        progress_pct: 60,
        generated_metadata: { story, real_image: realImage, cast_image: castResult },
      });
    } catch (err) {
      await failRun(sb, run_id, `Cast image generation failed: ${(err as Error).message}`);
      return new Response(JSON.stringify({ error: "Cast image failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Store story in memory for dedup
    const fingerprint = (story.summary || "").substring(0, 100).toLowerCase().replace(/[^a-z0-9]/g, "");
    await sb.from("story_memory").insert({
      project_id: context.projectId,
      run_id: run_id,
      story_title: story.title,
      story_fingerprint: fingerprint,
      source_url: story.source_url || null,
    });

    await log(sb, run_id, "info", "Phase 1 pipeline complete (stages 1-5). Awaiting Phase 2 implementation for remaining stages.");
    await updateRun(sb, run_id, {
      progress_pct: 60,
    });

    return new Response(JSON.stringify({ success: true, stage: "cast_generated", story_title: story.title }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Story pipeline error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
