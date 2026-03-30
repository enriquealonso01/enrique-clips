// ═══════════════════════════════════════════════════════════
// Shared OpenAI Integration Module
// Direct OpenAI API calls — no gateway proxy
// ═══════════════════════════════════════════════════════════

import OpenAI from "npm:openai@4";

// ── Model Routing ────────────────────────────────────────

export const MODELS = {
  /** Default text model — balanced quality and cost */
  TEXT_DEFAULT: "gpt-5.4-mini",
  /** Cheap model for metadata, classification, tagging */
  TEXT_CHEAP: "gpt-5.4-nano",
  /** Premium reasoning — only when needed */
  TEXT_PREMIUM: "gpt-5.4",
  /** Draft image generation */
  IMAGE_DRAFT: "gpt-image-1-mini",
  /** Final image generation */
  IMAGE_FINAL: "gpt-image-1.5",
} as const;

export type TextModel = typeof MODELS.TEXT_DEFAULT | typeof MODELS.TEXT_CHEAP | typeof MODELS.TEXT_PREMIUM;
export type ImageModel = typeof MODELS.IMAGE_DRAFT | typeof MODELS.IMAGE_FINAL;

// ── Client Initialization ────────────────────────────────

let _client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (_client) return _client;
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  _client = new OpenAI({ apiKey, timeout: 120_000, maxRetries: 1 });
  return _client;
}

// ── Usage Logger ─────────────────────────────────────────

export interface UsageEntry {
  endpoint: string;
  model: string;
  success: boolean;
  latency_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  error?: string;
}

const _usageLog: UsageEntry[] = [];

export function logUsage(entry: UsageEntry) {
  _usageLog.push(entry);
  console.log(`[AI_USAGE] ${entry.endpoint} model=${entry.model} ok=${entry.success} ${entry.latency_ms}ms tokens=${entry.total_tokens || "?"}`);
}

export function getUsageLog(): UsageEntry[] {
  return [..._usageLog];
}

// ── JSON Repair ──────────────────────────────────────────

