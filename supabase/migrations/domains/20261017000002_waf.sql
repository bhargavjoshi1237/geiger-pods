-- S11 WAF: IP sets, regex sets, web ACLs and stage associations.
--
-- @up
create table if not exists pods.ip_sets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 128),
  ip_version text not null check (ip_version in ('IPV4', 'IPV6')),
  addresses cidr[] not null default '{}',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create index if not exists ip_sets_project_idx on pods.ip_sets (project_id);

create table if not exists pods.regex_sets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 128),
  patterns text[] not null default '{}',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create index if not exists regex_sets_project_idx on pods.regex_sets (project_id);

create table if not exists pods.web_acls (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 128),
  default_action text not null default 'ALLOW' check (default_action in ('ALLOW', 'BLOCK')),
  rules jsonb not null default '[]'::jsonb,
  custom_responses jsonb not null default '{}'::jsonb,
  visibility jsonb not null default '{"sampledRequests": true, "metrics": true}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (project_id, name)
);

create index if not exists web_acls_project_idx on pods.web_acls (project_id);

create table if not exists pods.web_acl_associations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  web_acl_id uuid not null references pods.web_acls(id) on delete cascade,
  api_id uuid not null,
  stage_name text not null check (char_length(stage_name) between 1 and 128),
  created_at timestamptz not null default now(),
  unique (api_id, stage_name)
);

create index if not exists web_acl_associations_acl_idx on pods.web_acl_associations (web_acl_id);

drop trigger if exists ip_sets_touch_updated_at on pods.ip_sets;
create trigger ip_sets_touch_updated_at
before update on pods.ip_sets
for each row execute function pods.touch_updated_at();

drop trigger if exists regex_sets_touch_updated_at on pods.regex_sets;
create trigger regex_sets_touch_updated_at
before update on pods.regex_sets
for each row execute function pods.touch_updated_at();

drop trigger if exists web_acls_touch_updated_at on pods.web_acls;
create trigger web_acls_touch_updated_at
before update on pods.web_acls
for each row execute function pods.touch_updated_at();

alter table pods.ip_sets enable row level security;
alter table pods.regex_sets enable row level security;
alter table pods.web_acls enable row level security;
alter table pods.web_acl_associations enable row level security;

drop policy if exists ip_sets_read on pods.ip_sets;
create policy ip_sets_read on pods.ip_sets
  for select to authenticated using (pods.can('pods.waf.write', project_id));

drop policy if exists ip_sets_write on pods.ip_sets;
create policy ip_sets_write on pods.ip_sets
  for all to authenticated
  using (pods.can('pods.waf.write', project_id))
  with check (pods.can('pods.waf.write', project_id));

drop policy if exists regex_sets_read on pods.regex_sets;
create policy regex_sets_read on pods.regex_sets
  for select to authenticated using (pods.can('pods.waf.write', project_id));

drop policy if exists regex_sets_write on pods.regex_sets;
create policy regex_sets_write on pods.regex_sets
  for all to authenticated
  using (pods.can('pods.waf.write', project_id))
  with check (pods.can('pods.waf.write', project_id));

drop policy if exists web_acls_read on pods.web_acls;
create policy web_acls_read on pods.web_acls
  for select to authenticated using (pods.can('pods.waf.write', project_id));

drop policy if exists web_acls_write on pods.web_acls;
create policy web_acls_write on pods.web_acls
  for all to authenticated
  using (pods.can('pods.waf.write', project_id))
  with check (pods.can('pods.waf.write', project_id));

drop policy if exists web_acl_associations_read on pods.web_acl_associations;
create policy web_acl_associations_read on pods.web_acl_associations
  for select to authenticated using (pods.can('pods.waf.write', project_id));

drop policy if exists web_acl_associations_write on pods.web_acl_associations;
create policy web_acl_associations_write on pods.web_acl_associations
  for all to authenticated
  using (pods.can('pods.waf.write', project_id))
  with check (pods.can('pods.waf.write', project_id));

-- @down
drop policy if exists web_acl_associations_write on pods.web_acl_associations;
drop policy if exists web_acl_associations_read on pods.web_acl_associations;
drop policy if exists web_acls_write on pods.web_acls;
drop policy if exists web_acls_read on pods.web_acls;
drop policy if exists regex_sets_write on pods.regex_sets;
drop policy if exists regex_sets_read on pods.regex_sets;
drop policy if exists ip_sets_write on pods.ip_sets;
drop policy if exists ip_sets_read on pods.ip_sets;
drop trigger if exists web_acls_touch_updated_at on pods.web_acls;
drop trigger if exists regex_sets_touch_updated_at on pods.regex_sets;
drop trigger if exists ip_sets_touch_updated_at on pods.ip_sets;
drop index if exists pods.web_acl_associations_acl_idx;
drop table if exists pods.web_acl_associations;
drop index if exists pods.web_acls_project_idx;
drop table if exists pods.web_acls;
drop index if exists pods.regex_sets_project_idx;
drop table if exists pods.regex_sets;
drop index if exists pods.ip_sets_project_idx;
drop table if exists pods.ip_sets;
