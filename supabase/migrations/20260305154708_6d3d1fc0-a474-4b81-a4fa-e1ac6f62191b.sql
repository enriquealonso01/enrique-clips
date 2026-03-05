
-- Create tracks table for storing uploaded music files
CREATE TABLE public.tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  filename text NOT NULL,
  supabase_path text NOT NULL,
  duration_sec numeric NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read tracks" ON public.tracks FOR SELECT USING (true);
CREATE POLICY "Public insert tracks" ON public.tracks FOR INSERT WITH CHECK (true);
CREATE POLICY "Public delete tracks" ON public.tracks FOR DELETE USING (true);
CREATE POLICY "Public update tracks" ON public.tracks FOR UPDATE USING (true);

-- Add selected_track_id to projects
ALTER TABLE public.projects ADD COLUMN selected_track_id uuid REFERENCES public.tracks(id) ON DELETE SET NULL;
