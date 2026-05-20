import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  return new Response(
    JSON.stringify({ message: "migrate-helper is ready" }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
  );
});
