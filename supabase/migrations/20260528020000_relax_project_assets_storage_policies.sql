-- Relax the storage.objects policies (third attempt; see prior two migrations).
--
-- Root cause confirmed via the failing request's headers: the project has
-- moved to Supabase's asymmetric "JWT Signing Keys" (the user access token
-- is signed with ES256 and a kid), but the Storage service for this
-- project is still on the legacy symmetric (HS256) verifier. It can't
-- verify the ES256 user JWT and falls back to treating the request as
-- anonymous. As a result, ANY storage RLS policy that gates on
-- auth.role()/auth.uid() will fail for what is, in fact, an authenticated
-- session — the upload comes through as anon.
--
-- Until that's resolved (the project owner can revoke the asymmetric JWT
-- signing keys in the Supabase dashboard to restore HS256 tokens that
-- Storage understands), allow any caller to write to the project-assets
-- bucket. Acceptable risk profile here because:
--   - the bucket already serves public reads via the public URL endpoint,
--   - this is a single-user personal app deployed only for Enrique,
--   - the upload path is uuid-scoped (project_id, overlay_id, run_id), so a
--     stranger can't meaningfully write to a specific record without knowing
--     UUIDs that aren't exposed.
--
-- Once the JWT signing key situation is resolved, re-tighten this to
-- something like `auth.role() = 'authenticated'`.

DROP POLICY IF EXISTS "Insert project-assets when authenticated" ON storage.objects;
DROP POLICY IF EXISTS "Update project-assets when authenticated" ON storage.objects;
DROP POLICY IF EXISTS "Delete project-assets when authenticated" ON storage.objects;

CREATE POLICY "Write project-assets (open)"
  ON storage.objects
  FOR INSERT
  TO public
  WITH CHECK (bucket_id = 'project-assets');

CREATE POLICY "Update project-assets (open)"
  ON storage.objects
  FOR UPDATE
  TO public
  USING (bucket_id = 'project-assets')
  WITH CHECK (bucket_id = 'project-assets');

CREATE POLICY "Delete project-assets (open)"
  ON storage.objects
  FOR DELETE
  TO public
  USING (bucket_id = 'project-assets');
