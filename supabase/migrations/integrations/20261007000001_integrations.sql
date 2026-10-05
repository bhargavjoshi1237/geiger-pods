-- S04 integrations: integration configs, REST/WS integration responses,
-- private connectors (+ tokens) and backend client certificates.
--
-- Sorts after S03's catalog migration (later timestamp): pods.apis exists.
--
-- @up
create table if not exists pods.integrations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  public_id text not null,
  type text not null check (type in ('HTTP_PROXY', 'HTTP', 'MOCK', 'FUNCTION_PROXY', 'FUNCTION', 'AWS_SERVICE')),
  integration_method text not null default 'ANY',
  uri text,
  function jsonb,
  aws jsonb,
  connection_type text not null default 'INTERNET' check (connection_type in ('INTERNET', 'CONNECTOR')),
  connector_id uuid references pods.connectors(id) on delete set null,
  timeout_ms integer not null default 29000 check (timeout_ms >= 50 and timeout_ms <= 300000),
  payload_format_version text not null default '1.0' check (payload_format_version in ('1.0', '2.0')),
  passthrough_behavior text not null default 'WHEN_NO_MATCH' check (passthrough_behavior in ('WHEN_NO_MATCH', 'WHEN_NO_TEMPLATES', 'NEVER')),
  content_handling text check (content_handling in ('CONVERT_TO_TEXT', 'CONVERT_TO_BINARY')),
  request_parameters jsonb not null default '{}'::jsonb,
  request_templates jsonb not null default '{}'::jsonb,
  response_parameters jsonb not null default '{}'::jsonb,
  cache_key_parameters jsonb not null default '[]'::jsonb,
  cache_namespace text,
  response_transfer_mode text not null default 'BUFFERED' check (response_transfer_mode in ('BUFFERED', 'STREAM')),
  tls jsonb not null default '{"insecureSkipVerification": false, "serverNameToVerify": null}'::jsonb,
  backend_auth jsonb,
  description text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

create unique index if not exists integrations_api_public_uniq
  on pods.integrations (api_id, public_id) where deleted_at is null;
create index if not exists integrations_api_idx
  on pods.integrations (api_id) where deleted_at is null;

drop trigger if exists integrations_touch_updated_at on pods.integrations;
create trigger integrations_touch_updated_at
before update on pods.integrations
for each row execute function pods.touch_updated_at();

create table if not exists pods.integration_responses (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references pods.integrations(id) on delete cascade,
  status_code integer not null check (status_code >= 100 and status_code <= 599),
  selection_pattern text,
  response_parameters jsonb not null default '{}'::jsonb,
  response_templates jsonb not null default '{}'::jsonb,
  content_handling text check (content_handling in ('CONVERT_TO_TEXT', 'CONVERT_TO_BINARY')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

create index if not exists integration_responses_integration_idx
  on pods.integration_responses (integration_id) where deleted_at is null;

drop trigger if exists integration_responses_touch_updated_at on pods.integration_responses;
create trigger integration_responses_touch_updated_at
before update on pods.integration_responses
for each row execute function pods.touch_updated_at();

create table if not exists pods.connectors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'AVAILABLE', 'DEGRADED', 'FAILED', 'DELETING')),
  status_message text,
  allowed_targets text[] not null default '{}',
  agent_count integer not null default 0,
  last_seen_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

create unique index if not exists connectors_project_name_uniq
  on pods.connectors (project_id, name) where deleted_at is null;

drop trigger if exists connectors_touch_updated_at on pods.connectors;
create trigger connectors_touch_updated_at
before update on pods.connectors
for each row execute function pods.touch_updated_at();

