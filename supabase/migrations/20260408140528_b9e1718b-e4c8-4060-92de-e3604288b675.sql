CREATE TABLE public.ai_fix_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  feedback TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_json JSONB NULL,
  error_message TEXT NULL,
  rerun_triggered BOOLEAN NOT NULL DEFAULT false,
  run_id UUID NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_fix_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read ai_fix_history"
ON public.ai_fix_history FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated insert ai_fix_history"
ON public.ai_fix_history FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated update ai_fix_history"
ON public.ai_fix_history FOR UPDATE TO authenticated USING (true);

CREATE INDEX idx_ai_fix_history_project ON public.ai_fix_history(project_id, created_at DESC);