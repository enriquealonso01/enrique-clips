// ═══════════════════════════════════════════════════════════
// Shared AI Integration Module
// Routes text to OpenAI (gpt-5.3) or Gemini (flash), images to Gemini
// ═══════════════════════════════════════════════════════════

// ── Model Routing ────────────────────────────────────────

export const MODELS = {
  /** Default text model — OpenAI gpt-5.3 */
  TEXT_DEFAULT: "gpt-5.3-chat-latest",
  /** Cheap model for metadata, classification, tagging */
  TEXT_CHEAP: "gemini-2.5-flash",
  /** Premium reasoning — same as default */
  TEXT_PREMIUM: "gpt-5.3-chat-latest",
  /** Draft image generation */
  IMAGE_DRAFT: "gemini-3-pro-image-preview",
  /** Final image generation */
  IMAGE_FINAL: "gemini-3-pro-image-preview",
} as const;

export type TextModel = string;
export type ImageModel = typeof MODELS.IMAGE_DRAFT | typeof MODELS.IMAGE_FINAL;

const OPENAI_BASE = "https://api.openai.com/v1/chat/completions";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_TIMEOUT_MS = 180_000;
const IMAGE_TIMEOUT_MS = 120_000;
const IMAGE_RETRY_DELAY_MS = 30_000;
const IMAGE_MAX_TOTAL_WAIT_MS = 30 * 60 * 1000;

/** Returns true if the model should be routed through OpenAI API */
function isOpenAIModel(model: string): boolean {
  return model.startsWith("gpt-") || model.startsWith("openai/");
}

class GeminiApiError extends Error {
  status: number;
  bodyPreview: string;
  constructor(status: number, bodyPreview: string) {
    super(`Gemini API error ${status}: ${bodyPreview}`);
    this.name = "GeminiApiError";
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

class OpenAIApiError extends Error {
  status: number;
  bodyPreview: string;
  constructor(status: number, bodyPreview: string) {
    super(`OpenAI API error ${status}: ${bodyPreview}`);
    this.name = "OpenAIApiError";
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

export class Image503RetryableError extends Error {
  attempts: number;
  reason: string;
  constructor(attempts: number, reason = "503") {
    super(`Image generation failed (${reason}) after ${attempts} attempt(s). Pipeline should re-chain to retry.`);
    this.name = "Image503RetryableError";
    this.attempts = attempts;
    this.reason = reason;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getGeminiApiKey(): string {
  const key = Deno.env.get("GOOGLE_AI_API_KEY");
  if (!key) throw new Error("GOOGLE_AI_API_KEY is not configured");
  return key;
}

function getOpenAIApiKey(): string {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  return key;
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

function tryParseJSON(text: string): any | null {
  const cleaned = text
    .replace(/```json?\s*/g, "")
    .replace(/```/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/[\[{][\s\S]*[\]}]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

// ── OpenAI API Call ──────────────────────────────────────

async function openaiRequest(model: string, body: any, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  const apiKey = getOpenAIApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(OPENAI_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, ...body }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new OpenAIApiError(resp.status, errText.substring(0, 500));
    }

    return resp.json();
  } catch (err) {
    if ((err as any)?.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── OpenAI-to-Gemini Message Conversion (for Gemini models) ──

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: any;
}

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string }; functionCall?: any; functionResponse?: any }>;
}

function convertMessages(messages: OpenAIMessage[]): { systemInstruction?: { parts: Array<{ text: string }> }; contents: GeminiContent[] } {
  let systemInstruction: { parts: Array<{ text: string }> } | undefined;
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content :
        Array.isArray(msg.content) ? msg.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : String(msg.content);
      if (systemInstruction) {
        systemInstruction.parts[0].text += "\n\n" + text;
      } else {
        systemInstruction = { parts: [{ text }] };
      }
      continue;
    }

    const role = msg.role === "assistant" ? "model" : "user";
    const parts: GeminiContent["parts"] = [];

    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") {
          parts.push({ text: part.text });
        } else if (part.type === "image_url" && part.image_url?.url) {
          const base64Match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/s);
          if (base64Match) {
            parts.push({ inlineData: { mimeType: base64Match[1], data: base64Match[2] } });
          }
        }
      }
    } else {
      parts.push({ text: String(msg.content) });
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  return { systemInstruction, contents };
}

// ── OpenAI-to-Gemini Tool Conversion ─────────────────────

function stripAdditionalProperties(obj: any): any {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripAdditionalProperties);

  const cleaned: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "additionalProperties") continue;
    cleaned[key] = stripAdditionalProperties(value);
  }
  return cleaned;
}

function convertTools(tools: any[]): any[] {
  if (!tools || tools.length === 0) return [];

  const functionDeclarations = tools
    .filter((t: any) => t.type === "function")
    .map((t: any) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: stripAdditionalProperties(t.function.parameters),
    }));

  return [{ functionDeclarations }];
}

