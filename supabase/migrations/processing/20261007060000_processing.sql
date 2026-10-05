-- S06 request & response processing: models, request validators,
-- method responses and gateway-response customizations.
--
-- S03 (pods.rest_methods) and S04 (pods.integrations) land in parallel, so
-- this migration deliberately declares NO foreign keys to tables it does not
-- own: method_id/integration references are plain uuid/text columns validated
-- by the S05 compile step (validateProcessing). Foreign keys to the S03/S04
-- tables can be added once those migrations exist. project_id is stored
-- denormalized on every table so RLS can use pods.can() without joins.
--
-- @up
create table if not exists pods.models (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null,
  name text not null check (name ~ '^[A-Za-z0-9]{1,128}$'),
  content_type text not null default 'application/json',
  schema jsonb not null default '{}'::jsonb,
  description text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (api_id, name)
);

create table if not exists pods.request_validators (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null,
  name text not null,
  validate_request_body boolean not null default true,
  validate_request_parameters boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (api_id, name)
);

create table if not exists pods.method_responses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null,
  method_id uuid not null,
  status_code text not null check (status_code ~ '^[1-5][0-9][0-9]$'),
  response_parameters jsonb not null default '{}'::jsonb,
  response_models jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (method_id, status_code)
);

create table if not exists pods.gateway_responses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null,
  response_type text not null,
  status_code text,
  response_parameters jsonb not null default '{}'::jsonb,
  response_templates jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (api_id, response_type)
);

drop trigger if exists models_touch_updated_at on pods.models;
create trigger models_touch_updated_at
before update on pods.models
for each row execute function pods.touch_updated_at();

drop trigger if exists request_validators_touch_updated_at on pods.request_validators;
create trigger request_validators_touch_updated_at
before update on pods.request_validators
for each row execute function pods.touch_updated_at();

drop trigger if exists method_responses_touch_updated_at on pods.method_responses;
create trigger method_responses_touch_updated_at
before update on pods.method_responses
for each row execute function pods.touch_updated_at();

drop trigger if exists gateway_responses_touch_updated_at on pods.gateway_responses;
create trigger gateway_responses_touch_updated_at
before update on pods.gateway_responses
for each row execute function pods.touch_updated_at();

alter table pods.models enable row level security;
alter table pods.request_validators enable row level security;
alter table pods.method_responses enable row level security;
alter table pods.gateway_responses enable row level security;

drop policy if exists models_read on pods.models;
create policy models_read on pods.models
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists models_write on pods.models;
create policy models_write on pods.models
  for all to authenticated
  using (pods.can('pods.model.write', project_id))
  with check (pods.can('pods.model.write', project_id));

drop policy if exists request_validators_read on pods.request_validators;
create policy request_validators_read on pods.request_validators
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists request_validators_write on pods.request_validators;
create policy request_validators_write on pods.request_validators
  for all to authenticated
  using (pods.can('pods.model.write', project_id))
  with check (pods.can('pods.model.write', project_id));

drop policy if exists method_responses_read on pods.method_responses;
create policy method_responses_read on pods.method_responses
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists method_responses_write on pods.method_responses;
create policy method_responses_write on pods.method_responses
  for all to authenticated
  using (pods.can('pods.route.write', project_id))
  with check (pods.can('pods.route.write', project_id));

drop policy if exists gateway_responses_read on pods.gateway_responses;
create policy gateway_responses_read on pods.gateway_responses
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists gateway_responses_write on pods.gateway_responses;
create policy gateway_responses_write on pods.gateway_responses
  for all to authenticated
  using (pods.can('pods.gateway_response.write', project_id))
  with check (pods.can('pods.gateway_response.write', project_id));

-- @down
drop policy if exists gateway_responses_write on pods.gateway_responses;
drop policy if exists gateway_responses_read on pods.gateway_responses;
drop policy if exists method_responses_write on pods.method_responses;
drop policy if exists method_responses_read on pods.method_responses;
drop policy if exists request_validators_write on pods.request_validators;
drop policy if exists request_validators_read on pods.request_validators;
drop policy if exists models_write on pods.models;
drop policy if exists models_read on pods.models;
drop trigger if exists gateway_responses_touch_updated_at on pods.gateway_responses;
drop trigger if exists method_responses_touch_updated_at on pods.method_responses;
drop trigger if exists request_validators_touch_updated_at on pods.request_validators;
drop trigger if exists models_touch_updated_at on pods.models;
drop table if exists pods.gateway_responses;
drop table if exists pods.method_responses;
drop table if exists pods.request_validators;
drop table if exists pods.models;
