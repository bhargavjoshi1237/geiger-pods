-- S08 API keys, usage plans, throttling & quotas.
--
-- `pods.api_keys` holds key metadata; the value itself lives in the vault
-- (`value_ref`, kind `generic`) and is looked up at runtime by `value_hmac`
-- (HMAC-SHA256 with `PODS_KEY_PEPPER`). Selecting the value is never
-- possible through RLS: only the HMAC and the ref are selectable, and the
-- vault envelope columns are revoked from `authenticated` (S02).
-- `quota_since` (S08 addition to the spec schema) records plan creation /
-- the last quota change so the runtime can apply `offset` in the initial
-- period only.
--
-- @up
create table if not exists pods.api_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  public_id text not null,
  name text not null check (char_length(name) between 1 and 128),
  description text not null default '',
  enabled boolean not null default true,
  customer_id text,
  value_ref text not null,
  value_hmac bytea not null unique,
  value_prefix text not null,
  last_used_at timestamptz,
  tags jsonb not null default '{}'::jsonb,
  generate_distinct_id boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create unique index if not exists api_keys_project_public_uniq on pods.api_keys (project_id, public_id);
create index if not exists api_keys_project_idx on pods.api_keys (project_id);

create table if not exists pods.usage_plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  public_id text not null,
  name text not null check (char_length(name) between 1 and 128),
  description text not null default '',
  throttle jsonb,
  quota jsonb,
  quota_since timestamptz,
  tags jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create unique index if not exists usage_plans_project_public_uniq on pods.usage_plans (project_id, public_id);
create index if not exists usage_plans_project_idx on pods.usage_plans (project_id);

