import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fal } from "https://esm.sh/@fal-ai/client@1";
import { PROMPT_CONFIG_DOCUMENTATION } from "../_shared/promptConfigDoc.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const FAL_OPENROUTER_ENDPOINT = "openrouter/router";
const CLAUDE_OPUS_MODEL = "anthropic/claude-opus-4.6";
const POLL_INTERVAL_MS = 5_000;
const MAX_EDGE_RUNTIME_MS = 120_000;
const MAX_POLL_CHAINS = 60;

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

7. PRESERVE ALL TOP-LEVEL SECTIONS
- The output JSON MUST contain every top-level key that exists in the input JSON.
- Do not omit or drop any section (global, planning, keyframes, motion, overlays, metadata, audio, voiceover, pipeline, memory, version) even if you are not changing it.
- If a section is not relevant to the fix, copy it through unchanged.
- Dropping a top-level section is a critical error that will break the pipeline.

==================================================
PIPELINE ARCHITECTURE: K0 STARTING-STATE KEYFRAME
==================================================

The pipeline generates a K0 (starting-state) keyframe as the FIRST image in the keyframes step, BEFORE any scene keyframes (K1, K2, ...).
K0 is generated using the Keyframe Prompt Compiler with \`planning.start_state_rules\` injected directly into the prompt.
K0 anchors the entire visual chain: K0 → K1 → K2 → ... → Kn. Each keyframe receives the previous one as a visual reference.

CRITICAL: \`start_state_rules\` must accurately describe the starting state for the series concept:
- Construction/build series: describe the empty, undeveloped site
- Rescue/restoration series: describe the neglected, damaged, or abandoned state
- Story series: describe the opening scene environment
- Do NOT use generic "untouched/no structures" language — it must match the project's concept

If the user reports visual jumps between the opening and subsequent scenes, the most likely fix is adjusting \`start_state_rules\` to better match the series concept.

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
Return ONLY the final valid JSON.
The output MUST contain every top-level key from the input JSON — do not drop any sections.`;

function jsonResponse(data: unknown, status = 200) {
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
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function parseFixedConfig(output: string): Record<string, unknown> {
  const primary = extractFencedContent(output);
  const candidates = [primary];
  const extractedObject = extractBalancedObject(primary);
  if (extractedObject && extractedObject !== primary) candidates.push(extractedObject);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { continue; }
  }
  throw new Error("Invalid JSON: model response was not a valid JSON object");
}

/**
 * Validate that the fixed JSON preserves all top-level keys from the original.
 * If keys are missing, merge them back from the original to prevent data loss.
 */
function validateAndMergeKeys(
  fixed: Record<string, unknown>,
  original: Record<string, unknown>
): { merged: Record<string, unknown>; restoredKeys: string[] } {
  const restoredKeys: string[] = [];
  const merged = { ...fixed };

  for (const key of Object.keys(original)) {
    if (!(key in merged)) {
      merged[key] = original[key];
      restoredKeys.push(key);
    }
  }

  return { merged, restoredKeys };
}

