import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fal } from "https://esm.sh/@fal-ai/client@1";
import { buildResolvedPromptConfig, type PromptConfig } from "../_shared/promptConfig.ts";
import { callAI, summarizeMessages, summarizeAIResponse as summarizeResp, Image503RetryableError } from "../_shared/openai.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// OpenAI integration is now handled by _shared/openai.ts

// ── Behavior-Based Motion Grammar ──────────────────────────
const MOTION_GRAMMAR: Record<string, { camera: string; action: string; density_hint: string }> = {
  environment_idle: {
    camera: "slow pan OR static wide shot — no complex moves",
    action: "natural ambient movement only (wind, water, clouds, light shifts)",
    density_hint: "Scene should feel calm and spacious with minimal subject activity.",
  },
  cinematic_action: {
    camera: "ONE cinematic move: dolly / orbit / tracking shot — smooth and controlled",
    action: "ONE clear, dramatic subject action",
    density_hint: "Focus on a single subject performing one decisive action.",
  },
  timelapse_build: {
    camera: "fixed tripod OR very slow push-in — the camera barely moves",
    action: "continuous parallel activity: multiple workers, machines, or processes happening simultaneously",
    density_hint: "Scene should feel busy with overlapping activities suggesting the passage of time.",
  },
  conversation: {
    camera: "shot/reverse-shot framing OR slow push-in — stable and intimate",
    action: "subtle character movement: gestures, head turns, expressions",
    density_hint: "Scene should feel personal and focused on character interaction.",
  },
  exploration: {
    camera: "forward tracking shot following the subject — steady and continuous",
    action: "character walking, observing, discovering — continuous forward movement",
    density_hint: "Scene should convey forward momentum and curiosity.",
  },
  reveal: {
    camera: "slow cinematic move: dolly through, crane up, or pull back to reveal scale",
    action: "environment activation: lights turning on, doors opening, fog clearing",
    density_hint: "Scene should build to a moment of awe or payoff.",
  },
};

function getMotionGrammarBlock(): string {
  return Object.entries(MOTION_GRAMMAR)
    .map(([behavior, rules]) =>
      `### ${behavior}\n- Camera: ${rules.camera}\n- Action: ${rules.action}\n- Density: ${rules.density_hint}`
    )
    .join("\n\n");
}

function getMotionRulesForBehavior(behavior: string): { camera: string; action: string; density_hint: string } {
  return MOTION_GRAMMAR[behavior] || MOTION_GRAMMAR["cinematic_action"];
}

// ── Keyframe Prompt Compiler ─────────────────────────────
// Produces compact, scene-specific prompts instead of injecting
// the full concept, full style bible, and all rule blocks every time.

interface CompiledKeyframePrompt {
  prompt: string;
  debugSummary: string;
}

function summarizeIdentityAnchor(text: string): string {
  const firstLine = (text || "")
    .split(/\n+/)
    .map((part) => part.trim())
    .find(Boolean) || "";

  return firstLine.replace(/\s+/g, " ").slice(0, 180);
}

