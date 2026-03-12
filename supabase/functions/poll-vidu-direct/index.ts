import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const VIDU_API_KEY = Deno.env.get("VIDU_API_KEY");

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

  try {
    const { data: run } = await supabase.from("runs").select("*").eq("id", runId).single();
    if (!run) return json({ error: "Run not found" }, 404);
    if (run.status !== "running") return json({ status: "not_running", run_status: run.status });
    if (run.current_step !== "kling") return json({ status: "not_in_kling_step", current_step: run.current_step });

    const { data: project } = await supabase.from("projects").select("id, video_generator").eq("id", run.project_id).single();
    if (!project || (project.video_generator as string) !== "vidu_direct") return json({ status: "not_vidu_direct" });
    if (!VIDU_API_KEY) return json({ error: "VIDU_API_KEY not configured" }, 500);

    // Find pending vidu_direct clip assets
    const { data: allClipAssets } = await supabase
      .from("assets")
      .select("*")
      .eq("run_id", runId)
      .eq("type", "clip");

    const viduAssets = (allClipAssets || []).filter(a => {
      const meta = a.metadata as any;
      return meta?.vidu_task_id;
    });

    if (viduAssets.length === 0) {
      return json({ status: "no_pending_tasks" });
    }

    const pendingTasks = viduAssets.filter(a => {
      const meta = a.metadata as any;
      return meta?.vidu_task_id && meta.status !== "completed" && meta.status !== "failed";
    });

    let allDone = true;
    let completedCount = viduAssets.length - pendingTasks.length;

    for (const asset of pendingTasks) {
      const meta = asset.metadata as any;
      const taskId = meta.vidu_task_id;

      try {
        let statusResp = await fetch(`https://api.vidu.com/ent/v2/tasks/${taskId}/creations`, {
          headers: { "Authorization": `Token ${VIDU_API_KEY}` },
        });

        // Backward-compatible fallback in case account/region still serves legacy task route
        if (statusResp.status === 404) {
          statusResp = await fetch(`https://api.vidu.com/ent/v2/tasks/${taskId}`, {
            headers: { "Authorization": `Token ${VIDU_API_KEY}` },
          });
        }

        if (!statusResp.ok) {
          allDone = false;
          await log("debug", `Vidu Direct poll for ${taskId}: HTTP ${statusResp.status}`);
          continue;
        }

        const statusData = await statusResp.json();
        const taskState = statusData.state || statusData.status;

        if (taskState === "success") {
          const videoUrl = statusData.creations?.[0]?.url || statusData.video_url || statusData.url;
          if (videoUrl) {
            const videoResp = await fetch(videoUrl);
            if (videoResp.ok) {
              const videoBytes = new Uint8Array(await videoResp.arrayBuffer());
              const storagePath = `${project.id}/clips/${runId}/vidu-${taskId}.mp4`;
              await supabase.storage.from("project-assets").upload(storagePath, videoBytes, {
                contentType: "video/mp4",
                upsert: true,
              });
              await supabase.from("assets").update({
                supabase_path: storagePath,
                metadata: { ...meta, status: "completed", generator: "vidu_direct" },
              }).eq("id", asset.id);
              await log("info", `Vidu Direct video downloaded and stored: ${taskId}`);
              completedCount++;
            }
          } else {
            await log("error", `No video URL in Vidu Direct result for ${taskId}`, statusData);
            await supabase.from("assets").update({
              metadata: { ...meta, status: "failed" },
            }).eq("id", asset.id);
            completedCount++;
          }
        } else if (taskState === "failed") {
          await log("error", `Vidu Direct task ${taskId} failed`, statusData);
          await supabase.from("assets").update({
            metadata: { ...meta, status: "failed" },
          }).eq("id", asset.id);
          completedCount++;
        } else {
          allDone = false;
          await log("debug", `Vidu Direct task ${taskId} status: ${taskState || "unknown"}`);
        }
      } catch (err) {
        await log("warn", `Error polling Vidu Direct ${taskId}: ${err.message}`);
        allDone = false;
      }
    }

    if (!allDone) {
      const progress = 40 + Math.round((30 * completedCount) / viduAssets.length);
      await updateRun({ progress_pct: Math.min(progress, 69) });
      return json({ status: "polling", completed: completedCount, total: viduAssets.length });
    }

    // All done — advance to stitch
    await log("info", "All Vidu Direct tasks complete. Advancing to stitch step.");
    await updateRun({ current_step: "stitch", progress_pct: 70 });

    // Auto-invoke finalize-video
    try {
      const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/finalize-video`;
      await fetch(fnUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ run_id: runId }),
      });
      await log("info", "finalize-video invoked automatically.");
    } catch (chainErr) {
      await log("warn", `Auto-invoke finalize-video failed: ${chainErr.message}`);
    }

    return json({ status: "vidu_direct_complete", run_id: runId });
  } catch (err) {
    await log("error", `Poll-vidu-direct failed: ${err.message}`);
    return json({ error: err.message }, 500);
  }
});
