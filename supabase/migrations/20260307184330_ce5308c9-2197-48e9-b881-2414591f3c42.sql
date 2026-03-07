-- Drop existing public policies and replace with authenticated-only policies

-- PROJECTS
DROP POLICY IF EXISTS "Public read projects" ON public.projects;
DROP POLICY IF EXISTS "Public insert projects" ON public.projects;
DROP POLICY IF EXISTS "Public update projects" ON public.projects;
DROP POLICY IF EXISTS "Public delete projects" ON public.projects;

CREATE POLICY "Authenticated read projects" ON public.projects FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert projects" ON public.projects FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update projects" ON public.projects FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated delete projects" ON public.projects FOR DELETE TO authenticated USING (true);

-- RUNS
DROP POLICY IF EXISTS "Public read runs" ON public.runs;
DROP POLICY IF EXISTS "Public insert runs" ON public.runs;
DROP POLICY IF EXISTS "Public update runs" ON public.runs;
DROP POLICY IF EXISTS "Public delete runs" ON public.runs;

CREATE POLICY "Authenticated read runs" ON public.runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert runs" ON public.runs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update runs" ON public.runs FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated delete runs" ON public.runs FOR DELETE TO authenticated USING (true);

-- SCENES
DROP POLICY IF EXISTS "Public read scenes" ON public.scenes;
DROP POLICY IF EXISTS "Public insert scenes" ON public.scenes;
DROP POLICY IF EXISTS "Public update scenes" ON public.scenes;

CREATE POLICY "Authenticated read scenes" ON public.scenes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert scenes" ON public.scenes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update scenes" ON public.scenes FOR UPDATE TO authenticated USING (true);

-- ASSETS
DROP POLICY IF EXISTS "Public read assets" ON public.assets;
DROP POLICY IF EXISTS "Public insert assets" ON public.assets;
DROP POLICY IF EXISTS "Public update assets" ON public.assets;

CREATE POLICY "Authenticated read assets" ON public.assets FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert assets" ON public.assets FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update assets" ON public.assets FOR UPDATE TO authenticated USING (true);

-- TRACKS
DROP POLICY IF EXISTS "Public read tracks" ON public.tracks;
DROP POLICY IF EXISTS "Public insert tracks" ON public.tracks;
DROP POLICY IF EXISTS "Public update tracks" ON public.tracks;
DROP POLICY IF EXISTS "Public delete tracks" ON public.tracks;

CREATE POLICY "Authenticated read tracks" ON public.tracks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert tracks" ON public.tracks FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update tracks" ON public.tracks FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated delete tracks" ON public.tracks FOR DELETE TO authenticated USING (true);

-- OVERLAYS
DROP POLICY IF EXISTS "Public read overlays" ON public.overlays;
DROP POLICY IF EXISTS "Public insert overlays" ON public.overlays;
DROP POLICY IF EXISTS "Public update overlays" ON public.overlays;
DROP POLICY IF EXISTS "Public delete overlays" ON public.overlays;

CREATE POLICY "Authenticated read overlays" ON public.overlays FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert overlays" ON public.overlays FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update overlays" ON public.overlays FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated delete overlays" ON public.overlays FOR DELETE TO authenticated USING (true);

-- RUN_LOGS
DROP POLICY IF EXISTS "Public read run_logs" ON public.run_logs;
DROP POLICY IF EXISTS "Public insert run_logs" ON public.run_logs;

CREATE POLICY "Authenticated read run_logs" ON public.run_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert run_logs" ON public.run_logs FOR INSERT TO authenticated WITH CHECK (true);

-- PUBLISH_JOBS
DROP POLICY IF EXISTS "Public read publish_jobs" ON public.publish_jobs;
DROP POLICY IF EXISTS "Public insert publish_jobs" ON public.publish_jobs;
DROP POLICY IF EXISTS "Public update publish_jobs" ON public.publish_jobs;

CREATE POLICY "Authenticated read publish_jobs" ON public.publish_jobs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert publish_jobs" ON public.publish_jobs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update publish_jobs" ON public.publish_jobs FOR UPDATE TO authenticated USING (true);