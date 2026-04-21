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
    // ── PART 1: Regular project schedules ──
    const { data: schedules, error } = await supabase
      .from("schedules")
      .select("*, projects!inner(id, title, is_enabled, timezone)")
      .eq("is_enabled", true)
      .eq("projects.is_enabled", true)
      .not("project_id", "is", null);

    if (error) throw error;

    const triggered: string[] = [];

    if (schedules && schedules.length > 0) {
      for (const schedule of schedules) {
        const project = schedule.projects as any;
        const tz = project.timezone || "America/New_York";
        const localTimeStr = now.toLocaleString("en-US", { timeZone: tz, hour12: false });
        const localDate = new Date(localTimeStr);
        const currentHour = localDate.getHours();
        const currentMinute = localDate.getMinutes();
        const [schedHour, schedMinute] = schedule.time_utc.split(":").map(Number);

        if (currentHour !== schedHour || currentMinute !== schedMinute) continue;

        const scheduleDays: number[] = schedule.days_of_week || [0,1,2,3,4,5,6];
        const currentDow = localDate.getDay();
        if (!scheduleDays.includes(currentDow)) continue;

        if (schedule.last_triggered_at) {
          const lastLocal = new Date(new Date(schedule.last_triggered_at).toLocaleString("en-US", { timeZone: tz, hour12: false }));
          if (lastLocal.getFullYear() === localDate.getFullYear() && lastLocal.getMonth() === localDate.getMonth() && lastLocal.getDate() === localDate.getDate() && lastLocal.getHours() === localDate.getHours() && lastLocal.getMinutes() === localDate.getMinutes()) continue;
        }

        const { data: activeRuns } = await supabase.from("runs").select("id").eq("project_id", project.id).in("status", ["queued", "running"]).limit(1);
        if (activeRuns && activeRuns.length > 0) { console.log(`Project ${project.id} already has an active run, skipping`); continue; }

        const initialMetadata: Record<string, unknown> = {};
        if (schedule.scheduled_post_time) {
          let postTimeStr: string = schedule.scheduled_post_time;
          if (schedule.scheduled_post_time_end) {
            const [sh, sm] = schedule.scheduled_post_time.split(":").map(Number);
            const [eh, em] = schedule.scheduled_post_time_end.split(":").map(Number);
            const startMin = sh * 60 + sm;
            const endMin = eh * 60 + em;
            const totalRange = endMin >= startMin ? endMin - startMin : (1440 - startMin) + endMin;
            const randomOffset = Math.floor(Math.random() * (totalRange + 1));
            const pickedMin = (startMin + randomOffset) % 1440;
            postTimeStr = `${String(Math.floor(pickedMin / 60)).padStart(2, "0")}:${String(pickedMin % 60).padStart(2, "0")}:00`;
          }
          const localDateStr = now.toLocaleDateString("en-CA", { timeZone: tz });
          const publishLocalStr = `${localDateStr}T${postTimeStr}`;
          const scheduledLocal = new Date(new Date(publishLocalStr).toLocaleString("en-US", { timeZone: tz }));
          let publishDate = publishLocalStr;
          if (scheduledLocal <= localDate) {
            const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            publishDate = `${tomorrow.toLocaleDateString("en-CA", { timeZone: tz })}T${postTimeStr}`;
          }
          initialMetadata.publish_scheduled_date = publishDate;
          initialMetadata.publish_timezone = tz;
        }

        const { data: run, error: runErr } = await supabase.from("runs").insert({ project_id: project.id, status: "queued" as const, generated_metadata: Object.keys(initialMetadata).length > 0 ? initialMetadata : {} }).select().single();
        if (runErr || !run) { console.error(`Failed to create run for project ${project.id}:`, runErr); continue; }

        await Promise.all([
          supabase.from("schedules").update({ last_triggered_at: now.toISOString() }).eq("id", schedule.id),
          supabase.from("projects").update({ last_run_at: now.toISOString() }).eq("id", project.id),
        ]);

        const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/run-pipeline`;
        fetch(fnUrl, { method: "POST", headers: { "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify({ run_id: run.id }) }).catch((e) => console.error(`Pipeline invoke error:`, e));
        triggered.push(`${project.title} (schedule ${schedule.time_utc})`);
        console.log(`Triggered run ${run.id} for project "${project.title}" at ${schedule.time_utc}`);
      }
    }

    // ── PART 2: Story project schedules ──
    const storyTriggered: string[] = [];
    try {
      const { data: storySchedules } = await supabase
        .from("schedules")
        .select("*")
        .eq("is_enabled", true)
        .not("story_project_id", "is", null) as any;

      if (storySchedules && storySchedules.length > 0) {
        // Fetch story project details
        const storyProjectIds = [...new Set(storySchedules.map((s: any) => s.story_project_id))];
        const { data: storyProjects } = await supabase
          .from("story_projects")
          .select("id, title, is_enabled, timezone")
          .in("id", storyProjectIds)
          .eq("is_enabled", true);

        const projMap = new Map((storyProjects || []).map((p: any) => [p.id, p]));

        for (const schedule of storySchedules) {
          const project = projMap.get(schedule.story_project_id);
          if (!project) continue;

          const tz = (project as any).timezone || "America/New_York";
          const localTimeStr = now.toLocaleString("en-US", { timeZone: tz, hour12: false });
          const localDate = new Date(localTimeStr);
          const currentHour = localDate.getHours();
          const currentMinute = localDate.getMinutes();
          const [schedHour, schedMinute] = schedule.time_utc.split(":").map(Number);

          if (currentHour !== schedHour || currentMinute !== schedMinute) continue;

          const scheduleDays: number[] = schedule.days_of_week || [0,1,2,3,4,5,6];
          if (!scheduleDays.includes(localDate.getDay())) continue;

          if (schedule.last_triggered_at) {
            const lastLocal = new Date(new Date(schedule.last_triggered_at).toLocaleString("en-US", { timeZone: tz, hour12: false }));
            if (lastLocal.getFullYear() === localDate.getFullYear() && lastLocal.getMonth() === localDate.getMonth() && lastLocal.getDate() === localDate.getDate() && lastLocal.getHours() === localDate.getHours() && lastLocal.getMinutes() === localDate.getMinutes()) continue;
          }

          // Check for active story runs
          const { data: activeRuns } = await supabase.from("story_runs").select("id").eq("project_id", (project as any).id).in("status", ["queued", "researching_story", "story_selected", "cast_generated", "narration_generated", "beats_extracted", "scene_images_generating", "scenes_generating", "audio_mixing", "subtitles_processing", "end_card_rendering"]).limit(1);
          if (activeRuns && activeRuns.length > 0) { console.log(`Story project ${(project as any).id} already has an active run, skipping`); continue; }

          const initialMetadata: Record<string, unknown> = {};
          if (schedule.scheduled_post_time) {
            let postTimeStr: string = schedule.scheduled_post_time;
            if (schedule.scheduled_post_time_end) {
              const [sh, sm] = schedule.scheduled_post_time.split(":").map(Number);
              const [eh, em] = schedule.scheduled_post_time_end.split(":").map(Number);
              const startMin = sh * 60 + sm;
              const endMin = eh * 60 + em;
              const totalRange = endMin >= startMin ? endMin - startMin : (1440 - startMin) + endMin;
              const randomOffset = Math.floor(Math.random() * (totalRange + 1));
              const pickedMin = (startMin + randomOffset) % 1440;
              postTimeStr = `${String(Math.floor(pickedMin / 60)).padStart(2, "0")}:${String(pickedMin % 60).padStart(2, "0")}:00`;
            }
            const localDateStr = now.toLocaleDateString("en-CA", { timeZone: tz });
            const publishLocalStr = `${localDateStr}T${postTimeStr}`;
            const scheduledLocal = new Date(new Date(publishLocalStr).toLocaleString("en-US", { timeZone: tz }));
            let publishDate = publishLocalStr;
            if (scheduledLocal <= localDate) {
              const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
              publishDate = `${tomorrow.toLocaleDateString("en-CA", { timeZone: tz })}T${postTimeStr}`;
            }
            initialMetadata.publish_scheduled_date = publishDate;
            initialMetadata.publish_timezone = tz;
          }

          const { data: storyRun, error: runErr } = await supabase.from("story_runs").insert({ project_id: (project as any).id, status: "queued" as any, generated_metadata: Object.keys(initialMetadata).length > 0 ? initialMetadata : {} } as any).select().single();
          if (runErr || !storyRun) { console.error(`Failed to create story run for ${(project as any).id}:`, runErr); continue; }

          await supabase.from("schedules").update({ last_triggered_at: now.toISOString() }).eq("id", schedule.id);

          const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/story-pipeline`;
          fetch(fnUrl, { method: "POST", headers: { "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify({ run_id: storyRun.id }) }).catch((e) => console.error(`Story pipeline invoke error:`, e));
          storyTriggered.push(`${(project as any).title} (schedule ${schedule.time_utc})`);
          console.log(`Triggered story run ${storyRun.id} for "${(project as any).title}" at ${schedule.time_utc}`);
        }
      }
    } catch (storyErr) {
      console.error("Story scheduler error:", storyErr);
    }

    // ── Stuck-run watchdog ──
    const stuckResults: string[] = [];
    try {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: stuckRuns } = await supabase.from("runs").select("id, project_id, current_step, progress_pct, started_at").eq("status", "running").lt("started_at", fiveMinAgo);

      if (stuckRuns && stuckRuns.length > 0) {
        for (const stuck of stuckRuns) {
          const { data: recentLogs } = await supabase.from("run_logs").select("created_at").eq("run_id", stuck.id).order("created_at", { ascending: false }).limit(1);
          const lastLogAt = recentLogs?.[0]?.created_at;
          if (lastLogAt && new Date(lastLogAt).getTime() > Date.now() - 5 * 60 * 1000) continue;

          console.log(`Watchdog: re-triggering stuck run ${stuck.id}`);
          await supabase.from("run_logs").insert({ run_id: stuck.id, level: "warn" as any, message: `Watchdog: run appeared stuck at step="${stuck.current_step}". Re-triggering pipeline.` });

          const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/run-pipeline`;
          fetch(fnUrl, { method: "POST", headers: { "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify({ run_id: stuck.id }) }).catch((e) => console.error(`Watchdog error for ${stuck.id}:`, e));
          stuckResults.push(`${stuck.id} (step=${stuck.current_step})`);
        }
      }
    } catch (watchdogErr) {
      console.error("Watchdog error:", watchdogErr);
    }

    // ── Story-run watchdog ──
    const storyStuckResults: string[] = [];
    try {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      // Stages where the pipeline is doing synchronous work in story-pipeline (not waiting on external pollers)
      const ACTIVE_STAGES = [
        "queued",
        "researching_story",
        "story_selected",
        "cast_generated",
        "narration_generated",
        "beats_extracted",
        "scene_images_generating",
      ];
      const { data: stuckStoryRuns } = await supabase
        .from("story_runs")
        .select("id, current_stage, status, started_at")
        .in("status", ACTIVE_STAGES as any)
        .lt("started_at", fiveMinAgo);

      if (stuckStoryRuns && stuckStoryRuns.length > 0) {
        for (const stuck of stuckStoryRuns as any[]) {
          const { data: recentLogs } = await supabase
            .from("story_run_logs")
            .select("created_at")
            .eq("run_id", stuck.id)
            .order("created_at", { ascending: false })
            .limit(1);
          const lastLogAt = recentLogs?.[0]?.created_at;
          if (lastLogAt && new Date(lastLogAt).getTime() > Date.now() - 5 * 60 * 1000) continue;

          // Map current_stage → safest resume_stage for story-pipeline
          let resumeStage: string | null = null;
          switch (stuck.current_stage) {
            case "scene_images_generating": resumeStage = "stage10_continue"; break;
            case "beats_extracted":         resumeStage = "stage9"; break;
            case "narration_generated":     resumeStage = "stage9"; break;
            case "cast_generated":          resumeStage = "stage6"; break;
            case "story_selected":          resumeStage = "stage5"; break;
            case "researching_story":
            case "queued":
            default:                        resumeStage = null; // restart from stage 1
          }

          console.log(`Story watchdog: re-triggering ${stuck.id} (stage=${stuck.current_stage}, resume=${resumeStage ?? "full"})`);
          await supabase.from("story_run_logs").insert({
            run_id: stuck.id,
            level: "warn" as any,
            message: `Watchdog: story run stuck at stage="${stuck.current_stage}". Re-triggering pipeline (resume=${resumeStage ?? "full"}).`,
          });

          const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/story-pipeline`;
          const body: any = { run_id: stuck.id };
          if (resumeStage) body.resume_stage = resumeStage;
          fetch(fnUrl, {
            method: "POST",
            headers: { "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).catch((e) => console.error(`Story watchdog error for ${stuck.id}:`, e));
          storyStuckResults.push(`${stuck.id} (stage=${stuck.current_stage} → ${resumeStage ?? "full"})`);
        }
      }
    } catch (storyWatchdogErr) {
      console.error("Story watchdog error:", storyWatchdogErr);
    }

    return json({ status: "ok", triggered_count: triggered.length, triggered, story_triggered: storyTriggered, watchdog_retried: stuckResults, story_watchdog_retried: storyStuckResults });
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