function convertToolChoice(toolChoice: any): any {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === "string") {
    if (toolChoice === "auto") return { functionCallingConfig: { mode: "AUTO" } };
    if (toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
    if (toolChoice === "required") return { functionCallingConfig: { mode: "ANY" } };
  }

  if (toolChoice?.type === "function" && toolChoice?.function?.name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolChoice.function.name],
      },
    };
  }

  return undefined;
}

// ── Gemini API Call ──────────────────────────────────────

async function geminiRequest(model: string, body: any, timeoutMs = DEFAULT_TIMEOUT_MS, extraHeaders?: Record<string, string>): Promise<any> {
  const apiKey = getGeminiApiKey();
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new GeminiApiError(resp.status, errText.substring(0, 500));
    }

    return resp.json();
  } catch (err) {
    if ((err as any)?.name === "AbortError") {
      throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Text Completion ──────────────────────────────────────

export interface CallTextOptions {
  messages: Array<{ role: "system" | "user" | "assistant"; content: any }>;
  model?: TextModel;
  tools?: any[];
  tool_choice?: any;
  temperature?: number;
  max_tokens?: number;
  premium?: boolean;
  endpoint?: string;
}

export interface CallTextResult {
  content: string | null;
  tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> | undefined;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  raw: any;
}

/** Call OpenAI directly — messages are already in OpenAI format */
async function callTextOpenAI(opts: CallTextOptions, model: string): Promise<CallTextResult> {
  const body: any = {
    messages: opts.messages,
  };

  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    if (opts.tool_choice) body.tool_choice = opts.tool_choice;
  }
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.max_tokens) body.max_tokens = opts.max_tokens;

  const result = await openaiRequest(model, body);

  const choice = result.choices?.[0];
  const message = choice?.message;

  return {
    content: message?.content || null,
    tool_calls: message?.tool_calls,
    usage: result.usage ? {
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      total_tokens: result.usage.total_tokens,
    } : undefined,
    raw: result,
  };
}

/** Call Gemini — convert OpenAI format to Gemini format */
async function callTextGemini(opts: CallTextOptions, model: string): Promise<CallTextResult> {
  const { systemInstruction, contents } = convertMessages(opts.messages);

  const body: any = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  if (opts.tools && opts.tools.length > 0) {
    body.tools = convertTools(opts.tools);
    const toolConfig = convertToolChoice(opts.tool_choice);
    if (toolConfig) body.toolConfig = toolConfig;
  }

  if (opts.temperature !== undefined || opts.max_tokens) {
    body.generationConfig = {};
    if (opts.temperature !== undefined) body.generationConfig.temperature = opts.temperature;
    if (opts.max_tokens) body.generationConfig.maxOutputTokens = opts.max_tokens;
  }

  const result = await geminiRequest(model, body);

  const candidate = result.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text);
  const content = textParts.length > 0 ? textParts.join("") : null;

  const functionCalls = parts.filter((p: any) => p.functionCall);
  const tool_calls = functionCalls.length > 0
    ? functionCalls.map((p: any, i: number) => ({
        id: `call_${i}`,
        type: "function" as const,
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args),
        },
      }))
    : undefined;

  const usage = result.usageMetadata ? {
    prompt_tokens: result.usageMetadata.promptTokenCount,
    completion_tokens: result.usageMetadata.candidatesTokenCount,
    total_tokens: (result.usageMetadata.promptTokenCount || 0) + (result.usageMetadata.candidatesTokenCount || 0),
  } : undefined;

  return { content, tool_calls, usage, raw: result };
}

