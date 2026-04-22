ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON public.projects(is_archived);