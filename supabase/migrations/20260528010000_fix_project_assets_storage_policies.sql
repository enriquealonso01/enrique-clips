-- Replace the storage.objects policies added in
-- 20260528000000_allow_authenticated_writes_to_project_assets_storage.sql
-- with a more compatible syntax.
--
-- The original policies used `TO authenticated WITH CHECK (bucket_id = ...)`.
-- That syntax relies on the postgres connection role being set to
-- `authenticated` via `SET ROLE` after JWT validation. The Supabase Storage
-- REST API path here did not flip the role even with a valid JWT, so the
-- INSERT was still RLS-denied with "new row violates row-level security
-- policy for table 'objects'" despite the user being logged in.
--
-- The replacement policies apply `TO public` (any role) and gate the action
-- in the policy expression itself via `auth.role() = 'authenticated'`, which
-- reads the JWT claim and works regardless of which postgres role the
-- connection ended up with. Same effective permission, more reliable.

DROP POLICY IF EXISTS "Authenticated insert project-assets" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated update project-assets" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated delete project-assets" ON storage.objects;

CREATE POLICY "Insert project-assets when authenticated"
  ON storage.objects
  FOR INSERT
  TO public
  WITH CHECK (
    bucket_id = 'project-assets'
    AND auth.role() = 'authenticated'
  );

CREATE POLICY "Update project-assets when authenticated"
  ON storage.objects
  FOR UPDATE
  TO public
  USING (
    bucket_id = 'project-assets'
    AND auth.role() = 'authenticated'
  )
  WITH CHECK (
    bucket_id = 'project-assets'
    AND auth.role() = 'authenticated'
  );

CREATE POLICY "Delete project-assets when authenticated"
  ON storage.objects
  FOR DELETE
  TO public
  USING (
    bucket_id = 'project-assets'
    AND auth.role() = 'authenticated'
  );
