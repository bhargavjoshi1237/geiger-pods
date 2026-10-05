-- S07 consumer authorization: authorizers (JWT / TOKEN / REQUEST), project-level
-- signing credentials (SigV4 IAM equivalent) with identity policies, and the
-- resource-policy snapshot source.
--
-- Storage notes:
-- - `pods.authorizers` are per-API draft rows; the S05 compile step snapshots
--   them into the deployment artifact. Secrets are never stored here, only
--   `credentials_ref` (`secret:<id>`) pointers into the S02 vault.
-- - `pods.signing_credentials` holds the access key id + vault `secret_ref`;
--   the secret access key itself lives in the vault and is shown once.
-- - The REST resource policy lives on the S03 `pods.apis.resource_policy`
--   column (no new table); edits are service-gated on
--   `pods.resource_policy.write` (see lib/control/resource-policies.mjs).
--   The `apis_update` RLS policy (S03-owned, `pods.api.update`) stays the
--   row-level gate; only admin/owner hold both keys.
--
-- @up
create table if not exists pods.authorizers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  public_id text not null,
  name text not null,
  type text not null check (type in ('JWT', 'TOKEN', 'REQUEST')),
  identity_source text[] not null default '{}',
  identity_validation_expression text,
  jwt jsonb,
  function jsonb,
  payload_format_version text check (payload_format_version is null or payload_format_version in ('1.0', '2.0')),
  enable_simple_responses boolean not null default false,
  result_ttl_seconds integer not null default 300 check (result_ttl_seconds >= 0 and result_ttl_seconds <= 3600),
  timeout_ms integer not null default 10000 check (timeout_ms >= 1000 and timeout_ms <= 29000),
  credentials_ref text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create unique index if not exists authorizers_api_public_uniq on pods.authorizers (api_id, public_id);
create unique index if not exists authorizers_api_name_uniq on pods.authorizers (api_id, name);
create index if not exists authorizers_api_idx on pods.authorizers (api_id);

drop trigger if exists authorizers_touch_updated_at on pods.authorizers;
create trigger authorizers_touch_updated_at
before update on pods.authorizers
for each row execute function pods.touch_updated_at();

create table if not exists pods.signing_credentials (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  access_key_id text not null,
  secret_ref text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  last_used_at timestamptz,
  expires_at timestamptz,
  tags jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create unique index if not exists signing_credentials_access_key_uniq on pods.signing_credentials (access_key_id);
create unique index if not exists signing_credentials_project_name_uniq on pods.signing_credentials (project_id, name);
create index if not exists signing_credentials_project_idx on pods.signing_credentials (project_id);

drop trigger if exists signing_credentials_touch_updated_at on pods.signing_credentials;
create trigger signing_credentials_touch_updated_at
before update on pods.signing_credentials
for each row execute function pods.touch_updated_at();

create table if not exists pods.signing_policies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  credential_id uuid not null references pods.signing_credentials(id) on delete cascade,
  name text not null,
  document jsonb not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create unique index if not exists signing_policies_credential_name_uniq on pods.signing_policies (credential_id, name);
create index if not exists signing_policies_credential_idx on pods.signing_policies (credential_id);

drop trigger if exists signing_policies_touch_updated_at on pods.signing_policies;
create trigger signing_policies_touch_updated_at
before update on pods.signing_policies
for each row execute function pods.touch_updated_at();

alter table pods.authorizers enable row level security;
alter table pods.signing_credentials enable row level security;
alter table pods.signing_policies enable row level security;

drop policy if exists authorizers_read on pods.authorizers;
create policy authorizers_read on pods.authorizers
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists authorizers_write on pods.authorizers;
create policy authorizers_write on pods.authorizers
  for all to authenticated
  using (pods.can('pods.authorizer.write', project_id, api_id))
  with check (pods.can('pods.authorizer.write', project_id, api_id));

drop policy if exists signing_credentials_read on pods.signing_credentials;
create policy signing_credentials_read on pods.signing_credentials
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists signing_credentials_write on pods.signing_credentials;
create policy signing_credentials_write on pods.signing_credentials
  for all to authenticated
  using (pods.can('pods.secret.write', project_id))
  with check (pods.can('pods.secret.write', project_id));

drop policy if exists signing_policies_read on pods.signing_policies;
create policy signing_policies_read on pods.signing_policies
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists signing_policies_write on pods.signing_policies;
create policy signing_policies_write on pods.signing_policies
  for all to authenticated
  using (pods.can('pods.secret.write', project_id))
  with check (pods.can('pods.secret.write', project_id));

-- @down
drop policy if exists signing_policies_write on pods.signing_policies;
drop policy if exists signing_policies_read on pods.signing_policies;
drop policy if exists signing_credentials_write on pods.signing_credentials;
drop policy if exists signing_credentials_read on pods.signing_credentials;
drop policy if exists authorizers_write on pods.authorizers;
drop policy if exists authorizers_read on pods.authorizers;
drop trigger if exists signing_policies_touch_updated_at on pods.signing_policies;
drop index if exists pods.signing_policies_credential_idx;
drop index if exists pods.signing_policies_credential_name_uniq;
drop table if exists pods.signing_policies;
drop trigger if exists signing_credentials_touch_updated_at on pods.signing_credentials;
drop index if exists pods.signing_credentials_project_idx;
drop index if exists pods.signing_credentials_project_name_uniq;
drop index if exists pods.signing_credentials_access_key_uniq;
drop table if exists pods.signing_credentials;
drop trigger if exists authorizers_touch_updated_at on pods.authorizers;
drop index if exists pods.authorizers_api_idx;
drop index if exists pods.authorizers_api_name_uniq;
drop index if exists pods.authorizers_api_public_uniq;
drop table if exists pods.authorizers;
