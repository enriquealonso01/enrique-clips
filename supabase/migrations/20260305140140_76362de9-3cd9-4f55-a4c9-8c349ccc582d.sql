
-- Add video generator enum
CREATE TYPE public.video_generator AS ENUM ('kling', 'pika');

-- Add video_generator column to projects (default kling for backward compat)
ALTER TABLE public.projects
  ADD COLUMN video_generator public.video_generator NOT NULL DEFAULT 'kling',
  ADD COLUMN pika_resolution TEXT NOT NULL DEFAULT '1080p';