function getFalKey(): string {
  const key = Deno.env.get("FAL_KEY");
  if (!key) throw new Error("FAL_KEY is not configured");
  return key;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Server configuration incomplete" }, 500);

  const sb = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json();

    // --- PHASE 3: Poll for fal.ai result (self-chaining) ---
    if (body?._internal_poll === true) {
      const { historyId, projectId, falRequestId, rerunAfterFix, chainCount, originalTopLevelKeys } = body;
      const count = chainCount || 0;

      if (count > MAX_POLL_CHAINS) {
        await sb.from("ai_fix_history").update({
          status: "failed", error_message: "Timed out after too many poll chains",
        }).eq("id", historyId);
        return jsonResponse({ ok: false, error: "timeout" });
      }

      try {
        fal.config({ credentials: getFalKey() });
        const startedAt = Date.now();

        while (Date.now() - startedAt < MAX_EDGE_RUNTIME_MS) {
          const status: any = await fal.queue.status(FAL_OPENROUTER_ENDPOINT, {
            requestId: falRequestId,
            logs: true,
          });

          if (status?.status === "COMPLETED") {
            const result: any = await fal.queue.result(FAL_OPENROUTER_ENDPOINT, { requestId: falRequestId });
            const data = result?.data ?? {};
            const output = typeof data.output === "string" ? data.output.trim() : "";
            if (!output) {
              const providerError = typeof data.error === "string" ? data.error : "";
              throw new Error(providerError || "fal.ai returned an empty response");
            }

            console.log(`fix-config[${historyId}]: Received response (${output.length} chars)`);
            let parsed = parseFixedConfig(output);

            // Validate and restore any missing top-level keys
            if (Array.isArray(originalTopLevelKeys) && originalTopLevelKeys.length > 0) {
              const { data: currentProject } = await sb.from("projects")
                .select("prompt_config_json").eq("id", projectId).single();
              if (currentProject?.prompt_config_json) {
                const original = currentProject.prompt_config_json as Record<string, unknown>;
                const { merged, restoredKeys } = validateAndMergeKeys(parsed, original);
                if (restoredKeys.length > 0) {
                  console.log(`fix-config[${historyId}]: Restored dropped keys: ${restoredKeys.join(", ")}`);
                }
                parsed = merged;
              }
            }

            const { error: updateErr } = await sb.from("projects")
              .update({ prompt_config_json: parsed }).eq("id", projectId);
            if (updateErr) throw new Error(`Failed to save: ${updateErr.message}`);

            let runId: string | null = null;
            if (rerunAfterFix) {
              const { data: newRun, error: runErr } = await sb.from("runs")
                .insert({ project_id: projectId, status: "queued" as const })
                .select("id").single();
              if (runErr) throw new Error(`Config saved, but re-run failed: ${runErr.message}`);
              if (newRun?.id) {
                runId = newRun.id;
                fetch(`${supabaseUrl}/functions/v1/run-pipeline`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
                  body: JSON.stringify({ run_id: newRun.id, skip_publish: true }),
                }).catch((e) => console.error(`fix-config: Re-run trigger failed:`, e));
                console.log(`fix-config[${historyId}]: Pipeline triggered (run ${runId})`);
              }
            }

            await sb.from("ai_fix_history").update({
              status: "completed", result_json: parsed, run_id: runId, error_message: null,
            }).eq("id", historyId);

            console.log(`fix-config[${historyId}]: Completed successfully`);
            return jsonResponse({ ok: true });
          }

          if (status?.status === "FAILED") {
            const logs = Array.isArray(status?.logs) ? status.logs : [];
            const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
            const lastLogMsg = typeof lastLog?.message === "string" ? lastLog.message : "";
            const statusError = typeof status?.error === "string" ? status.error : "";
            throw new Error(statusError || lastLogMsg || "fal.ai request failed");
          }

          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }

        // Edge function about to timeout — self-chain to continue polling
        console.log(`fix-config[${historyId}]: Self-chaining poll (chain ${count + 1})`);
        fetch(`${supabaseUrl}/functions/v1/fix-config`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
          body: JSON.stringify({
            _internal_poll: true,
            historyId, projectId, falRequestId, rerunAfterFix,
            originalTopLevelKeys,
            chainCount: count + 1,
          }),
        }).catch((e) => console.error("fix-config: Self-chain failed:", e));

        return jsonResponse({ ok: true, chained: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`fix-config[${historyId}]: Poll error:`, message);
        await sb.from("ai_fix_history").update({
          status: "failed", error_message: message,
        }).eq("id", historyId);
        return jsonResponse({ ok: false, error: message }, 500);
      }
    }

    // --- PHASE 2: Submit to fal.ai (called internally) ---
    if (body?._internal_submit === true) {
      const { historyId, projectId, userFeedback, rerunAfterFix } = body;

      try {
        const { data: project } = await sb.from("projects")
          .select("prompt_config_json").eq("id", projectId).single();
        if (!project) throw new Error("Project not found");

        const currentJson = JSON.stringify(project.prompt_config_json ?? {}, null, 2);
        const originalTopLevelKeys = Object.keys(project.prompt_config_json ?? {});

        // Use the embedded full documentation instead of the placeholder
        const userPrompt = `[JSON STRUCTURE / PIPELINE DOCUMENTATION]\n\n${PROMPT_CONFIG_DOCUMENTATION}\n\n[USER FEEDBACK ABOUT WHAT WENT WRONG]\n\n${userFeedback}\n\n[CURRENT JSON]\n\n${currentJson}`;

        fal.config({ credentials: getFalKey() });

        console.log(`fix-config[${historyId}]: Submitting to ${CLAUDE_OPUS_MODEL} (doc: ${PROMPT_CONFIG_DOCUMENTATION.length} chars, json: ${currentJson.length} chars)`);
        const submitResponse: any = await fal.queue.submit(FAL_OPENROUTER_ENDPOINT, {
          input: {
            prompt: userPrompt,
            system_prompt: SYSTEM_PROMPT,
            model: CLAUDE_OPUS_MODEL,
            temperature: 0.2,
            max_tokens: 128_000,
          },
        });

        const falRequestId = submitResponse?.request_id;
        if (!falRequestId || typeof falRequestId !== "string") {
          throw new Error("fal.ai did not return a request_id");
        }

        console.log(`fix-config[${historyId}]: Queued as ${falRequestId}, starting poll chain`);

        // Dispatch polling phase — pass originalTopLevelKeys for validation
        fetch(`${supabaseUrl}/functions/v1/fix-config`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
          body: JSON.stringify({
            _internal_poll: true,
            historyId, projectId, falRequestId, rerunAfterFix,
            originalTopLevelKeys,
            chainCount: 0,
          }),
        }).catch((e) => console.error("fix-config: Poll dispatch failed:", e));

        return jsonResponse({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`fix-config[${historyId}]: Submit error:`, message);
        await sb.from("ai_fix_history").update({
          status: "failed", error_message: message,
        }).eq("id", historyId);
        return jsonResponse({ ok: false, error: message }, 500);
      }
    }

    // --- PHASE 1: Accept request from client ---
    const projectId = typeof body?.project_id === "string" ? body.project_id.trim() : "";
    const userFeedback = typeof body?.user_feedback === "string" ? body.user_feedback.trim() : "";
    const rerunAfterFix = body?.rerun_after_fix === true;

    if (!projectId || !userFeedback) {
      return jsonResponse({ error: "project_id and user_feedback are required" }, 400);
    }

    const { data: project, error: projErr } = await sb.from("projects")
      .select("prompt_config_json").eq("id", projectId).single();
    if (projErr || !project) return jsonResponse({ error: "Project not found" }, 404);

    const { data: historyRow, error: historyErr } = await sb.from("ai_fix_history")
      .insert({ project_id: projectId, feedback: userFeedback, status: "processing", rerun_triggered: rerunAfterFix })
      .select("id").single();
    if (historyErr || !historyRow?.id) return jsonResponse({ error: "Failed to create fix history entry" }, 500);

    const historyId = historyRow.id;
    console.log(`fix-config: Accepted for project ${projectId}, dispatching submit`);

    // Fire-and-forget submit phase
    fetch(`${supabaseUrl}/functions/v1/fix-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({
        _internal_submit: true,
        historyId, projectId, userFeedback, rerunAfterFix,
      }),
    }).catch((e) => console.error("fix-config: Submit dispatch failed:", e));

    return jsonResponse({ ok: true, history_id: historyId });
  } catch (err) {
    console.error("fix-config error:", err);
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
