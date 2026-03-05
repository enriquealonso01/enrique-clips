
-- Add scene_behavior enum
CREATE TYPE public.scene_behavior AS ENUM (
  'environment_idle',
  'cinematic_action',
  'timelapse_build',
  'conversation',
  'exploration',
  'reveal'
);

-- Add activity_density enum
CREATE TYPE public.activity_density AS ENUM ('low', 'medium', 'high');

-- Add columns to scenes table
ALTER TABLE public.scenes
  ADD COLUMN scene_behavior public.scene_behavior DEFAULT 'cinematic_action',
  ADD COLUMN activity_density public.activity_density DEFAULT 'medium';
