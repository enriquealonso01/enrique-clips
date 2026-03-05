import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fal } from "https://esm.sh/@fal-ai/client@1";

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
  const FAL_KEY = Deno.env.get("FAL_KEY");

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
    if (!project || project.video_generator !== "pika") return json({ status: "not_pika" });
    if (!FAL_KEY) return json({ error: "FAL_KEY not configured" }, 500);

    fal.config({ credentials: FAL_KEY });

    // Find pending clip assets with pika request IDs (handles both old batch- and new clip- naming)
    const { data: allClipAssets } = await supabase
      .from("assets")
      .select("*")
      .eq("run_id", runId)
      .eq("type", "clip");

    // Filter to pika assets only
    const pendingAssets = (allClipAssets || []).filter(a => {
      const meta = a.metadata as any;
      return meta?.pika_request_id;
    });

    if (pendingAssets.length === 0) {
      return json({ status: "no_pending_tasks" });
    }

    const pendingTasks = pendingAssets.filter((a) => {
      const meta = a.metadata as any;
      return meta?.pika_request_id && meta.status !== "completed" && meta.status !== "failed";
    });

    let allDone = true;
    let completedCount = pendingAssets.length - pendingTasks.length;

    for (const asset of pendingTasks) {
      const meta = asset.metadata as any;
      const reqId = meta.pika_request_id;
      const falEndpoint = meta.pika_model === "image-to-video"
        ? "fal-ai/pika/v2.2/image-to-video"
        : "fal-ai/pika/v2.2/pikaframes";

      try {
        const status = await fal.queue.status(falEndpoint, {
          requestId: reqId,
          logs: false,
        });

        if (status.status === "COMPLETED") {
          const result = await fal.queue.result(falEndpoint, {
            requestId: reqId,
          });
          const videoUrl = (result.data as any)?.video?.url;
          if (videoUrl) {
            const videoResp = await fetch(videoUrl);
            if (videoResp.ok) {
              const videoBytes = new Uint8Array(await videoResp.arrayBuffer());
              const storagePath = `${project.id}/clips/${runId}/pika-${reqId}.mp4`;
              await supabase.storage.from("project-assets").upload(storagePath, videoBytes, {
                contentType: "video/mp4",
                upsert: true,
              });
              await supabase.from("assets").update({
                supabase_path: storagePath,
                metadata: { pika_request_id: reqId, batch_index: meta.batch_index, status: "completed" },
              }).eq("id", asset.id);
              await log("info", `Pika video downloaded and stored: ${reqId}`);
              completedCount++;
            }
          } else {
            await log("error", `No video URL in Pika result for ${reqId}`, result.data);
            await supabase.from("assets").update({
              metadata: { ...meta, status: "failed" },
            }).eq("id", asset.id);
            completedCount++;
          }
        } else if (status.status === "FAILED") {
          await log("error", `Pika request ${reqId} failed`, status);
          await supabase.from("assets").update({
            metadata: { ...meta, status: "failed" },
          }).eq("id", asset.id);
          completedCount++;
        } else {
          allDone = false;
          await log("debug", `Pika request ${reqId} status: ${status.status}`);
        }
      } catch (err) {
        await log("warn", `Error polling Pika ${reqId}: ${err.message}`);
        allDone = false;
      }
    }

    if (!allDone) {
      const progress = 40 + Math.round((30 * completedCount) / pendingAssets.length);
      await updateRun({ progress_pct: Math.min(progress, 69) });
      return json({ status: "polling", completed: completedCount, total: pendingAssets.length });
    }

    // All done — advance to stitch
    await log("info", "All Pika tasks complete. Advancing to stitch step.");
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

    return json({ status: "pika_complete", run_id: runId });
  } catch (err) {
    await log("error", `Poll-pika failed: ${err.message}`);
    return json({ error: err.message }, 500);
  }
});
