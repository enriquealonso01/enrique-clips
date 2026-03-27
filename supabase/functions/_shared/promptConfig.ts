// ═══════════════════════════════════════════════════════════
// Prompt Config JSON — Types, Defaults, Validation, Merging
// Edge function copy (cannot import from src/)
// ═══════════════════════════════════════════════════════════

export interface PromptConfigGlobal {
  concept_prompt: string;
  rules: string[];
  negative_prompt: string;
  style_notes: string;
  content_type: string;
}

export interface PromptConfigPlanning {
  planner_system_prompt: string;
  planner_user_prompt_template: string;
  first_scene_hook_rules: string[];
  viral_pacing_rules: string[];
  scene_progression_rules: string[];
  start_state_rules: string[];
  behavior_assignment_rules: string[];
}

export interface PromptConfigKeyframes {
  prompt_template: string;
  composition_rules: string[];
  continuity_rules: string[];
  single_shot_only: boolean;
}

export interface PromptConfigMotion {
  prompt_template: string;
  camera_rules: string[];
  motion_rules: string[];
  negative_prompt_extra: string;
}

export interface PromptConfigOverlaySlot {
  enabled: boolean;
  generation_prompt: string;
}

export interface PromptConfigOverlayItem {
  overlay_type: string;
  content_mode: string;
  content_text?: string;
  content_prompt?: string;
  image_path?: string;
  position: string;
  style: string;
  start_pct: number;
  end_pct: number;
  font_size?: number;
  font_color?: string;
  bg_color?: string;
  z_index?: number;
  sort_order?: number;
  voiceover_enabled?: boolean;
}

export interface PromptConfigOverlays {
  opening: PromptConfigOverlaySlot;
  ending: PromptConfigOverlaySlot;
  items?: PromptConfigOverlayItem[];
}

export interface PromptConfigMetadata {
  title_prompt: string;
  description_prompt: string;
  hashtag_prompt: string;
  per_platform_prompts?: Record<string, {
    title_prompt?: string;
    description_prompt?: string;
    hashtag_prompt?: string;
  }>;
}

export interface PromptConfigVoiceover {
  enabled: boolean;
  voice_id: string;
  model: string;
}

export interface PromptConfigAudio {
  strategy: string;
  enabled: boolean;
}

export interface PromptConfigPipeline {
  use_legacy_fallbacks: boolean;
}

export interface PromptConfigMemory {
  enabled: boolean;
  instruction: string;
  lookback_count: number;
}

export interface PromptConfig {
  version: number;
  global: PromptConfigGlobal;
  planning: PromptConfigPlanning;
  keyframes: PromptConfigKeyframes;
  motion: PromptConfigMotion;
  overlays: PromptConfigOverlays;
  metadata: PromptConfigMetadata;
  audio: PromptConfigAudio;
  voiceover: PromptConfigVoiceover;
  pipeline: PromptConfigPipeline;
  memory: PromptConfigMemory;
}