export async function callText(opts: CallTextOptions): Promise<CallTextResult> {
  const model = opts.model || MODELS.TEXT_DEFAULT;
  const endpoint = opts.endpoint || "text";
  const start = Date.now();

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      let result: CallTextResult;

      if (isOpenAIModel(model)) {
        result = await callTextOpenAI(opts, model);
      } else {
        result = await callTextGemini(opts, model);
      }

      const latency = Date.now() - start;

      if (attempt > 1) {
        console.log(`[AI] Text generation succeeded on attempt ${attempt} after retries`);
      }

      logUsage({
        endpoint, model, success: true, latency_ms: latency,
        prompt_tokens: result.usage?.prompt_tokens,
        completion_tokens: result.usage?.completion_tokens,
        total_tokens: result.usage?.total_tokens,
      });

      return result;
    } catch (err) {
      // 503 → wait 60s and retry (unlimited) — applies to both APIs
      const is503 = (err instanceof GeminiApiError && err.status === 503) ||
                     (err instanceof OpenAIApiError && err.status === 503);
      if (is503) {
        console.warn(`[AI] Text 503 on attempt ${attempt} (${endpoint}). Waiting 60s before retry...`);
        logUsage({
          endpoint: `${endpoint}_503_attempt_${attempt}`, model, success: false,
          latency_ms: Date.now() - start,
          error: `503 attempt ${attempt}`,
        });
        await sleep(60_000);
        continue;
      }

      // OpenAI 429 rate limit → wait 30s and retry
      if (err instanceof OpenAIApiError && err.status === 429) {
        console.warn(`[AI] OpenAI 429 rate limit on attempt ${attempt} (${endpoint}). Waiting 30s...`);
        logUsage({
          endpoint: `${endpoint}_429_attempt_${attempt}`, model, success: false,
          latency_ms: Date.now() - start,
          error: `429 attempt ${attempt}`,
        });
        await sleep(30_000);
        continue;
      }

      const latency = Date.now() - start;
      logUsage({
        endpoint, model, success: false, latency_ms: latency,
        error: err instanceof Error ? err.message : String(err),
      });

      if (opts.premium && model !== MODELS.TEXT_PREMIUM) {
        console.log(`[AI] Escalating to premium model after failure: ${err}`);
        return callText({ ...opts, model: MODELS.TEXT_PREMIUM, premium: false });
      }
      throw err;
    }
  }
}

// ── Structured Text (JSON output with retry) ─────────────

export interface CallStructuredOptions extends CallTextOptions {
  parseJSON?: boolean;
}