create table if not exists pods.connector_tokens (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references pods.connectors(id) on delete cascade,
  token_hash text not null,
  prefix text not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index if not exists connector_tokens_hash_uniq
  on pods.connector_tokens (token_hash);
create index if not exists connector_tokens_connector_idx
  on pods.connector_tokens (connector_id);

create table if not exists pods.client_certificates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  public_id text not null,
  description text,
  certificate_pem text not null,
  private_key_ref text not null,
  expires_at timestamptz not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

create unique index if not exists client_certificates_project_public_uniq
  on pods.client_certificates (project_id, public_id) where deleted_at is null;

alter table pods.integrations enable row level security;
alter table pods.integration_responses enable row level security;
alter table pods.connectors enable row level security;
alter table pods.connector_tokens enable row level security;
alter table pods.client_certificates enable row level security;

-- Integrations: readable by project members, writable with the API-scoped key.
drop policy if exists integrations_read on pods.integrations;
create policy integrations_read on pods.integrations
  for select to authenticated using (pods.is_member(project_id) and deleted_at is null);

drop policy if exists integrations_write on pods.integrations;
create policy integrations_write on pods.integrations
  for all to authenticated
  using (pods.can('pods.integration.write', project_id, api_id))
  with check (pods.can('pods.integration.write', project_id, api_id));

drop policy if exists integration_responses_read on pods.integration_responses;
create policy integration_responses_read on pods.integration_responses
  for select to authenticated using (
    exists (
      select 1 from pods.integrations i
      where i.id = integration_id
        and pods.is_member(i.project_id)
        and i.deleted_at is null
    )
    and deleted_at is null
  );

drop policy if exists integration_responses_write on pods.integration_responses;
create policy integration_responses_write on pods.integration_responses
  for all to authenticated
  using (
    exists (
      select 1 from pods.integrations i
      where i.id = integration_id
        and pods.can('pods.integration.write', i.project_id, i.api_id)
    )
  )
  with check (
    exists (
      select 1 from pods.integrations i
      where i.id = integration_id
        and pods.can('pods.integration.write', i.project_id, i.api_id)
    )
  );

-- Connectors: readable by members; writes and token metadata need the key.
drop policy if exists connectors_read on pods.connectors;
create policy connectors_read on pods.connectors
  for select to authenticated using (pods.is_member(project_id) and deleted_at is null);

drop policy if exists connectors_write on pods.connectors;
create policy connectors_write on pods.connectors
  for all to authenticated
  using (pods.can('pods.connector.write', project_id))
  with check (pods.can('pods.connector.write', project_id));

-- Token hashes never go to members; the service role manages them and the
-- management API only returns metadata after its own permission check.
drop policy if exists connector_tokens_read on pods.connector_tokens;
create policy connector_tokens_read on pods.connector_tokens
  for select to authenticated using (
    exists (
      select 1 from pods.connectors c
      where c.id = connector_id
        and pods.can('pods.connector.write', c.project_id)
        and c.deleted_at is null
    )
  );

-- Client certificates: public PEMs readable by members, writes gated.
drop policy if exists client_certificates_read on pods.client_certificates;
create policy client_certificates_read on pods.client_certificates
  for select to authenticated using (pods.is_member(project_id) and deleted_at is null);

drop policy if exists client_certificates_write on pods.client_certificates;
create policy client_certificates_write on pods.client_certificates
  for all to authenticated
  using (pods.can('pods.client_cert.write', project_id))
  with check (pods.can('pods.client_cert.write', project_id));

-- @down
drop policy if exists client_certificates_write on pods.client_certificates;
drop policy if exists client_certificates_read on pods.client_certificates;
drop policy if exists connector_tokens_read on pods.connector_tokens;
drop policy if exists connectors_write on pods.connectors;
drop policy if exists connectors_read on pods.connectors;
drop policy if exists integration_responses_write on pods.integration_responses;
drop policy if exists integration_responses_read on pods.integration_responses;
drop policy if exists integrations_write on pods.integrations;
drop policy if exists integrations_read on pods.integrations;
drop index if exists pods.client_certificates_project_public_uniq;
drop table if exists pods.client_certificates;
drop index if exists pods.connector_tokens_connector_idx;
drop index if exists pods.connector_tokens_hash_uniq;
drop table if exists pods.connector_tokens;
drop trigger if exists connectors_touch_updated_at on pods.connectors;
drop index if exists pods.connectors_project_name_uniq;
drop table if exists pods.connectors;
drop trigger if exists integration_responses_touch_updated_at on pods.integration_responses;
drop index if exists pods.integration_responses_integration_idx;
drop table if exists pods.integration_responses;
drop trigger if exists integrations_touch_updated_at on pods.integrations;
drop index if exists pods.integrations_api_idx;
drop index if exists pods.integrations_api_public_uniq;
drop table if exists pods.integrations;
