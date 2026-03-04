import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const KLING_API_BASE = "https://api-singapore.klingai.com";

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

  // Generate Kling JWT token
  async function getKlingToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    const header = { alg: "HS256", typ: "JWT" };
    const payload = { iss: KLING_ACCESS_KEY, exp: now + 1800, iat: now, nbf: now };

    function b64url(buf: ArrayBuffer | Uint8Array): string {
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    const encHeader = b64url(encoder.encode(JSON.stringify(header)));
    const encPayload = b64url(encoder.encode(JSON.stringify(payload)));
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(KLING_SECRET_KEY!),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${encHeader}.${encPayload}`)
    );
    return `${encHeader}.${encPayload}.${b64url(signature)}`;
  }

  try {
    // Check run status
    const { data: run } = await supabase.from("runs").select("*").eq("id", runId).single();
    if (!run) return json({ error: "Run not found" }, 404);
    if (run.status !== "running") return json({ status: "not_running", run_status: run.status });
    if (run.current_step !== "kling") return json({ status: "not_in_kling_step", current_step: run.current_step });

    const { data: project } = await supabase.from("projects").select("id").eq("id", run.project_id).single();

    // Find pending clip assets with kling task IDs
    const { data: pendingAssets } = await supabase
      .from("assets")
      .select("*")
      .eq("run_id", runId)
      .eq("type", "clip")
      .like("supabase_path", `pending-kling/${runId}/%`);

    if (!pendingAssets || pendingAssets.length === 0) {
      return json({ status: "no_pending_tasks" });
    }

    // Filter to tasks still in-progress
    const pendingTasks = pendingAssets.filter((a) => {
      const meta = a.metadata as any;
      return meta?.kling_task_id && meta.status !== "completed" && meta.status !== "failed";
    });

    let allDone = true;
    let completedCount = pendingAssets.length - pendingTasks.length;

    if (pendingTasks.length > 0) {
      // Poll up to 3 concurrently
      const CONCURRENCY = 3;
      for (let batch = 0; batch < pendingTasks.length; batch += CONCURRENCY) {
        const batchItems = pendingTasks.slice(batch, batch + CONCURRENCY);
        const results = await Promise.all(
          batchItems.map(async (asset) => {
            const meta = asset.metadata as any;
            const taskId = meta.kling_task_id;
            const sceneIndex = meta.scene_index;

            try {
              const klingToken = await getKlingToken();
              const pollResp = await fetch(
                `${KLING_API_BASE}/v1/videos/image2video/${taskId}`,
                {
                  method: "GET",
                  headers: { Authorization: `Bearer ${klingToken}` },
                }
              );
              const pollResult = await pollResp.json();
              const taskStatus = pollResult.data?.task_status;

              if (taskStatus === "succeed") {
                const videoUrl = pollResult.data?.task_result?.videos?.[0]?.url || null;
                await log("info", `Kling task ${taskId} succeeded for scene ${sceneIndex}`);

                if (videoUrl) {
                  // Download video with retry
                  let videoData: Uint8Array | null = null;
                  for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                      const videoResp = await fetch(videoUrl);
                      videoData = new Uint8Array(await videoResp.arrayBuffer());
                      break;
                    } catch (dlErr) {
                      if (attempt === 2) throw dlErr;
                      await new Promise((r) => setTimeout(r, 2000));
                    }
                  }

                  const storagePath = `${project!.id}/clips/${runId}/scene-${sceneIndex}.mp4`;
                  const { error: uploadErr } = await supabase.storage
                    .from("project-assets")
                    .upload(storagePath, videoData!, {
                      contentType: "video/mp4",
                      upsert: true,
                    });

                  if (!uploadErr) {
                    await supabase
                      .from("assets")
                      .update({
                        supabase_path: storagePath,
                        metadata: {
                          kling_task_id: taskId,
                          scene_index: sceneIndex,
                          status: "completed",
                          size_bytes: videoData!.length,
                        },
                      })
                      .eq("id", asset.id);
                    await supabase
                      .from("scenes")
                      .update({ status: "clip_ready" as const })
                      .eq("id", asset.scene_id);
                    await log("info", `Clip saved for scene ${sceneIndex} (${(videoData!.length / 1024 / 1024).toFixed(1)}MB)`);
                    return "done";
                  } else {
                    await log("error", `Upload failed for scene ${sceneIndex}: ${uploadErr.message}`);
                    await supabase.from("assets").update({ metadata: { ...meta, status: "failed" } }).eq("id", asset.id);
                    await supabase.from("scenes").update({ status: "failed" as const }).eq("id", asset.scene_id);
                    return "done";
                  }
                } else {
                  await supabase.from("assets").update({ metadata: { ...meta, status: "failed" } }).eq("id", asset.id);
                  await supabase.from("scenes").update({ status: "failed" as const }).eq("id", asset.scene_id);
                  await log("error", `No video URL for scene ${sceneIndex}`);
                  return "done";
                }
              } else if (taskStatus === "failed") {
                await log("error", `Kling task ${taskId} failed: ${pollResult.data?.task_status_msg}`, pollResult.data);
                await supabase.from("assets").update({ metadata: { ...meta, status: "failed" } }).eq("id", asset.id);
                await supabase.from("scenes").update({ status: "failed" as const }).eq("id", asset.scene_id);
                return "done";
              } else {
                await log("debug", `Kling task ${taskId} status: ${taskStatus}`);
                return "pending";
              }
            } catch (err) {
              await log("error", `Error polling task ${taskId}: ${err.message}`);
              return "pending";
            }
          })
        );

        for (const r of results) {
          if (r === "pending") allDone = false;
          else completedCount++;
        }
      }
    }

    if (!allDone) {
      const progress = 40 + Math.round((30 * completedCount) / pendingAssets.length);
      await updateRun({ progress_pct: Math.min(progress, 69) });
      return json({ status: "polling", completed: completedCount, total: pendingAssets.length });
    }

    // All Kling tasks resolved — advance to stitch step
    await log("info", "All Kling tasks complete. Advancing to stitch step.");
    await updateRun({ current_step: "stitch", progress_pct: 70 });

    return json({ status: "kling_complete", run_id: runId });
  } catch (err) {
    await log("error", `Poll-kling failed: ${err.message}`);
    return json({ error: err.message }, 500);
  }
});
