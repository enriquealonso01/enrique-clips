
-- Enums
CREATE TYPE public.story_run_status AS ENUM (
  'queued','researching_story','story_selected','cast_generated',
  'narration_generated','beats_extracted','scene_images_generating',
  'scenes_generating','audio_mixing','subtitles_processing',
  'end_card_rendering','ready_to_publish','publishing','published',
  'paused','failed','cancelled'
);

CREATE TYPE public.story_asset_type AS ENUM (
  'background_music','ending_audio','narration_audio','real_image',
  'cast_reference_image','scene_image','scene_video_raw',
  'scene_video_trimmed','captioned_story_video','ending_visual_clip',
  'ending_audio_trimmed','final_video','emoji'
);

-- story_projects
CREATE TABLE public.story_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT 'Untitled Story Project',
  is_enabled boolean NOT NULL DEFAULT true,
  config_json jsonb DEFAULT '{"audio_mix":{"narrator_gain_db":0,"background_music_gain_db":-22,"background_music_ducking_enabled":true,"background_music_duck_gain_db":-26,"background_music_fade_in_ms":300,"background_music_fade_out_ms":500},"ending_audio":{"source_priority":["uploaded_ending_audio","background_music_fallback","silence"],"target_duration_sec":5.0,"fade_in_ms":250,"fade_out_ms":400}}'::jsonb,
  publish_platforms jsonb NOT NULL DEFAULT '{"tiktok":true,"youtube":true,"facebook":true,"instagram":true}'::jsonb,
  publish_defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
  timezone text NOT NULL DEFAULT 'America/New_York',
  background_music_path text,
  ending_audio_path text,
  emoji_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.story_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth read story_projects" ON public.story_projects FOR SELECT TO authenticated USING (true);
CREATE POLICY "Auth insert story_projects" ON public.story_projects FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Auth update story_projects" ON public.story_projects FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Auth delete story_projects" ON public.story_projects FOR DELETE TO authenticated USING (true);

CREATE TRIGGER update_story_projects_updated_at
  BEFORE UPDATE ON public.story_projects
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- story_runs
CREATE TABLE public.story_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.story_projects(id) ON DELETE CASCADE,
  status public.story_run_status NOT NULL DEFAULT 'queued',
  current_stage text NOT NULL DEFAULT 'create_run',
  progress_pct integer NOT NULL DEFAULT 0,
  error_message text,
  generated_metadata jsonb DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.story_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth read story_runs" ON public.story_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Auth insert story_runs" ON public.story_runs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Auth update story_runs" ON public.story_runs FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Auth delete story_runs" ON public.story_runs FOR DELETE TO authenticated USING (true);

-- story_run_logs
CREATE TABLE public.story_run_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.story_runs(id) ON DELETE CASCADE,
  level public.log_level NOT NULL DEFAULT 'info',
  message text NOT NULL,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.story_run_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth read story_run_logs" ON public.story_run_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Auth insert story_run_logs" ON public.story_run_logs FOR INSERT TO authenticated WITH CHECK (true);

-- story_assets
CREATE TABLE public.story_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES public.story_runs(id) ON DELETE CASCADE,
  type public.story_asset_type NOT NULL,
  supabase_path text NOT NULL,
  signed_url_last text,
  metadata jsonb DEFAULT '{}'::jsonb,
  scene_index integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.story_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth read story_assets" ON public.story_assets FOR SELECT TO authenticated USING (true);
CREATE POLICY "Auth insert story_assets" ON public.story_assets FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Auth update story_assets" ON public.story_assets FOR UPDATE TO authenticated USING (true);

-- story_memory
CREATE TABLE public.story_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.story_projects(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.story_runs(id) ON DELETE SET NULL,
  story_title text NOT NULL,
  story_fingerprint text,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.story_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth read story_memory" ON public.story_memory FOR SELECT TO authenticated USING (true);
CREATE POLICY "Auth insert story_memory" ON public.story_memory FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Auth delete story_memory" ON public.story_memory FOR DELETE TO authenticated USING (true);

-- Enable realtime for story_runs
ALTER PUBLICATION supabase_realtime ADD TABLE public.story_runs;
