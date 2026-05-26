// ═══════════════════════════════════════════════════════════
// subtitles-opusclip — Projects pipeline subtitle pass (opt-in)
// ───────────────────────────────────────────────────────────
// Invoked ONLY by finalize-video when a project's prompt_config_json has
// `subtitles.enabled === true` AND `subtitles.provider === "opusclip"`. It
// captions the already-merged final video via the OpusClip API, stores the
// captioned cut in R2, records `captioned_video_path` on the run, and
// re-invokes finalize-video to publish the captioned version.
//
// NOTE on OpusClip's nature: it is primarily a long-video → highlight CLIPPER,
// not a caption-an-existing-video service. We feed it our already-finished cut
// and set `curationPref.skipCurate = true` so it processes the WHOLE video
// instead of slicing out a highlight. `clipDurations: [[0,90]]` is a safety net
// so a ~30s input still maps to one full-length clip if skipCurate is ignored.
// The returned clip's `durationMs` is logged so we can verify on the FIRST run
// that the full length survived (if it comes back much shorter than the input,
// OpusClip re-clipped us and we should revert to provider "submagic").
//
// Isolation + fail-soft: identical contract to subtitles-submagic. On ANY error
// it marks `subtitles_failed` and still advances the run to publish
// (uncaptioned) so an OpusClip outage never blocks a post.
//
// Endpoints (base https://api.opus.pro/api):
//   POST /clip-projects                                   → create; returns project id
//   GET  /exportable-clips?q=findByProjectId&projectId=X  → poll; clip.uriForExport = rendered MP4
// Auth: Authorization: Bearer <OPUSCLIP_API_KEY>.
// ═══════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { r2Upload, mediaPublicUrl } from "../_shared/r2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OPUSCLIP_BASE = "https://api.opus.pro/api";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const OPUSCLIP_API_KEY = Deno.env.get("OPUSCLIP_API_KEY");

  const { run_id } = await req.json().catch(() => ({}));
  if (!run_id) return json({ error: "run_id required" }, 400);

  // Best-effort logging — a logging failure must never break the run.
  const log = async (level: string, message: string, data?: unknown) => {
    console.log(`[SUBS-OPUSCLIP] ${message}`);
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
    if (!OPUSCLIP_API_KEY) throw new Error("OPUSCLIP_API_KEY not configured");
    const authHeaders = { Authorization: `Bearer ${OPUSCLIP_API_KEY}` };

    // Resolve the project's subtitle config (language + OpusClip caption style).
    const { data: run } = await sb.from("runs").select("project_id").eq("id", run_id).single();
    if (!run) throw new Error("run not found");
    const { data: project } = await sb.from("projects").select("prompt_config_json").eq("id", run.project_id).single();
    const subsCfg = ((project?.prompt_config_json as any) || {}).subtitles || {};
    const oc = subsCfg.opusclip || {};
    const language = subsCfg.language || "en";

    // The merged-with-audio final video is the OpusClip input.
    const { data: finalAsset } = await sb.from("assets")
      .select("supabase_path").eq("run_id", run_id).eq("type", "final_video")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!finalAsset?.supabase_path) throw new Error("No final_video asset to caption");

    const videoUrl = mediaPublicUrl(finalAsset.supabase_path);

    // Build the create-project body. skipCurate => caption the WHOLE video (no
    // highlight slicing). Either a brand template (presets caption styling) or
    // the individual caption fields, configurable from subtitles.opusclip.*.
    const body: Record<string, unknown> = {
      videoUrl,
      uploadedVideoAttr: { title: `Subs ${String(run_id).substring(0, 8)}` },
      curationPref: {
        model: "ClipBasic",
        skipCurate: true,
        clipDurations: [[0, 90]],
        genre: "Auto",
      },
      importPreference: { sourceLang: language },
    };
    if (oc.brand_template_id) {
      body.brandTemplateId = oc.brand_template_id;
      body.renderPref = { layoutAspectRatio: "portrait" };
    } else {
      body.renderPref = {
        layoutAspectRatio: "portrait",
        enableCaption: true,
        captionStyle: oc.caption_style || "one-line",
        captionPosition: oc.caption_position || "auto",
        enableCaptionAnimation: true,
        captionAnimation: {
          name: oc.caption_animation || "pop",
          highlightColor: oc.highlight_color || "#04f827",
          bgColor: "",
        },
      };
    }

    await log("info", `Submitting final video to OpusClip (lang=${language}, skipCurate=true)`, { videoUrl });

    const createResp = await fetch(`${OPUSCLIP_BASE}/clip-projects`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!createResp.ok) throw new Error(`OpusClip create failed: ${createResp.status} ${await createResp.text()}`);

    const created = await createResp.json();
    // Defensive: the create response's id field is not pinned by the public docs.
    // Try the likely shapes; if none match, the raw payload is in the error log.
    const projectId = created?.id || created?.projectId || created?.data?.id || created?.data?.projectId || created?.project?.id;
    if (!projectId) throw new Error(`OpusClip create: no project id in response: ${JSON.stringify(created).substring(0, 400)}`);
    await log("info", `OpusClip project: ${projectId}`);

    // Poll exportable-clips until the rendered (captioned) clip is ready.
    let exportUrl: string | null = null;
    let durationMs: number | null = null;
    for (let i = 0; i < 120; i++) {
      await sleep(5000);
      const r = await fetch(
        `${OPUSCLIP_BASE}/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(String(projectId))}`,
        { headers: authHeaders },
      );
      if (!r.ok) continue;
      const payload = await r.json();
      const clips = Array.isArray(payload) ? payload : (payload?.data || payload?.clips || []);
      if (Array.isArray(clips) && clips.length > 0) {
        const clip = clips[0];
        const uri = clip?.uriForExport || clip?.exportUrl || clip?.downloadUrl;
        if (uri) { exportUrl = uri; durationMs = clip?.durationMs ?? null; break; }
      }
    }
    if (!exportUrl) throw new Error("OpusClip export timeout");
    await log("info", `OpusClip clip ready (durationMs=${durationMs}) — downloading...`, { durationMs });

    const dl = await fetch(exportUrl);
    if (!dl.ok) throw new Error(`Download failed: ${dl.status}`);
    const bytes = new Uint8Array(await dl.arrayBuffer());
    const path = `${run.project_id}/final/${run_id}/captioned_${Date.now()}.mp4`;
    await r2Upload(path, bytes, "video/mp4");
    await log("info", `Captioned video stored: ${path} (${(bytes.length / 1024 / 1024).toFixed(1)}MB)`);

    await advanceToPublish({ captioned_video_path: path, opusclip_project_id: projectId });
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