function compileKeyframePrompt(opts: {
  sceneIndex: number;
  totalScenes: number;
  aspectRatio: string;
  scene: { scene_title?: string; scene_description?: string; end_keyframe_prompt?: string; scene_behavior?: string; activity_density?: string };
  prevScene?: { scene_title?: string; scene_description?: string; end_keyframe_prompt?: string } | null;
  styleBible: Record<string, any>;
  conceptPrompt: string;
  landmarkName?: string;
  landmarkLocation?: string;
  landmarkEra?: string;
  topicSummary?: string;
  startStateRules?: string[];
}): CompiledKeyframePrompt {
  const { sceneIndex, totalScenes, aspectRatio, scene, prevScene, styleBible, conceptPrompt, landmarkName, landmarkLocation, landmarkEra, topicSummary, startStateRules } = opts;

  // 1. Identity lock — compress style bible to core visual anchors
  const identityParts: string[] = [];
  if (styleBible.environment_layout) identityParts.push(`Setting: ${styleBible.environment_layout}`);
  if (styleBible.lighting_palette) identityParts.push(`Light: ${styleBible.lighting_palette}`);
  if (styleBible.camera_constraints) identityParts.push(`Camera: ${styleBible.camera_constraints}`);
  if (styleBible.art_style) identityParts.push(`Style: ${styleBible.art_style}`);
  if (styleBible.character_identity) identityParts.push(`Subject: ${styleBible.character_identity}`);
  const doNotChange = Array.isArray(styleBible.do_not_change) ? styleBible.do_not_change.slice(0, 4) : [];
  if (doNotChange.length > 0) identityParts.push(`Lock: ${doNotChange.join(", ")}`);

  if (identityParts.length === 0) {
    if (landmarkName) identityParts.push(`Subject: ${landmarkName}`);
    if (landmarkLocation) identityParts.push(`Place: ${landmarkLocation}`);
    if (landmarkEra) identityParts.push(`Era: ${landmarkEra}`);

    const identityAnchor = summarizeIdentityAnchor(topicSummary || conceptPrompt);
    if (identityAnchor) identityParts.push(`Anchor: ${identityAnchor}`);
  }

  const identityBlock = identityParts.join(". ") || "Keep the same yard layout, build identity, and framing as the reference image.";

  // 2. Scene delta — what changed vs previous scene
  let deltaBlock = "";
  if (sceneIndex === 0) {
    // K0: the starting-state keyframe — use start_state_rules from config
    const rulesText = startStateRules && startStateRules.length > 0
      ? startStateRules.map(r => `- ${r}`).join("\n")
      : "Show the starting conditions before any action begins.";
    deltaBlock = `This is K0 — the STARTING STATE keyframe that anchors the entire series. Show the environment/subject EXACTLY as it exists before the series begins.\n${rulesText}`;
  } else if (prevScene && prevScene.end_keyframe_prompt) {
    deltaBlock = `Previous scene showed: "${prevScene.scene_title || "prior state"}". ` +
      `This scene advances to: "${scene.scene_title || "next state"}". ` +
      `Show clear visual progression from the previous frame.`;
  } else if (sceneIndex === 1) {
    deltaBlock = `This is the OPENING scene. Show clear visual progression from the reference image (K0 starting state).`;
  }

  // 3. Duplicate prevention — strengthen delta if scene descriptions are too similar
  if (prevScene?.end_keyframe_prompt && scene.end_keyframe_prompt) {
    const prevWords = new Set((prevScene.end_keyframe_prompt).toLowerCase().split(/\s+/));
    const curWords = new Set((scene.end_keyframe_prompt).toLowerCase().split(/\s+/));
    let overlap = 0;
    for (const w of curWords) { if (prevWords.has(w) && w.length > 3) overlap++; }
    const overlapRatio = overlap / Math.max(curWords.size, 1);
    if (overlapRatio > 0.6) {
      deltaBlock += ` IMPORTANT: The previous and current scenes are similar — emphasize what is NEW and DIFFERENT. Show measurable environmental change.`;
    }
  }

  // 4. Core visual target — the actual scene content
  const sceneTarget = scene.end_keyframe_prompt || scene.scene_description || "";

  // 5. Minimal constraints (no audio rules, no repeated negatives)
  const constraints = [
    "No text, watermarks, or logos",
    "Match reference image framing and palette exactly",
  ];
  if (sceneIndex > 1) {
    constraints.push("Maintain spatial continuity with previous keyframe");
  }

  // Build the compiled prompt
  const prompt = [
    `Generate a ${aspectRatio} image — keyframe K${sceneIndex} of ${totalScenes}.`,
    ``,
    `IDENTITY: ${identityBlock}`,
    ``,
    deltaBlock ? `PROGRESSION: ${deltaBlock}` : null,
    ``,
    `THIS SCENE: ${sceneTarget}`,
    ``,
    `CONSTRAINTS: ${constraints.join(". ")}.`,
  ].filter(line => line !== null).join("\n");

  return {
    prompt,
    debugSummary: `K${sceneIndex}: ${prompt.length} chars (identity=${identityBlock.length}, scene=${sceneTarget.length})`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  // OpenAI client is initialized lazily in _shared/openai.ts

  let runId: string;
  let skipPublish = false;
  try {
    const body = await req.json();
    runId = body.run_id;
    skipPublish = body.skip_publish === true;
  } catch {
    return json({ error: "run_id required" }, 400);
  }

  // ── Helpers ──────────────────────────────────────────────

  async function log(level: string, message: string, data?: unknown) {
    await supabase.from("run_logs").insert({
      run_id: runId,
      level: level as any,
      message,
      data: data ? (data as any) : null,
    });
  }

  async function updateRun(updates: Record<string, unknown>) {
    await supabase.from("runs").update(updates).eq("id", runId);
  }

  async function checkRunStatus(): Promise<string> {
    const { data } = await supabase.from("runs").select("status").eq("id", runId).single();
    return data?.status || "unknown";
  }

  // ── Heartbeat: emit a debug log every 2 min so the watchdog knows we're alive ──
  const heartbeatInterval = setInterval(async () => {
    try {
      await supabase.from("run_logs").insert({
        run_id: runId,
        level: "debug" as any,
        message: "Pipeline heartbeat — still processing (AI API may be retrying).",
      });
    } catch (_) { /* best-effort */ }
  }, 2 * 60 * 1000);

  /** Fire-and-forget: chain to the next step by calling ourselves */
  function chainNextStep() {
    const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/run-pipeline`;
    fetch(fnUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ run_id: runId }),
    }).catch((e) => console.error("Chain error:", e));
  }

  // callAI, summarizeMessages, summarizeAIResponse are now imported from _shared/openai.ts

  async function extractAndUploadImage(
    aiResult: any,
    storagePath: string,
    assetType: string,
    assetMeta: Record<string, unknown>
  ): Promise<string | null> {
    const message = aiResult.choices?.[0]?.message;
    if (!message) return null;

    const images = message.images;
    if (images && Array.isArray(images) && images.length > 0) {
      const imgUrl = images[0]?.image_url?.url;
      if (imgUrl) {
        const base64Match = imgUrl.match(/^data:([^;]+);base64,(.+)$/s);
        if (base64Match) {
          const mimeType = base64Match[1];
          const raw = atob(base64Match[2]);
          const imageData = new Uint8Array(raw.length);
          for (let j = 0; j < raw.length; j++) imageData[j] = raw.charCodeAt(j);
          const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
          const fullPath = `${storagePath}.${ext}`;
          const { error: uploadErr } = await supabase.storage
            .from("project-assets")
            .upload(fullPath, imageData, { contentType: mimeType, upsert: true });
          if (!uploadErr) {
            const { data: asset } = await supabase
              .from("assets")
              .insert({
                supabase_path: fullPath,
                type: assetType as any,
                run_id: assetMeta.run_id as string || null,
                scene_id: assetMeta.scene_id as string || null,
                metadata: assetMeta,
              })
              .select()
              .single();
            return asset?.id || null;
          } else {
            await log("warn", `Upload failed for ${fullPath}: ${uploadErr.message}`);
          }
        }
      }
    }

    const content = message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        let imgUrl: string | undefined;
        if (part.type === "image_url" && part.image_url?.url) imgUrl = part.image_url.url;
        if (imgUrl) {
          const base64Match = imgUrl.match(/^data:([^;]+);base64,(.+)$/s);
          if (base64Match) {
            const mimeType = base64Match[1];
            const raw = atob(base64Match[2]);
            const imageData = new Uint8Array(raw.length);
            for (let j = 0; j < raw.length; j++) imageData[j] = raw.charCodeAt(j);
            const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
            const fullPath = `${storagePath}.${ext}`;
            const { error: uploadErr } = await supabase.storage
              .from("project-assets")
              .upload(fullPath, imageData, { contentType: mimeType, upsert: true });
            if (!uploadErr) {
              const { data: asset } = await supabase.from("assets").insert({
                supabase_path: fullPath, type: assetType as any,
                run_id: assetMeta.run_id as string || null,
                scene_id: assetMeta.scene_id as string || null,
                metadata: assetMeta,
              }).select().single();
              return asset?.id || null;
            }
          }
        }
      }
    }
    return null;
  }

  function json(data: unknown, status = 200) {
    clearInterval(heartbeatInterval);
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Main dispatcher ──────────────────────────────────────

  try {
    const { data: run, error: runErr } = await supabase
      .from("runs")
      .select("*")
      .eq("id", runId)
      .single();
    if (runErr || !run) return json({ error: "Run not found" }, 404);

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("*")
      .eq("id", run.project_id)
      .single();
    if (projErr || !project) {
      await log("error", "Project not found");
      await updateRun({ status: "failed", error_message: "Project not found" });
      return json({ error: "Project not found" }, 404);
    }

    const step = run.current_step;

    // ── Build resolved prompt config ──
    const resolvedConfig: PromptConfig = buildResolvedPromptConfig(project);

    // If run is new (queued), start it and snapshot the resolved config
    if (run.status === "queued") {
      await updateRun({
        status: "running",
        started_at: new Date().toISOString(),
        current_step: "plan",
        progress_pct: 0,
        generated_metadata: { resolved_prompt_config: resolvedConfig, ...(skipPublish ? { skip_publish: true } : {}) },
      });
      await log("info", "Pipeline started");
    } else if (run.status !== "running") {
      return json({ status: "not_running", run_status: run.status });
    }

    // Combine motion negative prompt with global negative prompt
    const fullNegativePrompt = [
      resolvedConfig.motion.negative_prompt_extra,
      resolvedConfig.global.negative_prompt,
    ].filter(Boolean).join(", ");

    const conceptPrompt = resolvedConfig.global.concept_prompt;
    const metadataState: Record<string, any> = { ...(((run.generated_metadata as any) || {})) };

    // ═══════════════════════════════════════════════════════
    // STEP: plan — initial image + style bible + scene plan
    // ═══════════════════════════════════════════════════════
    if (step === "plan" || run.status === "queued") {
      const planStartTime = Date.now();
      await log("info", "Step 1: Generating initial image, style bible, and scene plan...");

      // Check if scenes already exist (resumability after timeout)
      const { data: existingScenes } = await supabase
        .from("scenes")
        .select("id")
        .eq("run_id", runId)
        .limit(1);
      const scenesAlreadyCreated = (existingScenes?.length || 0) > 0;

      // ── Fetch run memory (past topic summaries) if enabled ──
      let memoryBlock = "";
      if (resolvedConfig.memory?.enabled) {
        const lookback = resolvedConfig.memory.lookback_count || 30;
        const sourceProjectIds: string[] = resolvedConfig.memory.source_project_ids || [];
        const allProjectIds = [project.id, ...sourceProjectIds];

        // Fetch runs from this project + any source projects, combined by date
        const { data: pastRuns } = await supabase
          .from("runs")
          .select("topic_summary, created_at, project_id")
          .in("project_id", allProjectIds)
          .neq("id", runId)
          .not("topic_summary", "is", null)
          .order("created_at", { ascending: false })
          .limit(lookback);

        if (pastRuns && pastRuns.length > 0) {
          const memoryInstruction = resolvedConfig.memory.instruction || "Use this history to avoid repeating topics and ensure variety.";
          const topicList = pastRuns.map((r: any, i: number) => `${i + 1}. ${r.topic_summary}`).join("\n");
          memoryBlock = `\n\n=== SERIES MEMORY (last ${pastRuns.length} videos) ===\nINSTRUCTION: ${memoryInstruction}\n\nPrevious video topics:\n${topicList}\n`;
          await log("info", `Memory loaded: ${pastRuns.length} past topic(s) from ${allProjectIds.length} project(s) injected into planner.`);
        } else {
          await log("info", "Memory enabled but no past topics found yet.");
        }
      }

      // Recover style bible / subject metadata if resuming
      let styleBible: Record<string, any> = metadataState.style_bible || {};
      let landmarkName = metadataState.landmark_name || "";
      let landmarkLocation = metadataState.landmark_location || "";
      let landmarkEra = metadataState.landmark_era || "";

      if (!landmarkName && run.topic_summary) {
        const [summaryName, summaryMeta = ""] = String(run.topic_summary).split(/\s*\(/, 2);
        const metaParts = summaryMeta
          .replace(/\)$/g, "")
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);

        landmarkName = summaryName.trim();
        if (!landmarkLocation && metaParts.length > 0) landmarkLocation = metaParts[0];
        if (!landmarkEra && metaParts.length > 1) landmarkEra = metaParts.slice(1).join(", ");
      }

      const ensureStyleBible = async () => {
        if (Object.keys(styleBible).length > 0) return;

        try {
          const landmarkStyleContext = landmarkName
            ? `The specific subject is: ${landmarkName}, located at ${landmarkLocation || "unknown location"}, from ${landmarkEra || "unknown era"}. The style bible must be anchored to this exact subject and site.`
            : "Anchor the style bible to the exact project subject and environment already implied by the series context.";
          const styleBibleResult = await callAI(
            [
              {
                role: "system",
                content: `You are a visual consistency director. Given a series concept and a specific chosen landmark, produce a structured "Style Bible" that will be appended to every image and video prompt to maintain perfect consistency across all scenes.`,
              },
              {
                role: "user",
                content: `${landmarkStyleContext}\n\nSeries concept: ${conceptPrompt || run.topic_summary || "A visually stunning short video series"}\nAspect ratio: ${project.aspect_ratio}\n${resolvedConfig.global.rules.length ? `Rules: ${resolvedConfig.global.rules.join("\n")}` : ""}\n${resolvedConfig.global.negative_prompt ? `Avoid: ${resolvedConfig.global.negative_prompt}` : ""}\n${resolvedConfig.global.style_notes ? `Style notes: ${resolvedConfig.global.style_notes}` : ""}\n\nCreate a detailed style bible specifically for ${landmarkName || run.topic_summary || "this series"}.`,
              },
            ],
            [
              {
                type: "function",
                function: {
                  name: "create_style_bible",
                  description: "Output a structured style bible for visual consistency",
                  parameters: {
                    type: "object",
                    properties: {
                      character_identity: { type: "string", description: "Detailed description of main character/subject" },
                      outfit_description: { type: "string", description: "Exact clothing/outfit description" },
                      environment_layout: { type: "string", description: "Setting, background elements, spatial layout" },
                      lighting_palette: { type: "string", description: "Lighting style, color palette, mood" },
                      camera_constraints: { type: "string", description: "Default camera distance, angle, lens" },
                      do_not_change: { type: "array", items: { type: "string" }, description: "Elements that must remain identical" },
                      art_style: { type: "string", description: "Overall art/rendering style" },
                    },
                    required: ["character_identity", "outfit_description", "environment_layout", "lighting_palette", "camera_constraints", "do_not_change", "art_style"],
                    additionalProperties: false,
                  },
                },
              },
            ],
            { type: "function", function: { name: "create_style_bible" } }
          );

          const sbToolCall = styleBibleResult.choices?.[0]?.message?.tool_calls?.[0];
          if (sbToolCall) {
            styleBible = JSON.parse(sbToolCall.function.arguments);
            await log("info", `Style Bible generated for ${landmarkName || run.topic_summary || "series"}`, styleBible);
            Object.assign(metadataState, {
              style_bible: styleBible,
              landmark_name: landmarkName,
              landmark_location: landmarkLocation,
              landmark_era: landmarkEra,
              full_negative_prompt: fullNegativePrompt,
              resolved_prompt_config: resolvedConfig,
            });
            await updateRun({
              progress_pct: 18,
              generated_metadata: metadataState,
            });
          }
        } catch (err) {
          await log("warn", `Style Bible generation failed: ${err.message} — continuing without it`);
        }
      };

      if (!scenesAlreadyCreated) {

      // ── 1a: Generate Scene Plan FIRST (so we know which landmark was chosen) ──
      const styleBibleTextForPlan = Object.entries(styleBible)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join("\n");

      const planResult = await callAI(
        [
          {
            role: "system",
            content: `${resolvedConfig.planning.planner_system_prompt}
The series has ${project.scene_count} scenes, each ${project.clip_duration_sec} seconds long, in ${project.aspect_ratio} aspect ratio.
${resolvedConfig.global.rules.length ? `Rules:\n${resolvedConfig.global.rules.map(r => `- ${r}`).join("\n")}` : ""}
${resolvedConfig.global.negative_prompt ? `Avoid: ${resolvedConfig.global.negative_prompt}` : ""}

${styleBibleTextForPlan ? `=== STYLE BIBLE (must be followed for ALL scenes) ===\n${styleBibleTextForPlan}` : ""}

=== FIRST SCENE HOOK RULES ===
${resolvedConfig.planning.first_scene_hook_rules.map(r => `- ${r}`).join("\n")}

=== VIRAL PACING RULES ===
${resolvedConfig.planning.viral_pacing_rules.map(r => `- ${r}`).join("\n")}

=== KEYFRAME PROMPT RULES ===
${resolvedConfig.keyframes.composition_rules.map(r => `- ${r}`).join("\n")}
${resolvedConfig.keyframes.continuity_rules.map(r => `- ${r}`).join("\n")}

=== SCENE BEHAVIOR SYSTEM ===
Each scene MUST be assigned a scene_behavior from: environment_idle, cinematic_action, timelapse_build, conversation, exploration, reveal.
The behavior determines the motion grammar for camera and subject action in the kling_prompt.

BEHAVIOR ASSIGNMENT RULES:
${resolvedConfig.planning.behavior_assignment_rules.map(r => `- ${r}`).join("\n")}

=== MOTION GRAMMAR PER BEHAVIOR ===
The kling_prompt MUST follow the motion rules for its assigned behavior:

${getMotionGrammarBlock()}

=== ACTIVITY DENSITY ===
Each scene must also specify activity_density (low, medium, high):
- low: calm, minimal movement, 1-2 elements in motion
- medium: moderate activity, 2-4 elements
- high: busy scene, many simultaneous activities (construction, crowds, machinery)

=== SCENE PROGRESSION RULES ===
${resolvedConfig.planning.scene_progression_rules.map(r => `- ${r}`).join("\n")}

=== START STATE RULES ===
${resolvedConfig.planning.start_state_rules.map(r => `- ${r}`).join("\n")}${memoryBlock}`,
          },
          {
            role: "user",
            content: resolvedConfig.planning.planner_user_prompt_template
              ? resolvedConfig.planning.planner_user_prompt_template
                  .replace("{scene_count}", String(project.scene_count))
                  .replace("{concept_prompt}", conceptPrompt || "A visually stunning short video")
              : `Create a ${project.scene_count}-scene plan for: ${conceptPrompt || "A visually stunning short video"}`,
          },
        ],
        [
          {
            type: "function",
            function: {
              name: "create_scene_plan",
              description: "Create a structured scene-by-scene plan with behavior-based motion grammar",
              parameters: {
                type: "object",
                properties: {
                  landmark_name: { type: "string", description: "The exact name of the chosen landmark/subject" },
                  landmark_location: { type: "string", description: "The real location/city/country of the landmark" },
                  landmark_era: { type: "string", description: "The historical era and approximate construction years" },
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
          },
        ],
        { type: "function", function: { name: "create_scene_plan" } }
      );

      const toolCall = planResult.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall) throw new Error("No tool call in plan response");

      const scenePlan = JSON.parse(toolCall.function.arguments);
      landmarkName = scenePlan.landmark_name || landmarkName;
      landmarkLocation = scenePlan.landmark_location || landmarkLocation;
      landmarkEra = scenePlan.landmark_era || landmarkEra;
      await log("info", `Planner chose: ${landmarkName} (${landmarkLocation}, ${landmarkEra}) — ${scenePlan.scenes.length} scenes`, scenePlan);

      // Save scenes to DB
      for (const scene of scenePlan.scenes) {
        await supabase.from("scenes").insert({
          run_id: runId,
          scene_index: scene.scene_index,
          scene_title: scene.scene_title,
          scene_description: scene.scene_description,
          scene_behavior: scene.scene_behavior || "cinematic_action",
          activity_density: scene.activity_density || "medium",
          end_keyframe_prompt: scene.end_keyframe_prompt,
          kling_prompt: scene.kling_prompt,
          status: "pending" as const,
        });
      }
      await updateRun({ progress_pct: 10 });

      // ── Generate topic summary for this run ──
      try {
        const topicSummary = landmarkName
          ? `${landmarkName} (${landmarkLocation}, ${landmarkEra})`
          : `${conceptPrompt || project.title} — ${scenePlan.scenes.map((s: any) => s.scene_title).join(", ")}`;
        const trimmedSummary = topicSummary.length > 200 ? topicSummary.substring(0, 197) + "..." : topicSummary;
        await supabase.from("runs").update({ topic_summary: trimmedSummary }).eq("id", runId);
        await log("info", `Topic summary saved: "${trimmedSummary}"`);
      } catch (err) {
        await log("warn", `Topic summary generation failed: ${err.message}`);
      }

      // ── K0 (initial image) is now generated in the keyframes step using the prompt compiler ──
      // This avoids it being skipped when the plan step re-chains due to time budget.

      } // end if (!scenesAlreadyCreated)

      if (Date.now() - planStartTime > 80_000 && Object.keys(styleBible).length === 0) {
        await log("info", "Plan step time budget reached after initial image. Re-chaining for style bible.");
        chainNextStep();
        return json({ status: "plan_rechaining_for_style_bible", run_id: runId });
      }

      await ensureStyleBible();

      // Time-budget guard: if we've used >80s on plan, save and re-chain
      if (Date.now() - planStartTime > 80_000) {
        await log("info", "Plan step time budget reached after scene creation. Re-chaining for overlay generation.");
        chainNextStep();
        return json({ status: "plan_rechaining_for_overlays", run_id: runId });
      }

      // ── 1d: Sync JSON-defined overlays into DB ──
      try {
        // First, remove stale JSON-sourced overlays from previous runs
        await supabase
          .from("overlays")
          .delete()
          .eq("project_id", project.id)
          .eq("source", "json_config");

        const jsonOverlays = resolvedConfig.overlays?.items;
        if (jsonOverlays && Array.isArray(jsonOverlays) && jsonOverlays.length > 0) {
          await log("info", `Inserting ${jsonOverlays.length} overlay(s) from prompt config JSON...`);

          // Get current max sort_order for manual overlays
          const { data: existingOverlays } = await supabase
            .from("overlays")
            .select("sort_order")
            .eq("project_id", project.id)
            .order("sort_order", { ascending: false })
            .limit(1);
          let nextSortOrder = (existingOverlays?.[0]?.sort_order ?? -1) + 1;

          for (const item of jsonOverlays) {
            await supabase.from("overlays").insert({
              project_id: project.id,
              source: "json_config",
              overlay_type: item.overlay_type || "text",
              content_mode: item.content_mode || "exact",
              content_text: item.content_text || null,
              content_prompt: item.content_prompt || null,
              image_path: item.image_path || null,
              position: item.position || "bottom_center",
              style: item.style || "lower_third",
              start_pct: item.start_pct ?? 0,
              end_pct: item.end_pct ?? 100,
              font_size: item.font_size ?? 48,
              font_color: item.font_color || "#FFFFFF",
              bg_color: item.bg_color || "rgba(0,0,0,0.5)",
              z_index: item.z_index ?? 1,
              sort_order: nextSortOrder++,
              voiceover_enabled: item.voiceover_enabled ?? false,
            });
          }
          await log("info", `${jsonOverlays.length} JSON overlay(s) synced into DB`);
        }
      } catch (err) {
        await log("warn", `JSON overlay sync failed: ${err.message} — continuing with manual overlays only.`);
      }

      // ── 1e: AI overlay content generation ──
      // Time-budget guard before starting AI overlay calls
      if (Date.now() - planStartTime > 100_000) {
        await log("info", "Plan step time budget reached before overlay AI. Re-chaining.");
        chainNextStep();
        return json({ status: "plan_rechaining_for_overlay_ai", run_id: runId });
      }
      try {
        // Fetch scenes from DB (needed for overlay AI whether fresh or resumed)
        const { data: dbScenes } = await supabase
          .from("scenes")
          .select("*")
          .eq("run_id", runId)
          .order("scene_index");
        const scenesForOverlay = dbScenes || [];

        const { data: overlays } = await supabase
          .from("overlays")
          .select("*")
          .eq("project_id", project.id)
          .order("sort_order");

        // ── 1e-i: Single-text AI overlays (content_mode = 'ai_generated') ──
        // Skip overlays that already have content_text (resumability)
        const aiGenOverlays = (overlays || []).filter((o: any) => o.content_mode === "ai_generated" && !o.content_text);
        if (aiGenOverlays.length > 0) {
          await log("info", `Generating AI content for ${aiGenOverlays.length} overlay(s)...`);

          const overlayDescriptions = aiGenOverlays.map((o: any, i: number) =>
            `Overlay ${i} (${o.style}, appears ${o.start_pct}%-${o.end_pct}%): ${o.content_prompt || "Generate appropriate content"}`
          ).join("\n");

          const overlayGenResult = await callAI(
            [
              {
                role: "system",
                content: `You are a video overlay content writer. Given a series concept and overlay descriptions, generate compelling SHORT text for each overlay. Return ONLY a JSON array of objects with "index" (0-based) and "content" (the text). Example: [{"index":0,"content":"SECRET BUNKER"}]. No markdown fences, no explanation — just the JSON array.`,
              },
              {
                role: "user",
                content: `Series: ${conceptPrompt || project.title}
Scenes: ${scenesForOverlay.map((s: any) => `${s.scene_title}: ${s.scene_description}`).join("\n")}

Generate content for these overlays:
${overlayDescriptions}`,
              },
            ],
            undefined, undefined,
            "openai/gpt-5-mini"
          );

          const responseText = overlayGenResult.choices?.[0]?.message?.content || "";
          await log("debug", "AI overlay raw response", { responseText });

          let generated: Array<{ index: number; content: string }> = [];
          try {
            const cleaned = responseText.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
            generated = JSON.parse(cleaned);
          } catch {
            const match = responseText.match(/\[[\s\S]*\]/);
            if (match) {
              try { generated = JSON.parse(match[0]); } catch {}
            }
          }

          if (generated.length > 0) {
            for (const gen of generated) {
              if (gen.index >= 0 && gen.index < aiGenOverlays.length && gen.content) {
                await supabase
                  .from("overlays")
                  .update({ content_text: gen.content })
                  .eq("id", aiGenOverlays[gen.index].id);
                await log("info", `Overlay ${gen.index} content set: "${gen.content}"`);
              }
            }
          } else {
            await log("warn", `AI overlay generation returned no parseable content. Raw: ${responseText.substring(0, 200)}`);
            for (const ov of aiGenOverlays) {
              if (ov.content_prompt && ov.content_prompt.length <= 40) {
                await supabase.from("overlays").update({ content_text: ov.content_prompt }).eq("id", ov.id);
              }
            }
          }
        }

        // ── 1e-ii: AI Sequence overlays (content_mode = 'ai_sequence') ──
        // Skip overlays that already have content_text (resumability)
        const seqOverlays = (overlays || []).filter((o: any) => o.content_mode === "ai_sequence" && !o.content_text);
        if (seqOverlays.length > 0) {
           await log("info", `Generating AI sequences for ${seqOverlays.length} overlay(s)...`);
          const scenesList = scenesForOverlay.map((s: any, i: number) =>
            `Scene ${i + 1}: ${s.scene_title} — ${s.scene_description}`
          ).join("\n");

          for (const seqOv of seqOverlays) {
            // Time-budget guard inside sequence loop
            if (Date.now() - planStartTime > 120_000) {
              await log("info", "Plan step time budget reached during sequence generation. Re-chaining.");
              chainNextStep();
              return json({ status: "plan_rechaining_during_sequences", run_id: runId });
            }
            try {
              const seqResult = await callAI(
                [
                  {
                    role: "system",
                    content: `You are a dynamic video overlay sequencer. Given a video concept, its scenes, and a user prompt describing the desired overlay sequence, generate a JSON array of timed text frames. Each frame has: "text" (short ALL CAPS overlay text), "start_pct" (number 0-100), "end_pct" (number 0-100). The frames must tile the overlay's time window (${seqOv.start_pct}%-${seqOv.end_pct}%) without gaps or overlaps. Return ONLY the JSON array — no markdown, no explanation.`,
                  },
                  {
                    role: "user",
                    content: `Video concept: ${conceptPrompt || project.title}
Total scenes: ${scenesForOverlay.length}

Scenes:
${scenesList}

Overlay time window: ${seqOv.start_pct}% to ${seqOv.end_pct}% of video.

User prompt for this sequence:
${seqOv.content_prompt || "Generate contextually appropriate text that changes throughout the video based on the scene progression."}

Generate the timed text frames.`,
                  },
                ],
                undefined, undefined,
                "openai/gpt-5-mini"
              );

              const seqText = seqResult.choices?.[0]?.message?.content || "";
              await log("debug", "AI sequence raw response", { seqText: seqText.substring(0, 500) });

              let frames: Array<{ text: string; start_pct: number; end_pct: number }> = [];
              try {
                const cleaned = seqText.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
                frames = JSON.parse(cleaned);
              } catch {
                const match = seqText.match(/\[[\s\S]*\]/);
                if (match) {
                  try { frames = JSON.parse(match[0]); } catch {}
                }
              }

              if (Array.isArray(frames) && frames.length > 0) {
                // Validate and clamp frames within the overlay's time window
                const validFrames = frames
                  .filter(f => f.text && typeof f.start_pct === "number" && typeof f.end_pct === "number")
                  .map(f => ({
                    text: String(f.text).toUpperCase(),
                    start_pct: Math.max(seqOv.start_pct, Math.min(seqOv.end_pct, f.start_pct)),
                    end_pct: Math.max(seqOv.start_pct, Math.min(seqOv.end_pct, f.end_pct)),
                  }))
                  .filter(f => f.end_pct > f.start_pct);

                // Store as JSON string in content_text
                await supabase
                  .from("overlays")
                  .update({ content_text: JSON.stringify(validFrames) })
                  .eq("id", seqOv.id);
                await log("info", `AI sequence generated ${validFrames.length} frames for overlay ${seqOv.id}: ${validFrames.map(f => f.text).join(" → ")}`);
              } else {
                await log("warn", `AI sequence returned no parseable frames for overlay ${seqOv.id}`);
              }
            } catch (seqErr) {
              await log("warn", `AI sequence generation failed for overlay ${seqOv.id}: ${seqErr.message}`);
            }
          }
        }
      } catch (err) {
        await log("warn", `Overlay content generation failed: ${err.message} — continuing.`);
      }

      // Store style bible + negative prompt + resolved config in metadata for downstream steps
      Object.assign(metadataState, {
        style_bible: styleBible,
        landmark_name: landmarkName,
        landmark_location: landmarkLocation,
        landmark_era: landmarkEra,
        full_negative_prompt: fullNegativePrompt,
        resolved_prompt_config: resolvedConfig,
      });
      await updateRun({
        current_step: "keyframes",
        progress_pct: 15,
        generated_metadata: metadataState,
      });
      await log("info", "Plan step complete. Chaining to keyframes step.");
      chainNextStep();
      return json({ status: "plan_complete", run_id: runId });
    }

    // ═══════════════════════════════════════════════════════
    // STEP: keyframes — sequential chained keyframe generation
    // ═══════════════════════════════════════════════════════
    if (step === "keyframes") {
      await log("info", "Step 2: Generating chained keyframe images...");

      const metadata = (run.generated_metadata as any) || {};
      const styleBible = metadata.style_bible || {};
      const styleBibleText = Object.entries(styleBible)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join("; ");

      const { data: scenes } = await supabase
        .from("scenes")
        .select("*")
        .eq("run_id", runId)
        .order("scene_index");

      if (!scenes || scenes.length === 0) {
        await log("error", "No scenes found for keyframe generation");
        await updateRun({ status: "failed", error_message: "No scenes for keyframes" });
        return json({ error: "No scenes" }, 500);
      }

      // Find which scenes still need keyframes (resumability!)
      const { data: existingKeyframes } = await supabase
        .from("assets")
        .select("scene_id")
        .eq("run_id", runId)
        .eq("type", "keyframe");

      const doneSceneIds = new Set((existingKeyframes || []).map(a => a.scene_id));
      const pendingScenes = scenes.filter(s => !doneSceneIds.has(s.id));

      if (pendingScenes.length === 0) {
        await log("info", "All keyframes already generated. Advancing to kling.");
        await updateRun({ current_step: "kling", progress_pct: 40 });
        chainNextStep();
        return json({ status: "keyframes_already_done" });
      }

      // Get the last generated keyframe URL as chain reference
      let prevKeyframeUrl: string | null = null;

      // ── K0: Generate starting-state keyframe if not yet created ──
      const resolvedConfig = metadata.resolved_prompt_config || {};
      const startStateRules = resolvedConfig?.planning?.start_state_rules || [];
      const { data: existingK0 } = await supabase
        .from("assets")
        .select("supabase_path")
        .eq("run_id", runId)
        .eq("type", "initial_image")
        .limit(1);

      if (!existingK0 || existingK0.length === 0) {
        await log("info", "Generating K0 (starting-state keyframe) via prompt compiler...");
        const k0Compiled = compileKeyframePrompt({
          sceneIndex: 0,
          totalScenes: scenes.length,
          aspectRatio: project.aspect_ratio || "9:16",
          scene: {
            scene_title: "Starting State",
            scene_description: scenes[0]?.scene_description || "",
            end_keyframe_prompt: startStateRules.length > 0
              ? `Starting state: ${startStateRules.join(". ")}`
              : `The starting environment before any action begins. Series concept: ${metadata.landmark_name || conceptPrompt || project.title}`,
          },
          prevScene: null,
          styleBible,
          conceptPrompt: conceptPrompt || "",
          landmarkName: metadata.landmark_name || "",
          landmarkLocation: metadata.landmark_location || "",
          landmarkEra: metadata.landmark_era || "",
          topicSummary: run.topic_summary || "",
          startStateRules,
        });
        await log("debug", `Compiled K0 prompt: ${k0Compiled.debugSummary}`);

        try {
          const k0Result = await callAI(
            [{ role: "user", content: k0Compiled.prompt }],
            undefined, undefined,
            "google/gemini-3-pro-image-preview",
            ["image", "text"]
          );

          const k0AssetId = await extractAndUploadImage(
            k0Result,
            `${project.id}/keyframes/${runId}/scene-0-start`,
            "initial_image",
            { run_id: runId, purpose: "k0_starting_state", keyframe_type: "start", scene_index: 0 }
          );
          if (k0AssetId) {
            await log("info", "K0 (starting-state keyframe) saved");
            const { data: k0Asset } = await supabase
              .from("assets")
              .select("supabase_path")
              .eq("id", k0AssetId)
              .single();
            if (k0Asset) {
              const { data: urlData } = supabase.storage.from("project-assets").getPublicUrl(k0Asset.supabase_path);
              prevKeyframeUrl = urlData.publicUrl;
            }
          } else {
            await log("warn", "K0 image extraction failed — continuing without visual anchor");
          }
        } catch (k0Err) {
          if (k0Err instanceof Image503RetryableError) {
            await log("warn", `K0 got 503. Re-chaining to retry...`);
            chainNextStep();
            return json({ status: "k0_503_rechain", run_id: runId });
          }
          await log("warn", `K0 generation failed: ${k0Err.message} — continuing without it`);
        }
      } else {
        // K0 already exists — use it as starting chain reference
        const { data: urlData } = supabase.storage.from("project-assets").getPublicUrl(existingK0[0].supabase_path);
        prevKeyframeUrl = urlData.publicUrl;
        await log("info", "K0 already exists, using as chain anchor.");
      }

      // Check if the scene before the first pending one has a keyframe (for resume)
      const firstPendingIndex = pendingScenes[0].scene_index;
      if (firstPendingIndex > 1) {
        const prevScene = scenes.find(s => s.scene_index === firstPendingIndex - 1);
        if (prevScene) {
          const { data: prevKf } = await supabase
            .from("assets")
            .select("supabase_path")
            .eq("run_id", runId)
            .eq("scene_id", prevScene.id)
            .eq("type", "keyframe")
            .limit(1);
          if (prevKf && prevKf.length > 0) {
            const { data: urlData } = supabase.storage.from("project-assets").getPublicUrl(prevKf[0].supabase_path);
            prevKeyframeUrl = urlData.publicUrl;
          }
        }
      }

      // Generate keyframes for pending scenes — ONE per invocation to maximize
      // time budget for Flex-tier responses (can take minutes per image).
      let generatedCount = 0;
      const stepStartTime = Date.now();
      // Track per-scene retry attempts in metadata for 30-min max enforcement
      const keyframeAttempts: Record<number, { count: number; first_at: number }> = metadataState.keyframe_attempts || {};
      const MAX_IMAGE_WAIT_MS = 30 * 60 * 1000; // 30 minutes max per scene

      for (const scene of pendingScenes) {
        // Time-budget guard: if we've used >80s, re-chain to avoid edge function timeout
        if (Date.now() - stepStartTime > 80_000) {
          await log("info", `Time budget reached after ${generatedCount} keyframes. Re-chaining for remaining ${pendingScenes.length - generatedCount} scenes.`);
          metadataState.keyframe_attempts = keyframeAttempts;
          await updateRun({ generated_metadata: metadataState });
          chainNextStep();
          return json({ status: "keyframes_time_budget", generated: generatedCount, remaining: pendingScenes.length - generatedCount });
        }
        const status = await checkRunStatus();
        if (status !== "running") {
          await log("info", "Run halted during keyframe generation");
          return json({ status: "halted" });
        }

        // Check 30-min max for this scene
        const sceneAttempt = keyframeAttempts[scene.scene_index] || { count: 0, first_at: Date.now() };
        if (sceneAttempt.count > 0 && (Date.now() - sceneAttempt.first_at) > MAX_IMAGE_WAIT_MS) {
          await log("warn", `Keyframe K${scene.scene_index} exceeded 30-min retry limit (${sceneAttempt.count} attempts). Skipping.`);
          await supabase.from("scenes").update({ status: "keyframes_ready" as const }).eq("id", scene.id);
          generatedCount++;
          continue;
        }

        // Update attempt tracking
        sceneAttempt.count++;
        if (sceneAttempt.count === 1) sceneAttempt.first_at = Date.now();
        keyframeAttempts[scene.scene_index] = sceneAttempt;

        await log("info", `Generating end keyframe K${scene.scene_index} for: ${scene.scene_title} (attempt ${sceneAttempt.count})`);

        try {
          // Find the previous scene for delta computation
          const prevScene = scenes.find(s => s.scene_index === scene.scene_index - 1) || null;

          // Compile a compact, scene-specific prompt via the Keyframe Prompt Compiler
          const compiled = compileKeyframePrompt({
            sceneIndex: scene.scene_index,
            totalScenes: scenes.length,
            aspectRatio: project.aspect_ratio || "9:16",
            scene,
            prevScene,
            styleBible,
            conceptPrompt: conceptPrompt || "",
            landmarkName: metadata.landmark_name || "",
            landmarkLocation: metadata.landmark_location || "",
            landmarkEra: metadata.landmark_era || "",
            topicSummary: run.topic_summary || "",
          });
          await log("debug", `Compiled keyframe prompt: ${compiled.debugSummary}`);

          const userContent: any[] = [{ type: "text", text: compiled.prompt }];
          if (prevKeyframeUrl) {
            userContent.push({ type: "image_url", image_url: { url: prevKeyframeUrl } });
          }

          let assetId: string | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            const imageResult = await callAI(
              [{ role: "user", content: userContent }],
              undefined, undefined,
              "google/gemini-3-pro-image-preview",
              ["image", "text"]
            );

            assetId = await extractAndUploadImage(
              imageResult,
              `${project.id}/keyframes/${runId}/scene-${scene.scene_index}-end`,
              "keyframe",
              { run_id: runId, scene_id: scene.id, keyframe_type: "end", scene_index: scene.scene_index }
            );

            if (assetId) break;
            if (attempt === 0) {
              await log("warn", `No image data for keyframe K${scene.scene_index}, retrying...`);
              await new Promise(r => setTimeout(r, 2000));
            }
          }

          if (assetId) {
            await log("info", `Keyframe K${scene.scene_index} saved`);
            const { data: newAsset } = await supabase
              .from("assets")
              .select("supabase_path")
              .eq("id", assetId)
              .single();
            if (newAsset) {
              const { data: urlData } = supabase.storage.from("project-assets").getPublicUrl(newAsset.supabase_path);
              prevKeyframeUrl = urlData.publicUrl;
            }
          } else {
            await log("warn", `No image data for keyframe K${scene.scene_index} after retry`);
          }
          await supabase.from("scenes").update({ status: "keyframes_ready" as const }).eq("id", scene.id);
          // Clear retry tracking on success
          delete keyframeAttempts[scene.scene_index];
          generatedCount++;
        } catch (sceneErr) {
          if (sceneErr instanceof Image503RetryableError) {
            await log("warn", `Keyframe K${scene.scene_index} retriable (${sceneErr.reason}, attempt ${sceneAttempt.count}). Re-chaining...`);
            metadataState.keyframe_attempts = keyframeAttempts;
            await updateRun({ generated_metadata: metadataState });
            chainNextStep();
            return json({ status: "keyframe_retriable_rechain", run_id: runId, reason: sceneErr.reason });
          }
          await log("warn", `Keyframe generation failed for scene ${scene.scene_index}: ${sceneErr.message}`);
          await supabase.from("scenes").update({ status: "keyframes_ready" as const }).eq("id", scene.id);
          generatedCount++; // Count as processed even if failed, to avoid infinite loop
        }

        const totalDone = (scenes.length - pendingScenes.length) + generatedCount;
        const progress = 15 + Math.round((25 * totalDone) / scenes.length);
        await updateRun({ progress_pct: progress });
      }

      // All keyframes done — clean up attempt tracking and advance to kling
      delete metadataState.keyframe_attempts;
      await updateRun({ current_step: "kling", progress_pct: 40, generated_metadata: metadataState });
      await log("info", "Chained keyframe generation complete. Chaining to kling step.");
      chainNextStep();
      return json({ status: "keyframes_complete", run_id: runId });
    }

    // ═══════════════════════════════════════════════════════
    // STEP: kling — submit video generation tasks (Kling or Pika)
    // ═══════════════════════════════════════════════════════
    if (step === "kling") {
      const videoGenerator = (project as any).video_generator || "kling";
      await log("info", `Step 3: Video generation (${videoGenerator})...`);

      const metadata = (run.generated_metadata as any) || {};
      const negPrompt = metadata.full_negative_prompt || fullNegativePrompt;

      const { data: scenes } = await supabase
        .from("scenes")
        .select("*")
        .eq("run_id", runId)
        .order("scene_index");

      if (!scenes || scenes.length === 0) {
        await updateRun({ current_step: "stitch", progress_pct: 70 });
        chainNextStep();
        return json({ status: "no_scenes" });
      }

      // Check which scenes already have clip assets (resumability)
      const { data: existingClips } = await supabase
        .from("assets")
        .select("scene_id")
        .eq("run_id", runId)
        .eq("type", "clip");
      const clippedSceneIds = new Set((existingClips || []).map(a => a.scene_id));
      const pendingScenes = scenes.filter(s => !clippedSceneIds.has(s.id));

      // ── Gather keyframe URLs (shared by both generators) ──
      const sceneKeyframes: Record<number, string> = {};
      for (const scene of scenes) {
        const { data: kfAssets } = await supabase
          .from("assets")
          .select("supabase_path")
          .eq("run_id", runId)
          .eq("scene_id", scene.id)
          .eq("type", "keyframe")
          .limit(1);
        if (kfAssets && kfAssets.length > 0) {
          const { data: urlData } = supabase.storage.from("project-assets").getPublicUrl(kfAssets[0].supabase_path);
          sceneKeyframes[scene.scene_index] = urlData.publicUrl;
        }
      }

      // Get initial image URL
      let runInitialImageUrl: string | null = null;
      const { data: initAssets } = await supabase
        .from("assets")
        .select("supabase_path")
        .eq("run_id", runId)
        .eq("type", "initial_image")
        .limit(1);
      if (initAssets && initAssets.length > 0) {
        const { data: urlData } = supabase.storage.from("project-assets").getPublicUrl(initAssets[0].supabase_path);
        runInitialImageUrl = urlData.publicUrl;
      }

      // ══════════════════════════════════════════════════════
      // VIDU DIRECT API PATH
      // ══════════════════════════════════════════════════════
      if (videoGenerator === "vidu_direct") {
        const VIDU_API_KEY = Deno.env.get("VIDU_API_KEY");
        if (!VIDU_API_KEY) {
          await log("error", "VIDU_API_KEY not configured");
          await updateRun({ status: "failed", error_message: "VIDU_API_KEY not configured" });
          return json({ error: "VIDU_API_KEY not configured" }, 500);
        }

        const viduResolution = (project as any).pika_resolution || "720p";
        const enableAudio = (project as any).kling_sound || false;
        const viduModel = "viduq3-turbo";
        const clipDuration = Math.min(Math.max(project.clip_duration_sec || 5, 1), 16);

        // Build consecutive start→end image pairs
        const imageUrls: string[] = [];
        if (runInitialImageUrl) imageUrls.push(runInitialImageUrl);
        for (const scene of scenes) {
          if (sceneKeyframes[scene.scene_index]) imageUrls.push(sceneKeyframes[scene.scene_index]);
        }

        if (imageUrls.length < 2) {
          await log("error", "Vidu Direct needs at least 2 keyframe images for start→end transitions");
          await updateRun({ status: "failed", error_message: "Not enough keyframes for Vidu Direct" });
          return json({ error: "Not enough keyframes" }, 500);
        }

        const pairs: Array<{ start: string; end: string; sceneIndex: number; prompt: string }> = [];
        for (let i = 0; i < imageUrls.length - 1; i++) {
          const scene = scenes[i] || scenes[scenes.length - 1];
          pairs.push({
            start: imageUrls[i], end: imageUrls[i + 1],
            sceneIndex: scene.scene_index,
            prompt: scene.kling_prompt || conceptPrompt || "smooth cinematic transition",
          });
        }

        await log("info", `Vidu Direct: submitting ${pairs.length} clip(s), model=${viduModel}, duration=${clipDuration}s, resolution=${viduResolution}`);

        const viduTaskIds: string[] = [];
        const viduStartTime = Date.now();

        for (let clipIdx = 0; clipIdx < pairs.length; clipIdx++) {
          if (Date.now() - viduStartTime > 100_000) {
            await log("info", `Time budget reached after ${clipIdx} Vidu Direct submissions. Re-chaining.`);
            break;
          }
          const pair = pairs[clipIdx];

          // Vidu start-end2video API accepts 2 images: [start_frame, end_frame]
          const viduBody: Record<string, any> = {
            model: viduModel,
            images: [pair.start, pair.end],
            prompt: pair.prompt,
            duration: clipDuration,
            resolution: viduResolution,
            audio: enableAudio,
            movement_amplitude: "auto",
            off_peak: true,
          };

          await log("debug", `Vidu Direct clip ${clipIdx + 1}/${pairs.length} (scene ${pair.sceneIndex})`, {
            start: pair.start.substring(pair.start.lastIndexOf("/") + 1),
            end: pair.end.substring(pair.end.lastIndexOf("/") + 1),
          });

          try {
            const resp = await fetch("https://api.vidu.com/ent/v2/start-end2video", {
              method: "POST",
              headers: {
                "Authorization": `Token ${VIDU_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(viduBody),
            });

            if (!resp.ok) {
              const errText = await resp.text();
              await log("error", `Vidu Direct API error for clip ${clipIdx + 1}: ${resp.status} ${errText}`);
              continue;
            }

            const result = await resp.json();
            const taskId = result.task_id;
            if (!taskId) {
              await log("error", `No task_id for Vidu Direct clip ${clipIdx + 1}`, result);
              continue;
            }

            viduTaskIds.push(taskId);
            await log("info", `Vidu Direct clip ${clipIdx + 1} submitted: task_id=${taskId}, credits=${result.credits || "?"}`);

            const sceneForAsset = scenes.find(s => s.scene_index === pair.sceneIndex) || scenes[0];
            await supabase.from("assets").insert({
              supabase_path: `pending-vidu-direct/${runId}/clip-${clipIdx}`,
              type: "clip" as any, run_id: runId, scene_id: sceneForAsset.id,
              metadata: {
                vidu_task_id: taskId,
                clip_index: clipIdx,
                scene_index: pair.sceneIndex,
                status: "submitted",
                generator: "vidu_direct",
                model: viduModel,
              },
            });
          } catch (submitErr) {
            await log("error", `Vidu Direct clip ${clipIdx + 1} submit error: ${submitErr.message}`);
          }
        }

        if (viduTaskIds.length === 0) {
          await log("error", "No Vidu Direct tasks submitted successfully");
          await updateRun({ status: "failed", error_message: "All Vidu Direct submissions failed" });
          return json({ error: "All submissions failed" }, 500);
        }

        // Off-peak mode: pause the run and let the scheduled sweeper handle completion
        await log("info", `All ${viduTaskIds.length} Vidu Direct off-peak clips submitted. Pausing run for background polling.`);
        await updateRun({
          status: "paused",
          progress_pct: 45,
          generated_metadata: {
            ...(run.generated_metadata as any || {}),
            waiting_for: "vidu_off_peak",
            vidu_task_ids: viduTaskIds,
            off_peak_submitted_at: new Date().toISOString(),
          },
        });
        return json({ status: "vidu_off_peak_paused", run_id: runId, tasks: viduTaskIds.length });
      }

      // ══════════════════════════════════════════════════════
      // FAL.AI PATH (Pika / Vidu via fal.ai)
      // ══════════════════════════════════════════════════════
      if (videoGenerator === "pika" || videoGenerator === "vidu") {
        const FAL_KEY = Deno.env.get("FAL_KEY");
        if (!FAL_KEY) {
          await log("error", "FAL_KEY not configured — cannot use fal.ai generators");
          await updateRun({ status: "failed", error_message: "FAL_KEY not configured" });
          return json({ error: "FAL_KEY not configured" }, 500);
        }

        fal.config({ credentials: FAL_KEY });
        const falResolution = (project as any).pika_resolution || (videoGenerator === "vidu" ? "720p" : "1080p");
        const pikaModel = (project as any).pika_model || "pikaframes";
        const enableAudio = (project as any).kling_sound || false;

        // Determine fal.ai endpoint
        let falEndpoint: string;
        if (videoGenerator === "vidu") {
          falEndpoint = "fal-ai/vidu/q3/image-to-video/turbo";
        } else if (pikaModel === "image-to-video") {
          falEndpoint = "fal-ai/pika/v2.2/image-to-video";
        } else {
          falEndpoint = "fal-ai/pika/v2.2/pikaframes";
        }

        await log("info", `Generator: ${videoGenerator}, model: ${pikaModel}, endpoint: ${falEndpoint}`);

        const falRequestIds: string[] = [];

        if (videoGenerator === "vidu") {
          // ── Vidu: consecutive pairs with start + end frame ──
          const imageUrls: string[] = [];
          if (runInitialImageUrl) imageUrls.push(runInitialImageUrl);
          for (const scene of scenes) {
            if (sceneKeyframes[scene.scene_index]) imageUrls.push(sceneKeyframes[scene.scene_index]);
          }

          if (imageUrls.length < 2) {
            await log("error", "Vidu needs at least 2 keyframe images for start→end transitions");
            await updateRun({ status: "failed", error_message: "Not enough keyframes for Vidu" });
            return json({ error: "Not enough keyframes" }, 500);
          }

          const pairs: Array<{ start: string; end: string; sceneIndex: number; prompt: string }> = [];
          for (let i = 0; i < imageUrls.length - 1; i++) {
            const scene = scenes[i] || scenes[scenes.length - 1];
            pairs.push({
              start: imageUrls[i], end: imageUrls[i + 1],
              sceneIndex: scene.scene_index,
              prompt: scene.kling_prompt || conceptPrompt || "smooth cinematic transition",
            });
          }

          await log("info", `Vidu: submitting ${pairs.length} clip(s), each with start→end frame, 5s each`);

          const viduStartTime = Date.now();
          for (let clipIdx = 0; clipIdx < pairs.length; clipIdx++) {
            if (Date.now() - viduStartTime > 100_000) {
              await log("info", `Time budget reached after ${clipIdx} Vidu submissions. Re-chaining.`);
              break;
            }
            const pair = pairs[clipIdx];
            const falInput: Record<string, any> = {
              image_url: pair.start,
              end_image_url: pair.end,
              prompt: pair.prompt,
              duration: 5,
              resolution: falResolution,
              aspect_ratio: project.aspect_ratio || "9:16",
              audio: enableAudio,
            };

            await log("debug", `Vidu clip ${clipIdx + 1}/${pairs.length} (scene ${pair.sceneIndex})`, {
              start: pair.start.substring(pair.start.lastIndexOf("/") + 1),
              end: pair.end.substring(pair.end.lastIndexOf("/") + 1),
            });

            try {
              const { request_id } = await fal.queue.submit(falEndpoint, { input: falInput });
              if (!request_id) { await log("error", `No request_id for Vidu clip ${clipIdx + 1}`); continue; }
              falRequestIds.push(request_id);
              await log("info", `Vidu clip ${clipIdx + 1} submitted: ${request_id}`);

              const sceneForAsset = scenes.find(s => s.scene_index === pair.sceneIndex) || scenes[0];
              await supabase.from("assets").insert({
                supabase_path: `pending-pika/${runId}/clip-${clipIdx}`,
                type: "clip" as any, run_id: runId, scene_id: sceneForAsset.id,
                metadata: { pika_request_id: request_id, fal_endpoint: falEndpoint, clip_index: clipIdx, scene_index: pair.sceneIndex, status: "submitted", pika_model: "vidu-q3-turbo" },
              });
            } catch (submitErr) {
              await log("error", `Vidu clip ${clipIdx + 1} submit error: ${submitErr.message}`);
            }
          }
        } else if (pikaModel === "image-to-video") {
          // ── Pika Image-to-Video: single image per clip ──
          const imageItems: Array<{ url: string; sceneIndex: number; prompt: string }> = [];
          if (runInitialImageUrl) {
            imageItems.push({ url: runInitialImageUrl, sceneIndex: 0, prompt: scenes[0]?.kling_prompt || conceptPrompt || "cinematic motion" });
          }
          for (const scene of scenes) {
            if (sceneKeyframes[scene.scene_index]) {
              imageItems.push({
                url: sceneKeyframes[scene.scene_index],
                sceneIndex: scene.scene_index,
                prompt: scene.kling_prompt || conceptPrompt || "cinematic motion",
              });
            }
          }

          await log("info", `Pika i2v: submitting ${imageItems.length} clip(s), 5s each`);

          const pikaI2vStartTime = Date.now();
          for (let clipIdx = 0; clipIdx < imageItems.length; clipIdx++) {
            if (Date.now() - pikaI2vStartTime > 100_000) {
              await log("info", `Time budget reached after ${clipIdx} Pika i2v submissions. Re-chaining.`);
              break;
            }
            const item = imageItems[clipIdx];
            const falInput: Record<string, any> = {
              image_url: item.url,
              prompt: item.prompt,
              negative_prompt: negPrompt,
              resolution: falResolution,
              aspect_ratio: project.aspect_ratio || "9:16",
              duration: "5",
            };

            await log("debug", `Pika i2v clip ${clipIdx + 1}/${imageItems.length} (scene ${item.sceneIndex})`);

            try {
              const { request_id } = await fal.queue.submit(falEndpoint, { input: falInput });
              if (!request_id) { await log("error", `No request_id for i2v clip ${clipIdx + 1}`); continue; }
              falRequestIds.push(request_id);
              await log("info", `Pika i2v clip ${clipIdx + 1} submitted: ${request_id}`);

              const sceneForAsset = scenes.find(s => s.scene_index === item.sceneIndex) || scenes[0];
              await supabase.from("assets").insert({
                supabase_path: `pending-pika/${runId}/clip-${clipIdx}`,
                type: "clip" as any, run_id: runId, scene_id: sceneForAsset.id,
                metadata: { pika_request_id: request_id, fal_endpoint: falEndpoint, clip_index: clipIdx, scene_index: item.sceneIndex, status: "submitted", pika_model: "image-to-video" },
              });
            } catch (submitErr) {
              await log("error", `Pika i2v clip ${clipIdx + 1} submit error: ${submitErr.message}`);
            }
          }
        } else {
          // ── Pikaframes: consecutive 2-image pairs ──
          const imageUrls: string[] = [];
          if (runInitialImageUrl) imageUrls.push(runInitialImageUrl);
          for (const scene of scenes) {
            if (sceneKeyframes[scene.scene_index]) imageUrls.push(sceneKeyframes[scene.scene_index]);
          }

          if (imageUrls.length < 2) {
            await log("error", "Pikaframes needs at least 2 keyframe images");
            await updateRun({ status: "failed", error_message: "Not enough keyframes for Pikaframes" });
            return json({ error: "Not enough keyframes" }, 500);
          }

          const pairs: Array<{ start: string; end: string; sceneIndex: number; prompt: string }> = [];
          for (let i = 0; i < imageUrls.length - 1; i++) {
            const scene = scenes[i] || scenes[scenes.length - 1];
            pairs.push({
              start: imageUrls[i], end: imageUrls[i + 1],
              sceneIndex: scene.scene_index,
              prompt: scene.kling_prompt || conceptPrompt || "smooth cinematic transition",
            });
          }

          await log("info", `Pika pikaframes: submitting ${pairs.length} clip(s), each with 2 keyframes (start→end, 5s each)`);

          const pikaFramesStartTime = Date.now();
          for (let clipIdx = 0; clipIdx < pairs.length; clipIdx++) {
            if (Date.now() - pikaFramesStartTime > 100_000) {
              await log("info", `Time budget reached after ${clipIdx} Pikaframes submissions. Re-chaining.`);
              break;
            }
            const pair = pairs[clipIdx];
            const pikaInput: Record<string, any> = {
              image_urls: [pair.start, pair.end],
              prompt: pair.prompt, negative_prompt: negPrompt,
              resolution: falResolution,
              aspect_ratio: project.aspect_ratio || "9:16",
              transitions: [{ duration: 5, prompt: pair.prompt }],
            };

            await log("debug", `Pika clip ${clipIdx + 1}/${pairs.length} (scene ${pair.sceneIndex})`, {
              start: pair.start.substring(pair.start.lastIndexOf("/") + 1),
              end: pair.end.substring(pair.end.lastIndexOf("/") + 1),
            });

            try {
              const { request_id } = await fal.queue.submit(falEndpoint, { input: pikaInput });
              if (!request_id) { await log("error", `No request_id for clip ${clipIdx + 1}`); continue; }
              falRequestIds.push(request_id);
              await log("info", `Pika clip ${clipIdx + 1} submitted: ${request_id}`);

              const sceneForAsset = scenes.find(s => s.scene_index === pair.sceneIndex) || scenes[0];
              await supabase.from("assets").insert({
                supabase_path: `pending-pika/${runId}/clip-${clipIdx}`,
                type: "clip" as any, run_id: runId, scene_id: sceneForAsset.id,
                metadata: { pika_request_id: request_id, fal_endpoint: falEndpoint, clip_index: clipIdx, scene_index: pair.sceneIndex, status: "submitted", pika_model: "pikaframes" },
              });
            } catch (submitErr) {
              await log("error", `Pika clip ${clipIdx + 1} submit error: ${submitErr.message}`);
            }
          }
        }

        // Inline poll — up to ~8 min, then client-side poll-pika takes over
        // Pika can take up to ~500s per clip
        const POLL_INTERVAL_MS = 30000;
        const MAX_POLLS = 16; // ~8 minutes
        for (let poll = 0; poll < MAX_POLLS; poll++) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          const currentStatus = await checkRunStatus();
          if (currentStatus !== "running") return json({ status: "halted" });

          let allDone = true;
          let completedInline = 0;
          for (const reqId of falRequestIds) {
            try {
              const status = await fal.queue.status(falEndpoint, {
                requestId: reqId,
                logs: false,
              });

              if (status.status === "COMPLETED") {
                // Check if already downloaded
                const { data: existing } = await supabase.from("assets")
                  .select("supabase_path")
                  .eq("run_id", runId)
                  .eq("type", "clip")
                  .filter("metadata->>pika_request_id", "eq", reqId)
                  .single();
                if (existing && !existing.supabase_path.startsWith("pending-")) {
                  completedInline++;
                  continue;
                }

                const result = await fal.queue.result(falEndpoint, {
                  requestId: reqId,
                });
                const videoUrl = (result.data as any)?.video?.url;
                if (videoUrl) {
                  const videoResp = await fetch(videoUrl);
                  if (videoResp.ok) {
                    const videoBytes = new Uint8Array(await videoResp.arrayBuffer());
                    const storagePath = `${project.id}/clips/${runId}/fal-${reqId}.mp4`;
                    await supabase.storage.from("project-assets").upload(storagePath, videoBytes, { contentType: "video/mp4", upsert: true });
                    await supabase.from("assets")
                      .update({ supabase_path: storagePath, metadata: { pika_request_id: reqId, status: "completed" } })
                      .eq("run_id", runId)
                      .eq("type", "clip")
                      .filter("metadata->>pika_request_id", "eq", reqId);
                    await log("info", `Pika clip ${reqId} downloaded and stored`);
                    completedInline++;
                  }
                }
              } else if (status.status === "FAILED") {
                await log("error", `Pika clip ${reqId} failed`, status);
                completedInline++;
              } else {
                allDone = false;
                await log("debug", `Pika clip ${reqId}: ${status.status}`);
              }
            } catch (pollErr) {
              await log("warn", `Pika poll error ${reqId}: ${pollErr.message}`);
              allDone = false;
            }
          }

          if (allDone) {
            await log("info", `All ${falRequestIds.length} fal.ai clips completed.`);
            await updateRun({ current_step: "stitch", progress_pct: 70 });
            chainNextStep();
            return json({ status: "fal_complete", run_id: runId });
          }

          const progress = 40 + Math.round(30 * (completedInline / falRequestIds.length));
          await updateRun({ progress_pct: Math.min(progress, 69) });
        }

        await log("info", "Inline Pika polling timed out — client-side poll-pika will continue.");
        return json({ status: "pika_polling_timeout", run_id: runId });
      }

      // ══════════════════════════════════════════════════════
      // KLING PATH (original)
      // ══════════════════════════════════════════════════════
      const KLING_ACCESS_KEY = Deno.env.get("KLING_ACCESS_KEY");
      const KLING_SECRET_KEY = Deno.env.get("KLING_SECRET_KEY");
      const KLING_API_BASE = "https://api-singapore.klingai.com";

      async function getKlingToken(): Promise<string> {
        const encoder = new TextEncoder();
        const keyData = encoder.encode(KLING_SECRET_KEY);
        const key = await crypto.subtle.importKey(
          "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
        );
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: "HS256", typ: "JWT" };
        const payload = { iss: KLING_ACCESS_KEY, exp: now + 1800, iat: now, nbf: now };
        const b64url = (data: Uint8Array | string) => {
          const str = typeof data === "string" ? data : String.fromCharCode(...data);
          return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        };
        const encHeader = b64url(JSON.stringify(header));
        const encPayload = b64url(JSON.stringify(payload));
        const sigInput = encoder.encode(`${encHeader}.${encPayload}`);
        const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, sigInput));
        return `${encHeader}.${encPayload}.${b64url(signature)}`;
      }

      if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
        await log("warn", "KLING keys not configured — skipping video generation.");
        await updateRun({ current_step: "stitch", progress_pct: 70 });
        chainNextStep();
        return json({ status: "kling_skipped" });
      }

      if (pendingScenes.length === 0) {
        await log("info", "All Kling tasks already submitted. Starting polling.");
      } else {
        const soundSupported = project.kling_model_name?.startsWith("kling-v2-6");
        const klingDuration = (project.clip_duration_sec || 10) >= 10 ? "10" : "5";

        const CONCURRENCY = 3;
        const submitTask = async (scene: any, idx: number) => {
          await supabase.from("scenes").update({ status: "clip_requested" as const }).eq("id", scene.id);

          const sceneIdx = scene.scene_index;
          const allSceneIndices = scenes.map(s => s.scene_index);
          const myPos = allSceneIndices.indexOf(sceneIdx);

          const startImageUrl = myPos === 0
            ? (runInitialImageUrl || sceneKeyframes[sceneIdx])
            : (sceneKeyframes[scenes[myPos - 1].scene_index] || runInitialImageUrl);
          const endImageUrl = sceneKeyframes[sceneIdx];

          // Build behavior-aware prompt
          const behavior = scene.scene_behavior || "cinematic_action";
          const densityLabel = scene.activity_density || "medium";
          const enrichedPrompt = scene.kling_prompt
            ? `[${behavior}/${densityLabel}] ${scene.kling_prompt}`
            : "";

          const klingBody: Record<string, any> = {
            model_name: project.kling_model_name || "kling-v1",
            image: startImageUrl || "",
            prompt: enrichedPrompt,
            negative_prompt: negPrompt,
            duration: klingDuration,
            mode: project.kling_mode || "pro",
            sound: soundSupported && project.kling_sound ? "on" : "off",
          };

          if ((project.kling_mode || "pro") === "pro" && endImageUrl && endImageUrl !== startImageUrl) {
            klingBody.image_tail = endImageUrl;
          }

          await log("debug", `🔵 KLING CALL → POST /v1/videos/image2video scene=${sceneIdx}`, {
            model_name: klingBody.model_name,
            mode: klingBody.mode,
            duration: klingBody.duration,
            prompt: klingBody.prompt?.substring(0, 300),
            negative_prompt: klingBody.negative_prompt?.substring(0, 200),
            has_image: !!klingBody.image,
            has_image_tail: !!klingBody.image_tail,
          });

          const klingToken = await getKlingToken();
          const createResp = await fetch(`${KLING_API_BASE}/v1/videos/image2video`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${klingToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(klingBody),
          });
          const createResult = await createResp.json();

          await log("debug", `🟢 KLING RESP ← scene=${sceneIdx}`, createResult);

          if (createResult.code !== 0 || !createResult.data?.task_id) {
            await log("error", `Kling task creation failed for scene ${sceneIdx}: ${createResult.message}`, createResult);
            await supabase.from("scenes").update({ status: "failed" as const }).eq("id", scene.id);
            return;
          }

          const taskId = createResult.data.task_id;
          await log("info", `Kling task ${taskId} submitted for scene ${sceneIdx}`);

          await supabase.from("assets").insert({
            supabase_path: `pending-kling/${runId}/scene-${sceneIdx}`,
            type: "clip" as any,
            run_id: runId,
            scene_id: scene.id,
            metadata: { kling_task_id: taskId, scene_index: sceneIdx, status: "submitted" },
          });
        };

        // Submit in batches of CONCURRENCY, waiting for each batch to complete
        // before submitting the next to avoid Kling's "parallel task over resource pack limit"
        const totalBatches = Math.ceil(pendingScenes.length / CONCURRENCY);
        for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
          const status = await checkRunStatus();
          if (status !== "running") {
            await log("info", "Run halted during Kling submission");
            return json({ status: "halted" });
          }
          const batchStart = batchIdx * CONCURRENCY;
          const batchItems = pendingScenes.slice(batchStart, batchStart + CONCURRENCY);
          await log("info", `Submitting Kling batch ${batchIdx + 1}/${totalBatches} (${batchItems.length} scenes)`);
          await Promise.all(batchItems.map((s, i) => submitTask(s, batchStart + i)));

          // If there are more batches, poll until this batch completes before submitting next
          if (batchIdx < totalBatches - 1) {
            await log("info", `Waiting for batch ${batchIdx + 1} to complete before submitting next batch...`);
            const BATCH_POLL_INTERVAL = 15000;
            const MAX_BATCH_POLLS = 40; // ~10 minutes per batch
            let batchDone = false;
            for (let poll = 0; poll < MAX_BATCH_POLLS; poll++) {
              await new Promise(r => setTimeout(r, BATCH_POLL_INTERVAL));
              const runStatus = await checkRunStatus();
              if (runStatus !== "running") return json({ status: "halted" });

              // Check if all tasks from this batch have resolved
              const { data: batchAssets } = await supabase
                .from("assets")
                .select("metadata")
                .eq("run_id", runId)
                .eq("type", "clip")
                .like("supabase_path", `pending-kling/${runId}/%`);

              // Count how many of this batch's scenes are still pending
              const batchSceneIndices = new Set(batchItems.map(s => s.scene_index));
              const stillPending = (batchAssets || []).filter(a => {
                const meta = a.metadata as any;
                return meta?.kling_task_id && batchSceneIndices.has(meta.scene_index) &&
                  meta.status !== "completed" && meta.status !== "failed";
              });

              // Also check if tasks were downloaded (path no longer starts with pending-)
              const { data: completedAssets } = await supabase
                .from("assets")
                .select("metadata")
                .eq("run_id", runId)
                .eq("type", "clip")
                .not("supabase_path", "like", "pending-%");
              const completedSceneIndices = new Set((completedAssets || []).map(a => (a.metadata as any)?.scene_index));
              const failedScenes = (batchAssets || []).filter(a => {
                const meta = a.metadata as any;
                return batchSceneIndices.has(meta?.scene_index) && meta?.status === "failed";
              });

              // Batch is done when all its scenes are either completed or failed
              const resolvedCount = [...batchSceneIndices].filter(idx =>
                completedSceneIndices.has(idx) || failedScenes.some(a => (a.metadata as any)?.scene_index === idx)
              ).length;

              if (resolvedCount >= batchItems.length || stillPending.length === 0) {
                await log("info", `Batch ${batchIdx + 1} complete. Proceeding to next batch.`);
                batchDone = true;
                break;
              }

              // Trigger poll-kling to process completions
              try {
                const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/poll-kling`;
                await fetch(fnUrl, {
                  method: "POST",
                  headers: {
                    "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ run_id: runId }),
                });
              } catch (pollErr) {
                await log("warn", `Batch poll error: ${pollErr.message}`);
              }
            }

            if (!batchDone) {
              await log("warn", `Batch ${batchIdx + 1} polling timed out. Submitting next batch anyway.`);
            }
          }
        }

        await log("info", "All Kling tasks submitted.");
      }

      // Short inline poll loop (~2 min) then hand off to client/poll-kling
      const POLL_INTERVAL_MS = 15000;
      const MAX_POLLS = 8;
      for (let poll = 0; poll < MAX_POLLS; poll++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        const currentStatus = await checkRunStatus();
        if (currentStatus !== "running") return json({ status: "halted" });

        try {
          const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/poll-kling`;
          const pollResp = await fetch(fnUrl, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ run_id: runId }),
          });
          const pollResult = await pollResp.json();
          await log("debug", `Poll result: ${JSON.stringify(pollResult)}`);

          if (pollResult.status === "kling_complete") {
            await log("info", "All Kling tasks completed during inline polling.");
            return json({ status: "kling_complete", run_id: runId });
          }
        } catch (pollErr) {
          await log("warn", `Inline poll error: ${pollErr.message}`);
        }
      }

      await log("info", "Inline polling timed out — client/poll-kling will continue.");
      return json({ status: "kling_polling_timeout", run_id: runId });
    }

    // Steps stitch/metadata/publish/done are handled by finalize-video — chain to it
    if (["stitch", "metadata", "publish"].includes(step)) {
      await log("info", `Step "${step}" handled by finalize-video. Chaining...`);
      const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/finalize-video`;
      fetch(fnUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ run_id: runId }),
      }).catch((e) => console.error("Chain to finalize-video error:", e));
      return json({ status: "chained_to_finalize", step });
    }

    return json({ status: "step_not_handled_here", step });

  } catch (err) {
    await log("error", `Pipeline failed: ${err.message}`);
    await updateRun({ status: "failed", error_message: err.message, finished_at: new Date().toISOString() });

    // Send error notification email
    try {
      const notifyUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-notification`;
      await fetch(notifyUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ run_id: runId, type: "error", error_message: err.message }),
      });
    } catch (notifyErr) {
      console.error("Notification send error:", notifyErr);
    }

    return json({ error: err.message }, 500);
  }
});
