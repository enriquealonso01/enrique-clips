import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const now = new Date();

  try {
    // Fetch all enabled schedules with their projects
    const { data: schedules, error } = await supabase
      .from("schedules")
      .select("*, projects!inner(id, title, is_enabled, timezone)")
      .eq("is_enabled", true)
      .eq("projects.is_enabled", true);

    if (error) throw error;
    if (!schedules || schedules.length === 0) {
      return json({ status: "no_schedules" });
    }

    const triggered: string[] = [];

    for (const schedule of schedules) {
      const project = schedule.projects as any;
      const tz = project.timezone || "America/New_York";

      // Get current time in project's timezone
      const localTimeStr = now.toLocaleString("en-US", { timeZone: tz, hour12: false });
      const localDate = new Date(localTimeStr);
      const currentHour = localDate.getHours();
      const currentMinute = localDate.getMinutes();

      // Parse schedule time_utc (stored as HH:MM:SS in project's local time)
      const [schedHour, schedMinute] = schedule.time_utc.split(":").map(Number);

      if (currentHour !== schedHour || currentMinute !== schedMinute) {
        continue;
      }

      // Prevent double-trigger: check if already triggered in this minute
      if (schedule.last_triggered_at) {
        const lastLocal = new Date(
          new Date(schedule.last_triggered_at).toLocaleString("en-US", { timeZone: tz, hour12: false })
        );
        if (
          lastLocal.getFullYear() === localDate.getFullYear() &&
          lastLocal.getMonth() === localDate.getMonth() &&
          lastLocal.getDate() === localDate.getDate() &&
          lastLocal.getHours() === localDate.getHours() &&
          lastLocal.getMinutes() === localDate.getMinutes()
        ) {
          continue; // Already triggered this minute
        }
      }

      // Check for active runs on this project
      const { data: activeRuns } = await supabase
        .from("runs")
        .select("id")
        .eq("project_id", project.id)
        .in("status", ["queued", "running", "paused"])
        .limit(1);

      if (activeRuns && activeRuns.length > 0) {
        console.log(`Project ${project.id} already has an active run, skipping schedule ${schedule.id}`);
        continue;
      }

      // Create a new run
      const { data: run, error: runErr } = await supabase
        .from("runs")
        .insert({ project_id: project.id, status: "queued" as const })
        .select()
        .single();

      if (runErr || !run) {
        console.error(`Failed to create run for project ${project.id}:`, runErr);
        continue;
      }

      // Update last_triggered_at on schedule and last_run_at on project
      await Promise.all([
        supabase.from("schedules").update({ last_triggered_at: now.toISOString() }).eq("id", schedule.id),
        supabase.from("projects").update({ last_run_at: now.toISOString() }).eq("id", project.id),
      ]);

      // Fire pipeline
      const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/run-pipeline`;
      fetch(fnUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ run_id: run.id }),
      }).catch((e) => console.error(`Pipeline invoke error for ${project.id}:`, e));

      triggered.push(`${project.title} (schedule ${schedule.time_utc})`);
      console.log(`Triggered run ${run.id} for project "${project.title}" at ${schedule.time_utc}`);
    }

    return json({ status: "ok", triggered_count: triggered.length, triggered });
  } catch (err) {
    console.error("Scheduler error:", err);
    return json({ error: err.message }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
