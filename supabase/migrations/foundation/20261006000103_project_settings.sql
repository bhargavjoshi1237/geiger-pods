-- S02 data foundation: per-project gateway settings (AWS "account settings"
-- equivalent). One row per project; absent rows read as the defaults below.
--
-- @up
create table if not exists pods.project_settings (
  project_id uuid primary key references public.projects(id) on delete cascade,
  throttle_rate numeric not null default 10000,
  throttle_burst integer not null default 5000,
  throttle_kv_failure text not null default 'open' check (throttle_kv_failure in ('open', 'closed')),
  log_retention_days integer not null default 30,
  data_trace_retention_days integer not null default 3,
  default_region text not null default 'auto',
  features jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

drop trigger if exists project_settings_touch_updated_at on pods.project_settings;
create trigger project_settings_touch_updated_at
before update on pods.project_settings
for each row execute function pods.touch_updated_at();

alter table pods.project_settings enable row level security;

drop policy if exists project_settings_read on pods.project_settings;
create policy project_settings_read on pods.project_settings
  for select to authenticated using (pods.is_member(project_id));

drop policy if exists project_settings_write on pods.project_settings;
create policy project_settings_write on pods.project_settings
  for all to authenticated
  using (pods.can('pods.settings.write', project_id))
  with check (pods.can('pods.settings.write', project_id));

-- @down
drop policy if exists project_settings_write on pods.project_settings;
drop policy if exists project_settings_read on pods.project_settings;
drop trigger if exists project_settings_touch_updated_at on pods.project_settings;
drop table if exists pods.project_settings;
