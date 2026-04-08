import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { CLAUDE_OPUS_MODEL, runFalOpenRouterText } from "../_shared/falOpenrouter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const FIX_CONFIG_MAX_WAIT_MS = 15 * 60_000;

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

function extractFencedContent(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenceMatch?.[1]?.trim() || trimmed;
}

function extractBalancedObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseFixedConfig(output: string): Record<string, unknown> {
  const primary = extractFencedContent(output);
  const candidates = [primary];
  const extractedObject = extractBalancedObject(primary);

  if (extractedObject && extractedObject !== primary) {
    candidates.push(extractedObject);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Invalid JSON: model response was not a valid JSON object");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Server configuration is incomplete" }, 500);
  }

  const sb = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json();

    // --- PHASE 2: Background processing (called internally) ---
    if (body?._internal_process === true) {
      const { historyId, projectId, userFeedback, rerunAfterFix, documentation } = body;

      try {
        const { data: project } = await sb
          .from("projects")
          .select("prompt_config_json")
          .eq("id", projectId)
          .single();

        if (!project) throw new Error("Project not found");

        const currentJson = JSON.stringify(project.prompt_config_json ?? {}, null, 2);
        const userPrompt = `[JSON STRUCTURE / PIPELINE DOCUMENTATION]\n\n${documentation || "See PROMPT_CONFIG_REFERENCE.md for the full schema."}\n\n[USER FEEDBACK ABOUT WHAT WENT WRONG]\n\n${userFeedback}\n\n[CURRENT JSON]\n\n${currentJson}`;

        console.log(`fix-config[${historyId}]: Processing with ${CLAUDE_OPUS_MODEL}`);

        const aiResult = await runFalOpenRouterText({
          systemPrompt: SYSTEM_PROMPT,
          prompt: userPrompt,
          model: CLAUDE_OPUS_MODEL,
          temperature: 0.2,
          maxTokens: 16_000,
          maxWaitMs: FIX_CONFIG_MAX_WAIT_MS,
          pollIntervalMs: 5_000,
          onLog: (message) => console.log(`fix-config[${historyId}]: ${message}`),
        });

        console.log(`fix-config[${historyId}]: Received response (${aiResult.output.length} chars)`);

        const parsed = parseFixedConfig(aiResult.output);

        const { error: projectUpdateError } = await sb
          .from("projects")
          .update({ prompt_config_json: parsed })
          .eq("id", projectId);

        if (projectUpdateError) throw new Error(`Failed to save: ${projectUpdateError.message}`);

        let runId: string | null = null;
        if (rerunAfterFix) {
          const { data: newRun, error: runErr } = await sb
            .from("runs")
            .insert({ project_id: projectId, status: "queued" as const })
            .select("id")
            .single();

          if (runErr) throw new Error(`Config saved, but re-run failed: ${runErr.message}`);

          if (newRun?.id) {
            runId = newRun.id;
            const resp = await fetch(`${supabaseUrl}/functions/v1/run-pipeline`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
              body: JSON.stringify({ run_id: newRun.id, skip_publish: true }),
            });
            if (!resp.ok) {
              console.error(`fix-config[${historyId}]: Re-run trigger failed: ${resp.status}`);
            } else {
              console.log(`fix-config[${historyId}]: Pipeline triggered (run ${runId})`);
            }
          }
        }

        await sb.from("ai_fix_history").update({
          status: "completed", result_json: parsed, run_id: runId, error_message: null,
        }).eq("id", historyId);

        console.log(`fix-config[${historyId}]: Completed successfully`);
        return json({ ok: true });
      } catch (processingError) {
        const message = processingError instanceof Error ? processingError.message : String(processingError);
        console.error(`fix-config[${historyId}]: Error:`, message);
        await sb.from("ai_fix_history").update({
          status: "failed", error_message: message,
        }).eq("id", historyId);
        return json({ ok: false, error: message }, 500);
      }
    }

    // --- PHASE 1: Accept request, create history, dispatch background ---
    const projectId = typeof body?.project_id === "string" ? body.project_id.trim() : "";
    const userFeedback = typeof body?.user_feedback === "string" ? body.user_feedback.trim() : "";
    const rerunAfterFix = body?.rerun_after_fix === true;
    const documentation = typeof body?.documentation === "string" ? body.documentation : "";

    if (!projectId || !userFeedback) {
      return json({ error: "project_id and user_feedback are required" }, 400);
    }

    const { data: project, error: projErr } = await sb
      .from("projects")
      .select("prompt_config_json")
      .eq("id", projectId)
      .single();

    if (projErr || !project) {
      return json({ error: "Project not found" }, 404);
    }

    const { data: historyRow, error: historyErr } = await sb
      .from("ai_fix_history")
      .insert({
        project_id: projectId,
        feedback: userFeedback,
        status: "processing",
        rerun_triggered: rerunAfterFix,
      })
      .select("id")
      .single();

    if (historyErr || !historyRow?.id) {
      return json({ error: "Failed to create fix history entry" }, 500);
    }

    const historyId = historyRow.id;

    console.log(`fix-config: Starting ${CLAUDE_OPUS_MODEL} via fal.ai for project ${projectId}`);

    // Dispatch background processing via internal self-call (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/fix-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({
        _internal_process: true,
        historyId,
        projectId,
        userFeedback,
        rerunAfterFix,
        documentation,
      }),
    }).catch((e) => console.error("fix-config: Failed to dispatch background processing:", e));

    return json({ ok: true, history_id: historyId });
  } catch (err) {
    console.error("fix-config error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
