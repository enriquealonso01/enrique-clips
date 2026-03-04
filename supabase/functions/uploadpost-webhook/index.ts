import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const { request_id, job_id, status, platform_results } = body;

    if (!request_id && !job_id) {
      return new Response(
        JSON.stringify({ error: "request_id or job_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Find the publish job by request_id or job_id
    let query = supabase.from("publish_jobs").select("*");
    if (request_id) query = query.eq("uploadpost_request_id", request_id);
    else query = query.eq("uploadpost_job_id", job_id);

    const { data: publishJob, error: findErr } = await query.single();

    if (findErr || !publishJob) {
      return new Response(
        JSON.stringify({ error: "Publish job not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Map incoming status to our enum
    let mappedStatus = publishJob.status;
    if (status === "completed") mappedStatus = "completed";
    else if (status === "failed") mappedStatus = "failed";
    else if (status === "partial_failed") mappedStatus = "partial_failed";
    else if (status === "polling" || status === "processing") mappedStatus = "polling";

    const updates: Record<string, unknown> = { status: mappedStatus };
    if (platform_results) updates.platform_results = platform_results;
    if (job_id && !publishJob.uploadpost_job_id) updates.uploadpost_job_id = job_id;

    const { error: updateErr } = await supabase
      .from("publish_jobs")
      .update(updates)
      .eq("id", publishJob.id);

    if (updateErr) {
      return new Response(
        JSON.stringify({ error: updateErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
