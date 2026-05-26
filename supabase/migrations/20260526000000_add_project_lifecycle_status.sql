-- Channel lifecycle tracking: a tag (testing -> awaiting_monetization -> monetized)
-- plus a manually-set review/kill due date for channels still in testing.
-- Drives the lifecycle badge and the "review due / overdue" indicator on project cards.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'project_lifecycle') then
    create type public.project_lifecycle as enum ('testing', 'awaiting_monetization', 'monetized');
  end if;
end$$;

alter table public.projects
  add column if not exists lifecycle_status public.project_lifecycle not null default 'testing',
  add column if not exists testing_due_date date;

comment on column public.projects.lifecycle_status is 'Channel lifecycle stage: testing -> awaiting_monetization -> monetized. Drives the lifecycle badge and the testing review-due indicator in the UI.';
comment on column public.projects.testing_due_date is 'For lifecycle_status=testing only: the review date by which the channel must clear the analytics bar or be killed. Set manually by the operator.';
