import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  callText, callStructured, callImage,
  MODELS, type CallTextResult,
  logUsage, getUsageLog,
} from "../_shared/openai.ts";

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

// ── JSON Schemas ─────────────────────────────────────────

const PLAN_TOOL = {
  type: "function" as const,
  function: {
    name: "create_scene_plan",
    description: "Create a structured scene-by-scene plan",
    parameters: {
      type: "object",
      properties: {
        landmark_name: { type: "string" },
        landmark_location: { type: "string" },
        landmark_era: { type: "string" },
        scenes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scene_index: { type: "number" },
              scene_title: { type: "string" },
              scene_description: { type: "string" },
              scene_behavior: { type: "string", enum: ["environment_idle", "cinematic_action", "timelapse_build", "conversation", "exploration", "reveal"] },
              activity_density: { type: "string", enum: ["low", "medium", "high"] },
              end_keyframe_prompt: { type: "string" },
              kling_prompt: { type: "string" },
            },
            required: ["scene_index", "scene_title", "scene_description", "scene_behavior", "activity_density", "end_keyframe_prompt", "kling_prompt"],
            additionalProperties: false,
          },
        },
      },
      required: ["landmark_name", "landmark_location", "landmark_era", "scenes"],
      additionalProperties: false,
    },
  },
};

const STYLE_BIBLE_TOOL = {
  type: "function" as const,
  function: {
    name: "create_style_bible",
    description: "Output a structured style bible for visual consistency",
    parameters: {
      type: "object",
      properties: {
        character_identity: { type: "string" },
        outfit_description: { type: "string" },
        environment_layout: { type: "string" },
        lighting_palette: { type: "string" },
        camera_constraints: { type: "string" },
        do_not_change: { type: "array", items: { type: "string" } },
        art_style: { type: "string" },
      },
      required: ["character_identity", "outfit_description", "environment_layout", "lighting_palette", "camera_constraints", "do_not_change", "art_style"],
      additionalProperties: false,
    },
  },
};

// ── Router ───────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/ai-endpoints\/?/, "/");

  try {
    const body = req.method === "POST" ? await req.json() : {};

    // ── POST /plan ──
    if (path === "/plan") {
      const { system_prompt, user_prompt, scene_count, concept_prompt, premium } = body;
      const result = await callStructured({
        messages: [
          { role: "system", content: system_prompt || "You are a creative director for short-form video content." },
          { role: "user", content: user_prompt || `Create a ${scene_count || 5}-scene plan for: ${concept_prompt || "A visually stunning short video"}` },
        ],
        model: MODELS.TEXT_DEFAULT,
        tools: [PLAN_TOOL],
        tool_choice: { type: "function", function: { name: "create_scene_plan" } } as any,
        premium: !!premium,
        endpoint: "api/plan",
      });
      return json({ success: true, data: result });
    }

    // ── POST /style-bible ──
    if (path === "/style-bible") {
      const { system_prompt, user_prompt, premium } = body;
      const result = await callStructured({
        messages: [
          { role: "system", content: system_prompt || "You are a visual consistency director." },
          { role: "user", content: user_prompt || "Create a detailed style bible for this series." },
        ],
        model: MODELS.TEXT_DEFAULT,
        tools: [STYLE_BIBLE_TOOL],
        tool_choice: { type: "function", function: { name: "create_style_bible" } } as any,
        premium: !!premium,
        endpoint: "api/style-bible",
      });
      return json({ success: true, data: result });
    }

    // ── POST /platform-metadata ──
    if (path === "/platform-metadata") {
      const { system_prompt, user_prompt, platforms, platform_properties } = body;
      const result = await callStructured({
        messages: [
          { role: "system", content: system_prompt || "You are a social media metadata expert." },
          { role: "user", content: user_prompt },
        ],
        model: MODELS.TEXT_CHEAP,
        tools: [{
          type: "function" as const,
          function: {
            name: "generate_platform_metadata",
            description: "Generate per-platform video post metadata",
            parameters: {
              type: "object",
              properties: platform_properties,
              required: platforms,
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "generate_platform_metadata" } } as any,
        endpoint: "api/platform-metadata",
      });
      return json({ success: true, data: result });
    }

    // ── POST /overlay ──
    if (path === "/overlay") {
      const { system_prompt, user_prompt, premium } = body;
      const result = await callStructured({
        messages: [
          { role: "system", content: system_prompt || "You are a video overlay content writer. Return ONLY a JSON array." },
          { role: "user", content: user_prompt },
        ],
        model: MODELS.TEXT_DEFAULT,
        parseJSON: true,
        premium: !!premium,
        endpoint: "api/overlay",
      });
      return json({ success: true, data: result });
    }

    // ── POST /image/draft ──
    if (path === "/image/draft") {
      const { prompt, size, quality } = body;
      const result = await callImage({
        prompt,
        model: MODELS.IMAGE_DRAFT,
        size: size || "auto",
        quality: quality || "medium",
        endpoint: "api/image/draft",
      });
      return json({ success: true, data: { b64_json: result.b64_json, revised_prompt: result.revised_prompt } });
    }

    // ── POST /image/final ──
    if (path === "/image/final") {
      const { prompt, size, quality } = body;
      const result = await callImage({
        prompt,
        model: MODELS.IMAGE_FINAL,
        size: size || "auto",
        quality: quality || "high",
        endpoint: "api/image/final",
      });
      return json({ success: true, data: { b64_json: result.b64_json, revised_prompt: result.revised_prompt } });
    }

    // ── GET /usage ──
    if (path === "/usage") {
      return json({ success: true, data: getUsageLog() });
    }

    return json({ error: `Unknown endpoint: ${path}` }, 404);
  } catch (err) {
    console.error("AI endpoint error:", err);
    const message = err instanceof Error ? err.message : String(err);

    // Rate limit / payment errors
    if (message.includes("429") || message.includes("rate")) {
      return json({ error: "Rate limit exceeded. Please try again later." }, 429);
    }
    if (message.includes("402") || message.includes("insufficient")) {
      return json({ error: "Insufficient credits. Please add funds." }, 402);
    }

    return json({ error: message }, 500);
  }
});
