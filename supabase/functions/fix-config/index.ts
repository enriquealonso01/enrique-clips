import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fal } from "https://esm.sh/@fal-ai/client@1";

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

  try {
    const { user_feedback, current_json, documentation } = await req.json();

    if (!user_feedback || !current_json) {
      return json({ error: "user_feedback and current_json are required" }, 400);
    }

    const FAL_KEY = Deno.env.get("FAL_KEY");
    if (!FAL_KEY) {
      return json({ error: "FAL_KEY not configured" }, 500);
    }

    fal.config({ credentials: FAL_KEY });

    const userPrompt = `[JSON STRUCTURE / PIPELINE DOCUMENTATION]

${documentation || "No documentation provided."}

[USER FEEDBACK ABOUT WHAT WENT WRONG]

${user_feedback}

[CURRENT JSON]

${current_json}`;

    console.log(`fix-config: Calling Claude Opus 4.6 via fal.ai. Feedback: "${user_feedback.slice(0, 100)}..."`);

    const result = await fal.subscribe("openrouter/router", {
      input: {
        prompt: userPrompt,
        system_prompt: SYSTEM_PROMPT,
        model: "anthropic/claude-opus-4-6",
        max_tokens: 16000,
      },
    }) as any;

    const output = result?.data?.output || result?.output || "";

    if (!output) {
      return json({ error: "AI returned empty response" }, 500);
    }

    // Extract JSON from the response (strip markdown fences if present)
    let jsonStr = output.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    // Validate JSON
    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed !== "object" || parsed === null) {
        return json({ error: "AI returned non-object JSON" }, 422);
      }
      // Return the validated, re-serialized JSON
      return json({ fixed_json: JSON.stringify(parsed, null, 2) });
    } catch (parseErr) {
      return json({ error: `AI returned invalid JSON: ${(parseErr as Error).message}`, raw_output: jsonStr.slice(0, 500) }, 422);
    }
  } catch (err) {
    console.error("fix-config error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});
