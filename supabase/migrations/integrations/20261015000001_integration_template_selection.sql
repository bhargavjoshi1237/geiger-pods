-- B3 S06 config: WebSocket template selection expression on integrations
-- (S12 §1: `template_selection_expression` for request templates).
--
-- @up
alter table if exists pods.integrations
  add column if not exists template_selection_expression text;

-- @down
alter table if exists pods.integrations
  drop column if exists template_selection_expression;
