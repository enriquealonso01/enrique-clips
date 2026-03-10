import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const NOTIFICATION_EMAIL = "proven.solved@gmail.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY not configured");
    return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: { run_id: string; type: "completed" | "error"; error_message?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { run_id, type, error_message } = body;

  try {
    // Fetch run + project data
    const { data: run } = await supabase.from("runs").select("*").eq("id", run_id).single();

    if (!run) {
      return new Response(JSON.stringify({ error: "Run not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: project } = await supabase.from("projects").select("*").eq("id", run.project_id).single();

    const projectName = project?.title || "Untitled Project";
    const metadata = (run.generated_metadata as Record<string, any>) || {};

    let subject: string;
    let htmlBody: string;

    if (type === "completed") {
      const videoTitle = metadata.title || "Untitled Video";
      const description = metadata.description || "No description generated";
      const hashtags = (metadata.hashtags || []) as string[];

      // Try to get the final video URL
      const { data: finalAsset } = await supabase
        .from("assets")
        .select("supabase_path")
        .eq("run_id", run_id)
        .eq("type", "final_video")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      let videoLink = "";
      if (finalAsset?.supabase_path) {
        const { data: signedUrl } = await supabase.storage
          .from("project-assets")
          .createSignedUrl(finalAsset.supabase_path, 60 * 60 * 24 * 7); // 7 days
        if (signedUrl?.signedUrl) {
          videoLink = signedUrl.signedUrl;
        }
      }

      // Check publish job status
      const { data: publishJob } = await supabase
        .from("publish_jobs")
        .select("*")
        .eq("run_id", run_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      const publishStatus = publishJob ? `Published (status: ${publishJob.status})` : "Not published";

      const platforms = project?.publish_platforms as Record<string, boolean> | null;
      const enabledPlatforms = platforms
        ? Object.entries(platforms)
            .filter(([_, v]) => v)
            .map(([k]) => k)
            .join(", ")
        : "None";

      subject = `✅ ${projectName} — Run Completed & Posted`;

      htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a; background: #f9f9f9;">
  <div style="background: #ffffff; border-radius: 12px; padding: 32px; border: 1px solid #e5e5e5;">
    <div style="border-bottom: 2px solid #22c55e; padding-bottom: 16px; margin-bottom: 24px;">
      <h1 style="margin: 0; font-size: 22px; color: #1a1a1a;">✅ ${escapeHtml(projectName)}</h1>
      <p style="margin: 4px 0 0; font-size: 14px; color: #6b7280;">Run completed successfully</p>
    </div>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; color: #6b7280; width: 120px;">Video Title</td>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; font-weight: 600;">${escapeHtml(videoTitle)}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; color: #6b7280;">Description</td>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px;">${escapeHtml(description)}</td>
      </tr>
      ${
        hashtags.length > 0
          ? `
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; color: #6b7280;">Hashtags</td>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px;">${escapeHtml(hashtags.map((h) => `#${h}`).join(" "))}</td>
      </tr>`
          : ""
      }
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; color: #6b7280;">Platforms</td>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px;">${escapeHtml(enabledPlatforms)}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; color: #6b7280;">Publish Status</td>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px;">${escapeHtml(publishStatus)}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; font-size: 13px; color: #6b7280;">Run ID</td>
        <td style="padding: 10px 0; font-size: 12px; font-family: monospace; color: #9ca3af;">${escapeHtml(run_id)}</td>
      </tr>
    </table>

    ${
      videoLink
        ? `
    <div style="text-align: center; margin-top: 24px;">
      <a href="${videoLink}" style="display: inline-block; background: #2563eb; color: #ffffff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Watch Video</a>
    </div>`
        : ""
    }
  </div>

  <p style="text-align: center; font-size: 12px; color: #9ca3af; margin-top: 16px;">AI Creator Pipeline Notification</p>
</body>
</html>`;
    } else {
      // Error notification
      const errMsg = error_message || run.error_message || "Unknown error";

      // Get recent error logs
      const { data: errorLogs } = await supabase
        .from("run_logs")
        .select("*")
        .eq("run_id", run_id)
        .in("level", ["error", "warn"])
        .order("created_at", { ascending: false })
        .limit(10);

      const logEntries = (errorLogs || [])
        .map(
          (l) => `<tr>
          <td style="padding: 6px 8px; font-size: 12px; color: #6b7280; border-bottom: 1px solid #f0f0f0; white-space: nowrap;">${new Date(l.created_at).toLocaleTimeString()}</td>
          <td style="padding: 6px 8px; font-size: 12px; border-bottom: 1px solid #f0f0f0;">
            <span style="display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; ${l.level === "error" ? "background: #fef2f2; color: #dc2626;" : "background: #fffbeb; color: #d97706;"}">${l.level}</span>
          </td>
          <td style="padding: 6px 8px; font-size: 13px; border-bottom: 1px solid #f0f0f0;">${escapeHtml(l.message)}</td>
        </tr>`,
        )
        .join("");

      subject = `❌ ${projectName} — Run Failed`;

      htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a; background: #f9f9f9;">
  <div style="background: #ffffff; border-radius: 12px; padding: 32px; border: 1px solid #e5e5e5;">
    <div style="border-bottom: 2px solid #dc2626; padding-bottom: 16px; margin-bottom: 24px;">
      <h1 style="margin: 0; font-size: 22px; color: #1a1a1a;">❌ ${escapeHtml(projectName)}</h1>
      <p style="margin: 4px 0 0; font-size: 14px; color: #6b7280;">Run failed at step: <strong>${escapeHtml(run.current_step)}</strong></p>
    </div>

    <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="margin: 0; font-size: 14px; font-weight: 600; color: #dc2626;">Error</p>
      <p style="margin: 8px 0 0; font-size: 14px; color: #7f1d1d; word-break: break-word;">${escapeHtml(errMsg)}</p>
    </div>

    ${
      logEntries
        ? `
    <h2 style="font-size: 15px; margin: 0 0 12px; color: #374151;">Recent Logs</h2>
    <table style="width: 100%; border-collapse: collapse;">
      ${logEntries}
    </table>`
        : ""
    }

    <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
      <tr>
        <td style="padding: 8px 0; font-size: 13px; color: #6b7280; width: 100px;">Run ID</td>
        <td style="padding: 8px 0; font-size: 12px; font-family: monospace; color: #9ca3af;">${escapeHtml(run_id)}</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; font-size: 13px; color: #6b7280;">Failed Step</td>
        <td style="padding: 8px 0; font-size: 14px;">${escapeHtml(run.current_step)}</td>
      </tr>
    </table>
  </div>

  <p style="text-align: center; font-size: 12px; color: #9ca3af; margin-top: 16px;">AI Creator Pipeline Notification</p>
</body>
</html>`;
    }

    // Send email via Resend
    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "AI Creator <onboarding@resend.dev>",
        to: [NOTIFICATION_EMAIL],
        subject,
        html: htmlBody,
      }),
    });

    const resendResult = await resendResp.json();

    if (!resendResp.ok) {
      console.error("Resend error:", resendResult);
      return new Response(JSON.stringify({ error: "Email send failed", details: resendResult }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, email_id: resendResult.id }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Notification error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
