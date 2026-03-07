-- Create schedules table: one row per daily time per project
CREATE TABLE public.schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  time_utc time NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  last_triggered_at timestamptz DEFAULT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read schedules" ON public.schedules FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert schedules" ON public.schedules FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update schedules" ON public.schedules FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated delete schedules" ON public.schedules FOR DELETE TO authenticated USING (true);

-- Also allow service role (edge functions) via the default behavior