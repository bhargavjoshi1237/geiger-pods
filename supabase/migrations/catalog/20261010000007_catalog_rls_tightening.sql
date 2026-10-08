-- F14 (S15): catalog RLS tightening.
--
-- Two holes the S03 review left open:
-- 1. `apis_update` lets `pods.api.update` holders soft-delete an API
--    through direct SQL (the OR covers `deleted_at` writes). A trigger now
--    requires `pods.api.delete` for any `deleted_at` change; plain edits
--    still need only `pods.api.update`.
-- 2. `rest_resources_write`, `rest_methods_write` and `http_routes_write`
--    are `FOR ALL`, so `pods.route.write` holders can hard-DELETE rows
--    through direct SQL (bypassing unique-index history and audit). They
--    become INSERT + UPDATE only; the service layer soft-deletes through
--    the UPDATE policy, so nothing legitimate breaks.
--
-- @up
-- 1. Guard: changing `deleted_at` on apis needs `pods.api.delete`.
create or replace function pods.block_api_unsanctioned_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if OLD.deleted_at is distinct from NEW.deleted_at then
    if not pods.can('pods.api.delete', NEW.project_id) then
      raise exception 'forbidden: pods.api.delete is required to delete or restore an API' using errcode = '42501';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists apis_guard_delete on pods.apis;
create trigger apis_guard_delete
before update of deleted_at on pods.apis
for each row execute function pods.block_api_unsanctioned_delete();

-- 2. rest_resources: INSERT + UPDATE only (no hard DELETE).
drop policy if exists rest_resources_write on pods.rest_resources;
drop policy if exists rest_resources_insert on pods.rest_resources;
drop policy if exists rest_resources_update on pods.rest_resources;
create policy rest_resources_insert on pods.rest_resources
  for insert to authenticated with check (pods.can('pods.route.write', project_id, api_id));
create policy rest_resources_update on pods.rest_resources
  for update to authenticated
  using (pods.can('pods.route.write', project_id, api_id))
  with check (pods.can('pods.route.write', project_id, api_id));

-- 3. rest_methods: INSERT + UPDATE only (no hard DELETE).
drop policy if exists rest_methods_write on pods.rest_methods;
drop policy if exists rest_methods_insert on pods.rest_methods;
drop policy if exists rest_methods_update on pods.rest_methods;
create policy rest_methods_insert on pods.rest_methods
  for insert to authenticated with check (pods.can('pods.route.write', project_id, api_id));
create policy rest_methods_update on pods.rest_methods
  for update to authenticated
  using (pods.can('pods.route.write', project_id, api_id))
  with check (pods.can('pods.route.write', project_id, api_id));

-- 4. http_routes: INSERT + UPDATE only (no hard DELETE).
drop policy if exists http_routes_write on pods.http_routes;
drop policy if exists http_routes_insert on pods.http_routes;
drop policy if exists http_routes_update on pods.http_routes;
create policy http_routes_insert on pods.http_routes
  for insert to authenticated with check (pods.can('pods.route.write', project_id, api_id));
create policy http_routes_update on pods.http_routes
  for update to authenticated
  using (pods.can('pods.route.write', project_id, api_id))
  with check (pods.can('pods.route.write', project_id, api_id));

-- @down
drop policy if exists http_routes_update on pods.http_routes;
drop policy if exists http_routes_insert on pods.http_routes;
create policy http_routes_write on pods.http_routes
  for all to authenticated
  using (pods.can('pods.route.write', project_id, api_id))
  with check (pods.can('pods.route.write', project_id, api_id));

drop policy if exists rest_methods_update on pods.rest_methods;
drop policy if exists rest_methods_insert on pods.rest_methods;
create policy rest_methods_write on pods.rest_methods
  for all to authenticated
  using (pods.can('pods.route.write', project_id, api_id))
  with check (pods.can('pods.route.write', project_id, api_id));

drop policy if exists rest_resources_update on pods.rest_resources;
drop policy if exists rest_resources_insert on pods.rest_resources;
create policy rest_resources_write on pods.rest_resources
  for all to authenticated
  using (pods.can('pods.route.write', project_id, api_id))
  with check (pods.can('pods.route.write', project_id, api_id));

drop trigger if exists apis_guard_delete on pods.apis;
drop function if exists pods.block_api_unsanctioned_delete();