export const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  version: 1,
  global: {
    concept_prompt: "",
    rules: [],
    negative_prompt: "",
    style_notes: "",
    content_type: "transformation",
  },
  planning: {
    planner_system_prompt:
      "You are a creative director for short-form video content. You plan visually compelling scene sequences that maximize viewer retention and engagement. Each scene must advance the narrative clearly with escalating visual impact.",
    planner_user_prompt_template:
      "Create a {scene_count}-scene plan for: {concept_prompt}",
    first_scene_hook_rules: [
      "Scene 1 must grab attention within the first 2 seconds with a visually striking opening.",
      "The opening scene should establish the setting and hint at the transformation to come.",
      "Avoid slow or static openings — begin with visual energy or an intriguing composition.",
    ],
    viral_pacing_rules: [
      "Each scene must escalate visually — never plateau or repeat the same energy level.",
      "Alternate between wide establishing shots and close detail shots for visual variety.",
      "The final scene should deliver a satisfying payoff or dramatic reveal.",
    ],
    scene_progression_rules: [
      "Maintain strict temporal continuity — each scene follows logically from the previous one.",
      "No sudden jumps in progress. Changes must be incremental and believable.",
      "Objects, structures, and characters cannot appear unless introduced in a prior scene.",
      "Environmental conditions (lighting, weather, time of day) should transition smoothly.",
    ],
    start_state_rules: [
      "The world begins in its natural, untouched state before any process starts.",
      "Scene 1 should show ONLY the initial environment with no signs of the upcoming transformation.",
      "Human elements, tools, or construction materials should emerge gradually, not appear instantly.",
    ],
    behavior_assignment_rules: [
      "If the scene involves construction, city growth, farming, manufacturing, or building processes → timelapse_build",
      "If the scene is an opening landscape, establishing shot, or calm environment → environment_idle",
      "If the scene involves character dialogue or interaction → conversation",
      "If the scene involves travel, walking through spaces, or discovery → exploration",
      "If the scene is a final payoff, big reveal, or dramatic unveiling → reveal",
      "For dramatic character moments, action sequences, or story beats → cinematic_action",
    ],
  },
  keyframes: {
    prompt_template:
      "Generate a high-quality {aspect_ratio} image for this scene's END frame. This is keyframe K{scene_index} of {total_scenes}.\n\n=== STYLE BIBLE (follow exactly) ===\n{style_bible}\n\n=== SCENE ===\n{end_keyframe_prompt}\n\n=== RULES ===\n{composition_rules}\n{continuity_rules}\n- Do NOT add text, watermarks, or logos.",
    composition_rules: [
      "Include composition anchors: camera distance, subject position, horizon line, and environment layout.",
      "Maintain consistent framing relative to the style bible's camera constraints.",
    ],
    continuity_rules: [
      "Maintain IDENTICAL character appearance, outfit, and art style as the reference image.",
      "Keep the same lighting direction and color palette.",
      "Match the spatial layout established in previous keyframes.",
    ],
    single_shot_only: true,
  },
  motion: {
    prompt_template: "[{behavior}/{density}] {kling_prompt}",
    camera_rules: [
      "Follow the motion grammar rules assigned to the scene behavior.",
      "Camera movements must be smooth and controlled — no erratic or sudden shifts.",
    ],
    motion_rules: [
      "No morphing, teleportation, or physically impossible transformations.",
      "Subject motion must be natural and continuous within the clip duration.",
    ],
    negative_prompt_extra:
      "flicker, jitter, warping, morphing face, melting, extra limbs, extra fingers, text, watermark, logo, low-res, heavy noise, blurry, duplicate, deformed",
  },
  overlays: {
    opening: { enabled: false, generation_prompt: "" },
    ending: { enabled: true, generation_prompt: "" },
  },
  metadata: {
    title_prompt:
      "Generate a catchy, attention-grabbing title for a short-form video post (max 100 characters). Make it punchy, curiosity-driven, and platform-optimized.",
    description_prompt:
      "Generate an engaging video description (max 500 characters). Include a hook, brief summary of the content, and a call to action.",
    hashtag_prompt:
      "Generate 8-12 relevant hashtags for maximum discoverability. Mix broad trending tags with niche-specific ones.",
  },
  audio: {
    strategy: "background_music",
    enabled: true,
  },
  pipeline: {
    use_legacy_fallbacks: true,
  },
  memory: {
    enabled: false,
    instruction: "",
    lookback_count: 30,
  },
};

export function getDefaultPromptConfig(contentType?: string): PromptConfig {
  const config = JSON.parse(JSON.stringify(DEFAULT_PROMPT_CONFIG));
  if (contentType) {
    config.global.content_type = contentType;
  }
  return config;
}

function deepMerge(target: any, source: any): any {
  if (source === null || source === undefined) return target;
  if (typeof target !== "object" || typeof source !== "object") return source;
  if (Array.isArray(source)) return source.length > 0 ? source : target;

  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
      result[key] = deepMerge(target[key], source[key]);
    }
  }
  return result;
}

export function mergePromptConfig(
  defaults: PromptConfig,
  overrides: Partial<PromptConfig>
): PromptConfig {
  return deepMerge(defaults, overrides) as PromptConfig;
}

export function legacyFieldsToPromptConfig(project: {
  series_prompt?: string | null;
  series_rules?: string | null;
  negative_prompt?: string | null;
}): Partial<PromptConfig> {
  const partial: Partial<PromptConfig> = { global: {} as any };

  if (project.series_prompt) {
    partial.global!.concept_prompt = project.series_prompt;
  }
  if (project.series_rules) {
    partial.global!.rules = project.series_rules
      .split("\n")
      .map((r: string) => r.trim())
      .filter(Boolean);
  }
  if (project.negative_prompt) {
    partial.global!.negative_prompt = project.negative_prompt;
  }

  return partial;
}

export function buildResolvedPromptConfig(project: {
  series_prompt?: string | null;
  series_rules?: string | null;
  negative_prompt?: string | null;
  prompt_config_json?: any;
}): PromptConfig {
  const defaults = getDefaultPromptConfig();

  // Layer 1: legacy fallback
  const legacyOverrides = legacyFieldsToPromptConfig(project);
  let resolved = mergePromptConfig(defaults, legacyOverrides);

  // Layer 2: explicit prompt_config_json overrides
  if (project.prompt_config_json && typeof project.prompt_config_json === "object") {
    resolved = mergePromptConfig(resolved, project.prompt_config_json);
  }

  return resolved;
}
