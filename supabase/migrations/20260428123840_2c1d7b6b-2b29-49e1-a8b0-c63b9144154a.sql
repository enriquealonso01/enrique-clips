UPDATE public.runs
SET status = 'running',
    current_step = 'publish',
    progress_pct = 90,
    finished_at = NULL,
    error_message = NULL,
    generated_metadata = COALESCE(generated_metadata, '{}'::jsonb) - 'publish_scheduled_date' - 'publish_timezone'
WHERE id = 'f77af2a2-613e-4c7b-bfdd-1f91e0b223e7';