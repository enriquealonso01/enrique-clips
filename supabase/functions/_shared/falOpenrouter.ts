import { fal } from "https://esm.sh/@fal-ai/client@1";

const FAL_OPENROUTER_ENDPOINT = "openrouter/router";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 15 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFalKey(): string {
  const key = Deno.env.get("FAL_KEY");
  if (!key) throw new Error("FAL_KEY is not configured");
  return key;
}

export const CLAUDE_OPUS_MODEL = "anthropic/claude-opus-4.6";

export interface FalOpenRouterTextOptions {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  onLog?: (message: string) => void;
}

export interface FalOpenRouterTextResult {
  requestId: string;
  output: string;
  reasoning: string | null;
  usage: Record<string, unknown> | null;
}

export async function runFalOpenRouterText(
  opts: FalOpenRouterTextOptions,
): Promise<FalOpenRouterTextResult> {
  fal.config({ credentials: getFalKey() });

  const model = opts.model || CLAUDE_OPUS_MODEL;
  const submitResponse: any = await fal.queue.submit(FAL_OPENROUTER_ENDPOINT, {
    input: {
      prompt: opts.prompt,
      system_prompt: opts.systemPrompt,
      model,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 16_000,
    },
  });

  const requestId = submitResponse?.request_id;
  if (!requestId || typeof requestId !== "string") {
    throw new Error("fal.ai did not return a request_id");
  }

  opts.onLog?.(`Queued ${model} request ${requestId}`);

  const startedAt = Date.now();
  let seenLogCount = 0;

  while (Date.now() - startedAt < (opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)) {
    const status: any = await fal.queue.status(FAL_OPENROUTER_ENDPOINT, {
      requestId,
      logs: true,
    });

    const logs = Array.isArray(status?.logs) ? status.logs : [];
    if (logs.length > seenLogCount) {
      for (const entry of logs.slice(seenLogCount)) {
        const message = typeof entry?.message === "string"
          ? entry.message
          : typeof entry === "string"
            ? entry
            : JSON.stringify(entry);
        opts.onLog?.(message);
      }
      seenLogCount = logs.length;
    }

    if (status?.status === "COMPLETED") {
      const result: any = await fal.queue.result(FAL_OPENROUTER_ENDPOINT, {
        requestId,
      });
      const data = result?.data ?? {};
      const output = typeof data.output === "string" ? data.output.trim() : "";
      if (!output) {
        const providerError = typeof data.error === "string" ? data.error : "";
        throw new Error(providerError || "fal.ai returned an empty response");
      }

      return {
        requestId,
        output,
        reasoning: typeof data.reasoning === "string" ? data.reasoning : null,
        usage: data.usage && typeof data.usage === "object"
          ? data.usage as Record<string, unknown>
          : null,
      };
    }

    if (status?.status === "FAILED") {
      const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
      const lastLogMessage = typeof lastLog?.message === "string" ? lastLog.message : "";
      const statusError = typeof status?.error === "string" ? status.error : "";
      throw new Error(statusError || lastLogMessage || "fal.ai request failed");
    }

    await sleep(opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for ${model} after ${Math.round((opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS) / 60_000)} minutes`,
  );
}
