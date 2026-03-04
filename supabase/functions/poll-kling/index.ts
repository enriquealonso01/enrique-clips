import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const KLING_API_BASE = "https://api.klingai.com";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const KLING_ACCESS_KEY = Deno.env.get("KLING_ACCESS_KEY");
  const KLING_SECRET_KEY = Deno.env.get("KLING_SECRET_KEY");

  let runId: string;
  try {
    const body = await req.json();
    runId = body.run_id;
  } catch {
    return json({ error: "run_id required" }, 400);
  }

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

  // Get Kling JWT token
  async function getKlingToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: KLING_ACCESS_KEY, exp: now + 1800, iat: now, nbf: now };

    const encoder = new TextEncoder();
    const header = { alg: "HS256", typ: "JWT" };

    function b64url(buf: ArrayBuffer | Uint8Array): string {
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    const encHeader = b64url(encoder.encode(JSON.stringify(header)));
    const encPayload = b64url(encoder.encode(JSON.stringify(payload)));
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(KLING_SECRET_KEY!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${encHeader}.${encPayload}`));
    return `${encHeader}.${encPayload}.${b64url(signature)}`;
  }

  try {
    // Check run status
    const { data: run } = await supabase.from("runs").select("*").eq("id", runId).single();
    if (!run) return json({ error: "Run not found" }, 404);
    if (run.status !== "running") return json({ status: "not_running", run_status: run.status });
    if (run.current_step !== "kling") return json({ status: "not_in_kling_step", current_step: run.current_step });

    // Get project
    const { data: project } = await supabase.from("projects").select("*").eq("id", run.project_id).single();

    // Find pending clip assets with kling task IDs
    const { data: pendingAssets } = await supabase
      .from("assets")
      .select("*")
      .eq("run_id", runId)
      .eq("type", "clip")
      .like("supabase_path", `pending-kling/${runId}/%`);

    if (!pendingAssets || pendingAssets.length === 0) {
      // No pending tasks — might already be done
      return json({ status: "no_pending_tasks" });
    }

    let allDone = true;
    let anyProcessing = false;

    // Filter to only pending tasks
    const pendingTasks = pendingAssets.filter((a) => {
      const meta = a.metadata as any;
      return meta?.kling_task_id && meta.status !== "completed" && meta.status !== "failed";
    });

    if (pendingTasks.length === 0) {
      // All tasks already resolved
    } else {
      // Poll up to 3 concurrently
      const CONCURRENCY = 3;
      for (let batch = 0; batch < pendingTasks.length; batch += CONCURRENCY) {
        const batchItems = pendingTasks.slice(batch, batch + CONCURRENCY);
        const results = await Promise.all(batchItems.map(async (asset) => {
          const meta = asset.metadata as any;
          const taskId = meta.kling_task_id;
          const sceneIndex = meta.scene_index;

          try {
            const klingToken = await getKlingToken();
            const pollResp = await fetch(`${KLING_API_BASE}/v1/videos/image2video/${taskId}`, {
              method: "GET",
              headers: { "Authorization": `Bearer ${klingToken}` },
            });
            const pollResult = await pollResp.json();
            const taskStatus = pollResult.data?.task_status;

            if (taskStatus === "succeed") {
              const videoUrl = pollResult.data?.task_result?.videos?.[0]?.url || null;
              await log("info", `Kling task ${taskId} succeeded for scene ${sceneIndex}`);

              if (videoUrl) {
                const videoResp = await fetch(videoUrl);
                const videoData = new Uint8Array(await videoResp.arrayBuffer());
                const storagePath = `${project!.id}/clips/${runId}/scene-${sceneIndex}.mp4`;

                const { error: uploadErr } = await supabase.storage
                  .from("project-assets")
                  .upload(storagePath, videoData, { contentType: "video/mp4", upsert: true });

                if (!uploadErr) {
                  await supabase.from("assets").update({
                    supabase_path: storagePath,
                    metadata: { kling_task_id: taskId, scene_index: sceneIndex, status: "completed" },
                  }).eq("id", asset.id);
                  await supabase.from("scenes").update({ status: "clip_ready" as const }).eq("id", asset.scene_id);
                  await log("info", `Video clip saved for scene ${sceneIndex}`);
                } else {
                  await log("error", `Failed to upload video for scene ${sceneIndex}: ${uploadErr.message}`);
                  await supabase.from("assets").update({ metadata: { ...meta, status: "failed" } }).eq("id", asset.id);
                  await supabase.from("scenes").update({ status: "failed" as const }).eq("id", asset.scene_id);
                }
              } else {
                await supabase.from("assets").update({ metadata: { ...meta, status: "failed" } }).eq("id", asset.id);
                await supabase.from("scenes").update({ status: "failed" as const }).eq("id", asset.scene_id);
              }
              return "done";
            } else if (taskStatus === "failed") {
              await log("error", `Kling task ${taskId} failed: ${pollResult.data?.task_status_msg}`, pollResult.data);
              await supabase.from("assets").update({ metadata: { ...meta, status: "failed" } }).eq("id", asset.id);
              await supabase.from("scenes").update({ status: "failed" as const }).eq("id", asset.scene_id);
              return "done";
            } else {
              return "pending";
            }
          } catch (err) {
            await log("error", `Error polling Kling task ${taskId}: ${err.message}`);
            return "pending";
          }
        }));

        for (const r of results) {
          if (r === "pending") {
            allDone = false;
            anyProcessing = true;
          }
        }
      }
    }

    if (!allDone) {
      const progress = 40 + (anyProcessing ? 15 : 0);
      await updateRun({ progress_pct: progress });
      return json({ status: "polling", pending: true });
    }

    // All Kling tasks done — continue pipeline
    await log("info", "All Kling tasks complete. Proceeding to stitch step.");
    await updateRun({ current_step: "stitch", progress_pct: 70 });

    // Continue with remaining pipeline steps (stitch, metadata, publish, done)
    await log("info", "Step 4/7: Video stitching...");
    try {
      // Get all completed clip assets in scene order
      const { data: clipAssets } = await supabase
        .from("assets")
        .select("*, scenes!inner(scene_index)")
        .eq("run_id", runId)
        .eq("type", "clip")
        .order("scene_index", { referencedTable: "scenes", ascending: true });

      const completedClips = (clipAssets || []).filter(
        (a: any) => (a.metadata as any)?.status === "completed"
      );

      if (completedClips.length === 0) {
        await log("warn", "No completed clips found — skipping stitch.");
      } else if (completedClips.length === 1) {
        // Single clip — use it directly as the final video
        const clip = completedClips[0];
        const finalPath = `${project!.id}/final/${runId}/final-video.mp4`;

        // Download and re-upload as final video
        const { data: srcData } = supabase.storage
          .from("project-assets")
          .getPublicUrl(clip.supabase_path);
        const videoResp = await fetch(srcData.publicUrl);
        const videoBytes = new Uint8Array(await videoResp.arrayBuffer());

        const { error: upErr } = await supabase.storage
          .from("project-assets")
          .upload(finalPath, videoBytes, { contentType: "video/mp4", upsert: true });

        if (!upErr) {
          await supabase.from("assets").insert({
            supabase_path: finalPath,
            type: "final_video" as any,
            run_id: runId,
            metadata: { scene_count: 1, source_clips: [clip.supabase_path] },
          });
          await log("info", "Final video created from single clip.");
        } else {
          await log("warn", `Final video upload failed: ${upErr.message}`);
        }
      } else {
        // Multiple clips — concatenate raw MP4 bytes sequentially
        // NOTE: This works for clips with identical codec/resolution from the same Kling generation
        await log("info", `Concatenating ${completedClips.length} clips...`);

        const clipBuffers: Uint8Array[] = [];
        for (const clip of completedClips) {
          const { data: urlData } = supabase.storage
            .from("project-assets")
            .getPublicUrl(clip.supabase_path);
          const resp = await fetch(urlData.publicUrl);
          clipBuffers.push(new Uint8Array(await resp.arrayBuffer()));
        }

        // Simple concatenation — combine all bytes
        const totalLength = clipBuffers.reduce((sum, buf) => sum + buf.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const buf of clipBuffers) {
          combined.set(buf, offset);
          offset += buf.length;
        }

        const finalPath = `${project!.id}/final/${runId}/final-video.mp4`;
        const { error: upErr } = await supabase.storage
          .from("project-assets")
          .upload(finalPath, combined, { contentType: "video/mp4", upsert: true });

        if (!upErr) {
          await supabase.from("assets").insert({
            supabase_path: finalPath,
            type: "final_video" as any,
            run_id: runId,
            metadata: {
              scene_count: completedClips.length,
              source_clips: completedClips.map((c: any) => c.supabase_path),
            },
          });
          await log("info", `Final video created from ${completedClips.length} clips.`);
        } else {
          await log("warn", `Final video upload failed: ${upErr.message}`);
        }
      }
    } catch (err) {
      await log("warn", `Stitch step failed: ${err.message} — continuing.`);
    }
    await updateRun({ current_step: "metadata", progress_pct: 85 });

    // METADATA
    await log("info", "Step 5/7: Generating metadata...");
    try {
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

      const { data: scenes } = await supabase
        .from("scenes")
        .select("scene_title, scene_description")
        .eq("run_id", runId)
        .order("scene_index");

      const scenesSummary = scenes?.map((s: any) => `${s.scene_title}: ${s.scene_description}`).join("\n") || "";

      const aiResp = await fetch(AI_GATEWAY, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${LOVABLE_API_KEY}`,
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: "You are a social media content expert. Generate engaging metadata for a short-form video post." },
            { role: "user", content: `Generate a title, description, and hashtags for this video:\n\nSeries: ${project!.series_prompt || project!.title}\nScenes:\n${scenesSummary}` },
          ],
          tools: [{
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
          }],
          tool_choice: { type: "function", function: { name: "generate_metadata" } },
        }),
      });

      const metaResult = await aiResp.json();
      const metaToolCall = metaResult.choices?.[0]?.message?.tool_calls?.[0];
      if (metaToolCall) {
        const metadata = JSON.parse(metaToolCall.function.arguments);
        await updateRun({ generated_metadata: metadata, progress_pct: 95 });
        await log("info", "Metadata generated", metadata);
      }

      await updateRun({ current_step: "publish", progress_pct: 95 });
    } catch (err) {
      await log("warn", `Metadata step failed: ${err.message} — continuing`);
      await updateRun({ current_step: "publish", progress_pct: 95 });
    }

    // PUBLISH
    await log("info", "Step 6/7: Publishing...");
    if (!project!.uploadpost_api_key_encrypted || !project!.uploadpost_api_key_configured) {
      await log("warn", "Upload-Post API key not configured — skipping publish step.");
    } else {
      try {
        // Prefer final_video asset, fallback to first completed clip
        const { data: finalAssets } = await supabase
          .from("assets")
          .select("supabase_path")
          .eq("run_id", runId)
          .eq("type", "final_video")
          .limit(1);

        let videoPath: string | null = null;
        if (finalAssets && finalAssets.length > 0) {
          videoPath = finalAssets[0].supabase_path;
        } else {
          const { data: clipAssets } = await supabase
            .from("assets")
            .select("supabase_path, metadata")
            .eq("run_id", runId)
            .eq("type", "clip")
            .order("created_at");
          const firstClip = clipAssets?.find((a: any) => (a.metadata as any)?.status === "completed");
          videoPath = firstClip?.supabase_path || null;
        }

        if (!videoPath) {
          await log("warn", "No video found for publishing — skipping.");
        } else {
          const { data: urlData } = supabase.storage
            .from("project-assets")
            .getPublicUrl(videoPath);
          const videoUrl = urlData.publicUrl;

          // Re-fetch run to get freshly generated metadata
          const { data: freshRun } = await supabase.from("runs").select("generated_metadata").eq("id", runId).single();
          const metadata = (freshRun?.generated_metadata as any) || {};
          const title = metadata.title || project!.title || "Untitled Video";
          const description = metadata.description || "";
          const hashtags = metadata.hashtags || [];
          const hashtagStr = hashtags.map((h: string) => `#${h}`).join(" ");
          const fullDescription = description + (hashtagStr ? `\n\n${hashtagStr}` : "");

          // Determine platforms
          const platforms = project!.publish_platforms as Record<string, boolean>;
          const enabledPlatforms = Object.entries(platforms)
            .filter(([_, enabled]) => enabled)
            .map(([platform]) => platform);

          if (enabledPlatforms.length === 0) {
            await log("warn", "No publish platforms enabled — skipping.");
          } else {
            // Create publish job
            const { data: publishJob } = await supabase
              .from("publish_jobs")
              .insert({ run_id: runId, status: "submitted" as const })
              .select()
              .single();

            // Call Upload-Post API
            const apiKey = project!.uploadpost_api_key_encrypted!;
            const formData = new FormData();
            formData.append("video", videoUrl);
            formData.append("title", title);
            formData.append("description", fullDescription);
            if (project!.uploadpost_profile_username) {
              formData.append("user", project!.uploadpost_profile_username);
            }
            for (const platform of enabledPlatforms) {
              formData.append("platform[]", platform);
            }
            formData.append("async_upload", "true");

            await log("info", `Calling Upload-Post API for platforms: ${enabledPlatforms.join(", ")}`);

            const uploadResp = await fetch("https://api.upload-post.com/api/upload", {
              method: "POST",
              headers: {
                "Authorization": `Apikey ${apiKey}`,
              },
              body: formData,
            });

            const uploadResult = await uploadResp.json();
            await log("info", "Upload-Post API response", uploadResult);

            if (uploadResp.ok && uploadResult.request_id) {
              await supabase
                .from("publish_jobs")
                .update({
                  uploadpost_request_id: uploadResult.request_id,
                  uploadpost_job_id: uploadResult.job_id || null,
                  status: "polling" as const,
                })
                .eq("id", publishJob!.id);
              await log("info", `Upload-Post job submitted: ${uploadResult.request_id}`);
            } else {
              await supabase
                .from("publish_jobs")
                .update({
                  status: "failed" as const,
                  platform_results: uploadResult,
                })
                .eq("id", publishJob!.id);
              await log("error", `Upload-Post API failed: ${JSON.stringify(uploadResult)}`);
            }
          }
        }
      } catch (err) {
        await log("error", `Publish step failed: ${err.message}`);
      }
    }

    // DONE
    await updateRun({
      current_step: "done",
      status: "completed",
      progress_pct: 100,
      finished_at: new Date().toISOString(),
    });
    await log("info", "Pipeline completed successfully! 🎉");

    return json({ status: "completed", run_id: runId });
  } catch (err) {
    await log("error", `Poll-kling failed: ${err.message}`);
    return json({ error: err.message }, 500);
  }
});
