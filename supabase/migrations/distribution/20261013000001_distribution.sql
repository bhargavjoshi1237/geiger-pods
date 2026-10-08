-- S13 developer distribution (parts A/B): documentation parts & versions.
--
-- `pods.documentation_parts` holds OpenAPI-style properties keyed by
-- location `{type, path, method, statusCode, name}`, unique per API by a
-- canonical `location_key`, capped at 2000 parts (service-enforced).
-- `pods.documentation_versions` freezes a snapshot of all parts at
-- creation time (write-once; later part edits never touch it).
-- `pods.stages.documentation_version` associates a version with a stage;
-- export and portals read the stage's version.
--
-- Sorts after S03 (catalog) and S05 (releases): references pods.apis and
-- alters pods.stages.
--
-- @up
create table if not exists pods.documentation_parts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  location jsonb not null,
  location_key text not null,
  properties jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create unique index if not exists documentation_parts_api_location_uniq
  on pods.documentation_parts (api_id, location_key);
create index if not exists documentation_parts_api_idx
  on pods.documentation_parts (api_id);

create table if not exists pods.documentation_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  version text not null check (char_length(version) between 1 and 64),
  description text not null default '',
  snapshot jsonb not null default '[]'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create unique index if not exists documentation_versions_api_version_uniq
  on pods.documentation_versions (api_id, version);
create index if not exists documentation_versions_api_idx
  on pods.documentation_versions (api_id);

alter table pods.stages
  add column if not exists documentation_version text;

drop trigger if exists documentation_parts_touch_updated_at on pods.documentation_parts;
create trigger documentation_parts_touch_updated_at
before update on pods.documentation_parts
for each row execute function pods.touch_updated_at();

alter table pods.documentation_parts enable row level security;
alter table pods.documentation_versions enable row level security;

drop policy if exists documentation_parts_read on pods.documentation_parts;
create policy documentation_parts_read on pods.documentation_parts
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists documentation_parts_write on pods.documentation_parts;
create policy documentation_parts_write on pods.documentation_parts
  for all to authenticated
  using (pods.can('pods.documentation.write', project_id, api_id))
  with check (pods.can('pods.documentation.write', project_id, api_id));

drop policy if exists documentation_versions_read on pods.documentation_versions;
create policy documentation_versions_read on pods.documentation_versions
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists documentation_versions_insert on pods.documentation_versions;
create policy documentation_versions_insert on pods.documentation_versions
  for insert to authenticated
  with check (pods.can('pods.documentation.write', project_id, api_id));

-- @down
drop policy if exists documentation_versions_insert on pods.documentation_versions;
drop policy if exists documentation_versions_read on pods.documentation_versions;
drop policy if exists documentation_parts_write on pods.documentation_parts;
drop policy if exists documentation_parts_read on pods.documentation_parts;
drop trigger if exists documentation_parts_touch_updated_at on pods.documentation_parts;
alter table pods.stages drop column if exists documentation_version;
drop index if exists pods.documentation_versions_api_idx;
drop index if exists pods.documentation_versions_api_version_uniq;
drop table if exists pods.documentation_versions;
drop index if exists pods.documentation_parts_api_idx;
drop index if exists pods.documentation_parts_api_location_uniq;
drop table if exists pods.documentation_parts;
