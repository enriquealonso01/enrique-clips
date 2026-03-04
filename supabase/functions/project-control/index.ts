import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-project-token",
};

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    // Expected: /project-control?project_id=xxx&action=trigger|pause|resume|stop|status
    const projectId = url.searchParams.get("project_id");
    const action = url.searchParams.get("action");

    if (!projectId || !action) {
      return new Response(
        JSON.stringify({ error: "project_id and action query params required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Validate token
    const token = req.headers.get("x-project-token");
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Missing X-Project-Token header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, project_control_token_hash")
      .eq("id", projectId)
      .single();

    if (projErr || !project) {
      return new Response(
        JSON.stringify({ error: "Project not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!project.project_control_token_hash) {
      return new Response(
        JSON.stringify({ error: "No control token configured for this project" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const hashedInput = await hashToken(token);
    if (hashedInput !== project.project_control_token_hash) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Handle actions
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    if (action === "status") {
      const { data: run } = await supabase
        .from("runs")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      return json({ run: run || null });
    }

    if (action === "trigger") {
      const { data: run, error } = await supabase
        .from("runs")
        .insert({ project_id: projectId, status: "queued" })
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ run }, 201);
    }

    // For pause/resume/stop, find active run
    const { data: activeRun } = await supabase
      .from("runs")
      .select("*")
      .eq("project_id", projectId)
      .in("status", ["running", "paused", "queued"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!activeRun) {
      return json({ error: "No active run found" }, 404);
    }

    if (action === "pause") {
      if (activeRun.status !== "running") return json({ error: "Can only pause a running run" }, 400);
      const { error } = await supabase.from("runs").update({ status: "paused" }).eq("id", activeRun.id);
      if (error) return json({ error: error.message }, 500);
      return json({ status: "paused", run_id: activeRun.id });
    }

    if (action === "resume") {
      if (activeRun.status !== "paused") return json({ error: "Can only resume a paused run" }, 400);
      const { error } = await supabase.from("runs").update({ status: "running" }).eq("id", activeRun.id);
      if (error) return json({ error: error.message }, 500);
      return json({ status: "running", run_id: activeRun.id });
    }

    if (action === "stop") {
      const { error } = await supabase
        .from("runs")
        .update({ status: "stopped", finished_at: new Date().toISOString() })
        .eq("id", activeRun.id);
      if (error) return json({ error: error.message }, 500);
      return json({ status: "stopped", run_id: activeRun.id });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
