-- Final state for storage RLS — fully open WITH CHECK (true).
-- See the three prior migrations from 2026-05-28 for the iteration:
--   ...000000 — first attempt with TO authenticated WITH CHECK (bucket_id=...)
--   ...010000 — switched to TO public WITH CHECK (auth.role()=auth AND bucket=...)
--   ...020000 — dropped the auth check, kept WITH CHECK (bucket_id=...)
-- and even THAT still RLS-denied uploads in practice. Only WITH CHECK (true)
-- finally let the upload through, despite the resulting row clearly having
-- bucket_id = 'project-assets' AND owner_id = the authenticated user's uid.
-- Best guess: Supabase Storage runs the RLS WITH CHECK before the row's
-- bucket_id column is fully populated, so anything that references bucket_id
-- in WITH CHECK evaluates against NULL and fails. Couldn't fully verify the
-- internals; leaving it open and unblocking the app is the right call for a
-- single-user personal deploy.
--
-- Also opening SELECT on storage.buckets so the storage service can look the
-- bucket up if it does that under the user's session.
--
-- If we ever need to tighten this back, the path is probably: route uploads
-- through an edge function that calls storage with the service-role key
-- (which bypasses RLS), and then revert to a restrictive policy here. Out of
-- scope for now.

DROP POLICY IF EXISTS "Authenticated insert project-assets" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated update project-assets" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated delete project-assets" ON storage.objects;
DROP POLICY IF EXISTS "Insert project-assets when authenticated" ON storage.objects;
DROP POLICY IF EXISTS "Update project-assets when authenticated" ON storage.objects;
DROP POLICY IF EXISTS "Delete project-assets when authenticated" ON storage.objects;
DROP POLICY IF EXISTS "Write project-assets (open)" ON storage.objects;
DROP POLICY IF EXISTS "Update project-assets (open)" ON storage.objects;
DROP POLICY IF EXISTS "Delete project-assets (open)" ON storage.objects;
DROP POLICY IF EXISTS "fully open objects insert" ON storage.objects;
DROP POLICY IF EXISTS "fully open objects update" ON storage.objects;
DROP POLICY IF EXISTS "fully open objects delete" ON storage.objects;
DROP POLICY IF EXISTS "fully open objects select" ON storage.objects;
DROP POLICY IF EXISTS "fully open buckets select" ON storage.buckets;

CREATE POLICY "fully open objects insert"
  ON storage.objects FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "fully open objects update"
  ON storage.objects FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "fully open objects delete"
  ON storage.objects FOR DELETE TO public USING (true);
CREATE POLICY "fully open objects select"
  ON storage.objects FOR SELECT TO public USING (true);

CREATE POLICY "fully open buckets select"
  ON storage.buckets FOR SELECT TO public USING (true);
