// Upload-Post Analytics proxy edge function
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const UPLOADPOST_BASE = "https://api.upload-post.com";
const API_KEY = Deno.env.get("UPLOADPOST_API_KEY") ?? "";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function callUploadPost(path: string): Promise<{ status: number; body: any }> {
  const url = `${UPLOADPOST_BASE}${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Apikey ${API_KEY}` },
  });
  const text = await resp.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: resp.status, body };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (!API_KEY) return json({ error: "UPLOADPOST_API_KEY not configured" }, 500);

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (action === "metrics-config") {
      const r = await callUploadPost(`/api/uploadposts/platform-metrics`);
      return json(r.body, r.status);
    }

    if (action === "profile") {
      const username = url.searchParams.get("username");
      const platforms = url.searchParams.get("platforms") ||
        "instagram,tiktok,youtube,facebook,linkedin,x,threads,pinterest,reddit,bluesky";
      if (!username) return json({ error: "username required" }, 400);
      const extra: string[] = [];
      const pageId = url.searchParams.get("page_id");
      if (pageId) extra.push(`page_id=${encodeURIComponent(pageId)}`);
      const qs = `platforms=${encodeURIComponent(platforms)}${extra.length ? "&" + extra.join("&") : ""}`;
      const r = await callUploadPost(`/api/analytics/${encodeURIComponent(username)}?${qs}`);
      // If upstream returns an error, wrap it as a 200 with an `_error` field so the UI can render a friendly message
      // instead of the supabase functions client throwing on non-2xx.
      if (r.status >= 400) {
        return json({ _error: r.body?.message || r.body?.error || `Upload-Post error (${r.status})`, _status: r.status }, 200);
      }
      return json(r.body, r.status);
    }

    if (action === "totals") {
      const username = url.searchParams.get("username");
      if (!username) return json({ error: "username required" }, 400);
      const params: string[] = [];
      const period = url.searchParams.get("period");
      const startDate = url.searchParams.get("start_date");
      const endDate = url.searchParams.get("end_date");
      const platform = url.searchParams.get("platform");
      const breakdown = url.searchParams.get("breakdown");
      const metrics = url.searchParams.get("metrics");
      if (period) params.push(`period=${encodeURIComponent(period)}`);
      if (startDate) params.push(`start_date=${encodeURIComponent(startDate)}`);
      if (endDate) params.push(`end_date=${encodeURIComponent(endDate)}`);
      if (platform) params.push(`platform=${encodeURIComponent(platform)}`);
      if (breakdown) params.push(`breakdown=${encodeURIComponent(breakdown)}`);
      if (metrics) params.push(`metrics=${encodeURIComponent(metrics)}`);
      const qs = params.length ? `?${params.join("&")}` : "";
      const r = await callUploadPost(`/api/uploadposts/total-impressions/${encodeURIComponent(username)}${qs}`);
      return json(r.body, r.status);
    }

    return json({ error: "Unknown action. Use action=profile|totals|metrics-config" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
