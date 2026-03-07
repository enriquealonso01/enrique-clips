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
    // Fetch all enabled projects with a schedule configured
    const { data: projects, error } = await supabase
      .from("projects")
      .select("*")
      .eq("is_enabled", true)
      .in("posting_frequency_type", ["cron", "interval_hours"]);

    if (error) throw error;
    if (!projects || projects.length === 0) {
      return json({ status: "no_scheduled_projects" });
    }

    const triggered: string[] = [];

    for (const project of projects) {
      const shouldRun = await shouldTrigger(project, now);
      if (!shouldRun) continue;

      // Check if there's already an active run for this project
      const { data: activeRuns } = await supabase
        .from("runs")
        .select("id")
        .eq("project_id", project.id)
        .in("status", ["queued", "running", "paused"])
        .limit(1);

      if (activeRuns && activeRuns.length > 0) {
        console.log(`Project ${project.id} already has an active run, skipping`);
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

      // Update last_run_at
      await supabase
        .from("projects")
        .update({ last_run_at: now.toISOString() })
        .eq("id", project.id);

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

      triggered.push(project.id);
      console.log(`Triggered run ${run.id} for project "${project.title}" (${project.id})`);
    }

    return json({ status: "ok", triggered_count: triggered.length, triggered });
  } catch (err) {
    console.error("Scheduler error:", err);
    return json({ error: err.message }, 500);
  }
});

async function shouldTrigger(
  project: Record<string, any>,
  now: Date
): Promise<boolean> {
  const freqType = project.posting_frequency_type;
  const lastRunAt = project.last_run_at ? new Date(project.last_run_at) : null;

  if (freqType === "interval_hours") {
    const intervalHours = project.posting_interval_hours;
    if (!intervalHours || intervalHours <= 0) return false;

    if (!lastRunAt) return true; // Never run before

    const hoursSinceLastRun = (now.getTime() - lastRunAt.getTime()) / (1000 * 60 * 60);
    return hoursSinceLastRun >= intervalHours;
  }

  if (freqType === "cron") {
    const cronExpr = project.posting_cron;
    if (!cronExpr) return false;

    // Parse the cron expression and check if current minute matches
    // Format: minute hour day-of-month month day-of-week
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 5) return false;

    const [cronMin, cronHour, cronDom, cronMonth, cronDow] = parts;

    // Convert current time to the project's timezone
    const tz = project.timezone || "America/New_York";
    const localTime = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const minute = localTime.getMinutes();
    const hour = localTime.getHours();
    const dayOfMonth = localTime.getDate();
    const month = localTime.getMonth() + 1;
    const dayOfWeek = localTime.getDay(); // 0=Sun

    if (!matchesCronField(cronMin, minute)) return false;
    if (!matchesCronField(cronHour, hour)) return false;
    if (!matchesCronField(cronDom, dayOfMonth)) return false;
    if (!matchesCronField(cronMonth, month)) return false;
    if (!matchesCronField(cronDow, dayOfWeek)) return false;

    // Prevent double-trigger within the same minute window
    if (lastRunAt) {
      const lastLocal = new Date(lastRunAt.toLocaleString("en-US", { timeZone: tz }));
      if (
        lastLocal.getFullYear() === localTime.getFullYear() &&
        lastLocal.getMonth() === localTime.getMonth() &&
        lastLocal.getDate() === localTime.getDate() &&
        lastLocal.getHours() === localTime.getHours() &&
        lastLocal.getMinutes() === localTime.getMinutes()
      ) {
        return false; // Already triggered this minute
      }
    }

    return true;
  }

  return false;
}

function matchesCronField(field: string, value: number): boolean {
  if (field === "*") return true;

  // Handle */N (step values)
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    return !isNaN(step) && step > 0 && value % step === 0;
  }

  // Handle comma-separated values: 1,5,10
  const parts = field.split(",");
  for (const part of parts) {
    // Handle ranges: 1-5
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      if (!isNaN(start) && !isNaN(end) && value >= start && value <= end) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }

  return false;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    },
  });
}
