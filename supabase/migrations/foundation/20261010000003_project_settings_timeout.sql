-- B2 F5: project-level REST integration timeout ceiling (S04 §2).
-- `max_integration_timeout_ms` lets a project raise the REST timeout from the
-- 29 s default up to 300 s. HTTP stays capped at 30 s; the service layer
-- enforces the per-protocol ceiling.
--
-- @up
alter table if exists pods.project_settings
  add column if not exists max_integration_timeout_ms integer not null default 29000
    check (max_integration_timeout_ms >= 50 and max_integration_timeout_ms <= 300000);

-- @down
alter table if exists pods.project_settings
  drop column if exists max_integration_timeout_ms;
