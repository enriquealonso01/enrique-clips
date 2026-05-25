// ═══════════════════════════════════════════════════════════
// subtitles-submagic — Projects pipeline subtitle pass (opt-in)
// ───────────────────────────────────────────────────────────
// Invoked ONLY by finalize-video when a project's prompt_config_json has
// `subtitles.enabled === true` (e.g. watch-restoration). It captions the
// already-merged final video via Submagic, stores the captioned cut in R2,
// records `captioned_video_path` on the run, and re-invokes finalize-video to
// publish the captioned version.
//
// Isolation: no current channel sets `subtitles.enabled`, so finalize-video
// never calls this function for them — it cannot affect regular projects.
// Fail-soft: on ANY error it marks `subtitles_failed` and still advances the
// run to publish (uncaptioned) so a Submagic outage never blocks a post.
//
// Modeled on the proven Stories integration (retry-subtitles-once).
// ═══════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { r2Upload, mediaPublicUrl } from "../_shared/r2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared default Submagic theme (same one the Stories pipeline uses).
const DEFAULT_SUBMAGIC_THEME = "8ef61dce-7589-48ff-b269-8623a3a5179e";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const SUBMAGIC_API_KEY = Deno.env.get("SUBMAGIC_API_KEY");

  const { run_id } = await req.json().catch(() => ({}));
  if (!run_id) return json({ error: "run_id required" }, 400);

  // Best-effort logging — a logging failure must never break the run.
  const log = async (level: string, message: string, data?: unknown) => {
    console.log(`[SUBS-SUBMAGIC] ${message}`);
    try {
      await sb.from("run_logs").insert({ run_id, level, message, data: data ?? null });
    } catch (_) { /* ignore */ }
  };

  const reinvokeFinalize = async () => {
    try {
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/finalize-video`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("INTERNAL_FN_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ run_id }),
      });
    } catch (e) {
      await log("warn", `Re-invoke finalize-video failed: ${(e as Error).message}`);
    }
  };

  // Advance the run to publish (captioned on success, uncaptioned on failure)
  // and hand control back to finalize-video.
  const advanceToPublish = async (patch: Record<string, unknown>) => {
    const { data: cur } = await sb.from("runs").select("generated_metadata").eq("id", run_id).single();
    const meta = (cur?.generated_metadata as any) || {};
    await sb.from("runs").update({
      current_step: "publish",
      generated_metadata: { ...meta, ...patch },
    }).eq("id", run_id);
    await reinvokeFinalize();
  };

  try {
    if (!SUBMAGIC_API_KEY) throw new Error("SUBMAGIC_API_KEY not configured");

    // Resolve the project's subtitle config (theme + language).
    const { data: run } = await sb.from("runs").select("project_id").eq("id", run_id).single();
    if (!run) throw new Error("run not found");
    const { data: project } = await sb.from("projects").select("prompt_config_json").eq("id", run.project_id).single();
    const subsCfg = ((project?.prompt_config_json as any) || {}).subtitles || {};
    const themeId = subsCfg.user_theme_id || DEFAULT_SUBMAGIC_THEME;
    const language = subsCfg.language || "en";

    // The merged-with-audio final video is the Submagic input.
    const { data: finalAsset } = await sb.from("assets")
      .select("supabase_path").eq("run_id", run_id).eq("type", "final_video")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!finalAsset?.supabase_path) throw new Error("No final_video asset to caption");

    const videoUrl = mediaPublicUrl(finalAsset.supabase_path);
    await log("info", `Submitting final video to Submagic (theme=${themeId}, lang=${language})`);

    const createResp = await fetch("https://api.submagic.co/v1/projects", {
      method: "POST",
      headers: { "x-api-key": SUBMAGIC_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Subs ${String(run_id).substring(0, 8)}`,
        language,
        videoUrl,
        userThemeId: themeId,
      }),
    });
    if (!createResp.ok) throw new Error(`Submagic create failed: ${createResp.status} ${await createResp.text()}`);

    const subProject = await createResp.json();
    const subProjectId = subProject.id;
    await log("info", `Submagic project: ${subProjectId}`);

    // Poll transcription
    let transcribed = false;
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const r = await fetch(`https://api.submagic.co/v1/projects/${subProjectId}`, { headers: { "x-api-key": SUBMAGIC_API_KEY } });
      if (!r.ok) continue;
      const p = await r.json();
      if (p.status === "completed" || p.transcriptionStatus === "COMPLETED") { transcribed = true; break; }
      if (p.status === "failed") throw new Error(`Transcription failed: ${p.failedReason}`);
    }
    if (!transcribed) throw new Error("Transcription timeout");
    await log("info", "Transcribed, exporting...");

    const exportResp = await fetch(`https://api.submagic.co/v1/projects/${subProjectId}/export`, {
      method: "POST",
      headers: { "x-api-key": SUBMAGIC_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ width: 1080, height: 1920, fps: 30 }),
    });
    if (!exportResp.ok) throw new Error(`Export failed: ${await exportResp.text()}`);

    // Poll export
    let downloadUrl: string | null = null;
    for (let i = 0; i < 120; i++) {
      await sleep(5000);
      const r = await fetch(`https://api.submagic.co/v1/projects/${subProjectId}`, { headers: { "x-api-key": SUBMAGIC_API_KEY } });
      if (!r.ok) continue;
      const p = await r.json();
      if (p.status === "completed" && p.downloadUrl) { downloadUrl = p.downloadUrl; break; }
      if (p.status === "failed") throw new Error(`Export failed: ${p.failedReason}`);
    }
    if (!downloadUrl) throw new Error("Export timeout");

    await log("info", "Downloading captioned video...");
    const dl = await fetch(downloadUrl);
    const bytes = new Uint8Array(await dl.arrayBuffer());
    const path = `${run.project_id}/final/${run_id}/captioned_${Date.now()}.mp4`;
    await r2Upload(path, bytes, "video/mp4");
    await log("info", `Captioned video stored: ${path} (${(bytes.length / 1024 / 1024).toFixed(1)}MB)`);

    await advanceToPublish({ captioned_video_path: path, submagic_project_id: subProjectId });
    return json({ ok: true, path, run_id });
  } catch (e) {
    await log("error", `Subtitles failed — publishing uncaptioned: ${(e as Error).message}`);
    try {
      await advanceToPublish({ subtitles_failed: true });
    } catch (e2) {
      await log("error", `Failed to advance run to publish after subtitle failure: ${(e2 as Error).message}`);
    }
    // Return 200 so a transient invoker doesn't hammer retries; the run already advanced.
    return json({ ok: false, error: (e as Error).message, run_id });
  }
});
