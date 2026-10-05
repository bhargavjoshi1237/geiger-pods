-- S05 deployments, stages & runtime host: immutable deployment artifacts,
-- mutable stage pointers and append-only stage history.
--
-- Draft tables live in S03 (catalog) and S04 (integrations); the runtime reads
-- compiled artifacts stored here, never draft tables.
--
-- @up
create table if not exists pods.deployments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  public_id text not null,
  description text not null default '',
  artifact jsonb not null,
  digest text not null,
  schema_version integer not null default 1,
  warnings jsonb not null default '[]'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- Identical redeploys are allowed (AWS creates a new deployment each time),
-- so there is no unique (api_id, digest) constraint.
create index if not exists deployments_api_created_idx on pods.deployments (api_id, created_at desc);
create unique index if not exists deployments_api_public_uniq on pods.deployments (api_id, public_id);

create table if not exists pods.stages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 128),
  deployment_id uuid references pods.deployments(id) on delete restrict,
  description text not null default '',
  variables jsonb not null default '{}'::jsonb,
  auto_deploy boolean not null default false,
  client_certificate_id uuid,
  default_route_settings jsonb not null default '{}'::jsonb,
  route_settings jsonb not null default '{}'::jsonb,
  method_settings jsonb not null default '{}'::jsonb,
  access_log jsonb,
  tracing_enabled boolean not null default false,
  cache_cluster_enabled boolean not null default false,
  cache_cluster_size text,
  canary jsonb,
  last_deployment_status_message text,
  tags jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create unique index if not exists stages_api_name_uniq on pods.stages (api_id, name);
create index if not exists stages_api_idx on pods.stages (api_id);

create table if not exists pods.stage_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  stage_id uuid not null references pods.stages(id) on delete cascade,
  from_deployment_id uuid references pods.deployments(id) on delete set null,
  to_deployment_id uuid references pods.deployments(id) on delete set null,
  reason text not null check (reason in ('deploy', 'rollback', 'auto_deploy', 'canary_promote')),
  actor_id uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists stage_history_stage_idx on pods.stage_history (stage_id, created_at desc);

drop trigger if exists stages_touch_updated_at on pods.stages;
create trigger stages_touch_updated_at
before update on pods.stages
for each row execute function pods.touch_updated_at();

-- Changing deployment_id requires pods.stage.promote; other stage writes need
-- pods.stage.write. The service layer enforces the same split; this trigger is
-- defense in depth so direct SQL cannot promote without the key.
create or replace function pods.stage_promote_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if NEW.deployment_id is distinct from OLD.deployment_id then
    if not pods.can('pods.stage.promote', NEW.project_id, NEW.api_id) then
      raise exception 'forbidden: pods.stage.promote is required to move a stage';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists stages_promote_guard on pods.stages;
create trigger stages_promote_guard
before update of deployment_id on pods.stages
for each row execute function pods.stage_promote_guard();

alter table pods.deployments enable row level security;
alter table pods.stages enable row level security;
alter table pods.stage_history enable row level security;

drop policy if exists deployments_read on pods.deployments;
create policy deployments_read on pods.deployments
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists deployments_insert on pods.deployments;
create policy deployments_insert on pods.deployments
  for insert to authenticated with check (pods.can('pods.deployment.create', project_id, api_id));

-- Deployments are immutable: no update or delete policy for members.
-- Deletes go through the service (unreferenced only) with pods.stage.delete.

drop policy if exists stages_read on pods.stages;
create policy stages_read on pods.stages
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists stages_insert on pods.stages;
create policy stages_insert on pods.stages
  for insert to authenticated with check (pods.can('pods.stage.write', project_id, api_id));

drop policy if exists stages_update on pods.stages;
create policy stages_update on pods.stages
  for update to authenticated
  using (pods.can('pods.stage.write', project_id, api_id))
  with check (pods.can('pods.stage.write', project_id, api_id));

-- No delete policy: stage deletes go through the service with pods.stage.delete.

drop policy if exists stage_history_read on pods.stage_history;
create policy stage_history_read on pods.stage_history
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists stage_history_insert on pods.stage_history;
create policy stage_history_insert on pods.stage_history
  for insert to authenticated with check (
    pods.can('pods.stage.write', project_id) or pods.can('pods.stage.promote', project_id)
  );

-- @down
drop policy if exists stage_history_insert on pods.stage_history;
drop policy if exists stage_history_read on pods.stage_history;
drop policy if exists stages_update on pods.stages;
drop policy if exists stages_insert on pods.stages;
drop policy if exists stages_read on pods.stages;
drop policy if exists deployments_insert on pods.deployments;
drop policy if exists deployments_read on pods.deployments;
drop trigger if exists stages_promote_guard on pods.stages;
drop function if exists pods.stage_promote_guard();
drop trigger if exists stages_touch_updated_at on pods.stages;
drop index if exists pods.stage_history_stage_idx;
drop table if exists pods.stage_history;
drop index if exists pods.stages_api_idx;
drop index if exists pods.stages_api_name_uniq;
drop table if exists pods.stages;
drop index if exists pods.deployments_api_public_uniq;
drop index if exists pods.deployments_api_created_idx;
drop table if exists pods.deployments;
