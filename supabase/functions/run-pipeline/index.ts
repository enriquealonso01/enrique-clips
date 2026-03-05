import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

  let runId: string;
  try {
    const body = await req.json();
    runId = body.run_id;
  } catch {
    return new Response(JSON.stringify({ error: "run_id required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Helper: log to run_logs
  async function log(level: string, message: string, data?: unknown) {
    await supabase.from("run_logs").insert({
      run_id: runId,
      level: level as any,
      message,
      data: data ? (data as any) : null,
    });
  }

  // Helper: update run
  async function updateRun(updates: Record<string, unknown>) {
    await supabase.from("runs").update(updates).eq("id", runId);
  }

  // Helper: check if run was stopped/paused
  async function checkRunStatus(): Promise<string> {
    const { data } = await supabase.from("runs").select("status").eq("id", runId).single();
    return data?.status || "unknown";
  }

  // Helper: call Lovable AI (non-streaming, with optional modalities)
  async function callAI(
    messages: Array<{ role: string; content: any }>,
    tools?: any[],
    tool_choice?: any,
    model?: string,
    modalities?: string[],
    timeoutMs = 120000,
    retries = 1
  ) {
    const body: any = {
      model: model || "google/gemini-3-flash-preview",
      messages,
      stream: false,
    };
    if (tools) body.tools = tools;
    if (tool_choice) body.tool_choice = tool_choice;
    if (modalities) body.modalities = modalities;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(AI_GATEWAY, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`AI gateway error ${resp.status}: ${errText}`);
        }
        return await resp.json();
      } catch (err) {
        clearTimeout(timer);
        if (attempt < retries) {
          await log("warn", `AI call attempt ${attempt + 1} failed (${err.message}), retrying...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw err;
      }
    }
  }

  // Helper: extract image from AI response, upload to storage, create asset
  async function extractAndUploadImage(
    aiResult: any,
    storagePath: string,
    assetType: string,
    assetMeta: Record<string, unknown>
  ): Promise<string | null> {
    const message = aiResult.choices?.[0]?.message;
    if (!message) return null;

    // Check images array (Lovable AI gateway format)
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

    // Fallback: check content array for inline images
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

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    // Fetch run and project
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

    // Start run
    await updateRun({
      status: "running",
      started_at: new Date().toISOString(),
      current_step: "plan",
      progress_pct: 0,
    });
    await log("info", "Pipeline started");

    // ===== STEP 0: GENERATE INITIAL IMAGE =====
    // The initial image is generated per-run to maintain visual consistency across all scenes
    await log("info", "Generating initial consistency image for this run...");
    try {
      const initialImagePrompt = project.series_prompt
        ? `Generate a single high-quality ${project.aspect_ratio} reference image that captures the visual style, mood, and key character/subject for this series: "${project.series_prompt}". This image will be used as a visual anchor to keep all scenes consistent. Style: cinematic, high detail, rich colors.`
        : `Generate a high-quality ${project.aspect_ratio} cinematic reference image that can serve as a visual anchor for a short video series. Style: cinematic, high detail, rich colors, compelling subject.`;

      const imageResult = await callAI(
        [{ role: "user", content: initialImagePrompt }],
        undefined,
        undefined,
        "google/gemini-3-pro-image-preview",
        ["image", "text"]
      );

      const assetId = await extractAndUploadImage(
        imageResult,
        `${project.id}/initial-image/${runId}/reference`,
        "initial_image",
        { run_id: runId, purpose: "run_consistency_anchor" }
      );

      if (assetId) {
        await log("info", "Initial consistency image generated and saved");
      } else {
        await log("warn", "Could not extract image from AI response — pipeline continues without initial image");
      }

      await updateRun({ progress_pct: 5 });
    } catch (err) {
      await log("warn", `Initial image generation failed: ${err.message} — continuing without it`);
      await updateRun({ progress_pct: 5 });
    }

    // ===== STEP 1: PLAN + STYLE BIBLE =====
    await log("info", "Step 1/7: Generating style bible and scene plan...");

    // Global negative prompt template injected into every Kling call
    const KLING_NEGATIVE_TEMPLATE = "flicker, jitter, warping, morphing face, melting, extra limbs, extra fingers, text, watermark, logo, low-res, heavy noise, blurry, duplicate, deformed";
    const fullNegativePrompt = project.negative_prompt
      ? `${KLING_NEGATIVE_TEMPLATE}, ${project.negative_prompt}`
      : KLING_NEGATIVE_TEMPLATE;

    let styleBible: Record<string, any> = {};

    try {
      // --- 1a: Generate Style Bible ---
      const styleBibleResult = await callAI(
        [
          {
            role: "system",
            content: `You are a visual consistency director. Given a series concept, produce a structured "Style Bible" that will be appended to every image and video prompt to maintain perfect consistency across all scenes.`,
          },
          {
            role: "user",
            content: `Series concept: ${project.series_prompt || "A visually stunning short video series"}\nAspect ratio: ${project.aspect_ratio}\n${project.series_rules ? `Rules: ${project.series_rules}` : ""}\n${project.negative_prompt ? `Avoid: ${project.negative_prompt}` : ""}\n\nCreate a detailed style bible.`,
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
                  character_identity: { type: "string", description: "Detailed description of main character/subject: appearance, age, build, skin tone, hair, distinguishing features" },
                  outfit_description: { type: "string", description: "Exact clothing/outfit description with colors and materials" },
                  environment_layout: { type: "string", description: "Setting, background elements, spatial layout" },
                  lighting_palette: { type: "string", description: "Lighting style, color palette, time of day, mood" },
                  camera_constraints: { type: "string", description: "Default camera distance, angle, lens style" },
                  do_not_change: { type: "array", items: { type: "string" }, description: "List of elements that must remain identical across all scenes" },
                  art_style: { type: "string", description: "Overall art/rendering style (photorealistic, anime, 3D render, etc.)" },
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
        await log("info", "Style Bible generated", styleBible);
      }

      // --- 1b: Generate Scene Plan (with style bible context & constrained prompts) ---
      const styleBibleText = Object.entries(styleBible)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join("\n");

      const planResult = await callAI(
        [
          {
            role: "system",
            content: `You are a creative director for short-form video content. Generate a scene-by-scene plan.
The series has ${project.scene_count} scenes, each ${project.clip_duration_sec} seconds long, in ${project.aspect_ratio} aspect ratio.
${project.series_rules ? `Rules: ${project.series_rules}` : ""}
${project.negative_prompt ? `Avoid: ${project.negative_prompt}` : ""}

=== STYLE BIBLE (must be followed for ALL scenes) ===
${styleBibleText || "No style bible available."}

=== KEYFRAME PROMPT RULES ===
- Each end_keyframe_prompt must include composition anchors: camera distance (medium shot, close-up, etc.), subject position (centered, rule-of-thirds), horizon line, and room/environment layout.
- Maintain identical character appearance, outfit, and art style as defined in the style bible.
- Reference specific elements from the "do_not_change" list.

=== KLING MOTION PROMPT RULES ===
- Each kling_prompt must describe EXACTLY ONE camera move + ONE subject action. No multi-action prompts.
- Use consistent motion language: "slow dolly in", "gentle pan left", "subtle head turn", "soft parallax", "steady zoom out", "slight camera push".
- Keep motion gentle and controlled to minimize warping and jitter.
- Never describe cuts, transitions, or scene changes within a single prompt.`,
          },
          {
            role: "user",
            content: `Create a ${project.scene_count}-scene plan for: ${project.series_prompt || "A visually stunning short video"}`,
          },
        ],
        [
          {
            type: "function",
            function: {
              name: "create_scene_plan",
              description: "Create a structured scene-by-scene plan",
              parameters: {
                type: "object",
                properties: {
                  scenes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        scene_index: { type: "number" },
                        scene_title: { type: "string" },
                        scene_description: { type: "string", description: "Visual description of what happens" },
                        end_keyframe_prompt: { type: "string", description: "Detailed image prompt for the END frame of this clip. Must include composition anchors and style bible elements." },
                        kling_prompt: { type: "string", description: "Single camera move + single subject action. Keep motion gentle." },
                      },
                      required: ["scene_index", "scene_title", "scene_description", "end_keyframe_prompt", "kling_prompt"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["scenes"],
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
      await log("info", `Generated plan with ${scenePlan.scenes.length} scenes`, scenePlan);

      for (const scene of scenePlan.scenes) {
        await supabase.from("scenes").insert({
          run_id: runId,
          scene_index: scene.scene_index,
          scene_title: scene.scene_title,
          scene_description: scene.scene_description,
          end_keyframe_prompt: scene.end_keyframe_prompt,
          kling_prompt: scene.kling_prompt,
          status: "pending" as const,
        });
      }

      // Store style bible in run metadata for downstream use
      await updateRun({
        current_step: "keyframes",
        progress_pct: 15,
        generated_metadata: { style_bible: styleBible },
      });
      await log("info", "Scene plan and style bible saved");
    } catch (err) {
      await log("error", `Plan step failed: ${err.message}`);
      await updateRun({ status: "failed", error_message: `Plan failed: ${err.message}`, finished_at: new Date().toISOString() });
      return json({ error: err.message }, 500);
    }

    // Check if stopped
    if ((await checkRunStatus()) !== "running") {
      await log("info", "Run was stopped/paused, halting pipeline");
      return json({ status: "halted" });
    }

    // ===== STEP 2: KEYFRAMES (Sequential Chaining: K(i-1) → Ki) =====
    // K0 = initial seed image. For each scene i, generate Ki using K(i-1) as visual reference.
    // Clip i will use K(i-1) as start frame and Ki as end frame.
    await log("info", "Step 2/7: Generating chained keyframe images...");

    const styleBibleTextForKeyframes = Object.entries(styleBible)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("; ");

    try {
      const { data: scenes } = await supabase
        .from("scenes")
        .select("*")
        .eq("run_id", runId)
        .order("scene_index");

      // K0 = initial image (generated in Step 0). Get its URL as starting chain reference.
      const { data: initialAssets } = await supabase
        .from("assets")
        .select("supabase_path")
        .eq("run_id", runId)
        .eq("type", "initial_image")
        .limit(1);

      let prevKeyframeUrl: string | null = null;
      if (initialAssets && initialAssets.length > 0) {
        const { data: urlData } = supabase.storage
          .from("project-assets")
          .getPublicUrl(initialAssets[0].supabase_path);
        prevKeyframeUrl = urlData.publicUrl;
      }

      if (scenes) {
        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i];
          const status = await checkRunStatus();
          if (status !== "running") {
            await log("info", "Run halted during keyframe generation");
            return json({ status: "halted" });
          }

          await log("info", `Generating end keyframe K${i + 1} for scene ${scene.scene_index}: ${scene.scene_title}`);

          try {
            const promptText = `Generate a high-quality ${project.aspect_ratio} image for this scene's END frame. This is keyframe K${i + 1} of ${scenes.length}.

=== STYLE BIBLE (follow exactly) ===
${styleBibleTextForKeyframes || "Cinematic, high detail, vibrant colors."}

=== SCENE ===
${scene.end_keyframe_prompt}

=== RULES ===
- Maintain IDENTICAL character appearance, outfit, and art style as the reference image.
- Keep the same lighting/palette direction.
- Match the composition anchors specified in the scene description.
- Do NOT add text, watermarks, or logos.`;

            const userContent: any[] = [{ type: "text", text: promptText }];

            // Chain: use K(i-1) as visual reference for consistency
            if (prevKeyframeUrl) {
              userContent.push({
                type: "image_url",
                image_url: { url: prevKeyframeUrl },
              });
            }

            const imageResult = await callAI(
              [{ role: "user", content: userContent }],
              undefined,
              undefined,
              "google/gemini-3-pro-image-preview",
              ["image", "text"]
            );

            const assetId = await extractAndUploadImage(
              imageResult,
              `${project.id}/keyframes/${runId}/scene-${scene.scene_index}-end`,
              "keyframe",
              { run_id: runId, scene_id: scene.id, keyframe_type: "end", scene_index: scene.scene_index }
            );

            if (assetId) {
              await log("info", `Keyframe K${i + 1} saved for scene ${scene.scene_index}`);
              // Update chain reference: next scene uses this keyframe
              const { data: newAsset } = await supabase
                .from("assets")
                .select("supabase_path")
                .eq("id", assetId)
                .single();
              if (newAsset) {
                const { data: urlData } = supabase.storage
                  .from("project-assets")
                  .getPublicUrl(newAsset.supabase_path);
                prevKeyframeUrl = urlData.publicUrl;
              }
            } else {
              await log("warn", `No image data for keyframe K${i + 1} — keeping previous keyframe as chain reference`);
            }
            await supabase.from("scenes").update({ status: "keyframes_ready" as const }).eq("id", scene.id);
          } catch (sceneErr) {
            await log("warn", `Keyframe generation failed for scene ${scene.scene_index}: ${sceneErr.message}`);
            await supabase.from("scenes").update({ status: "keyframes_ready" as const }).eq("id", scene.id);
          }

          const progress = 15 + Math.round((25 * (i + 1)) / scenes.length);
          await updateRun({ progress_pct: progress });
        }
      }

      await updateRun({ current_step: "kling", progress_pct: 40 });
      await log("info", "Chained keyframe generation complete");
    } catch (err) {
      await log("error", `Keyframes step failed: ${err.message}`);
      await updateRun({ status: "failed", error_message: `Keyframes failed: ${err.message}`, finished_at: new Date().toISOString() });
      return json({ error: err.message }, 500);
    }

    // ===== STEP 3: KLING (Video Generation) =====
    await log("info", "Step 3/7: Video generation (Kling)...");
    const KLING_ACCESS_KEY = Deno.env.get("KLING_ACCESS_KEY");
    const KLING_SECRET_KEY = Deno.env.get("KLING_SECRET_KEY");
    const KLING_API_BASE = "https://api-singapore.klingai.com";

    // Helper: generate Kling JWT token (valid 30 min)
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
      await log("warn", "KLING_ACCESS_KEY/KLING_SECRET_KEY not configured — skipping video generation.");
      await updateRun({ current_step: "stitch", progress_pct: 70 });
    } else {
      try {
        const { data: scenes } = await supabase
          .from("scenes")
          .select("*")
          .eq("run_id", runId)
          .order("scene_index");

        if (scenes) {
          // Gather keyframe asset URLs for each scene (end keyframes)
          const sceneKeyframes: Record<number, string> = {};
          for (const scene of scenes) {
            const { data: keyframeAssets } = await supabase
              .from("assets")
              .select("supabase_path")
              .eq("run_id", runId)
              .eq("scene_id", scene.id)
              .eq("type", "keyframe")
              .limit(1);
            if (keyframeAssets && keyframeAssets.length > 0) {
              const { data: urlData } = supabase.storage
                .from("project-assets")
                .getPublicUrl(keyframeAssets[0].supabase_path);
              sceneKeyframes[scene.scene_index] = urlData.publicUrl;
            }
          }

          // Fetch initial image URL for this run (used as Scene 1's start image)
          let runInitialImageUrl: string | null = null;
          const { data: initAssets } = await supabase
            .from("assets")
            .select("supabase_path")
            .eq("run_id", runId)
            .eq("type", "initial_image")
            .limit(1);
          if (initAssets && initAssets.length > 0) {
            const { data: urlData } = supabase.storage
              .from("project-assets")
              .getPublicUrl(initAssets[0].supabase_path);
            runInitialImageUrl = urlData.publicUrl;
          }

          // Determine if sound is supported (only v2.6+)
          const soundSupported = project.kling_model_name?.startsWith("kling-v2-6");
          // Map clip_duration_sec to valid Kling duration ("5" or "10")
          const klingDuration = (project.clip_duration_sec || 10) >= 10 ? "10" : "5";

          // Submit Kling tasks concurrently in batches of 3
          const CONCURRENCY = 3;
          const submitTask = async (i: number) => {
            const scene = scenes[i];
            await supabase.from("scenes").update({ status: "clip_requested" as const }).eq("id", scene.id);

            // Chain: scene 1 starts from initial image, subsequent scenes start from previous scene's end keyframe
            const startImageUrl = i === 0
              ? (runInitialImageUrl || sceneKeyframes[scene.scene_index])
              : (sceneKeyframes[scenes[i - 1].scene_index] || runInitialImageUrl);
            const endImageUrl = sceneKeyframes[scene.scene_index];

            const klingBody: Record<string, any> = {
              model_name: project.kling_model_name || "kling-v1",
              image: startImageUrl || "",
              prompt: scene.kling_prompt || "",
              negative_prompt: fullNegativePrompt,
              duration: klingDuration,
              mode: project.kling_mode || "pro",
              sound: soundSupported && project.kling_sound ? "on" : "off",
            };

            const klingMode = project.kling_mode || "pro";
            if (klingMode === "pro" && endImageUrl && endImageUrl !== startImageUrl) {
              klingBody.image_tail = endImageUrl;
            }

            await log("debug", `Kling request body for scene ${scene.scene_index}`, klingBody);

            const klingToken = await getKlingToken();
            const createResp = await fetch(`${KLING_API_BASE}/v1/videos/image2video`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${klingToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(klingBody),
            });

            const createResult = await createResp.json();
            if (createResult.code !== 0 || !createResult.data?.task_id) {
              await log("error", `Kling task creation failed for scene ${scene.scene_index}: ${createResult.message}`, createResult);
              await supabase.from("scenes").update({ status: "failed" as const }).eq("id", scene.id);
              return;
            }

            const taskId = createResult.data.task_id;
            await log("info", `Kling task ${taskId} submitted for scene ${scene.scene_index}`);

            await supabase.from("assets").insert({
              supabase_path: `pending-kling/${runId}/scene-${scene.scene_index}`,
              type: "clip" as any,
              run_id: runId,
              scene_id: scene.id,
              metadata: { kling_task_id: taskId, scene_index: scene.scene_index, status: "submitted" },
            });
          };

          // Process in batches of CONCURRENCY
          for (let batch = 0; batch < scenes.length; batch += CONCURRENCY) {
            const status = await checkRunStatus();
            if (status !== "running") {
              await log("info", "Run halted during video generation");
              return json({ status: "halted" });
            }

            const batchEnd = Math.min(batch + CONCURRENCY, scenes.length);
            const batchPromises = [];
            for (let i = batch; i < batchEnd; i++) {
              await log("info", `Submitting Kling task for scene ${scenes[i].scene_index}`);
              batchPromises.push(submitTask(i));
            }
            await Promise.all(batchPromises);
          }
        }

        // Server-side poll loop: poll Kling for up to ~2 minutes so pipeline
        // continues without requiring the client to be active.
        await log("info", "All Kling tasks submitted. Starting server-side polling loop...");
        const POLL_INTERVAL_MS = 15000;
        const MAX_POLLS = 8; // ~2 minutes
        for (let poll = 0; poll < MAX_POLLS; poll++) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          
          const currentStatus = await checkRunStatus();
          if (currentStatus !== "running") {
            await log("info", "Run halted during Kling polling");
            return json({ status: "halted" });
          }

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
              return json({ status: "kling_complete_and_finalized", run_id: runId });
            }
          } catch (pollErr) {
            await log("warn", `Inline poll error: ${pollErr.message}`);
          }
        }

        await log("info", "Inline polling timed out — client polling will continue.");
        return json({ status: "kling_polling_timeout", run_id: runId });
      } catch (err) {
        await log("error", `Kling step failed: ${err.message}`);
        await updateRun({ status: "failed", error_message: `Kling failed: ${err.message}`, finished_at: new Date().toISOString() });
        return json({ error: err.message }, 500);
      }
    }

  } catch (err) {
    await log("error", `Pipeline failed: ${err.message}`);
    await updateRun({ status: "failed", error_message: err.message, finished_at: new Date().toISOString() });
    return json({ error: err.message }, 500);
  }
});
