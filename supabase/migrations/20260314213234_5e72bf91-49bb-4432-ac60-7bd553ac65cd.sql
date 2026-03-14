
CREATE TABLE public.project_tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  track_id uuid NOT NULL REFERENCES public.tracks(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, track_id)
);

ALTER TABLE public.project_tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read project_tracks" ON public.project_tracks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert project_tracks" ON public.project_tracks FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated delete project_tracks" ON public.project_tracks FOR DELETE TO authenticated USING (true);
