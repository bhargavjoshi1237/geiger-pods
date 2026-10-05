-- S09 release controls: stage cache settings columns.
--
-- `pods.stages` already carries `cache_cluster_enabled`, `cache_cluster_size`,
-- `method_settings` and `canary` (S05). This adds the remaining S09 §2 stage
-- settings: default TTL, encryption at rest, and the `Cache-Control: max-age=0`
-- authorization policy. Flush itself is a KV epoch bump (no table); the
-- `pods.cache.flush` key is enforced in the service layer.
--
-- @up
alter table pods.stages
  add column if not exists cache_default_ttl integer not null default 300
    check (cache_default_ttl >= 0 and cache_default_ttl <= 3600),
  add column if not exists cache_data_encrypted boolean not null default false,
  add column if not exists require_authorization_for_cache_control boolean not null default true,
  add column if not exists unauthorized_cache_control_header_strategy text not null default 'SUCCEED_WITH_RESPONSE_HEADER'
    check (unauthorized_cache_control_header_strategy in ('FAIL_WITH_403', 'SUCCEED_WITH_RESPONSE_HEADER', 'SUCCEED_WITHOUT_RESPONSE_HEADER'));

-- AWS cache sizes (S09 §2); Pods maps each to a KV byte budget.
alter table pods.stages drop constraint if exists stages_cache_size_check;
alter table pods.stages
  add constraint stages_cache_size_check
  check (cache_cluster_size is null or cache_cluster_size in ('0.5', '1.6', '6.1', '13.5', '28.4', '58.2', '118', '237'));

-- RLS is unchanged (S02 patterns): stages rows stay under the existing
-- `stages_read` / `stages_insert` / `stages_update` policies
-- (`pods.is_member` + `pods.can('pods.stage.write', …)`); no new tables.

-- @down
alter table pods.stages drop constraint if exists stages_cache_size_check;
alter table pods.stages
  drop column if exists unauthorized_cache_control_header_strategy,
  drop column if exists require_authorization_for_cache_control,
  drop column if exists cache_data_encrypted,
  drop column if exists cache_default_ttl;
