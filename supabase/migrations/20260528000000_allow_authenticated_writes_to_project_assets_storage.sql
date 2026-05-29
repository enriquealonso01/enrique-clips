-- Allow authenticated users to write to the project-assets storage bucket.
--
-- The Lovable→self-hosted migration on 2026-05-20 carried over table schemas
-- and table-level policies (rls_policy_always_true for authenticated on every
-- public.* table) but missed storage.objects. With RLS enabled on
-- storage.objects and zero policies, every client-side upload from the app
-- failed with "new row violates row-level security policy" (e.g. uploading an
-- overlay image, a track, a font).
--
-- These three policies bring storage.objects in line with the rest of the
-- schema's permissive single-user-app stance (Enrique is the only authenticated
-- user). They are scoped to bucket_id='project-assets' (our only bucket).
--
-- Public reads on the bucket continue to work via the public URL endpoint and
-- do not require a SELECT policy here.

CREATE POLICY "Authenticated insert project-assets"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'project-assets');

CREATE POLICY "Authenticated update project-assets"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'project-assets')
  WITH CHECK (bucket_id = 'project-assets');

CREATE POLICY "Authenticated delete project-assets"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'project-assets');
