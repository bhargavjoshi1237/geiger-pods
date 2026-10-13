-- Observability storage fixes found while seeding a real project.
--
-- 1. `pods.access_logs` and `pods.execution_logs` are range-partitioned on
--    `ts`, but nothing ever creates a partition, so every insert from the
--    gateway's log writers fails with "no partition of relation found".
--    A DEFAULT partition makes inserts always land; retention still drops
--    daily `<table>_yyyy_mm_dd` partitions when they exist and deletes rows
--    by `ts` otherwise (lib/control/retention.mjs).
-- 2. `pods.trace_spans` has no `ts` column, yet `observe-db.insertSpans`
--    writes one and the trace viewer + retention order/filter by it.
--
-- @up
create table if not exists pods.access_logs_default
  partition of pods.access_logs default;
create table if not exists pods.execution_logs_default
  partition of pods.execution_logs default;

alter table pods.trace_spans
  add column if not exists ts timestamptz not null default now();
create index if not exists trace_spans_project_ts_idx
  on pods.trace_spans (project_id, ts desc);

-- @down
drop index if exists pods.trace_spans_project_ts_idx;
alter table pods.trace_spans drop column if exists ts;
drop table if exists pods.execution_logs_default;
drop table if exists pods.access_logs_default;
