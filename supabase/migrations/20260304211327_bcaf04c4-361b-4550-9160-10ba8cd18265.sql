
-- Enums
CREATE TYPE public.run_status AS ENUM ('queued', 'running', 'paused', 'stopped', 'failed', 'completed');
CREATE TYPE public.run_step AS ENUM ('plan', 'keyframes', 'kling', 'stitch', 'metadata', 'publish', 'done');
CREATE TYPE public.scene_status AS ENUM ('pending', 'keyframes_ready', 'clip_requested', 'clip_ready', 'failed');
CREATE TYPE public.asset_type AS ENUM ('initial_image', 'keyframe', 'clip', 'final_video', 'thumbnail');
CREATE TYPE public.publish_job_status AS ENUM ('not_started', 'submitted', 'polling', 'completed', 'failed', 'partial_failed');
CREATE TYPE public.log_level AS ENUM ('debug', 'info', 'warn', 'error');
CREATE TYPE public.posting_frequency AS ENUM ('manual', 'interval_hours', 'cron');

-- Timestamp trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Projects table
CREATE TABLE public.projects (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled Project',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  series_prompt TEXT,
  series_rules TEXT,
  negative_prompt TEXT,
  scene_count INTEGER NOT NULL DEFAULT 3,
  clip_duration_sec INTEGER NOT NULL DEFAULT 10,
  aspect_ratio TEXT NOT NULL DEFAULT '9:16',
  initial_asset_id UUID,
  kling_model_name TEXT NOT NULL DEFAULT 'kling-v2-6',
  kling_mode TEXT NOT NULL DEFAULT 'pro',
  kling_sound BOOLEAN NOT NULL DEFAULT false,
  uploadpost_api_key_encrypted TEXT,
  uploadpost_api_key_configured BOOLEAN NOT NULL DEFAULT false,
  uploadpost_profile_username TEXT,
  publish_platforms JSONB NOT NULL DEFAULT '{"tiktok":true,"instagram":true,"youtube":true,"facebook":true}'::jsonb,
  publish_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
  posting_frequency_type public.posting_frequency NOT NULL DEFAULT 'manual',
  posting_interval_hours INTEGER,
  posting_cron TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  project_control_token_hash TEXT,
  project_control_token_hint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read projects" ON public.projects FOR SELECT USING (true);
CREATE POLICY "Public insert projects" ON public.projects FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update projects" ON public.projects FOR UPDATE USING (true);
CREATE POLICY "Public delete projects" ON public.projects FOR DELETE USING (true);

CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Runs table
CREATE TABLE public.runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  status public.run_status NOT NULL DEFAULT 'queued',
  current_step public.run_step NOT NULL DEFAULT 'plan',
  progress_pct INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read runs" ON public.runs FOR SELECT USING (true);
CREATE POLICY "Public insert runs" ON public.runs FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update runs" ON public.runs FOR UPDATE USING (true);
CREATE POLICY "Public delete runs" ON public.runs FOR DELETE USING (true);

-- Scenes table
CREATE TABLE public.scenes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  scene_index INTEGER NOT NULL,
  scene_title TEXT,
  scene_description TEXT,
  end_keyframe_prompt TEXT,
  kling_prompt TEXT,
  status public.scene_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.scenes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read scenes" ON public.scenes FOR SELECT USING (true);
CREATE POLICY "Public insert scenes" ON public.scenes FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update scenes" ON public.scenes FOR UPDATE USING (true);

-- Assets table
CREATE TABLE public.assets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID REFERENCES public.runs(id) ON DELETE CASCADE,
  scene_id UUID REFERENCES public.scenes(id) ON DELETE SET NULL,
  type public.asset_type NOT NULL,
  supabase_path TEXT NOT NULL,
  signed_url_last TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read assets" ON public.assets FOR SELECT USING (true);
CREATE POLICY "Public insert assets" ON public.assets FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update assets" ON public.assets FOR UPDATE USING (true);

ALTER TABLE public.projects ADD CONSTRAINT fk_initial_asset FOREIGN KEY (initial_asset_id) REFERENCES public.assets(id) ON DELETE SET NULL;

-- Publish jobs table
CREATE TABLE public.publish_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  uploadpost_request_id TEXT,
  uploadpost_job_id TEXT,
  status public.publish_job_status NOT NULL DEFAULT 'not_started',
  platform_results JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.publish_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read publish_jobs" ON public.publish_jobs FOR SELECT USING (true);
CREATE POLICY "Public insert publish_jobs" ON public.publish_jobs FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update publish_jobs" ON public.publish_jobs FOR UPDATE USING (true);

CREATE TRIGGER update_publish_jobs_updated_at BEFORE UPDATE ON public.publish_jobs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Run logs table
CREATE TABLE public.run_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  level public.log_level NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.run_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read run_logs" ON public.run_logs FOR SELECT USING (true);
CREATE POLICY "Public insert run_logs" ON public.run_logs FOR INSERT WITH CHECK (true);

-- Storage bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('project-assets', 'project-assets', true);

CREATE POLICY "Public read project-assets" ON storage.objects FOR SELECT USING (bucket_id = 'project-assets');
CREATE POLICY "Public upload project-assets" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'project-assets');
CREATE POLICY "Public update project-assets" ON storage.objects FOR UPDATE USING (bucket_id = 'project-assets');
CREATE POLICY "Public delete project-assets" ON storage.objects FOR DELETE USING (bucket_id = 'project-assets');

-- Indexes
CREATE INDEX idx_runs_project_id ON public.runs(project_id);
CREATE INDEX idx_scenes_run_id ON public.scenes(run_id);
CREATE INDEX idx_assets_run_id ON public.assets(run_id);
CREATE INDEX idx_assets_scene_id ON public.assets(scene_id);
CREATE INDEX idx_publish_jobs_run_id ON public.publish_jobs(run_id);
CREATE INDEX idx_run_logs_run_id ON public.run_logs(run_id);
CREATE INDEX idx_run_logs_level ON public.run_logs(level);
