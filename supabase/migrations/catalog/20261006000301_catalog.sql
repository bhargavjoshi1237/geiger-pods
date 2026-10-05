-- S03 API catalog & routing: apis, REST resources/methods, HTTP/WS routes.
-- Draft tables; the runtime reads compiled artifacts (S05), never these.
-- Invariants live in lib/control (service) + constraints/indexes here:
-- unique names/paths/keys among non-deleted rows, path_part grammar,
-- and a trigger that maintains rest_resources.path from the parent.
-- Sibling rules (one variable part per level, greedy-is-leaf) are service
-- checks backed by the unique (api_id, path) index.
--
-- @up
create table if not exists pods.apis (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  public_id text not null,
  name text not null,
  description text not null default '',
  protocol text not null check (protocol in ('REST', 'HTTP', 'WEBSOCKET')),
  api_version text,
  endpoint_type text not null default 'REGIONAL' check (endpoint_type in ('REGIONAL', 'EDGE', 'PRIVATE')),
  ip_address_type text not null default 'ipv4' check (ip_address_type in ('ipv4', 'dualstack')),
  disable_default_endpoint boolean not null default false,
  api_key_source text not null default 'HEADER' check (api_key_source in ('HEADER', 'AUTHORIZER')),
  api_key_selection_expression text,
  binary_media_types text[] not null default '{}',
  minimum_compression_size integer check (minimum_compression_size is null or (minimum_compression_size >= 0 and minimum_compression_size <= 10485760)),
  route_selection_expression text,
  cors jsonb,
  resource_policy jsonb,
  missing_route_behavior text not null default 'aws' check (missing_route_behavior in ('aws', 'not_found')),
  tags jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

create unique index if not exists apis_public_id_uidx on pods.apis (public_id);
create unique index if not exists apis_project_name_uidx on pods.apis (project_id, name) where deleted_at is null;

create table if not exists pods.rest_resources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  parent_id uuid references pods.rest_resources(id) on delete cascade,
  path_part text not null,
  path text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  check (parent_id is not null or path_part = ''),
  check (
    path_part = ''
    or path_part ~ '^[A-Za-z0-9._~:@!$&''()*,;=-]+$'
    or path_part ~ '^\{[A-Za-z_][A-Za-z0-9_.-]*\+?\}$'
  )
);

create unique index if not exists rest_resources_api_path_uidx on pods.rest_resources (api_id, path) where deleted_at is null;
create index if not exists rest_resources_api_idx on pods.rest_resources (api_id);
create index if not exists rest_resources_parent_idx on pods.rest_resources (parent_id);

-- Maintains path from the parent (root is "/"). Fires on insert and on
-- parent/path_part updates only, so the service can rewrite a renamed
-- branch's descendant paths explicitly without fighting the trigger.
create or replace function pods.rest_resource_path()
returns trigger
language plpgsql
as $$
declare
  parent_path text;
begin
  if NEW.parent_id is null then
    NEW.path := '/';
  else
    select path into parent_path from pods.rest_resources where id = NEW.parent_id;
    if not found then
      raise exception 'rest_resources parent % not found', NEW.parent_id;
    end if;
    if parent_path = '/' then
      NEW.path := '/' || NEW.path_part;
    else
      NEW.path := parent_path || '/' || NEW.path_part;
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists rest_resources_path on pods.rest_resources;
create trigger rest_resources_path
before insert or update of parent_id, path_part on pods.rest_resources
for each row execute function pods.rest_resource_path();