create table if not exists pods.usage_plan_stages (
  plan_id uuid not null references pods.usage_plans(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  stage_name text not null check (char_length(stage_name) between 1 and 128),
  method_throttles jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (plan_id, api_id, stage_name)
);

create index if not exists usage_plan_stages_api_idx on pods.usage_plan_stages (api_id, stage_name);

create table if not exists pods.usage_plan_keys (
  plan_id uuid not null references pods.usage_plans(id) on delete cascade,
  api_key_id uuid not null references pods.api_keys(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (plan_id, api_key_id)
);

create index if not exists usage_plan_keys_key_idx on pods.usage_plan_keys (api_key_id);

-- Written by the S10 rollup (service role, bypasses RLS); read for GetUsage.
create table if not exists pods.usage_daily (
  project_id uuid not null references public.projects(id) on delete cascade,
  plan_id uuid not null references pods.usage_plans(id) on delete cascade,
  api_key_id uuid not null references pods.api_keys(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  stage_name text not null,
  day date not null,
  count bigint not null default 0,
  throttled bigint not null default 0,
  quota_rejected bigint not null default 0,
  primary key (project_id, plan_id, api_key_id, api_id, stage_name, day)
);

create index if not exists usage_daily_plan_day_idx on pods.usage_daily (plan_id, day);

-- Append-only usage adjustments (AWS UpdateUsage audit trail).
create table if not exists pods.quota_adjustments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  plan_id uuid not null references pods.usage_plans(id) on delete cascade,
  api_key_id uuid not null references pods.api_keys(id) on delete cascade,
  period_start timestamptz not null,
  delta integer,
  set_remaining integer,
  actor_id uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists quota_adjustments_period_idx on pods.quota_adjustments (plan_id, api_key_id, period_start);

drop trigger if exists api_keys_touch_updated_at on pods.api_keys;
create trigger api_keys_touch_updated_at
before update on pods.api_keys
for each row execute function pods.touch_updated_at();

drop trigger if exists usage_plans_touch_updated_at on pods.usage_plans;
create trigger usage_plans_touch_updated_at
before update on pods.usage_plans
for each row execute function pods.touch_updated_at();

alter table pods.api_keys enable row level security;
alter table pods.usage_plans enable row level security;
alter table pods.usage_plan_stages enable row level security;
alter table pods.usage_plan_keys enable row level security;
alter table pods.usage_daily enable row level security;
alter table pods.quota_adjustments enable row level security;

-- Keys: read/write through pods.api_key.write. There is deliberately no
-- value column here to reveal — the plaintext lives in the vault.
drop policy if exists api_keys_read on pods.api_keys;
create policy api_keys_read on pods.api_keys
  for select to authenticated using (pods.can('pods.api_key.write', project_id));

drop policy if exists api_keys_write on pods.api_keys;
create policy api_keys_write on pods.api_keys
  for all to authenticated
  using (pods.can('pods.api_key.write', project_id))
  with check (pods.can('pods.api_key.write', project_id));

-- Plans, plan stages and plan keys: pods.usage_plan.write throughout.
drop policy if exists usage_plans_read on pods.usage_plans;
create policy usage_plans_read on pods.usage_plans
  for select to authenticated using (pods.can('pods.usage_plan.write', project_id));

drop policy if exists usage_plans_write on pods.usage_plans;
create policy usage_plans_write on pods.usage_plans
  for all to authenticated
  using (pods.can('pods.usage_plan.write', project_id))
  with check (pods.can('pods.usage_plan.write', project_id));

drop policy if exists usage_plan_stages_read on pods.usage_plan_stages;
create policy usage_plan_stages_read on pods.usage_plan_stages
  for select to authenticated using (
    exists (select 1 from pods.usage_plans plan
      where plan.id = usage_plan_stages.plan_id
        and pods.can('pods.usage_plan.write', plan.project_id))
  );

drop policy if exists usage_plan_stages_write on pods.usage_plan_stages;
create policy usage_plan_stages_write on pods.usage_plan_stages
  for all to authenticated
  using (
    exists (select 1 from pods.usage_plans plan
      where plan.id = usage_plan_stages.plan_id
        and pods.can('pods.usage_plan.write', plan.project_id))
  )
  with check (
    exists (select 1 from pods.usage_plans plan
      where plan.id = usage_plan_stages.plan_id
        and pods.can('pods.usage_plan.write', plan.project_id))
  );

drop policy if exists usage_plan_keys_read on pods.usage_plan_keys;
create policy usage_plan_keys_read on pods.usage_plan_keys
  for select to authenticated using (
    exists (select 1 from pods.usage_plans plan
      where plan.id = usage_plan_keys.plan_id
        and pods.can('pods.usage_plan.write', plan.project_id))
  );

drop policy if exists usage_plan_keys_write on pods.usage_plan_keys;
create policy usage_plan_keys_write on pods.usage_plan_keys
  for all to authenticated
  using (
    exists (select 1 from pods.usage_plans plan
      where plan.id = usage_plan_keys.plan_id
        and pods.can('pods.usage_plan.write', plan.project_id))
  )
  with check (
    exists (select 1 from pods.usage_plans plan
      where plan.id = usage_plan_keys.plan_id
        and pods.can('pods.usage_plan.write', plan.project_id))
  );

-- Usage history + adjustments: read through pods.usage.view (GetUsage),
-- writes through pods.usage_plan.write (rollup uses the service role).
drop policy if exists usage_daily_read on pods.usage_daily;
create policy usage_daily_read on pods.usage_daily
  for select to authenticated using (pods.can('pods.usage.view', project_id));

drop policy if exists usage_daily_write on pods.usage_daily;
create policy usage_daily_write on pods.usage_daily
  for all to authenticated
  using (pods.can('pods.usage_plan.write', project_id))
  with check (pods.can('pods.usage_plan.write', project_id));

drop policy if exists quota_adjustments_read on pods.quota_adjustments;
create policy quota_adjustments_read on pods.quota_adjustments
  for select to authenticated using (
    pods.can('pods.usage.view', project_id) or pods.can('pods.usage_plan.write', project_id)
  );

drop policy if exists quota_adjustments_write on pods.quota_adjustments;
create policy quota_adjustments_write on pods.quota_adjustments
  for all to authenticated
  using (pods.can('pods.usage_plan.write', project_id))
  with check (pods.can('pods.usage_plan.write', project_id));

-- @down
drop policy if exists quota_adjustments_write on pods.quota_adjustments;
drop policy if exists quota_adjustments_read on pods.quota_adjustments;
drop policy if exists usage_daily_write on pods.usage_daily;
drop policy if exists usage_daily_read on pods.usage_daily;
drop policy if exists usage_plan_keys_write on pods.usage_plan_keys;
drop policy if exists usage_plan_keys_read on pods.usage_plan_keys;
drop policy if exists usage_plan_stages_write on pods.usage_plan_stages;
drop policy if exists usage_plan_stages_read on pods.usage_plan_stages;
drop policy if exists usage_plans_write on pods.usage_plans;
drop policy if exists usage_plans_read on pods.usage_plans;
drop policy if exists api_keys_write on pods.api_keys;
drop policy if exists api_keys_read on pods.api_keys;
drop trigger if exists usage_plans_touch_updated_at on pods.usage_plans;
drop trigger if exists api_keys_touch_updated_at on pods.api_keys;
drop index if exists pods.quota_adjustments_period_idx;
drop table if exists pods.quota_adjustments;
drop index if exists pods.usage_daily_plan_day_idx;
drop table if exists pods.usage_daily;
drop index if exists pods.usage_plan_keys_key_idx;
drop table if exists pods.usage_plan_keys;
drop index if exists pods.usage_plan_stages_api_idx;
drop table if exists pods.usage_plan_stages;
drop index if exists pods.usage_plans_project_idx;
drop index if exists pods.usage_plans_project_public_uniq;
drop table if exists pods.usage_plans;
drop index if exists pods.api_keys_project_idx;
drop index if exists pods.api_keys_project_public_uniq;
drop table if exists pods.api_keys;
