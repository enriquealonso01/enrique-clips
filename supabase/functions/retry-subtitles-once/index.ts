import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const SUBMAGIC_API_KEY = Deno.env.get("SUBMAGIC_API_KEY")!;

  const { run_id } = await req.json();
  if (!run_id) return new Response(JSON.stringify({ error: "run_id required" }), { status: 400, headers: corsHeaders });

  const log = async (message: string, data?: unknown) => {
    console.log(`[RETRY-SUBS] ${message}`);
    await sb.from("story_run_logs").insert({ run_id, level: "info", message, data: data || null });
  };

  try {
    // Get the existing final_video as the input (it has narration + music + end card)
    const { data: finalAsset } = await sb.from("story_assets")
      .select("*").eq("run_id", run_id).eq("type", "final_video")
      .order("created_at", { ascending: false }).limit(1).single();

    if (!finalAsset) throw new Error("No final_video asset found");

    const { data: signedUrl } = await sb.storage.from("project-assets")
      .createSignedUrl(finalAsset.supabase_path, 3600);
    if (!signedUrl?.signedUrl) throw new Error("Could not sign final video URL");

    await log("Submitting final video to Submagic with userThemeId");

    // Create Submagic project with correct userThemeId field
    const createResp = await fetch("https://api.submagic.co/v1/projects", {
      method: "POST",
      headers: { "x-api-key": SUBMAGIC_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Retry Subs ${run_id.substring(0, 8)}`,
        language: "en",
        videoUrl: signedUrl.signedUrl,
        userThemeId: "8ef61dce-7589-48ff-b269-8623a3a5179e",
      }),
    });

    if (!createResp.ok) {
      const errText = await createResp.text();
      throw new Error(`Submagic create failed: ${createResp.status} ${errText}`);
    }

    const subProject = await createResp.json();
    const subProjectId = subProject.id;
    await log(`Submagic project: ${subProjectId}`);

    // Poll for transcription
    let transcribed = false;
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const r = await fetch(`https://api.submagic.co/v1/projects/${subProjectId}`, {
        headers: { "x-api-key": SUBMAGIC_API_KEY },
      });
      if (!r.ok) continue;
      const p = await r.json();
      if (p.status === "completed" || p.transcriptionStatus === "COMPLETED") { transcribed = true; break; }
      if (p.status === "failed") throw new Error(`Transcription failed: ${p.failedReason}`);
    }
    if (!transcribed) throw new Error("Transcription timeout");
    await log("Transcribed, exporting...");

    // Export
    const exportResp = await fetch(`https://api.submagic.co/v1/projects/${subProjectId}/export`, {
      method: "POST",
      headers: { "x-api-key": SUBMAGIC_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ width: 1080, height: 1920, fps: 30 }),
    });
    if (!exportResp.ok) throw new Error(`Export failed: ${await exportResp.text()}`);

    // Poll for export
    let downloadUrl: string | null = null;
    for (let i = 0; i < 120; i++) {
      await sleep(5000);
      const r = await fetch(`https://api.submagic.co/v1/projects/${subProjectId}`, {
        headers: { "x-api-key": SUBMAGIC_API_KEY },
      });
      if (!r.ok) continue;
      const p = await r.json();
      if (p.status === "completed" && p.downloadUrl) { downloadUrl = p.downloadUrl; break; }
      if (p.status === "failed") throw new Error(`Export failed: ${p.failedReason}`);
    }
    if (!downloadUrl) throw new Error("Export timeout");

    await log("Downloading captioned video...");
    const dl = await fetch(downloadUrl);
    const bytes = new Uint8Array(await dl.arrayBuffer());
    const path = `story-runs/${run_id}/captioned_retry_${Date.now()}.mp4`;
    await sb.storage.from("project-assets").upload(path, bytes, { contentType: "video/mp4", upsert: true });

    const { data: signed } = await sb.storage.from("project-assets").createSignedUrl(path, 60 * 60 * 24 * 7);

    await sb.from("story_assets").insert({
      run_id,
      type: "captioned_story_video",
      supabase_path: path,
      signed_url_last: signed?.signedUrl || null,
      metadata: { submagic_project_id: subProjectId, retry: true, size_bytes: bytes.length },
    });

    await log(`Captioned video stored: ${path} (${(bytes.length / 1024 / 1024).toFixed(1)}MB)`);

    return new Response(JSON.stringify({ ok: true, path, signed_url: signed?.signedUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    await log(`ERROR: ${(e as Error).message}`);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
