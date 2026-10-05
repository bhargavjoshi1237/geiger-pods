-- S14 management API hardening: access tokens, idempotency keys, generic
-- resource tags, declarative stacks and management event subscriptions.
--
-- Tags use one generic table keyed by (resource_type, resource_id) so specs
-- landing later (S08 keys/plans, S11 domains, S13 portals) need no schema
-- change; per-resource ownership checks stay in their services.
--
-- @up
create table if not exists pods.access_tokens (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null check (kind in ('personal', 'service')),
  user_id uuid,
  name text not null check (char_length(name) between 1 and 128),
  prefix text not null,
  token_hash text not null unique,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  last_used_at timestamptz,
  last_used_ip text,
  revoked_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check ((kind = 'personal' and user_id is not null) or (kind = 'service' and user_id is null))
);

create table if not exists pods.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  actor_key text not null,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  request_hash text not null,
  response_status integer not null,
  response_body jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  unique (project_id, actor_key, idempotency_key)
);
create index if not exists idempotency_keys_expires_idx on pods.idempotency_keys (expires_at);

create table if not exists pods.tags (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  resource_type text not null,
  resource_id text not null,
  key text not null check (char_length(key) between 1 and 128),
  value text not null default '' check (char_length(value) <= 256),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, resource_type, resource_id, key)
);
create index if not exists tags_resource_idx on pods.tags (project_id, resource_type, resource_id);

create table if not exists pods.stacks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  last_applied_hash text,
  last_applied_at timestamptz,
  status text not null default 'idle' check (status in ('idle', 'applying', 'applied', 'failed')),
  last_error text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (project_id, name)
);

create table if not exists pods.event_subscriptions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 128),
  event_types text[] not null default '{}',
  target_url text not null,
  secret_ref text not null,
  enabled boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (project_id, name)
);

create table if not exists pods.event_deliveries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  subscription_id uuid not null references pods.event_subscriptions(id) on delete cascade,
  event_type text not null,
  event_id text not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists event_deliveries_due_idx on pods.event_deliveries (status, next_attempt_at);

drop trigger if exists access_tokens_touch_updated_at on pods.access_tokens;
create trigger access_tokens_touch_updated_at
before update on pods.access_tokens
for each row execute function pods.touch_updated_at();

drop trigger if exists tags_touch_updated_at on pods.tags;
create trigger tags_touch_updated_at
before update on pods.tags
for each row execute function pods.touch_updated_at();

drop trigger if exists stacks_touch_updated_at on pods.stacks;
create trigger stacks_touch_updated_at
before update on pods.stacks
for each row execute function pods.touch_updated_at();

drop trigger if exists event_subscriptions_touch_updated_at on pods.event_subscriptions;
create trigger event_subscriptions_touch_updated_at
before update on pods.event_subscriptions
for each row execute function pods.touch_updated_at();

drop trigger if exists event_deliveries_touch_updated_at on pods.event_deliveries;
create trigger event_deliveries_touch_updated_at
before update on pods.event_deliveries
for each row execute function pods.touch_updated_at();

alter table pods.access_tokens enable row level security;
alter table pods.idempotency_keys enable row level security;
alter table pods.tags enable row level security;
alter table pods.stacks enable row level security;
alter table pods.event_subscriptions enable row level security;
alter table pods.event_deliveries enable row level security;

drop policy if exists access_tokens_read on pods.access_tokens;
create policy access_tokens_read on pods.access_tokens
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists access_tokens_write on pods.access_tokens;
create policy access_tokens_write on pods.access_tokens
  for all to authenticated
  using (pods.can('pods.token.write', project_id))
  with check (pods.can('pods.token.write', project_id));

drop policy if exists idempotency_keys_all on pods.idempotency_keys;
create policy idempotency_keys_all on pods.idempotency_keys
  for all to authenticated using (pods.is_member(project_id))
  with check (pods.is_member(project_id));

drop policy if exists tags_read on pods.tags;
create policy tags_read on pods.tags
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists tags_write on pods.tags;
create policy tags_write on pods.tags
  for all to authenticated
  using (pods.can('pods.api.update', project_id))
  with check (pods.can('pods.api.update', project_id));

drop policy if exists stacks_read on pods.stacks;
create policy stacks_read on pods.stacks
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists stacks_write on pods.stacks;
create policy stacks_write on pods.stacks
  for all to authenticated
  using (pods.can('pods.api.create', project_id))
  with check (pods.can('pods.api.create', project_id));

drop policy if exists event_subscriptions_read on pods.event_subscriptions;
create policy event_subscriptions_read on pods.event_subscriptions
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists event_subscriptions_write on pods.event_subscriptions;
create policy event_subscriptions_write on pods.event_subscriptions
  for all to authenticated
  using (pods.can('pods.export.write', project_id))
  with check (pods.can('pods.export.write', project_id));

drop policy if exists event_deliveries_read on pods.event_deliveries;
create policy event_deliveries_read on pods.event_deliveries
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists event_deliveries_write on pods.event_deliveries;
create policy event_deliveries_write on pods.event_deliveries
  for all to authenticated
  using (pods.can('pods.export.write', project_id))
  with check (pods.can('pods.export.write', project_id));

-- @down
drop policy if exists event_deliveries_write on pods.event_deliveries;
drop policy if exists event_deliveries_read on pods.event_deliveries;
drop policy if exists event_subscriptions_write on pods.event_subscriptions;
drop policy if exists event_subscriptions_read on pods.event_subscriptions;
drop policy if exists stacks_write on pods.stacks;
drop policy if exists stacks_read on pods.stacks;
drop policy if exists tags_write on pods.tags;
drop policy if exists tags_read on pods.tags;
drop policy if exists idempotency_keys_all on pods.idempotency_keys;
drop policy if exists access_tokens_write on pods.access_tokens;
drop policy if exists access_tokens_read on pods.access_tokens;
drop trigger if exists event_deliveries_touch_updated_at on pods.event_deliveries;
drop trigger if exists event_subscriptions_touch_updated_at on pods.event_subscriptions;
drop trigger if exists stacks_touch_updated_at on pods.stacks;
drop trigger if exists tags_touch_updated_at on pods.tags;
drop trigger if exists access_tokens_touch_updated_at on pods.access_tokens;
drop table if exists pods.event_deliveries;
drop table if exists pods.event_subscriptions;
drop table if exists pods.stacks;
drop table if exists pods.tags;
drop table if exists pods.idempotency_keys;
drop table if exists pods.access_tokens;
