-- S10 observability: metrics rollups, access/execution logs, trace spans,
-- alarms + channels + history, log sinks, sampling rules.
--
-- Retention (CloudWatch-like): minute rows 15 days, hour rows 455 days; the
-- rollup job (`app/api/internal/jobs/rollup`) merges minute → hour. Access
-- and execution logs are daily-partitioned by the application
-- (`pods.access_logs` / `pods.execution_logs` parent tables; a daily job
-- creates `*_YYYY_MM_DD` children) and pruned after
-- `project_settings.log_retention_days`. Trace spans live 7 days.
--
-- @up
create table if not exists pods.metrics_minute (
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  stage text not null,
  dims_hash text not null,
  dims jsonb not null default '{}'::jsonb,
  minute timestamptz not null,
  metric text not null,
  sum double precision not null default 0,
  count bigint not null default 0,
  min double precision,
  max double precision,
  hist integer[] not null default '{}'::integer[],
  unique (project_id, api_id, stage, dims_hash, minute, metric)
);
create index if not exists metrics_minute_project_minute_idx on pods.metrics_minute (project_id, minute desc);
create index if not exists metrics_minute_api_stage_idx on pods.metrics_minute (api_id, stage, minute desc);

create table if not exists pods.metrics_hour (
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  stage text not null,
  dims_hash text not null,
  dims jsonb not null default '{}'::jsonb,
  hour timestamptz not null,
  metric text not null,
  sum double precision not null default 0,
  count bigint not null default 0,
  min double precision,
  max double precision,
  hist integer[] not null default '{}'::integer[],
  unique (project_id, api_id, stage, dims_hash, hour, metric)
);
create index if not exists metrics_hour_project_hour_idx on pods.metrics_hour (project_id, hour desc);

-- Additive merge for runtime flushes (two instances upsert the same minute).
create or replace function pods.metrics_minute_add(
  p_project uuid, p_api uuid, p_stage text, p_dims_hash text, p_dims jsonb,
  p_minute timestamptz, p_metric text, p_sum double precision, p_count bigint,
  p_min double precision, p_max double precision, p_hist integer[]
)
returns void
language sql
as $$
  insert into pods.metrics_minute
    (project_id, api_id, stage, dims_hash, dims, minute, metric, sum, count, min, max, hist)
    values (p_project, p_api, p_stage, p_dims_hash, p_dims, p_minute, p_metric, p_sum, p_count, p_min, p_max, coalesce(p_hist, '{}'::integer[]))
  on conflict (project_id, api_id, stage, dims_hash, minute, metric)
  do update set
    sum = pods.metrics_minute.sum + excluded.sum,
    count = pods.metrics_minute.count + excluded.count,
    min = case when excluded.min is null then pods.metrics_minute.min
               when pods.metrics_minute.min is null then excluded.min
               else least(pods.metrics_minute.min, excluded.min) end,
    max = case when excluded.max is null then pods.metrics_minute.max
               when pods.metrics_minute.max is null then excluded.max
               else greatest(pods.metrics_minute.max, excluded.max) end,
    hist = (select array_agg(coalesce(old_h, 0) + coalesce(new_h, 0) order by position)
            from unnest(pods.metrics_minute.hist, excluded.hist) with ordinality as merged(old_h, new_h, position));
$$;

create or replace function pods.metrics_hour_add(
  p_project uuid, p_api uuid, p_stage text, p_dims_hash text, p_dims jsonb,
  p_hour timestamptz, p_metric text, p_sum double precision, p_count bigint,
  p_min double precision, p_max double precision, p_hist integer[]
)
returns void
language sql
as $$
  insert into pods.metrics_hour
    (project_id, api_id, stage, dims_hash, dims, hour, metric, sum, count, min, max, hist)
    values (p_project, p_api, p_stage, p_dims_hash, p_dims, p_hour, p_metric, p_sum, p_count, p_min, p_max, coalesce(p_hist, '{}'::integer[]))
  on conflict (project_id, api_id, stage, dims_hash, hour, metric)
  do update set
    sum = pods.metrics_hour.sum + excluded.sum,
    count = pods.metrics_hour.count + excluded.count,
    min = case when excluded.min is null then pods.metrics_hour.min
               when pods.metrics_hour.min is null then excluded.min
               else least(pods.metrics_hour.min, excluded.min) end,
    max = case when excluded.max is null then pods.metrics_hour.max
               when pods.metrics_hour.max is null then excluded.max
               else greatest(pods.metrics_hour.max, excluded.max) end,
    hist = (select array_agg(coalesce(old_h, 0) + coalesce(new_h, 0) order by position)
            from unnest(pods.metrics_hour.hist, excluded.hist) with ordinality as merged(old_h, new_h, position));
$$;

