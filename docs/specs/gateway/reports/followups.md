# Cross-spec follow-ups (orchestrator log)

Findings reported by agents or reviewers that belong to another spec's files. The owning spec's next pass, or the S15 hardening pass, must close each one. Mark it done with evidence.

| # | Source | Owner | Item | Status |
|---|---|---|---|---|
| F1 | S01 review | S06 | `gateway-responses.mjs` `resolveGatewayCustomization`: `table[type]` reads through the prototype chain. Use `Object.hasOwn` | **done** (orchestrator): `Object.hasOwn` lookups |
| F2 | S01 review | S06 | `resolveGatewayParameter`/`lookupGatewayHeader`: `name in bag` and `stageVariables[...]` without `__proto__`/`constructor` guards | **done** (orchestrator): `ownValue` helper for stageVariables/context/query; multivalue headers case-insensitive (also closes part of F18) |
| F3 | S01 review | S12 | `runPipeline` fallback for `WEBSOCKET` protocol is the REST 403; S12 must define WS behavior | open |
| F4 | S04 report | S15 | `PODS_ALLOW_LOOPBACK` / `integration.allowLoopback` SSRF test escape hatch: production must refuse to start or ignore it when `NODE_ENV=production` | open |
| F5 | S04 report | S05/S15 | `project_settings.max_integration_timeout_ms` (raise REST timeout to 300 s) not implemented; validation caps at 29 s / 30 s | open |
| F6 | S06 report | integration | Add FKs from S06 tables to `pods.rest_methods` / `pods.integrations` now that both exist | open |
| F7 | S02/S03/S04/S06 reports | all | Migrations never applied to a real Postgres; `[db]` RLS tests skipped. Needs `PODS_TEST_DB_URL` + `pg` devDependency | open |
| F8 | S03 report | S05 | HTTP quickCreate stub (`provisionQuickCreateTarget`) must be completed once integrations and stages exist | open |
| F10 | S02 review | orchestrator | `pods.audit()` callable by any authenticated user → forged audit rows | **done**: guard added (member of project, actor = caller) in `20261006000102_authz_functions.sql`; needs DB test once F7 lands |
| F11 | S02 review | S02/UI pass | Secrets screen missing "disable version" action, last-rotated column, client-side used-by pre-check | open |
| F12 | S02 review | S04 follow-up | `countSecretReferences` swallows all errors (fails open once S04 tables exist); narrow to missing-table only | open |
| F13 | S02 review | S15 | Audit pagination cursor lacks `id` tiebreak; `settings.features` unwritable (dead branch) | open |
| F14 | S03 review | S15 | Catalog RLS: `apis_update` lets `pods.api.update` holders soft-delete via direct SQL; `rest_resources/rest_methods/http_routes` `FOR ALL` allows hard DELETE. Tighten in a follow-up migration with DB tests | open |
| F15 | S03 review | orchestrator | Cursor strings interpolated into PostgREST `or()` filters | **done**: strict ISO-timestamp + uuid validation in all five `decodeCursor` copies (`lib/control/{apis,connectors,integrations,secrets,audit}.mjs`); S15 should dedupe them into one module |
| F16 | S03 review | S15 | No atomicity in clone handlers / `deleteResource` (db port lacks transactions) | open |
| F17 | S06 review | S06/S15 | ReDoS surfaces: CORS wildcard origin regex built per request; VTL `replaceAll/split/matches` compile request-controlled regex (AWS parity). Precompile and bound input length or run in a linear engine | open |
| F18 | S06 review | S01/S06 | `resolveGatewayParameter` multivalue lookup is case-sensitive; `status_code` unchecked; `truncateBody` slices UTF-16 after UTF-8 measure; compression header casing | open |
| F19 | S05 report | S04 | `tests/fixtures/upstream.mjs` `/sleep/*` destroys the response when `req.destroyed` (normal on Node 24 after body read) | open |
| F20 | S05 report | S03/S04/S06 + UI pass | Draft-mutation routes don't call `scheduleAutoDeploy` yet (HTTP auto-deploy only fires from the deployments route) | open |
| F21 | S05 report | S15 | Deploy lock is in-process; wire `db.advisoryLock` (Postgres) for multi-instance control planes | open |
| F22 | S04 review | orchestrator | `invoke.mjs` `renderRefined` responses lacked `x-pods-request-id` | **done**: `runPhases` adds `x-pods-request-id` to every phase `Response` (orchestrator fix to S01 pipeline, incl. immutable-header re-wrap) |
| F23 | S04 review | S15 | `verifyWebhookSignature` non-timing-safe compare; connector token modulo bias; `serveStream` buffers full private response (≤10 MB) | open |
| F24 | S04 review | S04 owner / S15 | `integration_responses_write` RLS ignores parent `deleted_at`; `recordHeartbeat` must only be exposed on a service-role path | open |
| F9 | all reports | orchestrator | `parity-status.md` rows not updated by agents (by design); orchestrator updates after each wave | open |
| F25 | S14 report | S08 + S11 + S13 | Stack kinds for `usagePlans`, `domains`, WAF, portals: register via `registerStackHandler` once those specs land; throttle-diff acceptance then moves from API-field proxy to a real plan kind | open |
| F26 | S14 report | S14/UI pass | `?tag:Key=Value` filters on all list endpoints (`parseTagFilters` ships; not wired into in-flight list handlers to avoid colliding with S08/S10) | open |
| F27 | S14 report | orchestrator/UI pass | `components/internal/screens/admin/` (tokens, tags, stacks) standalone; register in `registry.jsx` + sidebar + `/settings/tokens` route after Wave 4 shared-file churn settles | open |
| F28 | S14 report | S15 | CLI live e2e (login → create → deploy → logs tail) needs a running app + DB; idempotency/rate-limit KV backing for multi-instance control planes | open |
