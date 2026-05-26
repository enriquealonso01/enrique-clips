-- Add a terminal 'killed' lifecycle status for channels that failed the
-- Day-40 review and were archived. Added in its own migration so the new
-- enum value is committed before any row is updated to use it.
alter type public.project_lifecycle add value if not exists 'killed';
