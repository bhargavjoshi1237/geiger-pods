-- B2 F24: integration_responses_write must ignore soft-deleted parents
-- (the read policy already checks `i.deleted_at is null`).
--
-- @up
drop policy if exists integration_responses_write on pods.integration_responses;
create policy integration_responses_write on pods.integration_responses
  for all to authenticated
  using (
    exists (
      select 1 from pods.integrations i
      where i.id = integration_id
        and pods.can('pods.integration.write', i.project_id, i.api_id)
        and i.deleted_at is null
    )
  )
  with check (
    exists (
      select 1 from pods.integrations i
      where i.id = integration_id
        and pods.can('pods.integration.write', i.project_id, i.api_id)
        and i.deleted_at is null
    )
  );

-- @down
drop policy if exists integration_responses_write on pods.integration_responses;
create policy integration_responses_write on pods.integration_responses
  for all to authenticated
  using (
    exists (
      select 1 from pods.integrations i
      where i.id = integration_id
        and pods.can('pods.integration.write', i.project_id, i.api_id)
    )
  )
  with check (
    exists (
      select 1 from pods.integrations i
      where i.id = integration_id
        and pods.can('pods.integration.write', i.project_id, i.api_id)
    )
  );