/** Clean markdown fences and parse JSON. Returns null on failure. */
function tryParseJSON(text: string): any | null {
  const cleaned = text
    .replace(/```json?\s*/g, "")
    .replace(/```/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON array or object
    const match = cleaned.match(/[\[{][\s\S]*[\]}]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

// ── Text Completion ──────────────────────────────────────

export interface CallTextOptions {
  messages: Array<{ role: "system" | "user" | "assistant"; content: any }>;
  model?: TextModel;
  tools?: OpenAI.ChatCompletionTool[];
  tool_choice?: OpenAI.ChatCompletionToolChoiceOption;
  temperature?: number;
  max_tokens?: number;
  /** If true, escalate to premium model on failure */
  premium?: boolean;
  /** Endpoint name for usage logging */
  endpoint?: string;
}

export interface CallTextResult {
  content: string | null;
  tool_calls: OpenAI.ChatCompletionMessageToolCall[] | undefined;
  usage: OpenAI.CompletionUsage | undefined;
  raw: OpenAI.ChatCompletion;
}

export async function callText(opts: CallTextOptions): Promise<CallTextResult> {
  const client = getOpenAIClient();
  const model = opts.model || MODELS.TEXT_DEFAULT;
  const endpoint = opts.endpoint || "text";
  const start = Date.now();

  try {
    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: opts.messages as any,
      stream: false,
    };
    if (opts.tools) params.tools = opts.tools;
    if (opts.tool_choice) params.tool_choice = opts.tool_choice;
    if (opts.temperature !== undefined) params.temperature = opts.temperature;
    if (opts.max_tokens) params.max_tokens = opts.max_tokens;

    const result = await client.chat.completions.create(params);
    const latency = Date.now() - start;

    logUsage({
      endpoint, model, success: true, latency_ms: latency,
      prompt_tokens: result.usage?.prompt_tokens,
      completion_tokens: result.usage?.completion_tokens,
      total_tokens: result.usage?.total_tokens,
    });

    return {
      content: result.choices[0]?.message?.content || null,
      tool_calls: result.choices[0]?.message?.tool_calls,
      usage: result.usage,
      raw: result,
    };
  } catch (err) {
    const latency = Date.now() - start;
    logUsage({
      endpoint, model, success: false, latency_ms: latency,
      error: err instanceof Error ? err.message : String(err),
    });

    // Escalate to premium if allowed and failed
    if (opts.premium && model !== MODELS.TEXT_PREMIUM) {
      console.log(`[AI] Escalating to premium model after failure: ${err}`);
      return callText({ ...opts, model: MODELS.TEXT_PREMIUM, premium: false });
    }
    throw err;
  }
}

// ── Structured Text (JSON output with retry) ─────────────

export interface CallStructuredOptions extends CallTextOptions {
  /** Parse the response as JSON. If parsing fails, retry with repair prompt. */
  parseJSON?: boolean;
}

export async function callStructured<T = any>(opts: CallStructuredOptions): Promise<T> {
  const result = await callText(opts);

  // If using tool calls, extract from tool call arguments
  if (result.tool_calls && result.tool_calls.length > 0) {
    const args = result.tool_calls[0].function.arguments;
    const parsed = tryParseJSON(args);
    if (parsed !== null) return parsed as T;
    throw new Error(`Failed to parse tool call JSON: ${args.substring(0, 200)}`);
  }

  // If parsing as JSON content
  if (opts.parseJSON && result.content) {
    const parsed = tryParseJSON(result.content);
    if (parsed !== null) return parsed as T;

    // Retry once with repair prompt
    console.log("[AI] JSON parse failed, retrying with repair prompt...");
    const repairResult = await callText({
      ...opts,
      messages: [
        ...opts.messages,
        { role: "assistant", content: result.content },
        {
          role: "user",
          content: "Your previous response was not valid JSON. Please return ONLY a valid JSON object/array with no markdown fences, no explanation — just the raw JSON.",
        },
      ],
      endpoint: `${opts.endpoint || "structured"}_repair`,
    });

    if (repairResult.content) {
      const repaired = tryParseJSON(repairResult.content);
      if (repaired !== null) return repaired as T;
    }
    throw new Error(`JSON repair also failed. Original: ${result.content?.substring(0, 200)}`);
  }

  return result.content as any;
}

// ── Image Generation ─────────────────────────────────────

export interface CallImageOptions {
  prompt: string;
  model?: ImageModel;
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  n?: number;
  /** Endpoint name for usage logging */
  endpoint?: string;
}

export interface CallImageResult {
  /** Base64-encoded image data */
  b64_json: string;
  /** Revised prompt (if applicable) */
  revised_prompt?: string;
}

export async function callImage(opts: CallImageOptions): Promise<CallImageResult> {
  const client = getOpenAIClient();
  const model = opts.model || MODELS.IMAGE_DRAFT;
  const endpoint = opts.endpoint || "image";
  const start = Date.now();

  try {
    const result = await client.images.generate({
      model,
      prompt: opts.prompt,
      size: opts.size || "auto",
      quality: opts.quality || (model === MODELS.IMAGE_FINAL ? "high" : "medium"),
      n: opts.n || 1,
    } as any);

    const latency = Date.now() - start;
    logUsage({ endpoint, model, success: true, latency_ms: latency });

    const img = result.data[0];
    return {
      b64_json: img.b64_json || "",
      revised_prompt: img.revised_prompt || undefined,
    };
  } catch (err) {
    const latency = Date.now() - start;
    logUsage({
      endpoint, model, success: false, latency_ms: latency,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ── Summarization helpers (for logging) ──────────────────

export function summarizeMessages(messages: Array<{ role: string; content: any }>): any[] {
  return messages.map(m => {
    const content = m.content;
    if (typeof content === "string") {
      return { role: m.role, content: content.length > 500 ? content.substring(0, 500) + "…[truncated]" : content };
    }
    if (Array.isArray(content)) {
      return {
        role: m.role,
        content: content.map((part: any) => {
          if (part.type === "text" && typeof part.text === "string") {
            return { type: "text", text: part.text.length > 500 ? part.text.substring(0, 500) + "…[truncated]" : part.text };
          }
          if (part.type === "image_url") return { type: "image_url", url: "[image]" };
          return part;
        }),
      };
    }
    return { role: m.role, content: "[complex]" };
  });
}

export function summarizeAIResponse(result: CallTextResult): any {
  const summary: any = {};
  if (result.tool_calls && result.tool_calls.length > 0) {
    summary.tool_calls = result.tool_calls.map(tc => ({
      name: tc.function.name,
      args_preview: tc.function.arguments.substring(0, 300) + (tc.function.arguments.length > 300 ? "…" : ""),
    }));
  }
  if (result.content) {
    summary.text = result.content.length > 500 ? result.content.substring(0, 500) + "…[truncated]" : result.content;
  }
  summary.finish_reason = result.raw.choices[0]?.finish_reason;
  summary.usage = result.usage;
  return summary;
}

// ── Pipeline-compatible wrapper ──────────────────────────
// Drop-in replacement for the old callAI function

export async function callAI(
  messages: Array<{ role: string; content: any }>,
  tools?: any[],
  tool_choice?: any,
  model?: string,
  modalities?: string[],
  timeoutMs = 120000,
  retries = 1
): Promise<any> {
  // Map old model names to new OpenAI models
  const modelMap: Record<string, string> = {
    "google/gemini-2.5-pro": MODELS.TEXT_DEFAULT,
    "google/gemini-2.5-flash": MODELS.TEXT_CHEAP,
    "openai/gpt-5-mini": MODELS.TEXT_DEFAULT,
    "openai/gpt-5": MODELS.TEXT_PREMIUM,
    "google/gemini-3-pro-image-preview": MODELS.IMAGE_DRAFT,
  };
  const mappedModel = model ? (modelMap[model] || model) : MODELS.TEXT_DEFAULT;

  // Image generation path
  if (modalities?.includes("image")) {
    const textContent = Array.isArray(messages[0]?.content)
      ? messages[0].content.find((p: any) => p.type === "text")?.text || ""
      : String(messages[0]?.content || "");

    const imageModel = mappedModel.startsWith("gpt-image") ? mappedModel as ImageModel : MODELS.IMAGE_DRAFT;

    const imgResult = await callImage({
      prompt: textContent,
      model: imageModel,
      size: "auto",
      quality: imageModel === MODELS.IMAGE_FINAL ? "high" : "medium",
      endpoint: "pipeline_image",
    });

    // Return in the old format for backward compat
    return {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          images: [{
            type: "image_url",
            image_url: { url: `data:image/png;base64,${imgResult.b64_json}` },
          }],
        },
        finish_reason: "stop",
      }],
    };
  }

  // Text completion path
  const textResult = await callText({
    messages: messages as any,
    model: mappedModel as TextModel,
    tools: tools as any,
    tool_choice: tool_choice as any,
    endpoint: "pipeline_text",
  });

  // Return in the old format for backward compat
  const response: any = {
    choices: [{
      message: {
        role: "assistant",
        content: textResult.content,
        tool_calls: textResult.tool_calls,
      },
      finish_reason: textResult.raw.choices[0]?.finish_reason,
    }],
    usage: textResult.usage,
  };

  return response;
}
