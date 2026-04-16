
-- Add story search prompt to story_projects
ALTER TABLE public.story_projects ADD COLUMN IF NOT EXISTS story_search_prompt text DEFAULT NULL;

-- Add UploadPost publish fields to story_projects
ALTER TABLE public.story_projects ADD COLUMN IF NOT EXISTS uploadpost_api_key_encrypted text DEFAULT NULL;
ALTER TABLE public.story_projects ADD COLUMN IF NOT EXISTS uploadpost_api_key_configured boolean NOT NULL DEFAULT false;
ALTER TABLE public.story_projects ADD COLUMN IF NOT EXISTS uploadpost_profile_username text DEFAULT NULL;

-- Add story_project_id to schedules so we can reuse the same table for story schedules
ALTER TABLE public.schedules ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE public.schedules ADD COLUMN IF NOT EXISTS story_project_id uuid DEFAULT NULL;
