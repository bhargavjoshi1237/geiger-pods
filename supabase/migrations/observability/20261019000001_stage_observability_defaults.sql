-- F50 (S15 part 2): stage observability defaults the S10 control plane writes.
--
-- `lib/control/stage-observability.mjs` persists `default_logging_level` and
-- `default_data_trace` through `db.updateStage`, but the columns never
-- existed on `pods.stages` (only `access_log`, `method_settings`,
-- `route_settings` and `tracing_enabled` shipped in the releases migration),
-- so any write carrying a stage-default logging level or data-trace flag
-- fails against a real database. The gateway loader now selects these
-- columns to feed the emit phase (`ctx.stageSettings`).
--
-- @up
alter table pods.stages
  add column if not exists default_logging_level text not null default 'OFF',
  add column if not exists default_data_trace boolean not null default false;

-- @down
alter table pods.stages
  drop column if exists default_data_trace,
  drop column if exists default_logging_level;
