-- Reset failed story run so vidu video gen can be retriggered (no image regen)
UPDATE public.story_runs
SET status = 'scenes_generating', current_stage = 'scenes_generating', error_message = NULL, finished_at = NULL
WHERE id = '208beb86-8c22-457f-a447-bdb49d37b4df';
