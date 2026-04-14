import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const VIDU_API_KEY = Deno.env.get("VIDU_API_KEY");
  if (!VIDU_API_KEY) return json({ error: "VIDU_API_KEY not configured" }, 500);

  let runId: string | null = null;
  let sweeperMode = false;
  try { const body = await req.json(); runId = body.run_id; sweeperMode = !!body.sweeper; } catch {}

  // Sweeper mode: find all paused story runs waiting for vidu off-peak
  if (!runId && sweeperMode) {
    const { data: pausedRuns } = await sb.from("story_runs")
      .select("id, generated_metadata")
      .eq("status", "paused");
    const offPeakRunIds = (pausedRuns || [])
      .filter(r => (r.generated_metadata as any)?.waiting_for === "vidu_off_peak")
      .map(r => r.id);
    if (offPeakRunIds.length === 0) return json({ status: "no_off_peak_runs" });
    await log("info", `Sweeper found ${offPeakRunIds.length} off-peak story runs to poll`);
    // Poll each one by self-invoking
    const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/story-poll-vidu`;
    for (const rid of offPeakRunIds) {
      fetch(fnUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: rid }),
      }).catch(e => console.error("Sweeper dispatch error:", e));
    }
    return json({ status: "sweeper_dispatched", count: offPeakRunIds.length });
  }

  if (!runId) return json({ error: "run_id required" }, 400);

  async function log(level: string, message: string, data?: unknown) {
    console.log(`[STORY-POLL][${level}] ${message}`);
    await sb.from("story_run_logs").insert({ run_id: runId, level: level as any, message, data: data || null });
  }

  try {
    const { data: run } = await sb.from("story_runs").select("*").eq("id", runId).single();
    if (!run) return json({ error: "Run not found" });
    if (["cancelled", "failed", "published"].includes(run.status)) return json({ status: "not_active" });
    const isOffPeak = run.status === "paused" && (run.generated_metadata as any)?.waiting_for === "vidu_off_peak";

    // Find pending story video assets
    const { data: clipAssets } = await sb.from("story_assets")
      .select("*").eq("run_id", runId).eq("type", "scene_video_raw");

    const pending = (clipAssets || []).filter(a => {
      const m = a.metadata as any;
      return m?.vidu_task_id && m.status !== "completed" && m.status !== "failed";
    });
    const total = clipAssets?.length || 0;
    let completedCount = total - pending.length;

    for (const asset of pending) {
      const meta = asset.metadata as any;
      const taskId = meta.vidu_task_id;

      try {
        let resp = await fetch(`https://api.vidu.com/ent/v2/tasks/${taskId}/creations`, {
          headers: { "Authorization": `Token ${VIDU_API_KEY}` },
        });
        if (resp.status === 404) {
          resp = await fetch(`https://api.vidu.com/ent/v2/tasks/${taskId}`, {
            headers: { "Authorization": `Token ${VIDU_API_KEY}` },
          });
        }
        if (!resp.ok) { await log("debug", `Vidu poll ${taskId}: HTTP ${resp.status}`); continue; }

        const data = await resp.json();
        const state = data.state || data.status;

        if (state === "success") {
          const videoUrl = data.creations?.[0]?.url || data.video_url || data.url;
          if (videoUrl) {
            const videoResp = await fetch(videoUrl);
            if (videoResp.ok) {
              const videoBytes = new Uint8Array(await videoResp.arrayBuffer());
              const storagePath = `story-runs/${runId}/scene_${meta.scene_index}_raw.mp4`;
              await sb.storage.from("project-assets").upload(storagePath, videoBytes, { contentType: "video/mp4", upsert: true });
              await sb.from("story_assets").update({
                supabase_path: storagePath,
                metadata: { ...meta, status: "completed", generator: "vidu_direct" },
              }).eq("id", asset.id);
              await log("info", `Vidu clip ${meta.scene_index} downloaded: ${taskId}`);
              completedCount++;
            }
          } else {
            await sb.from("story_assets").update({ metadata: { ...meta, status: "failed" } }).eq("id", asset.id);
            completedCount++;
          }
        } else if (state === "failed" || state === "cancelled") {
          await log("error", `Vidu task ${taskId} ${state}`);
          await sb.from("story_assets").update({ metadata: { ...meta, status: "failed" } }).eq("id", asset.id);
          completedCount++;
        } else {
          await log("debug", `Vidu task ${taskId}: ${state || "processing"}`);
        }
      } catch (err) {
        await log("warn", `Poll error ${taskId}: ${(err as Error).message}`);
      }
    }

    const allDone = completedCount >= total;
    const progress = 62 + Math.round((8 * completedCount) / Math.max(total, 1));
    await sb.from("story_runs").update({ progress_pct: Math.min(progress, 70) }).eq("id", runId);

    if (!allDone) {
      // Self-re-invoke after 15s delay so polling continues automatically
      const selfUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/story-poll-vidu`;
      setTimeout(() => {
        fetch(selfUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ run_id: runId }),
        }).catch(e => console.error("Self-chain poll error:", e));
      }, 15_000);
      return json({ status: "polling", completed: completedCount, total });
    }

    // All clips done — advance to finalization
    await log("info", "All Vidu clips complete. Invoking story-finalize.");
    await sb.from("story_runs").update({
      current_stage: "video_stitching",
      progress_pct: 72,
    }).eq("id", runId);

    // Chain to story-finalize
    const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/story-finalize`;
    await fetch(fnUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ run_id: runId }),
    });

    return json({ status: "complete", run_id: runId });
  } catch (err) {
    await log("error", `Poll failed: ${(err as Error).message}`);
    return json({ error: (err as Error).message }, 500);
  }
});
