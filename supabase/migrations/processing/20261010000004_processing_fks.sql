-- B2 F6: cross-spec foreign keys deferred while S03/S04/S06 landed in
-- parallel (see processing migration header). Both sides exist now.
--
-- @up
-- S06 method_responses belong to one REST method.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'method_responses_method_id_fkey'
  ) then
    alter table pods.method_responses
      add constraint method_responses_method_id_fkey
      foreign key (method_id) references pods.rest_methods(id) on delete cascade;
  end if;
end
$$;

-- S03 draft rows point at S04 integrations (plain uuid until now).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'rest_methods_integration_id_fkey'
  ) then
    alter table pods.rest_methods
      add constraint rest_methods_integration_id_fkey
      foreign key (integration_id) references pods.integrations(id) on delete set null;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'http_routes_integration_id_fkey'
  ) then
    alter table pods.http_routes
      add constraint http_routes_integration_id_fkey
      foreign key (integration_id) references pods.integrations(id) on delete set null;
  end if;
end
$$;

-- S03 methods may name an S06 request validator.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'rest_methods_request_validator_id_fkey'
  ) then
    alter table pods.rest_methods
      add constraint rest_methods_request_validator_id_fkey
      foreign key (request_validator_id) references pods.request_validators(id) on delete set null;
  end if;
end
$$;

-- @down
alter table if exists pods.rest_methods drop constraint if exists rest_methods_request_validator_id_fkey;
alter table if exists pods.http_routes drop constraint if exists http_routes_integration_id_fkey;
alter table if exists pods.rest_methods drop constraint if exists rest_methods_integration_id_fkey;
alter table if exists pods.method_responses drop constraint if exists method_responses_method_id_fkey;