create table if not exists pods.rest_methods (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  resource_id uuid not null references pods.rest_resources(id) on delete cascade,
  http_method text not null check (http_method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY')),
  authorization_type text not null default 'NONE' check (authorization_type in ('NONE', 'SIGNED', 'JWT', 'CUSTOM')),
  authorizer_id uuid,
  authorization_scopes text[] not null default '{}',
  api_key_required boolean not null default false,
  operation_name text not null default '',
  request_validator_id uuid,
  request_parameters jsonb not null default '{}'::jsonb,
  request_models jsonb not null default '{}'::jsonb,
  integration_id uuid,
  settings jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

create unique index if not exists rest_methods_resource_method_uidx on pods.rest_methods (resource_id, http_method) where deleted_at is null;
create index if not exists rest_methods_api_idx on pods.rest_methods (api_id);
create index if not exists rest_methods_resource_idx on pods.rest_methods (resource_id);

create table if not exists pods.http_routes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  route_key text not null check (char_length(route_key) between 1 and 512),
  authorization_type text not null default 'NONE' check (authorization_type in ('NONE', 'SIGNED', 'JWT', 'CUSTOM')),
  authorizer_id uuid,
  authorization_scopes text[] not null default '{}',
  api_key_required boolean not null default false,
  integration_id uuid,
  operation_name text not null default '',
  request_parameters jsonb not null default '{}'::jsonb,
  request_models jsonb not null default '{}'::jsonb,
  model_selection_expression text,
  route_response_selection_expression text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

create unique index if not exists http_routes_api_key_uidx on pods.http_routes (api_id, route_key) where deleted_at is null;
create index if not exists http_routes_api_idx on pods.http_routes (api_id);

drop trigger if exists apis_touch_updated_at on pods.apis;
create trigger apis_touch_updated_at
before update on pods.apis
for each row execute function pods.touch_updated_at();

drop trigger if exists rest_resources_touch_updated_at on pods.rest_resources;
create trigger rest_resources_touch_updated_at
before update on pods.rest_resources
for each row execute function pods.touch_updated_at();

drop trigger if exists rest_methods_touch_updated_at on pods.rest_methods;
create trigger rest_methods_touch_updated_at
before update on pods.rest_methods
for each row execute function pods.touch_updated_at();

drop trigger if exists http_routes_touch_updated_at on pods.http_routes;
create trigger http_routes_touch_updated_at
before update on pods.http_routes
for each row execute function pods.touch_updated_at();

alter table pods.apis enable row level security;
alter table pods.rest_resources enable row level security;
alter table pods.rest_methods enable row level security;
alter table pods.http_routes enable row level security;

drop policy if exists apis_read on pods.apis;
create policy apis_read on pods.apis
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists apis_insert on pods.apis;
create policy apis_insert on pods.apis
  for insert to authenticated with check (pods.can('pods.api.create', project_id));

-- Updates cover edits (pods.api.update) and soft deletes (pods.api.delete);
-- the service layer enforces the exact one. No hard-delete policy.
drop policy if exists apis_update on pods.apis;
create policy apis_update on pods.apis
  for update to authenticated
  using (pods.can('pods.api.update', project_id) or pods.can('pods.api.delete', project_id))
  with check (pods.can('pods.api.update', project_id) or pods.can('pods.api.delete', project_id));

drop policy if exists rest_resources_read on pods.rest_resources;
create policy rest_resources_read on pods.rest_resources
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists rest_resources_write on pods.rest_resources;
create policy rest_resources_write on pods.rest_resources
  for all to authenticated
  using (pods.can('pods.route.write', project_id, api_id))
  with check (pods.can('pods.route.write', project_id, api_id));

drop policy if exists rest_methods_read on pods.rest_methods;
create policy rest_methods_read on pods.rest_methods
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists rest_methods_write on pods.rest_methods;
create policy rest_methods_write on pods.rest_methods
  for all to authenticated
  using (pods.can('pods.route.write', project_id, api_id))
  with check (pods.can('pods.route.write', project_id, api_id));

drop policy if exists http_routes_read on pods.http_routes;
create policy http_routes_read on pods.http_routes
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists http_routes_write on pods.http_routes;
create policy http_routes_write on pods.http_routes
  for all to authenticated
  using (pods.can('pods.route.write', project_id, api_id))
  with check (pods.can('pods.route.write', project_id, api_id));

-- @down
drop policy if exists http_routes_write on pods.http_routes;
drop policy if exists http_routes_read on pods.http_routes;
drop policy if exists rest_methods_write on pods.rest_methods;
drop policy if exists rest_methods_read on pods.rest_methods;
drop policy if exists rest_resources_write on pods.rest_resources;
drop policy if exists rest_resources_read on pods.rest_resources;
drop policy if exists apis_update on pods.apis;
drop policy if exists apis_insert on pods.apis;
drop policy if exists apis_read on pods.apis;
drop trigger if exists http_routes_touch_updated_at on pods.http_routes;
drop trigger if exists rest_methods_touch_updated_at on pods.rest_methods;
drop trigger if exists rest_resources_touch_updated_at on pods.rest_resources;
drop trigger if exists apis_touch_updated_at on pods.apis;
drop table if exists pods.http_routes;
drop table if exists pods.rest_methods;
drop trigger if exists rest_resources_path on pods.rest_resources;
drop function if exists pods.rest_resource_path();
drop table if exists pods.rest_resources;
drop table if exists pods.apis;
