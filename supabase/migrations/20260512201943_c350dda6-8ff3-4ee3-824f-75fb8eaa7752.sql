
DELETE FROM public.assets
WHERE run_id IN (
  'f2638f82-3350-4568-a043-97f8b3090f10',
  'f454b1ab-4c68-4951-a0f2-7bf1f63801a7',
  '162f0a31-cc91-46e7-a69f-8c27c7410c6a'
)
AND type = 'clip'
AND metadata->>'status' = 'failed';

UPDATE public.runs
SET status = 'running',
    current_step = 'keyframes',
    progress_pct = 35,
    error_message = NULL,
    finished_at = NULL,
    generated_metadata = (COALESCE(generated_metadata, '{}'::jsonb) - 'waiting_for' - 'vidu_task_ids' - 'off_peak_submitted_at' - 'final_video_url')
WHERE id IN (
  'f2638f82-3350-4568-a043-97f8b3090f10',
  'f454b1ab-4c68-4951-a0f2-7bf1f63801a7',
  '162f0a31-cc91-46e7-a69f-8c27c7410c6a'
);