-- Access logs: parent table, daily children created by the retention job.
create table if not exists pods.access_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  stage text not null default '',
  ts timestamptz not null default now(),
  request_id text not null default '',
  status integer,
  route text,
  source_ip text,
  line text not null default '',
  fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
) partition by range (ts);
create index if not exists access_logs_project_ts_idx on pods.access_logs (project_id, ts desc);
create index if not exists access_logs_request_idx on pods.access_logs (project_id, request_id);

create table if not exists pods.execution_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  stage text not null default '',
  request_id text not null default '',
  ts timestamptz not null default now(),
  level text not null default 'INFO',
  lines jsonb not null default '[]'::jsonb,
  data_trace boolean not null default false,
  created_at timestamptz not null default now()
) partition by range (ts);
create index if not exists execution_logs_project_ts_idx on pods.execution_logs (project_id, ts desc);
create index if not exists execution_logs_request_idx on pods.execution_logs (project_id, request_id);

create table if not exists pods.trace_spans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  api_id uuid not null references pods.apis(id) on delete cascade,
  stage text not null default '',
  request_id text not null default '',
  trace_id text not null default '',
  span_id text not null default '',
  parent_id text,
  name text not null default '',
  kind text not null default 'server',
  attributes jsonb not null default '{}'::jsonb,
  start_ms bigint not null default 0,
  end_ms bigint,
  duration_ms double precision,
  status text not null default 'ok',
  created_at timestamptz not null default now()
);
create index if not exists trace_spans_request_idx on pods.trace_spans (project_id, request_id);
create index if not exists trace_spans_trace_idx on pods.trace_spans (project_id, trace_id);
create index if not exists trace_spans_created_idx on pods.trace_spans (created_at);

