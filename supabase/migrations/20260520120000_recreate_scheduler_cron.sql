-- Recreate the pg_cron triggers that drive generation on the self-hosted backend.
-- These were configured out-of-band on Lovable Cloud and were never captured in a
-- migration, so the DB clone did not bring them over.
--
-- Three jobs (mirroring the source):
--   * invoke-scheduler-every-minute  (* * * * *)  -> scheduler        (reads public.schedules, fires due project/story runs)
--   * sweep-vidu-off-peak            (*/5 * * * *) -> poll-vidu-direct (sweeps pending Projects Vidu clips)
--   * story-vidu-offpeak-sweeper     (*/5 * * * *) -> story-poll-vidu  (sweeps pending Stories Vidu clips)
--
-- ACTIVATION — run at CUTOVER ONLY. Running these while the old Lovable backend is
-- still live double-generates and double-publishes to social. Prerequisites:
--   1. Edge functions (scheduler, poll-vidu-direct, story-poll-vidu, ...) are deployed to this project.
--   2. Store the invoke key in Vault once (project publishable/anon or service key):
--        select vault.create_secret('<INVOKE_KEY>', 'cron_invoke_key');
--   3. Then apply this file. Keys are read from Vault at call time, never stored in git.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'invoke-scheduler-every-minute', '* * * * *',
  $$ select net.http_post(
       url := 'https://hvdvrqmrphbsouomjeqz.supabase.co/functions/v1/scheduler',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_invoke_key')
       )
     ); $$
);

select cron.schedule(
  'sweep-vidu-off-peak', '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://hvdvrqmrphbsouomjeqz.supabase.co/functions/v1/poll-vidu-direct',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_invoke_key')
       )
     ); $$
);

select cron.schedule(
  'story-vidu-offpeak-sweeper', '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://hvdvrqmrphbsouomjeqz.supabase.co/functions/v1/story-poll-vidu',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_invoke_key')
       )
     ); $$
);
