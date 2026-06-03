-- Test-only table for the `test-pov-hook` edge function.
--
-- Lets Enrique fire JUST the POV-hook portion of the pipeline (no planner,
-- no scene gen, no main video concat, no publish) and review the rendered
-- 4s hook clip + snap caption in isolation. Each row tracks one isolated
-- hook generation: K0/K1 keyframes, the Vidu pair task, the resulting
-- hook clip, and the final composited test artifact.
--
-- Not referenced by the production pipeline -- only by the test-pov-hook
-- edge function. Safe to truncate any time.

create table if not exists public.hook_test_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  variant_index integer not null,
  variant_name text,
  vidu_task_id text,
  k0_asset_id uuid references public.assets(id) on delete set null,
  k1_asset_id uuid references public.assets(id) on delete set null,
  hook_clip_asset_id uuid references public.assets(id) on delete set null,
  final_video_url text,
  snap_text text,
  -- submitted | generating_keyframes | vidu_submitted | clip_ready | composed | failed
  status text default 'submitted',
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hook_test_runs_project_id_idx on public.hook_test_runs(project_id);
create index if not exists hook_test_runs_status_idx on public.hook_test_runs(status);
create index if not exists hook_test_runs_created_at_idx on public.hook_test_runs(created_at desc);
