-- S02 data foundation: management audit trail (CloudTrail equivalent).
-- Append-only: updates and deletes are rejected by trigger. Users read through
-- the pods.audit.view policy; writes go through pods.audit() or the service
-- role. Credential-shaped keys are redacted by the writer, not by the schema.
--
-- @up
create table if not exists pods.audit_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  actor_id uuid,
  actor_type text not null default 'user' check (actor_type in ('user', 'token', 'system')),
  action text not null,
  resource_type text not null,
  resource_id text,
  api_id uuid,
  before jsonb,
  after jsonb,
  request_id text,
  source_ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_project_time_idx
  on pods.audit_events (project_id, created_at desc);
create index if not exists audit_events_project_resource_idx
  on pods.audit_events (project_id, resource_type, resource_id);

create or replace function pods.reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

drop trigger if exists audit_events_no_update on pods.audit_events;
create trigger audit_events_no_update
before update or delete on pods.audit_events
for each row execute function pods.reject_audit_mutation();

alter table pods.audit_events enable row level security;

drop policy if exists audit_events_read on pods.audit_events;
create policy audit_events_read on pods.audit_events
  for select to authenticated using (pods.can('pods.audit.view', project_id));

-- No insert/update/delete policies for authenticated: rows are written by the
-- service role or by pods.audit() (security definer).

-- @down
drop policy if exists audit_events_read on pods.audit_events;
drop trigger if exists audit_events_no_update on pods.audit_events;
drop function if exists pods.reject_audit_mutation();
drop index if exists pods.audit_events_project_resource_idx;
drop index if exists pods.audit_events_project_time_idx;
drop table if exists pods.audit_events;
