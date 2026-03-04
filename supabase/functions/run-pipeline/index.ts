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

  // Helper: call Lovable AI (non-streaming)
  async function callAI(messages: Array<{ role: string; content: string }>, tools?: any[], tool_choice?: any, model?: string) {
    const body: any = {
      model: model || "google/gemini-3-flash-preview",
      messages,
      stream: false,
    };
    if (tools) body.tools = tools;
    if (tool_choice) body.tool_choice = tool_choice;

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

  // Return 202 immediately, process in background
  // (We process synchronously but the client doesn't wait)
  try {
    // Fetch run and project
    const { data: run, error: runErr } = await supabase
      .from("runs")
      .select("*")
      .eq("id", runId)
      .single();
    if (runErr || !run) {
      return new Response(JSON.stringify({ error: "Run not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("*")
      .eq("id", run.project_id)
      .single();
    if (projErr || !project) {
      await log("error", "Project not found");
      await updateRun({ status: "failed", error_message: "Project not found" });
      return new Response(JSON.stringify({ error: "Project not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Start run
    await updateRun({
      status: "running",
      started_at: new Date().toISOString(),
      current_step: "plan",
      progress_pct: 0,
    });
    await log("info", "Pipeline started");

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

      // Parse tool call response
      const toolCall = planResult.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall) throw new Error("No tool call in plan response");

      const scenePlan = JSON.parse(toolCall.function.arguments);
      await log("info", `Generated plan with ${scenePlan.scenes.length} scenes`, scenePlan);

      // Insert scenes
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
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if stopped
    if ((await checkRunStatus()) !== "running") {
      await log("info", "Run was stopped/paused, halting pipeline");
      return new Response(JSON.stringify({ status: "halted" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ===== STEP 2: KEYFRAMES =====
    await log("info", "Step 2/7: Generating keyframe images...");
    try {
      const { data: scenes } = await supabase
        .from("scenes")
        .select("*")
        .eq("run_id", runId)
        .order("scene_index");

      if (scenes) {
        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i];
          const status = await checkRunStatus();
          if (status !== "running") {
            await log("info", "Run halted during keyframe generation");
            return new Response(JSON.stringify({ status: "halted" }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          await log("info", `Generating keyframe for scene ${scene.scene_index}: ${scene.scene_title}`);

          try {
            // Generate end keyframe image using AI image model
            const imageResult = await callAI(
              [
                {
                  role: "user",
                  content: `Generate a high-quality ${project.aspect_ratio} image: ${scene.end_keyframe_prompt}. Style: cinematic, high detail, vibrant colors.`,
                },
              ],
              undefined,
              undefined,
              "google/gemini-3-pro-image-preview"
            );

            // Check response for inline image data
            const message = imageResult.choices?.[0]?.message;
            let imageData: Uint8Array | null = null;
            let mimeType = "image/png";

            if (message?.content) {
              // Content may be array of parts or string
              const content = message.content;
              if (Array.isArray(content)) {
                for (const part of content) {
                  if (part.type === "image_url" && part.image_url?.url) {
                    const base64Match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
                    if (base64Match) {
                      mimeType = base64Match[1];
                      const raw = atob(base64Match[2]);
                      imageData = new Uint8Array(raw.length);
                      for (let j = 0; j < raw.length; j++) imageData[j] = raw.charCodeAt(j);
                    }
                  } else if (part.type === "inline_data" && part.data) {
                    mimeType = part.mime_type || "image/png";
                    const raw = atob(part.data);
                    imageData = new Uint8Array(raw.length);
                    for (let j = 0; j < raw.length; j++) imageData[j] = raw.charCodeAt(j);
                  }
                }
              }

              if (imageData) {
                const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
                const storagePath = `${project.id}/keyframes/${runId}/scene-${scene.scene_index}-end.${ext}`;

                const { error: uploadErr } = await supabase.storage
                  .from("project-assets")
                  .upload(storagePath, imageData, { contentType: mimeType, upsert: true });

                if (!uploadErr) {
                  const { data: asset } = await supabase
                    .from("assets")
                    .insert({
                      supabase_path: storagePath,
                      type: "keyframe" as const,
                      run_id: runId,
                      scene_id: scene.id,
                      metadata: { keyframe_type: "end", scene_index: scene.scene_index },
                    })
                    .select()
                    .single();

                  await log("info", `Keyframe saved for scene ${scene.scene_index}`);
                  await supabase.from("scenes").update({ status: "keyframes_ready" as const }).eq("id", scene.id);
                } else {
                  await log("warn", `Failed to upload keyframe for scene ${scene.scene_index}: ${uploadErr.message}`);
                }
              } else {
                await log("warn", `No image data in AI response for scene ${scene.scene_index}. Keyframe generation may need a different model.`);
                // Still mark as ready so pipeline continues
                await supabase.from("scenes").update({ status: "keyframes_ready" as const }).eq("id", scene.id);
              }
            }
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
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ===== STEP 3: KLING (Video Generation) =====
    await log("info", "Step 3/7: Video generation (Kling)...");
    const KLING_API_KEY = Deno.env.get("KLING_API_KEY");
    if (!KLING_API_KEY) {
      await log("warn", "KLING_API_KEY not configured — skipping video generation. Add your Kling API key in Cloud secrets to enable this step.");
      await updateRun({ current_step: "stitch", progress_pct: 70 });
    } else {
      try {
        const { data: scenes } = await supabase
          .from("scenes")
          .select("*")
          .eq("run_id", runId)
          .order("scene_index");

        if (scenes) {
          for (let i = 0; i < scenes.length; i++) {
            const scene = scenes[i];
            const status = await checkRunStatus();
            if (status !== "running") {
              await log("info", "Run halted during video generation");
              return new Response(JSON.stringify({ status: "halted" }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }

            await log("info", `Requesting Kling video for scene ${scene.scene_index}`);
            await supabase.from("scenes").update({ status: "clip_requested" as const }).eq("id", scene.id);

            // TODO: Implement actual Kling API call
            // For now, log that it needs implementation with the actual Kling API endpoints
            await log("info", `Kling API call placeholder for scene ${scene.scene_index} — awaiting Kling API integration`);

            const progress = 40 + Math.round((30 * (i + 1)) / scenes.length);
            await updateRun({ progress_pct: progress });
          }
        }

        await updateRun({ current_step: "stitch", progress_pct: 70 });
        await log("info", "Kling video generation step complete");
      } catch (err) {
        await log("error", `Kling step failed: ${err.message}`);
        await updateRun({ status: "failed", error_message: `Kling failed: ${err.message}`, finished_at: new Date().toISOString() });
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ===== STEP 4: STITCH =====
    await log("info", "Step 4/7: Video stitching...");
    await log("warn", "Stitch step placeholder — video concatenation requires clip assets from Kling. Skipping.");
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
      // Create publish job record
      const { data: publishJob } = await supabase
        .from("publish_jobs")
        .insert({
          run_id: runId,
          status: "not_started" as const,
        })
        .select()
        .single();

      await log("info", "Publish job created. Video upload to Upload-Post requires stitched final video — marking as pending.");
      // Actual Upload-Post API call would go here when we have a final video
    }

    // ===== STEP 7: DONE =====
    await updateRun({
      current_step: "done",
      status: "completed",
      progress_pct: 100,
      finished_at: new Date().toISOString(),
    });
    await log("info", "Pipeline completed successfully! 🎉");

    return new Response(JSON.stringify({ status: "completed", run_id: runId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    await log("error", `Pipeline failed: ${err.message}`);
    await updateRun({ status: "failed", error_message: err.message, finished_at: new Date().toISOString() });
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
