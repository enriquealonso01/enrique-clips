import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { r2Upload } from "../_shared/r2.ts";

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

  // Support both single run_id and sweeper mode (no run_id = find all paused vidu runs)
  let runIds: string[] = [];
  try {
    const body = await req.json();
    if (body.run_id) {
      runIds = [body.run_id];
    }
  } catch {
    // No body — sweeper mode
  }

  // Sweeper mode: find all paused runs waiting for vidu off-peak clips
  if (runIds.length === 0) {
    const { data: pausedRuns } = await supabase
      .from("runs")
      .select("id, generated_metadata")
      .eq("status", "paused")
      .eq("current_step", "kling");

    runIds = (pausedRuns || [])
      .filter(r => {
        const meta = r.generated_metadata as any;
        return meta?.waiting_for === "vidu_off_peak";
      })
      .map(r => r.id);

    if (runIds.length === 0) {
      return json({ status: "no_paused_vidu_runs" });
    }
  }

  if (!VIDU_API_KEY) return json({ error: "VIDU_API_KEY not configured" }, 500);

  const results: Record<string, any> = {};

  for (const runId of runIds) {
    results[runId] = await pollRunClips(runId);
  }

  return json({ status: "sweep_complete", results });

  async function log(runId: string, level: string, message: string, data?: unknown) {
    await supabase.from("run_logs").insert({
      run_id: runId,
      level: level as any,
      message,
      data: data ? (data as any) : null,
    });
  }

  async function pollRunClips(runId: string) {
    try {
      const { data: run } = await supabase.from("runs").select("*").eq("id", runId).single();
      if (!run) return { error: "Run not found" };

      // Accept both running and paused (off-peak) runs
      if (run.status !== "running" && run.status !== "paused") {
        return { status: "not_active", run_status: run.status };
      }
      if (run.current_step !== "kling") {
        return { status: "not_in_kling_step", current_step: run.current_step };
      }

      const { data: project } = await supabase.from("projects").select("id, video_generator").eq("id", run.project_id).single();
      if (!project || (project.video_generator as string) !== "vidu_direct") return { status: "not_vidu_direct" };

      // Find all vidu_direct clip assets
      const { data: allClipAssets } = await supabase
        .from("assets")
        .select("*")
        .eq("run_id", runId)
        .eq("type", "clip");

      const viduAssets = (allClipAssets || []).filter(a => {
        const meta = a.metadata as any;
        return meta?.vidu_task_id;
      });

      if (viduAssets.length === 0) return { status: "no_pending_tasks" };

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

          if (statusResp.status === 404) {
            statusResp = await fetch(`https://api.vidu.com/ent/v2/tasks/${taskId}`, {
              headers: { "Authorization": `Token ${VIDU_API_KEY}` },
            });
          }

          if (!statusResp.ok) {
            allDone = false;
            await log(runId, "debug", `Vidu Direct poll for ${taskId}: HTTP ${statusResp.status}`);
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
                let videoPublicUrl = "";
                try {
                  ({ publicUrl: videoPublicUrl } = await r2Upload(storagePath, videoBytes, "video/mp4"));
                } catch (e) {
                  await log(runId, "error", `Vidu Direct R2 upload FAILED for ${taskId}: ${(e as Error).message}. Will retry on next poll.`);
                  allDone = false;
                  continue;
                }
                // Verify the object is actually retrievable before marking the asset complete.
                // Guards against silent storage failures (the underlying bug behind run ec2b7bc6 stitch failure).
                let verified = false;
                for (let v = 0; v < 3; v++) {
                  const headResp = await fetch(videoPublicUrl, { method: "HEAD" });
                  if (headResp.ok) { verified = true; break; }
                  await new Promise((r) => setTimeout(r, 1000));
                }
                if (!verified) {
                  await log(runId, "error", `Vidu Direct upload verification FAILED for ${taskId} at ${storagePath}. Will retry on next poll.`);
                  allDone = false;
                  continue;
                }
                await supabase.from("assets").update({
                  supabase_path: storagePath,
                  metadata: { ...meta, status: "completed", generator: "vidu_direct" },
                }).eq("id", asset.id);
                await log(runId, "info", `Vidu Direct video downloaded, stored, and verified: ${taskId}`);
                completedCount++;
              }
            } else {
              await log(runId, "error", `No video URL in Vidu Direct result for ${taskId}`, statusData);
              await supabase.from("assets").update({
                metadata: { ...meta, status: "failed" },
              }).eq("id", asset.id);
              completedCount++;
            }
          } else if (taskState === "failed" || taskState === "cancelled") {
            await log(runId, "error", `Vidu Direct task ${taskId} ${taskState}`, statusData);
            await supabase.from("assets").update({
              metadata: { ...meta, status: "failed" },
            }).eq("id", asset.id);
            completedCount++;
          } else {
            allDone = false;
            await log(runId, "debug", `Vidu Direct task ${taskId} status: ${taskState || "unknown"}`);
          }
        } catch (err) {
          await log(runId, "warn", `Error polling Vidu Direct ${taskId}: ${err.message}`);
          allDone = false;
        }
      }

      if (!allDone) {
        const progress = 40 + Math.round((30 * completedCount) / viduAssets.length);
        await supabase.from("runs").update({ progress_pct: Math.min(progress, 69) }).eq("id", runId);
        return { status: "polling", completed: completedCount, total: viduAssets.length };
      }

      // All done — resume the run and advance to stitch
      await log(runId, "info", "All Vidu Direct tasks complete. Resuming run and advancing to stitch.");
      await supabase.from("runs").update({
        status: "running",
        current_step: "stitch",
        progress_pct: 70,
      }).eq("id", runId);

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
        await log(runId, "info", "finalize-video invoked automatically after off-peak completion.");
      } catch (chainErr) {
        await log(runId, "warn", `Auto-invoke finalize-video failed: ${chainErr.message}`);
      }

      return { status: "vidu_direct_complete", run_id: runId };
    } catch (err) {
      await log(runId, "error", `Poll-vidu-direct failed: ${err.message}`);
      return { error: err.message };
    }
  }
});
