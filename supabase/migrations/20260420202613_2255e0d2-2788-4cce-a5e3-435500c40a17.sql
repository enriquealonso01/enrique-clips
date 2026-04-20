ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS teaser_intro_enabled boolean NOT NULL DEFAULT false;