create table if not exists pods.notification_channels (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  type text not null check (type in ('webhook', 'slack_webhook', 'email')),
  config jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists notification_channels_project_idx on pods.notification_channels (project_id);

create table if not exists pods.alarms (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  description text not null default '',
  metric text not null,
  dimensions jsonb not null default '{}'::jsonb,
  statistic text not null default 'Average',
  period_sec integer not null default 60
    check (period_sec > 0 and period_sec % 60 = 0),
  evaluation_periods integer not null default 1,
  datapoints_to_alarm integer not null default 1,
  comparison text not null default '>' check (comparison in ('>', '>=', '<', '<=')),
  threshold double precision not null default 0,
  treat_missing_data text not null default 'missing'
    check (treat_missing_data in ('missing', 'notBreaching', 'breaching', 'ignore')),
  actions jsonb not null default '{"ok":[],"alarm":[],"insufficientData":[]}'::jsonb,
  state text not null default 'INSUFFICIENT_DATA'
    check (state in ('OK', 'ALARM', 'INSUFFICIENT_DATA')),
  state_reason text not null default '',
  state_updated_at timestamptz,
  enabled boolean not null default true,
  version integer not null default 1,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists alarms_project_idx on pods.alarms (project_id);
create index if not exists alarms_enabled_idx on pods.alarms (enabled) where enabled = true;

create table if not exists pods.alarm_history (
  id uuid primary key default gen_random_uuid(),
  alarm_id uuid not null references pods.alarms(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  from_state text not null,
  to_state text not null,
  reason text not null default '',
  idempotency_key text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists alarm_history_idempotency_uniq on pods.alarm_history (idempotency_key);
create index if not exists alarm_history_alarm_idx on pods.alarm_history (alarm_id, created_at desc);

create table if not exists pods.log_sinks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  type text not null check (type in ('https', 's3', 'otlp_logs')),
  config jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  last_delivery_at timestamptz,
  last_error text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists log_sinks_project_idx on pods.log_sinks (project_id);

create table if not exists pods.sampling_rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  priority integer not null default 1,
  reservoir_per_sec integer not null default 1,
  fixed_rate double precision not null default 0.05,
  match jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists sampling_rules_project_idx on pods.sampling_rules (project_id, priority);

alter table pods.metrics_minute enable row level security;
alter table pods.metrics_hour enable row level security;
alter table pods.access_logs enable row level security;
alter table pods.execution_logs enable row level security;
alter table pods.trace_spans enable row level security;
alter table pods.notification_channels enable row level security;
alter table pods.alarms enable row level security;
alter table pods.alarm_history enable row level security;
alter table pods.log_sinks enable row level security;
alter table pods.sampling_rules enable row level security;

-- Telemetry reads are permission-gated (like processing/ RLS): members read
-- through `pods.is_member`, but sensitive telemetry additionally requires the
-- operation key via `pods.can`. Telemetry inserts come only from the service
-- role (runtime flushers/jobs bypass RLS); no authenticated INSERT policy
-- exists for metrics/access/execution/trace, so users cannot write them.
-- Data-trace bodies (`execution_logs` with `data_trace = true`) require
-- `pods.logs.data`; other execution rows require `pods.logs.view`.
drop policy if exists metrics_minute_select on pods.metrics_minute;
create policy metrics_minute_select on pods.metrics_minute for select to authenticated
  using (pods.can('pods.monitoring.view', project_id) or pods.can('pods.logs.view', project_id));
drop policy if exists metrics_hour_select on pods.metrics_hour;
create policy metrics_hour_select on pods.metrics_hour for select to authenticated
  using (pods.can('pods.monitoring.view', project_id) or pods.can('pods.logs.view', project_id));
drop policy if exists access_logs_select on pods.access_logs;
create policy access_logs_select on pods.access_logs for select to authenticated
  using (pods.can('pods.monitoring.view', project_id) or pods.can('pods.logs.view', project_id));
drop policy if exists execution_logs_select on pods.execution_logs;
create policy execution_logs_select on pods.execution_logs for select to authenticated
  using (
    (coalesce(data_trace, false) = false and (pods.can('pods.monitoring.view', project_id) or pods.can('pods.logs.view', project_id)))
    or (coalesce(data_trace, false) = true and pods.can('pods.logs.data', project_id))
  );
drop policy if exists trace_spans_select on pods.trace_spans;
create policy trace_spans_select on pods.trace_spans for select to authenticated
  using (pods.can('pods.monitoring.view', project_id) or pods.can('pods.logs.view', project_id));
drop policy if exists alarm_history_select on pods.alarm_history;
create policy alarm_history_select on pods.alarm_history for select to authenticated
  using (pods.can('pods.monitoring.view', project_id));
drop policy if exists alarms_read on pods.alarms;
create policy alarms_read on pods.alarms
  for select to authenticated using (pods.can('pods.monitoring.view', project_id));
drop policy if exists alarms_write on pods.alarms;
create policy alarms_write on pods.alarms
  for all to authenticated
  using (pods.can('pods.alarm.write', project_id))
  with check (pods.can('pods.alarm.write', project_id));
drop policy if exists notification_channels_read on pods.notification_channels;
create policy notification_channels_read on pods.notification_channels
  for select to authenticated using (pods.can('pods.monitoring.view', project_id));
drop policy if exists notification_channels_write on pods.notification_channels;
create policy notification_channels_write on pods.notification_channels
  for all to authenticated
  using (pods.can('pods.alarm.write', project_id))
  with check (pods.can('pods.alarm.write', project_id));
drop policy if exists log_sinks_read on pods.log_sinks;
create policy log_sinks_read on pods.log_sinks
  for select to authenticated using (pods.can('pods.monitoring.view', project_id));
drop policy if exists log_sinks_write on pods.log_sinks;
create policy log_sinks_write on pods.log_sinks
  for all to authenticated
  using (pods.can('pods.export.write', project_id))
  with check (pods.can('pods.export.write', project_id));
drop policy if exists sampling_rules_read on pods.sampling_rules;
create policy sampling_rules_read on pods.sampling_rules
  for select to authenticated using (pods.can('pods.monitoring.view', project_id));
drop policy if exists sampling_rules_write on pods.sampling_rules;
create policy sampling_rules_write on pods.sampling_rules
  for all to authenticated
  using (pods.can('pods.export.write', project_id))
  with check (pods.can('pods.export.write', project_id));

-- @down
drop policy if exists sampling_rules_write on pods.sampling_rules;
drop policy if exists sampling_rules_read on pods.sampling_rules;
drop policy if exists log_sinks_write on pods.log_sinks;
drop policy if exists log_sinks_read on pods.log_sinks;
drop policy if exists notification_channels_write on pods.notification_channels;
drop policy if exists notification_channels_read on pods.notification_channels;
drop policy if exists alarm_history_select on pods.alarm_history;
drop policy if exists alarms_write on pods.alarms;
drop policy if exists alarms_read on pods.alarms;
drop policy if exists trace_spans_select on pods.trace_spans;
drop policy if exists execution_logs_select on pods.execution_logs;
drop policy if exists access_logs_select on pods.access_logs;
drop policy if exists metrics_hour_select on pods.metrics_hour;
drop policy if exists metrics_minute_select on pods.metrics_minute;
drop table if exists pods.sampling_rules;
drop table if exists pods.log_sinks;
drop table if exists pods.alarm_history;
drop table if exists pods.alarms;
drop table if exists pods.notification_channels;
drop table if exists pods.trace_spans;
drop table if exists pods.execution_logs;
drop table if exists pods.access_logs;
drop function if exists pods.metrics_hour_add(uuid, uuid, text, text, jsonb, timestamptz, text, double precision, bigint, double precision, double precision, integer[]);
drop function if exists pods.metrics_minute_add(uuid, uuid, text, text, jsonb, timestamptz, text, double precision, bigint, double precision, double precision, integer[]);
drop table if exists pods.metrics_hour;
drop table if exists pods.metrics_minute;
