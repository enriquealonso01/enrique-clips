import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const { run_id, segment_count = 5, gap_ms = 25 } = await req.json();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const RENDI = Deno.env.get("RENDI_API_KEY")!;

  const inputFiles: Record<string, string> = {};
  for (let i = 0; i < segment_count; i++) {
    const path = `story-runs/${run_id}/narration-segments/seg-${String(i).padStart(3, "0")}.mp3`;
    const { data } = await sb.storage.from("project-assets").createSignedUrl(path, 3600);
    if (!data?.signedUrl) return new Response(JSON.stringify({ error: `missing seg ${i}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    inputFiles[`in_seg${i}`] = data.signedUrl;
  }

  const SILENCE_TRIM = "silenceremove=start_periods=1:start_duration=0:start_threshold=-40dB:stop_periods=1:stop_duration=0.6:stop_threshold=-40dB:detection=peak";
  const gapSec = gap_ms / 1000;
  let filter = "";
  const labels: string[] = [];
  for (let i = 0; i < segment_count; i++) {
    const isLast = i === segment_count - 1;
    if (!isLast && gapSec > 0) filter += `[${i}:a]${SILENCE_TRIM},apad=pad_dur=${gapSec.toFixed(3)}[a${i}];`;
    else filter += `[${i}:a]${SILENCE_TRIM}[a${i}];`;
    labels.push(`[a${i}]`);
  }
  filter += `${labels.join("")}concat=n=${segment_count}:v=0:a=1[outa]`;
  const inputArgs = Array.from({ length: segment_count }, (_, i) => `-i {{in_seg${i}}}`).join(" ");
  const ffmpegCmd = `${inputArgs} -filter_complex "${filter}" -map "[outa]" -c:a libmp3lame -b:a 128k -ar 44100 {{out_narration}}`;

  const submit = await fetch("https://api.rendi.dev/v1/run-ffmpeg-command", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": RENDI },
    body: JSON.stringify({ ffmpeg_command: ffmpegCmd, input_files: inputFiles, output_files: { out_narration: "narration_stitched.mp3" }, max_command_run_seconds: 60, vcpu_count: 4 }),
  });
  if (!submit.ok) return new Response(JSON.stringify({ error: "submit failed", body: await submit.text() }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const { command_id } = await submit.json();

  let stitchedUrl: string | null = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const p = await fetch(`https://api.rendi.dev/v1/commands/${command_id}`, { headers: { "X-API-KEY": RENDI } });
    const pj = await p.json();
    if (pj.status === "SUCCESS") { stitchedUrl = pj.output_files?.out_narration?.storage_url; break; }
    if (pj.status === "FAILED") return new Response(JSON.stringify({ error: "rendi failed", pj }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (!stitchedUrl) return new Response(JSON.stringify({ error: "timeout" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const dl = await fetch(stitchedUrl);
  const bytes = new Uint8Array(await dl.arrayBuffer());
  const path = `story-runs/${run_id}/narration.mp3`;
  await sb.storage.from("project-assets").upload(path, bytes, { contentType: "audio/mpeg", upsert: true });
  await sb.from("story_assets").update({
    metadata: { segmented: true, segment_count, gap_ms, restitched_at: new Date().toISOString(), size_bytes: bytes.length },
  }).eq("run_id", run_id).eq("type", "narration_audio");

  // Clean prior outputs and reset run for finalize retry
  await sb.from("story_assets").delete().eq("run_id", run_id).in("type", ["final_video", "captioned_story_video"]);
  await sb.from("story_runs").update({
    status: "scenes_generating", current_stage: "video_stitching", progress_pct: 72,
    error_message: null, finished_at: null,
  }).eq("id", run_id);

  // Trigger finalize
  await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/story-finalize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ run_id, force_retry: true }),
  });

  return new Response(JSON.stringify({ ok: true, size_bytes: bytes.length, run_id }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
