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
    modalities?: string[]
  ) {
    const body: any = {
      model: model || "google/gemini-3-flash-preview",
      messages,
      stream: false,
    };
    if (tools) body.tools = tools;
    if (tool_choice) body.tool_choice = tool_choice;
    if (modalities) body.modalities = modalities;

    const resp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`AI gateway error ${resp.status}: ${errText}`);
    }
    return await resp.json();
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

    // ===== STEP 1: PLAN =====
    await log("info", "Step 1/7: Generating scene plan...");
    try {
      const planResult = await callAI(
        [
          {
            role: "system",
            content: `You are a creative director for short-form video content. Generate a scene-by-scene plan for a video series.
The series has ${project.scene_count} scenes, each ${project.clip_duration_sec} seconds long, in ${project.aspect_ratio} aspect ratio.
${project.series_rules ? `Rules: ${project.series_rules}` : ""}
${project.negative_prompt ? `Avoid: ${project.negative_prompt}` : ""}`,
          },
          {
            role: "user",
            content: `Create a ${project.scene_count}-scene plan for this series: ${project.series_prompt || "A visually stunning short video"}`,
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
                        end_keyframe_prompt: { type: "string", description: "Detailed image generation prompt for the end keyframe" },
                        kling_prompt: { type: "string", description: "Motion prompt for video generation describing how the scene moves/animates" },
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

      await updateRun({ current_step: "keyframes", progress_pct: 15 });
      await log("info", "Scene plan saved to database");
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

    // ===== STEP 2: KEYFRAMES =====
    await log("info", "Step 2/7: Generating keyframe images...");
    try {
      const { data: scenes } = await supabase
        .from("scenes")
        .select("*")
        .eq("run_id", runId)
        .order("scene_index");

      // Fetch initial image for this run to use as visual reference
      const { data: initialAssets } = await supabase
        .from("assets")
        .select("supabase_path")
        .eq("run_id", runId)
        .eq("type", "initial_image")
        .limit(1);

      let initialImageUrl: string | null = null;
      if (initialAssets && initialAssets.length > 0) {
        const { data: urlData } = supabase.storage
          .from("project-assets")
          .getPublicUrl(initialAssets[0].supabase_path);
        initialImageUrl = urlData.publicUrl;
      }

      if (scenes) {
        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i];
          const status = await checkRunStatus();
          if (status !== "running") {
            await log("info", "Run halted during keyframe generation");
            return json({ status: "halted" });
          }

          await log("info", `Generating keyframe for scene ${scene.scene_index}: ${scene.scene_title}`);

          try {
            // Build message with optional initial image reference for consistency
            const userContent: any[] = [
              {
                type: "text",
                text: `Generate a high-quality ${project.aspect_ratio} image for this scene. Keep visual style consistent with the reference image. Scene: ${scene.end_keyframe_prompt}. Style: cinematic, high detail, vibrant colors.`,
              },
            ];

            if (initialImageUrl) {
              userContent.push({
                type: "image_url",
                image_url: { url: initialImageUrl },
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
              await log("info", `Keyframe saved for scene ${scene.scene_index}`);
            } else {
              await log("warn", `No image data for scene ${scene.scene_index}`);
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
      await log("info", "Keyframe generation complete");
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
      const payload = { iss: KLING_ACCESS_KEY, exp: now + 1800, iat: now };

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
          // Gather keyframe asset URLs for each scene
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

          // Determine if sound is supported (only v2.6+)
          const soundSupported = project.kling_model_name?.startsWith("kling-v2-6");
          // Map clip_duration_sec to valid Kling duration ("5" or "10")
          const klingDuration = (project.clip_duration_sec || 10) >= 10 ? "10" : "5";

          for (let i = 0; i < scenes.length; i++) {
            const scene = scenes[i];
            const status = await checkRunStatus();
            if (status !== "running") {
              await log("info", "Run halted during video generation");
              return json({ status: "halted" });
            }

            await log("info", `Submitting Kling task for scene ${scene.scene_index}`);
            await supabase.from("scenes").update({ status: "clip_requested" as const }).eq("id", scene.id);

            // Build Kling request body
            const startImageUrl = i > 0 && sceneKeyframes[scenes[i - 1].scene_index]
              ? sceneKeyframes[scenes[i - 1].scene_index]
              : sceneKeyframes[scene.scene_index];
            const endImageUrl = sceneKeyframes[scene.scene_index];

            const klingBody: Record<string, any> = {
              model_name: project.kling_model_name || "kling-v1",
              image: startImageUrl || "",
              prompt: scene.kling_prompt || "",
              negative_prompt: project.negative_prompt || "",
              duration: klingDuration,
              mode: project.kling_mode || "pro",
              sound: soundSupported && project.kling_sound ? "on" : "off",
            };

            // Add end frame if we have a different end keyframe
            if (endImageUrl && endImageUrl !== startImageUrl) {
              klingBody.image_tail = endImageUrl;
            }

            await log("debug", `Kling request body for scene ${scene.scene_index}`, klingBody);

            // Submit task
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
              const progress = 40 + Math.round((30 * (i + 1)) / scenes.length);
              await updateRun({ progress_pct: progress });
              continue;
            }

            const taskId = createResult.data.task_id;
            await log("info", `Kling task ${taskId} submitted for scene ${scene.scene_index}`);

            // Poll for completion (max ~10 minutes per scene)
            const maxPolls = 60;
            const pollIntervalMs = 10_000;
            let videoUrl: string | null = null;

            for (let poll = 0; poll < maxPolls; poll++) {
              // Check if run was stopped
              const runStatus = await checkRunStatus();
              if (runStatus !== "running") {
                await log("info", "Run halted during Kling polling");
                return json({ status: "halted" });
              }

              await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

              const pollToken = await getKlingToken();
              const pollResp = await fetch(`${KLING_API_BASE}/v1/videos/image2video/${taskId}`, {
                method: "GET",
                headers: { "Authorization": `Bearer ${pollToken}` },
              });
              const pollResult = await pollResp.json();
              const taskStatus = pollResult.data?.task_status;

              if (taskStatus === "succeed") {
                videoUrl = pollResult.data?.task_result?.videos?.[0]?.url || null;
                await log("info", `Kling task ${taskId} succeeded for scene ${scene.scene_index}`);
                break;
              } else if (taskStatus === "failed") {
                await log("error", `Kling task ${taskId} failed: ${pollResult.data?.task_status_msg}`, pollResult.data);
                break;
              }
              // still processing, continue polling
            }

            if (videoUrl) {
              // Download video and upload to storage
              try {
                const videoResp = await fetch(videoUrl);
                const videoData = new Uint8Array(await videoResp.arrayBuffer());
                const storagePath = `${project.id}/clips/${runId}/scene-${scene.scene_index}.mp4`;

                const { error: uploadErr } = await supabase.storage
                  .from("project-assets")
                  .upload(storagePath, videoData, { contentType: "video/mp4", upsert: true });

                if (!uploadErr) {
                  await supabase.from("assets").insert({
                    supabase_path: storagePath,
                    type: "clip" as any,
                    run_id: runId,
                    scene_id: scene.id,
                    metadata: { kling_task_id: taskId, scene_index: scene.scene_index },
                  });
                  await supabase.from("scenes").update({ status: "clip_ready" as const }).eq("id", scene.id);
                  await log("info", `Video clip saved for scene ${scene.scene_index}`);
                } else {
                  await log("error", `Failed to upload video for scene ${scene.scene_index}: ${uploadErr.message}`);
                  await supabase.from("scenes").update({ status: "failed" as const }).eq("id", scene.id);
                }
              } catch (dlErr) {
                await log("error", `Failed to download Kling video for scene ${scene.scene_index}: ${dlErr.message}`);
                await supabase.from("scenes").update({ status: "failed" as const }).eq("id", scene.id);
              }
            } else {
              await log("warn", `No video URL obtained for scene ${scene.scene_index}`);
              await supabase.from("scenes").update({ status: "failed" as const }).eq("id", scene.id);
            }

            const progress = 40 + Math.round((30 * (i + 1)) / scenes.length);
            await updateRun({ progress_pct: progress });
          }
        }

        await updateRun({ current_step: "stitch", progress_pct: 70 });
        await log("info", "Kling video generation step complete");
      } catch (err) {
        await log("error", `Kling step failed: ${err.message}`);
        await updateRun({ status: "failed", error_message: `Kling failed: ${err.message}`, finished_at: new Date().toISOString() });
        return json({ error: err.message }, 500);
      }
    }

    // ===== STEP 4: STITCH =====
    await log("info", "Step 4/7: Video stitching...");
    await log("warn", "Stitch step placeholder — requires clip assets from Kling. Skipping.");
    await updateRun({ current_step: "metadata", progress_pct: 85 });

    // ===== STEP 5: METADATA =====
    await log("info", "Step 5/7: Generating metadata...");
    try {
      const { data: scenes } = await supabase
        .from("scenes")
        .select("scene_title, scene_description")
        .eq("run_id", runId)
        .order("scene_index");

      const scenesSummary = scenes?.map((s) => `${s.scene_title}: ${s.scene_description}`).join("\n") || "";

      const metaResult = await callAI(
        [
          {
            role: "system",
            content: "You are a social media content expert. Generate engaging metadata for a short-form video post.",
          },
          {
            role: "user",
            content: `Generate a title, description, and hashtags for this video:\n\nSeries: ${project.series_prompt || project.title}\nScenes:\n${scenesSummary}`,
          },
        ],
        [
          {
            type: "function",
            function: {
              name: "generate_metadata",
              description: "Generate video post metadata",
              parameters: {
                type: "object",
                properties: {
                  title: { type: "string", description: "Catchy video title (max 100 chars)" },
                  description: { type: "string", description: "Engaging video description (max 500 chars)" },
                  hashtags: { type: "array", items: { type: "string" }, description: "Relevant hashtags without # prefix" },
                },
                required: ["title", "description", "hashtags"],
                additionalProperties: false,
              },
            },
          },
        ],
        { type: "function", function: { name: "generate_metadata" } }
      );

      const metaToolCall = metaResult.choices?.[0]?.message?.tool_calls?.[0];
      if (metaToolCall) {
        const metadata = JSON.parse(metaToolCall.function.arguments);
        await updateRun({ generated_metadata: metadata, progress_pct: 95 });
        await log("info", "Metadata generated", metadata);
      } else {
        await log("warn", "No metadata generated from AI response");
      }

      await updateRun({ current_step: "publish", progress_pct: 95 });
    } catch (err) {
      await log("warn", `Metadata step failed: ${err.message} — continuing to publish`);
      await updateRun({ current_step: "publish", progress_pct: 95 });
    }

    // ===== STEP 6: PUBLISH =====
    await log("info", "Step 6/7: Publishing...");
    if (!project.uploadpost_api_key_encrypted || !project.uploadpost_api_key_configured) {
      await log("warn", "Upload-Post API key not configured — skipping publish step.");
    } else {
      const { data: publishJob } = await supabase
        .from("publish_jobs")
        .insert({ run_id: runId, status: "not_started" as const })
        .select()
        .single();
      await log("info", "Publish job created — awaiting final video for Upload-Post submission.");
    }

    // ===== STEP 7: DONE =====
    await updateRun({
      current_step: "done",
      status: "completed",
      progress_pct: 100,
      finished_at: new Date().toISOString(),
    });
    await log("info", "Pipeline completed successfully! 🎉");

    return json({ status: "completed", run_id: runId });
  } catch (err) {
    await log("error", `Pipeline failed: ${err.message}`);
    await updateRun({ status: "failed", error_message: err.message, finished_at: new Date().toISOString() });
    return json({ error: err.message }, 500);
  }
});
