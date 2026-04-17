CREATE TABLE public.analytics_profiles (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_username text NOT NULL UNIQUE,
  display_name text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.analytics_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read analytics_profiles"
  ON public.analytics_profiles FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated insert analytics_profiles"
  ON public.analytics_profiles FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated update analytics_profiles"
  ON public.analytics_profiles FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated delete analytics_profiles"
  ON public.analytics_profiles FOR DELETE TO authenticated USING (true);