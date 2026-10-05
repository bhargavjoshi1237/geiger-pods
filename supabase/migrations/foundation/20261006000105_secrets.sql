-- S02 data foundation: vault storage. `secrets` holds metadata (selectable by
-- project members); `secret_versions` holds envelopes. Ciphertext columns are
-- revoked from authenticated at the column level, so even a permissive
-- follow-up policy can never expose them; version rows are written only
-- through the server vault path (service role).
--
-- @up
create table if not exists pods.secrets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  description text,
  kind text not null check (kind in ('generic', 'header', 'basic_auth', 'bearer', 'aws_credentials', 'client_certificate', 'private_key', 'oauth_client')),
  current_version integer not null default 1,
  last_rotated_at timestamptz,
  expires_at timestamptz,
  fingerprint text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

create unique index if not exists secrets_project_name_uniq
  on pods.secrets (project_id, name) where deleted_at is null;

drop trigger if exists secrets_touch_updated_at on pods.secrets;
create trigger secrets_touch_updated_at
before update on pods.secrets
for each row execute function pods.touch_updated_at();

create table if not exists pods.secret_versions (
  id uuid primary key default gen_random_uuid(),
  secret_id uuid not null references pods.secrets(id) on delete cascade,
  version integer not null,
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  wrapped_dek bytea not null,
  kek_id text not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create unique index if not exists secret_versions_secret_version_uniq
  on pods.secret_versions (secret_id, version);
create index if not exists secret_versions_secret_idx
  on pods.secret_versions (secret_id);

alter table pods.secrets enable row level security;
alter table pods.secret_versions enable row level security;

drop policy if exists secrets_read on pods.secrets;
create policy secrets_read on pods.secrets
  for select to authenticated using (pods.is_member(project_id) and deleted_at is null);

drop policy if exists secrets_write on pods.secrets;
create policy secrets_write on pods.secrets
  for all to authenticated
  using (pods.can('pods.secret.write', project_id))
  with check (pods.can('pods.secret.write', project_id));

-- Version metadata (not envelopes) is readable by members; ciphertext columns
-- stay revoked so a faulty future grant cannot leak them.
grant select (id, secret_id, version, kek_id, created_by, created_at, disabled_at)
  on pods.secret_versions to authenticated;

drop policy if exists secret_versions_read on pods.secret_versions;
create policy secret_versions_read on pods.secret_versions
  for select to authenticated using (
    exists (
      select 1 from pods.secrets s
      where s.id = secret_id
        and pods.is_member(s.project_id)
        and s.deleted_at is null
    )
  );

-- No insert/update/delete policies for authenticated on secret_versions:
-- version rows are written only through the server vault path (service role).

-- @down
drop policy if exists secret_versions_read on pods.secret_versions;
revoke select (id, secret_id, version, kek_id, created_by, created_at, disabled_at)
  on pods.secret_versions from authenticated;
drop policy if exists secrets_write on pods.secrets;
drop policy if exists secrets_read on pods.secrets;
drop trigger if exists secrets_touch_updated_at on pods.secrets;
drop index if exists pods.secret_versions_secret_idx;
drop index if exists pods.secret_versions_secret_version_uniq;
drop table if exists pods.secret_versions;
drop index if exists pods.secrets_project_name_uniq;
drop table if exists pods.secrets;
