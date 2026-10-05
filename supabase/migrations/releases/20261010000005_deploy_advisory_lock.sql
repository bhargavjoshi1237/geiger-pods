-- B2 F21: cross-instance deploy lock (multi-instance control planes).
--
-- A Postgres advisory lock cannot be held across PostgREST calls (each rpc
-- is its own transaction, and pooled sessions are shared), so the lock is a
-- lease row: `acquire` claims it only when free or expired, `release` drops
-- it for the same holder. The lease expiry bounds a crashed deploy. The
-- service also keeps its in-process lock.
--
-- @up
create table if not exists pods.deploy_locks (
  api_id uuid primary key references pods.apis(id) on delete cascade,
  holder uuid not null,
  expires_at timestamptz not null
);

-- No policies: the table is reachable only through the functions below.
alter table pods.deploy_locks enable row level security;
revoke all on pods.deploy_locks from anon, authenticated;

create or replace function pods.acquire_deploy_lock(p_api uuid, p_holder uuid, p_ttl_seconds integer default 60)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_claimed uuid;
begin
  select a.project_id into v_project from pods.apis a where a.id = p_api and a.deleted_at is null;
  if v_project is null or not pods.can('pods.deployment.create', v_project, p_api) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into pods.deploy_locks as l (api_id, holder, expires_at)
  values (p_api, p_holder, pg_catalog.now() + pg_catalog.make_interval(secs => least(greatest(p_ttl_seconds, 5), 300)))
  on conflict (api_id) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where l.expires_at < pg_catalog.now()
  returning l.holder into v_claimed;
  return v_claimed = p_holder;
end;
$$;

create or replace function pods.release_deploy_lock(p_api uuid, p_holder uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from pods.deploy_locks where api_id = p_api and holder = p_holder;
$$;

revoke execute on function pods.acquire_deploy_lock(uuid, uuid, integer) from public;
revoke execute on function pods.release_deploy_lock(uuid, uuid) from public;
grant execute on function pods.acquire_deploy_lock(uuid, uuid, integer) to authenticated;
grant execute on function pods.release_deploy_lock(uuid, uuid) to authenticated;

-- @down
drop function if exists pods.release_deploy_lock(uuid, uuid);
drop function if exists pods.acquire_deploy_lock(uuid, uuid, integer);
drop table if exists pods.deploy_locks;
