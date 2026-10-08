-- S12 WebSocket APIs: route responses (`$default` per route).
-- Draft table; the runtime reads the compiled artifact (S05), never this.
--
-- @up
create table if not exists pods.route_responses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  route_id uuid not null references pods.http_routes(id) on delete cascade,
  route_response_key text not null check (route_response_key = '$default'),
  response_models jsonb not null default '{}'::jsonb,
  model_selection_expression text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

create unique index if not exists route_responses_route_key_uidx
  on pods.route_responses (route_id, route_response_key) where deleted_at is null;
create index if not exists route_responses_api_idx on pods.route_responses (api_id);

-- WebSocket integration response selection (S12 §1).
alter table if exists pods.integrations
  add column if not exists integration_response_selection_expression text;

drop trigger if exists route_responses_touch_updated_at on pods.route_responses;
create trigger route_responses_touch_updated_at
before update on pods.route_responses
for each row execute function pods.touch_updated_at();

alter table pods.route_responses enable row level security;

drop policy if exists route_responses_read on pods.route_responses;
create policy route_responses_read on pods.route_responses
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists route_responses_write on pods.route_responses;
create policy route_responses_write on pods.route_responses
  for all to authenticated
  using (pods.can('pods.route.write', project_id, api_id))
  with check (pods.can('pods.route.write', project_id, api_id));

-- @down
drop policy if exists route_responses_write on pods.route_responses;
drop policy if exists route_responses_read on pods.route_responses;
drop trigger if exists route_responses_touch_updated_at on pods.route_responses;
alter table if exists pods.integrations drop column if exists integration_response_selection_expression;
drop index if exists pods.route_responses_api_idx;
drop index if exists pods.route_responses_route_key_uidx;
drop table if exists pods.route_responses;
