
CREATE TABLE public.overlays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  overlay_type TEXT NOT NULL DEFAULT 'text',
  style TEXT NOT NULL DEFAULT 'lower_third',
  content_text TEXT,
  content_mode TEXT NOT NULL DEFAULT 'exact',
  position TEXT NOT NULL DEFAULT 'bottom_center',
  start_pct NUMERIC NOT NULL DEFAULT 0,
  end_pct NUMERIC NOT NULL DEFAULT 100,
  z_index INTEGER NOT NULL DEFAULT 1,
  font_size INTEGER DEFAULT 48,
  font_color TEXT DEFAULT '#FFFFFF',
  bg_color TEXT DEFAULT 'rgba(0,0,0,0.5)',
  image_path TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.overlays ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read overlays" ON public.overlays FOR SELECT USING (true);
CREATE POLICY "Public insert overlays" ON public.overlays FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update overlays" ON public.overlays FOR UPDATE USING (true);
CREATE POLICY "Public delete overlays" ON public.overlays FOR DELETE USING (true);