export async function callStructured<T = any>(opts: CallStructuredOptions): Promise<T> {
  const result = await callText(opts);

  if (result.tool_calls && result.tool_calls.length > 0) {
    const args = result.tool_calls[0].function.arguments;
    const parsed = tryParseJSON(args);
    if (parsed !== null) return parsed as T;
    throw new Error(`Failed to parse tool call JSON: ${args.substring(0, 200)}`);
  }

  if (opts.parseJSON && result.content) {
    const parsed = tryParseJSON(result.content);
    if (parsed !== null) return parsed as T;

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

// ── Image Generation (Gemini native) ─────────────────────

export interface CallImageOptions {
  prompt: string;
  model?: ImageModel;
  size?: string;
  quality?: string;
  n?: number;
  endpoint?: string;
  referenceImage?: string;
}

export interface CallImageResult {
  b64_json: string;
  revised_prompt?: string;
}

function sizeToAspectRatio(size?: string): string {
  if (!size || size === "auto") return "9:16";
  const map: Record<string, string> = {
    "1024x1024": "1:1",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
    "9:16": "9:16",
    "16:9": "16:9",
    "1:1": "1:1",
    "2:3": "2:3",
    "3:2": "3:2",
    "3:4": "3:4",
    "4:3": "4:3",
    "4:5": "4:5",
    "5:4": "5:4",
  };
  return map[size] || "9:16";
}

function qualityToResolution(quality?: string): string {
  if (quality === "high") return "2K";
  if (quality === "low") return "1K";
  return "1K";
}

export async function callImage(opts: CallImageOptions): Promise<CallImageResult> {
  const model = opts.model || MODELS.IMAGE_DRAFT;
  const endpoint = opts.endpoint || "image";
  const start = Date.now();

  const parts: any[] = [{ text: opts.prompt }];

  if (opts.referenceImage) {
    const base64Match = opts.referenceImage.match(/^data:([^;]+);base64,(.+)$/s);
    if (base64Match) {
      parts.unshift({ inlineData: { mimeType: base64Match[1], data: base64Match[2] } });
    } else if (opts.referenceImage.startsWith("http")) {
      try {
        const imgResp = await fetch(opts.referenceImage);
        if (imgResp.ok) {
          const imgBuffer = await imgResp.arrayBuffer();
          const imgBytes = new Uint8Array(imgBuffer);
          let binary = "";
          for (let i = 0; i < imgBytes.length; i++) {
            binary += String.fromCharCode(imgBytes[i]);
          }
          const b64 = btoa(binary);
          const mimeType = imgResp.headers.get("content-type") || "image/png";
          parts.unshift({ inlineData: { mimeType, data: b64 } });
          console.log(`[AI] Fetched reference image (${(imgBytes.length / 1024).toFixed(0)}KB) for image-to-image chaining`);
        } else {
          console.warn(`[AI] Failed to fetch reference image: ${imgResp.status} ${imgResp.statusText}`);
        }
      } catch (fetchErr) {
        console.warn(`[AI] Error fetching reference image: ${(fetchErr as Error).message}`);
      }
    }
  }

  const body: any = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: sizeToAspectRatio(opts.size),
        imageSize: qualityToResolution(opts.quality),
      },
    },
    service_tier: "flex",
  };

  const attemptStart = Date.now();
  try {
    const result = await geminiRequest(model, body, IMAGE_TIMEOUT_MS, {
      "X-Server-Timeout": String(Math.floor(IMAGE_TIMEOUT_MS / 1000)),
    });
    const latency = Date.now() - start;

    const candidate = result.candidates?.[0];
    const responseParts = candidate?.content?.parts || [];

    const imagePart = responseParts.find((p: any) => p.inlineData?.mimeType?.startsWith("image/"));
    if (!imagePart) {
      const textPart = responseParts.find((p: any) => p.text);
      throw new Error(`No image in Gemini response${textPart ? `: ${textPart.text.substring(0, 200)}` : ""}`);
    }

    const usage = result.usageMetadata ? {
      prompt_tokens: result.usageMetadata.promptTokenCount,
      completion_tokens: result.usageMetadata.candidatesTokenCount,
      total_tokens: (result.usageMetadata.promptTokenCount || 0) + (result.usageMetadata.candidatesTokenCount || 0),
    } : undefined;

    logUsage({
      endpoint, model, success: true, latency_ms: latency,
      prompt_tokens: usage?.prompt_tokens,
      completion_tokens: usage?.completion_tokens,
      total_tokens: usage?.total_tokens,
    });

    return { b64_json: imagePart.inlineData.data, revised_prompt: undefined };
  } catch (err) {
    const latency = Date.now() - attemptStart;

    const isTimeout = (err as any)?.name === "AbortError" || 
                      (err instanceof Error && err.message.includes("timed out"));
    const is503 = err instanceof GeminiApiError && err.status === 503;

    if (is503 || isTimeout) {
      const reason = isTimeout ? "timeout" : "503";
      console.warn(`[AI] Image ${reason} after ${(latency / 1000).toFixed(1)}s. Waiting ${IMAGE_RETRY_DELAY_MS / 1000}s before re-chain...`);
      logUsage({
        endpoint: `${endpoint}_${reason}`, model, success: false, latency_ms: latency,
        error: `${reason}`,
      });
      await sleep(IMAGE_RETRY_DELAY_MS);
      throw new Image503RetryableError(1, reason);
    }

    logUsage({
      endpoint, model, success: false, latency_ms: latency,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ── Summarization helpers ────────────────────────────────

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
  summary.finish_reason = result.raw.candidates?.[0]?.finishReason || result.raw.choices?.[0]?.finish_reason;
  summary.usage = result.usage;
  return summary;
}

// ── Pipeline-compatible wrapper ──────────────────────────

export async function callAI(
  messages: Array<{ role: string; content: any }>,
  tools?: any[],
  tool_choice?: any,
  model?: string,
  modalities?: string[],
  timeoutMs = 120000,
  retries = 1
): Promise<any> {
  // Map old model names
  const modelMap: Record<string, string> = {
    "google/gemini-2.5-pro": MODELS.TEXT_DEFAULT,
    "google/gemini-2.5-flash": MODELS.TEXT_CHEAP,
    "openai/gpt-5-mini": MODELS.TEXT_DEFAULT,
    "openai/gpt-5": MODELS.TEXT_PREMIUM,
    "openai/gpt-5-nano": MODELS.TEXT_CHEAP,
    "gpt-5-mini": MODELS.TEXT_DEFAULT,
    "gpt-5-nano": MODELS.TEXT_CHEAP,
    "gpt-5": MODELS.TEXT_PREMIUM,
    "google/gemini-3-pro-image-preview": MODELS.IMAGE_DRAFT,
    "google/gemini-3.1-flash-image-preview": MODELS.IMAGE_DRAFT,
    "google/gemini-3.1-flash-lite-preview": MODELS.IMAGE_DRAFT,
  };
  const mappedModel = model ? (modelMap[model] || model) : MODELS.TEXT_DEFAULT;

  // Image generation path (always Gemini)
  if (modalities?.includes("image")) {
    const textContent = Array.isArray(messages[0]?.content)
      ? messages[0].content.find((p: any) => p.type === "text")?.text || ""
      : String(messages[0]?.content || "");

    let referenceImage: string | undefined;
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        const imgPart = msg.content.find((p: any) => p.type === "image_url");
        if (imgPart?.image_url?.url) {
          referenceImage = imgPart.image_url.url;
          break;
        }
      }
    }

    const imgResult = await callImage({
      prompt: textContent,
      model: mappedModel as ImageModel,
      size: "auto",
      quality: "medium",
      endpoint: "pipeline_image",
      referenceImage,
    });

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

  const response: any = {
    choices: [{
      message: {
        role: "assistant",
        content: textResult.content,
        tool_calls: textResult.tool_calls,
      },
      finish_reason: textResult.raw.candidates?.[0]?.finishReason || textResult.raw.choices?.[0]?.finish_reason || "stop",
    }],
    usage: textResult.usage,
  };

  return response;
}
