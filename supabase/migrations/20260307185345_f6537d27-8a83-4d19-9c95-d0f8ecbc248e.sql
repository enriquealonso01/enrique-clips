-- Add last_run_at to projects so scheduler can avoid duplicate triggers
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS last_run_at timestamptz DEFAULT NULL;

-- Enable pg_cron and pg_net extensions
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;