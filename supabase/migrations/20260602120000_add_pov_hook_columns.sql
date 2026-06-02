-- POV-hook track on runs.
-- Adds four nullable columns that are only ever populated when the project's
-- prompt_config_json has a top-level `pov_hook` block with `enabled: true`.
-- Every existing project lacks that block, so every existing and future run on
-- those projects keeps `pov_hook_status = 'not_started'` and behaves exactly
-- as it does today — no code path reads these columns unless the config asks.
--
-- pov_hook_status        — lifecycle marker ('not_started' | 'polling' | 'completed' | 'failed').
-- pov_hook_provider_id   — Vidu task_id for the hook clip, populated at submit time.
-- pov_hook_clip_asset_id — the row in assets that holds the rendered hook .mp4.
-- pov_hook_variant_index — index into pov_hook.variants that was crypto-picked at run start.

alter table public.runs
  add column if not exists pov_hook_status        text default 'not_started',
  add column if not exists pov_hook_provider_id   text,
  add column if not exists pov_hook_clip_asset_id uuid,
  add column if not exists pov_hook_variant_index integer;

-- Asset FK matches the pattern of scene_id on assets (on delete: null the link
-- but keep the run row intact).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'runs_pov_hook_clip_asset_id_fkey'
  ) then
    alter table public.runs
      add constraint runs_pov_hook_clip_asset_id_fkey
      foreign key (pov_hook_clip_asset_id)
      references public.assets(id)
      on delete set null;
  end if;
end $$;
