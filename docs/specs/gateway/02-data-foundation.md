# S02 — Data foundation: schema, authorization, audit, vault, management API base

**Wave 1 · Depends on: S01 · Blocks: every spec that stores configuration**

AWS references: [IAM for the control plane](https://docs.aws.amazon.com/apigateway/latest/developerguide/permissions.html), [CloudTrail logging of management calls](https://docs.aws.amazon.com/apigateway/latest/developerguide/cloudtrail.html), [account settings](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-account-settings.html).

Pods equivalents: Geiger project membership plus `@geiger/rbac` permissions replace IAM for *who can configure*. `pods.audit_events` replaces CloudTrail. `pods.project_settings` replaces API Gateway account settings. `lib/vault` is a Pods extension that stores backend credentials. AWS customers use Secrets Manager plus Lambda for this; Pods makes it first-class because the product definition is "hide your upstream keys".

## 1. Permission catalog (`geiger-rbac.config.js`)

Replace the Phase‑0 view-only catalog with the full catalog. Defining every key now avoids edits to this shared file later. Keys use `pods.<resource>.<action>`:

| Group | Keys |
|---|---|
| Workspace views | `pods.<section>.view` for every section in the screen registry (kept from Phase 0) |
| APIs | `pods.api.create`, `pods.api.update`, `pods.api.delete`, `pods.api.import`, `pods.api.export` |
| Build | `pods.route.write`, `pods.integration.write`, `pods.model.write`, `pods.authorizer.write`, `pods.gateway_response.write`, `pods.documentation.write` |
| Release | `pods.deployment.create`, `pods.stage.write`, `pods.stage.promote`, `pods.stage.delete`, `pods.cache.flush`, `pods.test.invoke` |
| Consumers | `pods.api_key.write`, `pods.api_key.reveal`, `pods.usage_plan.write`, `pods.usage.view` |
| Security | `pods.secret.write`, `pods.secret.use`, `pods.client_cert.write`, `pods.trust_store.write`, `pods.waf.write`, `pods.resource_policy.write` |
| Network | `pods.domain.write`, `pods.connector.write` |
| Operations | `pods.logs.view`, `pods.logs.data`(view request/response bodies), `pods.alarm.write`, `pods.audit.view`, `pods.export.write` |
| Distribution | `pods.portal.write`, `pods.portal.publish`, `pods.sdk.generate` |
| WebSocket | `pods.connection.manage` |
| Administration | `pods.settings.write`, `pods.role.grant`, `pods.token.write` |

Scope (`scopeBy`): API-level keys (`route`, `integration`, `model`, `authorizer`, `gateway_response`, `documentation`, `deployment`, `stage*`, `cache.flush`, `test.invoke`) use `scopeBy: "api"`, so a grant can be narrowed to specific APIs.

System roles (inherited from the suite role, `lib/workspace/access.mjs`):

| Role | Permissions |
|---|---|
| owner | `["*"]` |
| admin | `pods.*` except `pods.role.grant` |
| manager | all view keys, all Build, Release (not `stage.delete`), Consumers (not `api_key.reveal`), `logs.*`, `audit.view`, `secret.use`, `portal.write` |
| member | all view keys, `pods.usage.view`, `pods.logs.view` |

Additional product roles (e.g. "API Developer", "Release Manager", "Consumer Support") can be granted per user through `pods.role_grants`. Union semantics apply, as in `@geiger/rbac`.

## 2. Migrations (`supabase/migrations/foundation/`)

Create with `npm run db:new -- <name> --dir foundation`. Every table has the suite columns `id uuid pk default gen_random_uuid()`, `project_id uuid not null references public.projects(id) on delete cascade`, `metadata jsonb not null default '{}'`, `created_by uuid default auth.uid()`, `created_at`, `updated_at` (shared `touch_updated_at()` trigger), `deleted_at`, and `version int not null default 1`, unless stated otherwise.

1. `rbac` — body from `migrationSql("pods")` of `@geiger/rbac`, which creates `pods.role_grants` and `pods.rbac_allows`. Review it. Delete any demo `using (true)` policy, and add the policies in §3.
2. `authz_functions`:
   - `pods.inherited_role(p_project uuid) returns text`: SQL mirror of `inheritedRole()`. Org project → `organization_users.role` for `auth.uid()` (owner/admin/manager, else member). Org-less project → `owner` if `created_by = auth.uid()`. Otherwise null. `security definer`, `stable`, `set search_path = ''`.
   - `pods.role_permissions(p_role text) returns text[]`: a generated literal table. **Generated** by `scripts/gen-rbac-sql.mjs` from `geiger-rbac.config.js`. A test asserts the SQL matches the config, which prevents drift.
   - `pods.can(p_permission text, p_project uuid, p_api uuid default null) returns boolean` = `public.rbac_key_matches(pods.role_permissions(pods.inherited_role(p_project)), p_permission) or pods.rbac_allows(p_permission, p_project, 'api', p_api)`.
   - `pods.is_member(p_project uuid) returns boolean` = `pods.inherited_role(p_project) is not null`.
3. `project_settings` (one row per project, `project_id` pk): `throttle_rate numeric default 10000`, `throttle_burst int default 5000`, `throttle_kv_failure text default 'open' check in ('open','closed')`, `log_retention_days int default 30`, `data_trace_retention_days int default 3`, `default_region text default 'auto'`, `features jsonb default '{}'`. This is the AWS "account settings" equivalent.
4. `audit_events` (append-only; no `updated_at`/`deleted_at`/`version`): `actor_id uuid`, `actor_type text check in ('user','token','system')`, `action text` (e.g. `api.create`), `resource_type text`, `resource_id text`, `api_id uuid null`, `before jsonb`, `after jsonb`, `request_id text`, `source_ip inet`, `user_agent text`, `created_at`. Trigger: `before update or delete → raise exception`. Index `(project_id, created_at desc)`, `(project_id, resource_type, resource_id)`.
5. `secrets`: `name text` (unique per project among non-deleted), `description`, `kind text check in ('generic','header','basic_auth','bearer','aws_credentials','client_certificate','private_key','oauth_client')`, `current_version int`, `last_rotated_at`, `expires_at null`, `fingerprint text` (last 4 chars or cert SHA-256).
   `secret_versions` (immutable): `secret_id`, `version int`, `ciphertext bytea`, `iv bytea`, `auth_tag bytea`, `wrapped_dek bytea`, `kek_id text`, `created_by`, `created_at`, `disabled_at null`. Unique `(secret_id, version)`.

## 3. RLS policies

For every `pods.*` configuration table created by any spec:
- `select`: `pods.is_member(project_id)` (plus `deleted_at is null` in views).
- `insert/update/delete`: `pods.can('<permission for that table>', project_id, api_id)`. Soft-delete is an update.
- `secret_versions`: **no** select policy for `authenticated`. Column-level `revoke select (ciphertext, iv, auth_tag, wrapped_dek)`. Insert happens only through the server vault path (service role, §5). `secrets` metadata is selectable by members.
- `audit_events`: select requires `pods.can('pods.audit.view', project_id)`. Insert is done by the service role or by `security definer` function `pods.audit(...)`. Users can never insert arbitrary rows.
- `role_grants`: select for members; insert/update requires `pods.role.grant`. A grantee can never grant a role holding a key the grantor lacks. Enforce this in function `pods.grant_role(...)` (security definer), and route all grant writes through it.

Each later spec lists its tables and their write permission in a table titled **RLS**. The policy is generated by `@geiger/rbac` `toSqlPolicies` where possible and reviewed by hand.

## 4. Server-side plumbing

- `lib/supabase/server.js`: `createServerSupabase()` uses `createServerClient` from `@supabase/ssr`, with `await cookies()` (Next 16: async) and `suiteCookieOptions`. `createServiceSupabase()` reads `SUPABASE_SERVICE_ROLE_KEY` and throws if it is imported into a client bundle (`import "server-only"`).
- `lib/control/actor.mjs`: `resolveActor(request) → { type:'user'|'token', userId, tokenId?, scopes? }` from the session cookie or `Authorization: Bearer pods_pat_…` (S14). It returns null when unauthenticated.
- `lib/control/authz.mjs`: `requirePermission(db, actor, key, { projectId, apiId })`. It loads project role, membership and grants, evaluates with `@geiger/rbac` (`can`), and throws `HttpError(403, 'forbidden', decision.reason)`. **Defense in depth:** RLS enforces the same rule in the database.
- `lib/control/http.mjs`: `route(handler, { permission })` wraps a Next route handler. It handles JSON parsing with a size cap of 6 MB (the AWS import limit), actor resolution, permission checks, `If-Match` → `version`, error mapping and request-id headers.
- `lib/control/audit.mjs`: `audit(db, actor, { action, resourceType, resourceId, apiId, before, after })`. It redacts any key named `/secret|password|token|value|privateKey|ciphertext/i` before storage.
- `lib/control/validate.mjs`: a tiny schema validator (`object`, `string{min,max,pattern}`, `int{min,max}`, `enum`, `array`, `optional`). Specs declare input shapes with it.

## 5. Vault (`lib/vault/`)

- Keys: `PODS_VAULT_KEYS` is a JSON map `{ "<kid>": "<base64 32 bytes>" }` and `PODS_VAULT_ACTIVE_KID` selects the active key. Both are server-only. Startup fails if the active kid is missing.
- Encryption: per-version random 32-byte DEK, AES-256-GCM. The DEK is wrapped with the KEK (AES-256-GCM). AAD = `${projectId}:${secretId}:${version}`. Implementation uses `node:crypto` only.
- API: `createSecret(db, actor, { projectId, name, kind, value, description })`, `rotateSecret(...)` (new version, old version stays valid until disabled), `disableVersion`, `deleteSecret` (soft delete; versions retained 30 days, then purged by job), `resolve(ref)` (service role only). A **secret ref** is `secret:<secretId>` (latest enabled) or `secret:<secretId>@<version>`. Configuration rows and artifacts store refs, never values.
- `kind` validation: `header` = `{name, value}`; `basic_auth` = `{username, password}`; `bearer` = `{token}`; `aws_credentials` = `{accessKeyId, secretAccessKey, sessionToken?, region?}`; `client_certificate` = `{certificatePem, privateKeyPem, passphrase?}`; `oauth_client` = `{tokenUrl, clientId, clientSecret, scope?, audience?}`.
- Values are **write-only**. The management API never returns them; responses include `fingerprint` and `kind` only.
- Rotation re-encrypt job: `scripts/vault-rewrap.mjs --to <kid>` re-wraps DEKs under a new KEK without touching ciphertext.

## 6. Workspace routing & navigation

Phase 0 supports only single-segment sections. Replace `resolveSection(rest)` with `resolveScreen(rest)`. It matches a registry of patterns and returns `{ section, screen, params }` or `null`:

```js
// lib/workspace/screens.mjs
export const SCREENS = [
  { pattern: [],                                   section: "overview",   screen: "overview" },
  { pattern: ["apis"],                             section: "apis",       screen: "apiList" },
  { pattern: ["apis", ":apiId"],                   section: "apis",       screen: "apiDetail" },
  { pattern: ["apis", ":apiId", ":tab"],           section: "apis",       screen: "apiDetail" }, // tab ∈ allowed list
  // later specs add rows (keys, plans, domains, connectors, portals, monitoring…)
];
```

Unknown patterns and disallowed tabs return `null`, which renders not-found as before. Keep the Phase‑0 tests and add the new ones. Sidebar sections become: Overview, APIs, Usage plans & keys, Custom domains, Connectors, Secrets, Monitoring, Portals, Audit, Settings, Roadmap. Each one is gated by `pods.<section>.view`.

## 7. Screens delivered by S02

- **Secrets** (`/secrets`): list (name, kind, fingerprint, current version, last rotated, used-by count), create dialog (kind-specific write-only fields), rotate, disable version, delete with the used-by list as a blocker. Never displays values.
- **Settings** (`/settings`): existing read-only project details, plus editable project settings (throttle rate/burst, KV failure mode, retention) gated by `pods.settings.write`.
- **Team access** (`/settings/access`): product role grants list, grant/revoke via `pods.grant_role`, scope narrowing to specific APIs.

## Management API (S02)

| Method & path | Permission |
|---|---|
| `GET/PATCH /api/v1/projects/{p}/settings` | view / `pods.settings.write` |
| `GET/POST /api/v1/projects/{p}/secrets`, `GET/PATCH/DELETE …/secrets/{id}`, `POST …/secrets/{id}/rotate`, `POST …/secrets/{id}/versions/{v}/disable` | `pods.secret.write` |
| `GET /api/v1/projects/{p}/audit?resourceType=&resourceId=&actor=&from=&to=` | `pods.audit.view` |
| `GET/POST/DELETE /api/v1/projects/{p}/role-grants` | `pods.role.grant` |

## Acceptance tests

- `S02: generated role_permissions SQL equals geiger-rbac config` (pure test over the generator).
- `S02: member cannot create a secret; manager can use but not write; admin can write` (authz unit tests through `requirePermission`).
- `S02 [db]: user A cannot select rows of project B; nonmember of org project sees nothing even if public.projects RLS is permissive`.
- `S02 [db]: authenticated role cannot select secret_versions.ciphertext`.
- `S02 [db]: audit_events rejects update and delete`.
- `S02: vault round-trips a value; tampered ciphertext, wrong AAD and wrong KEK each fail`.
- `S02: rotate keeps old version resolvable until disabled; disabled version resolve throws`.
- `S02: management API never returns secret value fields (snapshot of every secrets endpoint response)`.
- `S02: resolveScreen matches nested patterns and rejects unknown tabs`.
- `S02: grant_role refuses to grant a role containing keys the grantor lacks`.
- `S02: audit redacts secret-like keys in before/after`.
