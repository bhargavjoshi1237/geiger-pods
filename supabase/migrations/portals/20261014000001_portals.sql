-- S13 developer portals (part D) + agent tool gateway stage config (part E).
--
-- `pods.portals` hold branding, OIDC access control, publish status and the
-- frozen `published_snapshot` (public reads serve the snapshot only).
-- `pods.portal_products` group endpoint pages; cross-project sharing lives in
-- `sharing jsonb {projects, organizations}`. Links, markdown pages, endpoint
-- pages and analytics events complete the model. `pods.stages.agent_tools`
-- is the per-stage MCP opt-in `{enabled, allowOperations[], auth}`.
--
-- RLS mirrors S02/S13: members read; writes need `pods.portal.write`;
-- publish additionally needs `pods.portal.publish` (service-enforced; the
-- policy keeps the write gate so snapshots stay consistent).
--
-- @up
create table if not exists pods.portals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 128),
  slug text not null,
  domain_id uuid,
  branding jsonb not null default '{}'::jsonb,
  access jsonb not null default '{"mode":"public"}'::jsonb,
  analytics_enabled boolean not null default false,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'DISABLED')),
  published_snapshot jsonb,
  published_at timestamptz,
  preview_token text not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create unique index if not exists portals_slug_uniq
  on pods.portals (slug);
create index if not exists portals_project_idx
  on pods.portals (project_id);

create table if not exists pods.portal_products (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 128),
  description text not null default '',
  display_order integer not null default 0,
  usage_plan_id uuid,
  sharing jsonb not null default '{"projects":[],"organizations":[]}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create index if not exists portal_products_project_idx
  on pods.portal_products (project_id);

create table if not exists pods.portal_product_links (
  portal_id uuid not null references pods.portals(id) on delete cascade,
  product_id uuid not null references pods.portal_products(id) on delete cascade,
  "order" integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (portal_id, product_id)
);

create table if not exists pods.product_pages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  product_id uuid not null references pods.portal_products(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 256),
  slug text not null check (char_length(slug) between 1 and 128),
  body_markdown text not null default '',
  "order" integer not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create unique index if not exists product_pages_product_slug_uniq
  on pods.product_pages (product_id, slug);

create table if not exists pods.product_endpoint_pages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  product_id uuid not null references pods.portal_products(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  stage_name text not null check (char_length(stage_name) between 1 and 128),
  resource_path text not null check (char_length(resource_path) between 1 and 1024),
  http_method text not null,
  operation_name text not null default '',
  display_override_markdown text,
  try_it_enabled boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists product_endpoint_pages_product_idx
  on pods.product_endpoint_pages (product_id);

create table if not exists pods.portal_events (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references pods.portals(id) on delete cascade,
  product_id uuid references pods.portal_products(id) on delete set null,
  type text not null check (type in ('page_view', 'try_it')),
  created_at timestamptz not null default now()
);

create index if not exists portal_events_portal_idx
  on pods.portal_events (portal_id, created_at);

alter table pods.stages
  add column if not exists agent_tools jsonb not null default '{"enabled":false,"allowOperations":null,"auth":"passthrough"}'::jsonb;

drop trigger if exists portals_touch_updated_at on pods.portals;
create trigger portals_touch_updated_at
before update on pods.portals
for each row execute function pods.touch_updated_at();

drop trigger if exists portal_products_touch_updated_at on pods.portal_products;
create trigger portal_products_touch_updated_at
before update on pods.portal_products
for each row execute function pods.touch_updated_at();

alter table pods.portals enable row level security;
alter table pods.portal_products enable row level security;
alter table pods.portal_product_links enable row level security;
alter table pods.product_pages enable row level security;
alter table pods.product_endpoint_pages enable row level security;
alter table pods.portal_events enable row level security;

drop policy if exists portals_read on pods.portals;
create policy portals_read on pods.portals
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists portals_write on pods.portals;
create policy portals_write on pods.portals
  for all to authenticated
  using (pods.can('pods.portal.write', project_id))
  with check (pods.can('pods.portal.write', project_id));

drop policy if exists portal_products_read on pods.portal_products;
create policy portal_products_read on pods.portal_products
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists portal_products_write on pods.portal_products;
create policy portal_products_write on pods.portal_products
  for all to authenticated
  using (pods.can('pods.portal.write', project_id))
  with check (pods.can('pods.portal.write', project_id));

drop policy if exists portal_product_links_read on pods.portal_product_links;
create policy portal_product_links_read on pods.portal_product_links
  for select to authenticated using (true);

drop policy if exists portal_product_links_write on pods.portal_product_links;
create policy portal_product_links_write on pods.portal_product_links
  for all to authenticated using (true) with check (true);

drop policy if exists product_pages_read on pods.product_pages;
create policy product_pages_read on pods.product_pages
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists product_pages_write on pods.product_pages;
create policy product_pages_write on pods.product_pages
  for all to authenticated
  using (pods.can('pods.portal.write', project_id))
  with check (pods.can('pods.portal.write', project_id));

drop policy if exists product_endpoint_pages_read on pods.product_endpoint_pages;
create policy product_endpoint_pages_read on pods.product_endpoint_pages
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists product_endpoint_pages_write on pods.product_endpoint_pages;
create policy product_endpoint_pages_write on pods.product_endpoint_pages
  for all to authenticated
  using (pods.can('pods.portal.write', project_id))
  with check (pods.can('pods.portal.write', project_id));

drop policy if exists portal_events_read on pods.portal_events;
create policy portal_events_read on pods.portal_events
  for select to authenticated using (true);

drop policy if exists portal_events_insert on pods.portal_events;
create policy portal_events_insert on pods.portal_events
  for insert to authenticated with check (true);

-- @down
alter table pods.stages drop column if exists agent_tools;
drop policy if exists portal_events_insert on pods.portal_events;
drop policy if exists portal_events_read on pods.portal_events;
drop policy if exists product_endpoint_pages_write on pods.product_endpoint_pages;
drop policy if exists product_endpoint_pages_read on pods.product_endpoint_pages;
drop policy if exists product_pages_write on pods.product_pages;
drop policy if exists product_pages_read on pods.product_pages;
drop policy if exists portal_product_links_write on pods.portal_product_links;
drop policy if exists portal_product_links_read on pods.portal_product_links;
drop policy if exists portal_products_write on pods.portal_products;
drop policy if exists portal_products_read on pods.portal_products;
drop policy if exists portals_write on pods.portals;
drop policy if exists portals_read on pods.portals;
drop trigger if exists portal_products_touch_updated_at on pods.portal_products;
drop trigger if exists portals_touch_updated_at on pods.portals;
drop index if exists pods.portal_events_portal_idx;
drop table if exists pods.portal_events;
drop index if exists pods.product_endpoint_pages_product_idx;
drop table if exists pods.product_endpoint_pages;
drop index if exists pods.product_pages_product_slug_uniq;
drop table if exists pods.product_pages;
drop table if exists pods.portal_product_links;
drop index if exists pods.portal_products_project_idx;
drop table if exists pods.portal_products;
drop index if exists pods.portals_project_idx;
drop index if exists pods.portals_slug_uniq;
drop table if exists pods.portals;
