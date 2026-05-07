UPDATE public.runs
SET status='queued', current_step='stitch', error_message=NULL, finished_at=NULL, progress_pct=70
WHERE id='a3a493ff-074c-49cc-9d4e-0dd075307d20';
