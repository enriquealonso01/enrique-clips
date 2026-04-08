import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM_PROMPT = `You are an expert JSON configuration editor for a video-generation pipeline.

Your job is to REPAIR and IMPROVE an existing JSON config based on:

1. the pipeline JSON structure/documentation,
2. the user's feedback about what went wrong in the generated video,
3. the current JSON that produced the flawed output.

Your goal is to make the SMALLEST POSSIBLE set of changes needed to fix the issue while preserving everything that is already working.

You must think like a surgical editor, not a rewriter.

==================================================
PRIMARY OBJECTIVE
==================================================

Revise the current JSON so that it addresses the reported video defect or undesired behavior, while:
- preserving the existing JSON structure,
- preserving all valid keys, nesting, and schema rules,
- preserving style, tone, and intent of the existing project,
- minimizing edits,
- avoiding unnecessary rewrites,
- avoiding broad speculative changes unless they are clearly required to fix the reported problem.

If the issue can be solved by changing only a few fields, then only change those few fields.

==================================================
EDITING RULES
==================================================

1. MINIMIZE CHANGES
- Make the fewest changes necessary.
- Do not rewrite large sections unless absolutely necessary.
- Do not rename keys.
- Do not reorder structure unless required.
- Do not remove working logic unless it conflicts with the requested fix.

2. FIX THE SPECIFIC PROBLEM
- Focus first on the exact defect described in the user feedback.
- Infer the most likely JSON-level causes of the issue.
- Strengthen prompts, rules, constraints, sequencing, or wording only where helpful.
- If multiple small edits are needed, prefer targeted edits over sweeping rewrites.

3. PRESERVE WORKING BEHAVIOR
- Assume the existing JSON mostly works.
- Do not "improve" unrelated parts just because you think they could be better.
- Do not make stylistic changes unless they directly support fixing the reported issue.

4. FOLLOW THE DOCUMENTATION EXACTLY
- The output JSON must remain fully compatible with the documented structure.
- Do not invent unsupported keys or schema fields.
- Do not omit required fields.
- Respect all documented rules and conventions.

5. BE PRECISE
- If the defect involves motion, continuity, framing, worker behavior, object behavior, reveal logic, sequencing, realism, audio, overlays, pacing, or camera behavior, strengthen the relevant instructions precisely.
- Prefer concrete constraints over vague wording.

6. OUTPUT VALID JSON ONLY
- Return only the final corrected JSON.
- Do not wrap it in markdown.
- Do not include explanations, commentary, notes, bullets, or prose outside the JSON.
- Do not include placeholder text in the output.
- The output must be directly usable by the application.

==================================================
REASONING GUIDELINES
==================================================

Before editing, internally determine:
- what the user is complaining about,
- which parts of the JSON most likely caused it,
- what is the smallest safe fix,
- whether the issue should be solved by tightening wording, adding constraints, clarifying sequencing, restricting behavior, or adjusting existing instructions.

When uncertain:
- prefer minimal constraint additions rather than broad rewrites,
- prefer preserving current intent,
- prefer explicit prevention of the undesired behavior.

==================================================
FINAL INSTRUCTION
==================================================

Produce the corrected JSON now.
Return ONLY the final valid JSON.`;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  try {
    const { project_id, user_feedback, rerun_after_fix, documentation } = await req.json();

    if (!project_id || !user_feedback) {
      return json({ error: "project_id and user_feedback are required" }, 400);
    }

    // 1. Fetch project's current config
    const { data: project, error: projErr } = await sb
      .from("projects")
      .select("prompt_config_json")
      .eq("id", project_id)
      .single();

    if (projErr || !project) {
      return json({ error: "Project not found" }, 404);
    }

    const currentJson = JSON.stringify(project.prompt_config_json, null, 2);

    // 2. Create history record as "processing"
    const { data: historyRow } = await sb
      .from("ai_fix_history")
      .insert({
        project_id,
        feedback: user_feedback,
        status: "processing",
        rerun_triggered: rerun_after_fix || false,
      })
      .select("id")
      .single();

    const historyId = historyRow?.id;

    // 3. Return immediately so user can leave
    // Do the actual AI work in the background
    const responsePromise = (async () => {
      try {
        const GOOGLE_AI_API_KEY = Deno.env.get("GOOGLE_AI_API_KEY");
        if (!GOOGLE_AI_API_KEY) {
          await sb.from("ai_fix_history").update({ status: "failed", error_message: "GOOGLE_AI_API_KEY not configured" }).eq("id", historyId);
          return;
        }

        const userPrompt = `[JSON STRUCTURE / PIPELINE DOCUMENTATION]

${documentation || "See PROMPT_CONFIG_REFERENCE.md for the full schema."}

[USER FEEDBACK ABOUT WHAT WENT WRONG]

${user_feedback}

[CURRENT JSON]

${currentJson}`;

        // Retry logic with fallback model
        const models = ["gemini-2.5-pro", "gemini-2.5-pro", "gemini-2.5-flash"];
        let resp: Response | null = null;
        let lastError = "";

        for (let attempt = 0; attempt < models.length; attempt++) {
          const model = models[attempt];
          console.log(`fix-config: Attempt ${attempt + 1}/${models.length} using ${model} for project ${project_id}. Feedback: "${user_feedback.slice(0, 100)}..."`);

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 120_000);

          try {
            const r = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_AI_API_KEY}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
                  contents: [{ role: "user", parts: [{ text: userPrompt }] }],
                  generationConfig: { maxOutputTokens: 16000 },
                }),
                signal: controller.signal,
              }
            );
            clearTimeout(timeout);

            if (r.ok) {
              resp = r;
              break;
            }

            const errText = await r.text();
            lastError = `AI API error: ${r.status}`;
            console.error(`fix-config: Attempt ${attempt + 1} failed (${r.status}): ${errText}`);

            if (r.status === 503 && attempt < models.length - 1) {
              const wait = (attempt + 1) * 15;
              console.log(`fix-config: Waiting ${wait}s before retry...`);
              await new Promise(resolve => setTimeout(resolve, wait * 1000));
              continue;
            }
          } catch (fetchErr) {
            clearTimeout(timeout);
            lastError = (fetchErr as Error).message;
            console.error(`fix-config: Attempt ${attempt + 1} fetch error: ${lastError}`);
            if (attempt < models.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 10_000));
              continue;
            }
          }
        }

        if (!resp) {
          await sb.from("ai_fix_history").update({ status: "failed", error_message: lastError }).eq("id", historyId);
          return;
        }

        const result = await resp.json();
        const output = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

        if (!output) {
          await sb.from("ai_fix_history").update({ status: "failed", error_message: "AI returned empty response" }).eq("id", historyId);
          return;
        }

        console.log(`fix-config: Got AI response (${output.length} chars)`);

        // Extract JSON
        let jsonStr = output.trim();
        const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (fenceMatch) {
          jsonStr = fenceMatch[1].trim();
        }

        // Validate JSON
        let parsed: any;
        try {
          parsed = JSON.parse(jsonStr);
          if (typeof parsed !== "object" || parsed === null) {
            await sb.from("ai_fix_history").update({ status: "failed", error_message: "AI returned non-object JSON" }).eq("id", historyId);
            return;
          }
        } catch (parseErr) {
          await sb.from("ai_fix_history").update({
            status: "failed",
            error_message: `Invalid JSON: ${(parseErr as Error).message}`,
          }).eq("id", historyId);
          return;
        }

        console.log("fix-config: JSON validated, saving to project...");

        // 4. Save the fixed config to the project
        await sb.from("projects").update({ prompt_config_json: parsed }).eq("id", project_id);

        // 5. Optionally trigger re-run without publish
        let runId: string | null = null;
        if (rerun_after_fix) {
          const { data: newRun } = await sb
            .from("runs")
            .insert({ project_id, status: "queued" as const })
            .select("id")
            .single();

          if (newRun) {
            runId = newRun.id;
            // Trigger pipeline without publish
            const pipelineUrl = `${supabaseUrl}/functions/v1/run-pipeline`;
            await fetch(pipelineUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${serviceKey}`,
              },
              body: JSON.stringify({ run_id: newRun.id, skip_publish: true }),
            });
            console.log(`fix-config: Pipeline triggered (run ${runId}) — no publish`);
          }
        }

        // 6. Mark history as completed
        await sb.from("ai_fix_history").update({
          status: "completed",
          result_json: parsed,
          run_id: runId,
        }).eq("id", historyId);

        console.log("fix-config: Done!");
      } catch (err) {
        console.error("fix-config background error:", err);
        await sb.from("ai_fix_history").update({
          status: "failed",
          error_message: (err as Error).message,
        }).eq("id", historyId);
      }
    })();

    // Use waitUntil to keep the function alive after responding
    // Deno Deploy supports this pattern — the promise runs in the background
    // But Edge Functions may not support waitUntil, so we await instead
    // However, we want to return quickly. Edge functions have 150s timeout.
    // The AI call takes ~30-60s, so we can await it within the timeout.
    await responsePromise;

    return json({ ok: true, history_id: historyId });
  } catch (err) {
    console.error("fix-config error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});
