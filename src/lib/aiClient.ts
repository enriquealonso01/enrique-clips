// ═══════════════════════════════════════════════════════════
// Frontend AI API Client
// All calls go through our own edge functions — never direct to OpenAI
// ═══════════════════════════════════════════════════════════

const AI_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-endpoints`;

async function callEndpoint<T>(path: string, body: Record<string, any>): Promise<T> {
  const resp = await fetch(`${AI_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    if (resp.status === 429) throw new Error("Rate limit exceeded. Please try again later.");
    if (resp.status === 402) throw new Error("Insufficient credits. Please add funds.");
    throw new Error(err.error || `AI API error ${resp.status}`);
  }

  const result = await resp.json();
  if (!result.success) throw new Error(result.error || "Unknown AI error");
  return result.data as T;
}

// ── Typed Interfaces ─────────────────────────────────────

export interface ScenePlan {
  landmark_name: string;
  landmark_location: string;
  landmark_era: string;
  scenes: Array<{
    scene_index: number;
    scene_title: string;
    scene_description: string;
    scene_behavior: "environment_idle" | "cinematic_action" | "timelapse_build" | "conversation" | "exploration" | "reveal";
    activity_density: "low" | "medium" | "high";
    end_keyframe_prompt: string;
    kling_prompt: string;
  }>;
}

export interface StyleBible {
  character_identity: string;
  outfit_description: string;
  environment_layout: string;
  lighting_palette: string;
  camera_constraints: string;
  do_not_change: string[];
  art_style: string;
}

export interface PlatformMetadata {
  [platform: string]: {
    title: string;
    description: string;
    hashtags: string[];
  };
}

export interface OverlayContent {
  index: number;
  content: string;
}

export interface ImageResult {
  b64_json: string;
  revised_prompt?: string;
}

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

// ── API Functions ────────────────────────────────────────

export async function generatePlan(input: {
  system_prompt?: string;
  user_prompt?: string;
  scene_count?: number;
  concept_prompt?: string;
  premium?: boolean;
}): Promise<ScenePlan> {
  return callEndpoint<ScenePlan>("/plan", input);
}

export async function generateStyleBible(input: {
  system_prompt?: string;
  user_prompt?: string;
  premium?: boolean;
}): Promise<StyleBible> {
  return callEndpoint<StyleBible>("/style-bible", input);
}

export async function generatePlatformMetadata(input: {
  system_prompt?: string;
  user_prompt: string;
  platforms: string[];
  platform_properties: Record<string, any>;
}): Promise<PlatformMetadata> {
  return callEndpoint<PlatformMetadata>("/platform-metadata", input);
}

export async function generateOverlayContent(input: {
  system_prompt?: string;
  user_prompt: string;
  premium?: boolean;
}): Promise<OverlayContent[]> {
  return callEndpoint<OverlayContent[]>("/overlay", input);
}

export async function generateDraftKeyframe(input: {
  prompt: string;
  size?: string;
  quality?: string;
}): Promise<ImageResult> {
  return callEndpoint<ImageResult>("/image/draft", input);
}

export async function generateFinalKeyframe(input: {
  prompt: string;
  size?: string;
  quality?: string;
}): Promise<ImageResult> {
  return callEndpoint<ImageResult>("/image/final", input);
}

export async function getAIUsage(): Promise<UsageEntry[]> {
  const resp = await fetch(`${AI_BASE}/usage`, {
    headers: {
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
  });
  const result = await resp.json();
  return result.data || [];
}
