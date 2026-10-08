-- S11 custom domains, TLS, mTLS trust stores, routing rules and private
-- access associations.
--
-- `pods.domain_names.domain_name` is globally unique among non-deleted rows
-- across all projects (partial unique index). Certificates: the chain is
-- public data (`certificate_chain_pem`); the key lives behind
-- `certificate_key_ref` (vault `client_certificate` kind, project-scoped at
-- resolve time). Tests store both inline; production resolves the ref
-- through `ports.secrets.forProject`.
--
-- @up
create table if not exists pods.domain_names (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  domain_name text not null check (char_length(domain_name) between 1 and 253),
  endpoint_type text not null default 'REGIONAL' check (endpoint_type in ('REGIONAL', 'EDGE', 'PRIVATE')),
  ip_address_type text not null default 'ipv4' check (ip_address_type in ('ipv4', 'dualstack')),
  security_policy text not null default 'TLS_1_2',
  certificate_mode text not null default 'managed' check (certificate_mode in ('managed', 'imported')),
  certificate_chain_pem text,
  certificate_key_ref text,
  certificate_expires_at timestamptz,
  verification_token text not null,
  status text not null default 'PENDING_VERIFICATION'
    check (status in ('PENDING_VERIFICATION', 'PENDING_CERTIFICATE', 'AVAILABLE', 'UPDATING', 'FAILED')),
  status_message text,
  target_hostname text not null,
  routing_mode text not null default 'API_MAPPING_ONLY'
    check (routing_mode in ('API_MAPPING_ONLY', 'ROUTING_RULE_THEN_API_MAPPING', 'ROUTING_RULE_ONLY')),
  mtls jsonb,
  policy jsonb,
  tags jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

create unique index if not exists domain_names_name_uniq on pods.domain_names (domain_name) where deleted_at is null;
create index if not exists domain_names_project_idx on pods.domain_names (project_id) where deleted_at is null;

create table if not exists pods.api_mappings (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references pods.domain_names(id) on delete cascade,
  api_id uuid not null,
  stage_name text not null check (char_length(stage_name) between 1 and 128),
  base_path text not null default '',
  created_at timestamptz not null default now(),
  unique (domain_id, base_path)
);

create index if not exists api_mappings_domain_idx on pods.api_mappings (domain_id);

create table if not exists pods.routing_rules (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references pods.domain_names(id) on delete cascade,
  priority integer not null check (priority between 1 and 1000000),
  conditions jsonb not null default '{}'::jsonb,
  action jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (domain_id, priority)
);

create index if not exists routing_rules_domain_idx on pods.routing_rules (domain_id);

create table if not exists pods.trust_stores (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 128),
  pem_bundle text not null,
  cert_count integer not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  crl_pem text,
  versions jsonb not null default '[]'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create index if not exists trust_stores_project_idx on pods.trust_stores (project_id);

create table if not exists pods.domain_access_associations (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references pods.domain_names(id) on delete cascade,
  connector_id uuid not null,
  created_at timestamptz not null default now(),
  unique (domain_id, connector_id)
);

drop trigger if exists domain_names_touch_updated_at on pods.domain_names;
create trigger domain_names_touch_updated_at
before update on pods.domain_names
for each row execute function pods.touch_updated_at();

drop trigger if exists trust_stores_touch_updated_at on pods.trust_stores;
create trigger trust_stores_touch_updated_at
before update on pods.trust_stores
for each row execute function pods.touch_updated_at();

alter table pods.domain_names enable row level security;
alter table pods.api_mappings enable row level security;
alter table pods.routing_rules enable row level security;
alter table pods.trust_stores enable row level security;
alter table pods.domain_access_associations enable row level security;

drop policy if exists domain_names_read on pods.domain_names;
create policy domain_names_read on pods.domain_names
  for select to authenticated using (pods.can('pods.domain.write', project_id));

drop policy if exists domain_names_write on pods.domain_names;
create policy domain_names_write on pods.domain_names
  for all to authenticated
  using (pods.can('pods.domain.write', project_id))
  with check (pods.can('pods.domain.write', project_id));

drop policy if exists api_mappings_read on pods.api_mappings;
create policy api_mappings_read on pods.api_mappings
  for select to authenticated using (
    exists (select 1 from pods.domain_names domain
      where domain.id = api_mappings.domain_id
        and pods.can('pods.domain.write', domain.project_id))
  );

drop policy if exists api_mappings_write on pods.api_mappings;
create policy api_mappings_write on pods.api_mappings
  for all to authenticated
  using (
    exists (select 1 from pods.domain_names domain
      where domain.id = api_mappings.domain_id
        and pods.can('pods.domain.write', domain.project_id))
  )
  with check (
    exists (select 1 from pods.domain_names domain
      where domain.id = api_mappings.domain_id
        and pods.can('pods.domain.write', domain.project_id))
  );

drop policy if exists routing_rules_read on pods.routing_rules;
create policy routing_rules_read on pods.routing_rules
  for select to authenticated using (
    exists (select 1 from pods.domain_names domain
      where domain.id = routing_rules.domain_id
        and pods.can('pods.domain.write', domain.project_id))
  );

drop policy if exists routing_rules_write on pods.routing_rules;
create policy routing_rules_write on pods.routing_rules
  for all to authenticated
  using (
    exists (select 1 from pods.domain_names domain
      where domain.id = routing_rules.domain_id
        and pods.can('pods.domain.write', domain.project_id))
  )
  with check (
    exists (select 1 from pods.domain_names domain
      where domain.id = routing_rules.domain_id
        and pods.can('pods.domain.write', domain.project_id))
  );

drop policy if exists trust_stores_read on pods.trust_stores;
create policy trust_stores_read on pods.trust_stores
  for select to authenticated using (pods.can('pods.trust_store.write', project_id));

drop policy if exists trust_stores_write on pods.trust_stores;
create policy trust_stores_write on pods.trust_stores
  for all to authenticated
  using (pods.can('pods.trust_store.write', project_id))
  with check (pods.can('pods.trust_store.write', project_id));

drop policy if exists domain_access_associations_read on pods.domain_access_associations;
create policy domain_access_associations_read on pods.domain_access_associations
  for select to authenticated using (
    exists (select 1 from pods.domain_names domain
      where domain.id = domain_access_associations.domain_id
        and pods.can('pods.domain.write', domain.project_id))
  );

drop policy if exists domain_access_associations_write on pods.domain_access_associations;
create policy domain_access_associations_write on pods.domain_access_associations
  for all to authenticated
  using (
    exists (select 1 from pods.domain_names domain
      where domain.id = domain_access_associations.domain_id
        and pods.can('pods.domain.write', domain.project_id))
  )
  with check (
    exists (select 1 from pods.domain_names domain
      where domain.id = domain_access_associations.domain_id
        and pods.can('pods.domain.write', domain.project_id))
  );

-- @down
drop policy if exists domain_access_associations_write on pods.domain_access_associations;
drop policy if exists domain_access_associations_read on pods.domain_access_associations;
drop policy if exists trust_stores_write on pods.trust_stores;
drop policy if exists trust_stores_read on pods.trust_stores;
drop policy if exists routing_rules_write on pods.routing_rules;
drop policy if exists routing_rules_read on pods.routing_rules;
drop policy if exists api_mappings_write on pods.api_mappings;
drop policy if exists api_mappings_read on pods.api_mappings;
drop policy if exists domain_names_write on pods.domain_names;
drop policy if exists domain_names_read on pods.domain_names;
drop trigger if exists trust_stores_touch_updated_at on pods.trust_stores;
drop trigger if exists domain_names_touch_updated_at on pods.domain_names;
drop table if exists pods.domain_access_associations;
drop table if exists pods.trust_stores;
drop table if exists pods.routing_rules;
drop index if exists pods.api_mappings_domain_idx;
drop table if exists pods.api_mappings;
drop index if exists pods.domain_names_project_idx;
drop index if exists pods.domain_names_name_uniq;
drop table if exists pods.domain_names;
