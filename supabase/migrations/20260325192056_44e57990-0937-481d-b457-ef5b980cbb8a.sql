CREATE OR REPLACE FUNCTION public.get_random_project_track(p_project_id uuid)
RETURNS TABLE(track_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pt.track_id
  FROM public.project_tracks pt
  WHERE pt.project_id = p_project_id
  ORDER BY random()
  LIMIT 1;
$$;