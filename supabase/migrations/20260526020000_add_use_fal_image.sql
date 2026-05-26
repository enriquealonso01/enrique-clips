-- Per-project toggle to route keyframe image generation through fal.ai
-- (Gemini 2.5 Flash Image / "Nano Banana") instead of the direct Google
-- Gemini API. Defaults off so existing projects keep the current Google path.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS use_fal_image boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.projects.use_fal_image IS
  'When true, keyframe (K0/K1+) image generation for this project uses fal.ai Gemini 2.5 Flash Image instead of the direct Google Gemini API. Toggled per-project in the app (Video tab).';
