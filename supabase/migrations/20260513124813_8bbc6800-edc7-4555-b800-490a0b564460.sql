UPDATE runs
SET status = 'running',
    current_step = 'keyframes',
    error_message = NULL,
    progress_pct = 30,
    generated_metadata = COALESCE(generated_metadata, '{}'::jsonb) - 'keyframe_attempts'
WHERE id = 'a89d0109-5f1d-449d-9442-32596ca3606d';