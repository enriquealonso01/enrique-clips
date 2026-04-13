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

      // Check day-of-week filter
      const scheduleDays: number[] = schedule.days_of_week || [0,1,2,3,4,5,6];
      const currentDow = localDate.getDay(); // 0=Sun
      if (!scheduleDays.includes(currentDow)) {
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

      // Build initial generated_metadata with optional publish_scheduled_date
      const initialMetadata: Record<string, unknown> = {};
      if (schedule.scheduled_post_time) {
        // Determine the actual post time — random within range if end is set
        let postTimeStr: string = schedule.scheduled_post_time; // HH:MM:SS
        if (schedule.scheduled_post_time_end) {
          const [sh, sm] = schedule.scheduled_post_time.split(":").map(Number);
          const [eh, em] = schedule.scheduled_post_time_end.split(":").map(Number);
          const startMin = sh * 60 + sm;
          const endMin = eh * 60 + em;
          // Support overnight ranges (e.g. 22:00 → 02:00)
          const totalRange = endMin >= startMin ? endMin - startMin : (1440 - startMin) + endMin;
          const randomOffset = Math.floor(Math.random() * (totalRange + 1));
          const pickedMin = (startMin + randomOffset) % 1440;
          const pH = String(Math.floor(pickedMin / 60)).padStart(2, "0");
          const pM = String(pickedMin % 60).padStart(2, "0");
          postTimeStr = `${pH}:${pM}:00`;
          console.log(`Schedule ${schedule.id}: random post time ${postTimeStr} (range ${schedule.scheduled_post_time}–${schedule.scheduled_post_time_end})`);
        }

        // Compute full ISO-8601 datetime: today in project TZ + chosen post time
        const localDateStr = now.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
        const publishLocalStr = `${localDateStr}T${postTimeStr}`;
        // If the scheduled post time has already passed today, schedule for tomorrow
        const scheduledLocal = new Date(new Date(publishLocalStr).toLocaleString("en-US", { timeZone: tz }));
        let publishDate = publishLocalStr;
        if (scheduledLocal <= localDate) {
          const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          const tomorrowStr = tomorrow.toLocaleDateString("en-CA", { timeZone: tz });
          publishDate = `${tomorrowStr}T${postTimeStr}`;
        }
        initialMetadata.publish_scheduled_date = publishDate;
        initialMetadata.publish_timezone = tz;
        console.log(`Schedule ${schedule.id}: post will be scheduled at ${publishDate} (${tz})`);
      }

      // Create a new run
      const { data: run, error: runErr } = await supabase
        .from("runs")
        .insert({
          project_id: project.id,
          status: "queued" as const,
          generated_metadata: Object.keys(initialMetadata).length > 0 ? initialMetadata : {},
        })
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

    // ── Stuck-run watchdog ──
    // Detect runs stuck in "running" for >5 min with no recent log activity
    // This catches edge-function crashes that kill a run mid-step without re-chaining
    const stuckResults: string[] = [];
    try {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: stuckRuns } = await supabase
        .from("runs")
        .select("id, project_id, current_step, progress_pct, started_at")
        .eq("status", "running")
        .lt("started_at", fiveMinAgo);

      if (stuckRuns && stuckRuns.length > 0) {
        for (const stuck of stuckRuns) {
          // Check last log timestamp — if >5 min old, run is truly stuck
          const { data: recentLogs } = await supabase
            .from("run_logs")
            .select("created_at")
            .eq("run_id", stuck.id)
            .order("created_at", { ascending: false })
            .limit(1);

          const lastLogAt = recentLogs?.[0]?.created_at;
          if (lastLogAt && new Date(lastLogAt).getTime() > Date.now() - 5 * 60 * 1000) {
            continue; // Had recent activity, not stuck
          }

          console.log(`Watchdog: re-triggering stuck run ${stuck.id} (step=${stuck.current_step}, progress=${stuck.progress_pct}%)`);

          // Log watchdog action
          await supabase.from("run_logs").insert({
            run_id: stuck.id,
            level: "warn" as any,
            message: `Watchdog: run appeared stuck at step="${stuck.current_step}" (no logs for >5 min). Re-triggering pipeline.`,
          });

          // Re-invoke pipeline
          const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/run-pipeline`;
          fetch(fnUrl, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ run_id: stuck.id }),
          }).catch((e) => console.error(`Watchdog pipeline invoke error for ${stuck.id}:`, e));

          stuckResults.push(`${stuck.id} (step=${stuck.current_step})`);
        }
      }
    } catch (watchdogErr) {
      console.error("Watchdog error:", watchdogErr);
    }

    return json({ status: "ok", triggered_count: triggered.length, triggered, watchdog_retried: stuckResults });
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
