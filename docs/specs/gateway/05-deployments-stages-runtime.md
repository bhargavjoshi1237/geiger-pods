# S05 — Deployments, stages & gateway runtime host

**Wave 3 · Depends on: S03, S04 (and ADR-1 confirmation) · Blocks: S06 runtime wiring, S07–S14**

This spec delivers the **first working gateway**: a published stage receives real traffic and forwards it to a real backend.

AWS references: [REST deployments](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-deploy-api.html), [REST stages](https://docs.aws.amazon.com/apigateway/latest/developerguide/stages.html), [stage variables](https://docs.aws.amazon.com/apigateway/latest/developerguide/stage-variables.html), [HTTP stages & auto-deploy](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-stages.html), [invoke URL](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-call-api.html), [test invoke](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-test-method.html).

## 1. Deployment artifact (`lib/gateway/artifact/`)

`compile(draft) → { artifact, warnings[], errors[] }`. It is pure, takes the full draft graph for one API, and is deterministic, so the same draft always gives the same bytes.

```jsonc
{
  "schemaVersion": 1,
  "projectId": "uuid", "apiId": "uuid", "apiPublicId": "a1b2c3d4e5", "protocol": "REST",
  "settings": { "apiKeySource": "HEADER", "binaryMediaTypes": [], "minimumCompressionSize": null,
                "missingRouteBehavior": "aws", "cors": null, "resourcePolicy": null, "routeSelectionExpression": null },
  "routes":    [ /* HTTP/WS: {id, routeKey, auth{type, authorizerId, scopes}, apiKeyRequired, integrationId, ...} */ ],
  "resources": [ /* REST: {id, path, methods:{GET:{id, auth, apiKeyRequired, validatorId, requestParameters, requestModels, integrationId, methodResponses}}} */ ],
  "integrations": { "<id>": { /* S04 fields; secrets only as refs */ } },
  "authorizers": { }, "models": { }, "validators": { }, "gatewayResponses": { }, "integrationResponses": { },
  "matcher": { /* precompiled trie from S03 */ },
  "digest": "sha256:<hex of canonical JSON without digest>"
}
```

**Compile errors** (deploy refused, 422) follow AWS validations. Examples: a REST method with no integration ("No integration defined for method"); an HTTP route with no target where the API has no `$default` behavior; an authorizer reference that doesn't exist; a template that fails to parse (S06); a model reference that doesn't exist; a CONNECTOR integration without a connector; an unknown `$context` variable in a mapping; a capability not supported by the protocol. A REST API with zero methods is refused with "The REST API doesn't contain any methods".
**Warnings** (deploy allowed): unused integrations/models, authorizer with caching but no identity source, etc.

Canonical JSON: sorted keys, no whitespace, UTF‑8. The artifact **must not** contain secret values; `compile` throws if any string matches the vault's plaintext cache (test hook) or any `backend_auth` field contains a non-ref value.

## 2. Data model (`supabase/migrations/releases/`)

`pods.deployments` (immutable after insert; no update policy): `api_id`, `public_id`, `description`, `artifact jsonb`, `digest text`, `schema_version int`, `warnings jsonb`, `created_by`, `created_at`. Unique `(api_id, digest)` is **not** enforced, because identical redeploys are allowed (AWS creates a new deployment each time). Index `(api_id, created_at desc)`.

`pods.stages`: `api_id`, `name`, `deployment_id`, `description`, `variables jsonb`, `auto_deploy bool` (HTTP/WS), `client_certificate_id null`, `default_route_settings jsonb`, `route_settings jsonb` (HTTP/WS: routeKey → settings), `method_settings jsonb` (REST: `"{resourcePath}/{METHOD}"` or `"*/*"` → settings, S08/S09/S10 own the keys), `access_log` jsonb (S10), `tracing_enabled bool` (S10), `cache_cluster_enabled bool`, `cache_cluster_size text` (S09), `canary jsonb null` (S09), `last_deployment_status_message text` (auto-deploy errors), `tags jsonb`, `version int`. Unique `(api_id, name)`.
- Name rules: REST `^[A-Za-z0-9_-]{1,128}$`. HTTP/WS also allow `$default` (one per API), which serves without a stage path prefix.
- Variables: ≤100 entries; key `^[A-Za-z0-9_]{1,64}$`; value ≤512 chars from `[A-Za-z0-9-._~:/?#&=,]` (AWS character set).

`pods.stage_history` (append-only): `stage_id`, `from_deployment_id`, `to_deployment_id`, `reason` (`deploy`/`rollback`/`auto_deploy`/`canary_promote`), `actor_id`, `created_at`.

**RLS:** deployments insert requires `pods.deployment.create`. Stages insert/update require `pods.stage.write`; changing `deployment_id` additionally requires `pods.stage.promote` (enforced in service and in a `before update` trigger calling `pods.can`). Delete requires `pods.stage.delete`.

## 3. Control-plane operations (`lib/control/deployments.mjs`, `stages.mjs`)

- **Create deployment** `POST …/apis/{apiId}/deployments {description, stageName?, stageDescription?}`. It loads the draft in one read transaction, compiles, and inserts. If `stageName` is given, it creates or updates the stage pointer in the same transaction (AWS `CreateDeployment` with `stageName`). A Postgres advisory lock is taken per API, and a concurrent deploy gets 409 `deploy_in_progress`. Rate limit: 1 deploy / 2 s per API (AWS: 1 / 5 s per account).
- **Update stage pointer** (`PATCH …/stages/{name} {deploymentId}`, `If-Match` version): this is a compare-and-swap. It writes `stage_history` and publishes the `pods:stage-changed` KV message `{apiPublicId, stage}`.
- **Rollback** `POST …/stages/{name}/rollback {deploymentId}`: same as a pointer update, with reason `rollback`. The UI lists the history.
- **Auto-deploy** (HTTP/WS only): after any committed draft mutation of an API that has an auto-deploy stage, `scheduleAutoDeploy(apiId)` debounces 1 s, then compiles and deploys to every auto-deploy stage. On compile error, live traffic is untouched, and the stage gets `last_deployment_status_message` plus an audit entry. It runs in-process via `after()` (`next/server`) from the mutating route handler.
- **Delete deployment**: allowed only if no stage or canary references it. Otherwise 409, naming those stages (AWS parity).
- **Compare deployments** `GET …/deployments/{a}/diff/{b}`: structural JSON diff for the UI.
- **Test invoke** (REST; capability `testInvoke`) `POST …/resources/{rid}/methods/{m}/test-invoke {pathWithQueryString, headers, body, stageVariables, clientCertificateId}`. It compiles the **draft** in memory and runs the engine in the Next server with real ports. It **skips** authorization, API keys, throttling, quotas and caching (AWS test invoke bypasses them) and never writes to stages. It returns `{status, headers, multiValueHeaders, body, latencyMs, log}`. `log` is an execution-log transcript in AWS style ("Starting execution for request…", "Method request path:", "Endpoint request URI:", "Endpoint response body before transformations:", …), with secret values masked. Permission: `pods.test.invoke`. Test traffic is excluded from metrics and usage.

## 4. Invoke URLs

- Host-based (canonical): `https://{apiPublicId}.{PODS_GATEWAY_DOMAIN}/{stage}/{path}`; for a `$default` stage: `https://{apiPublicId}.{PODS_GATEWAY_DOMAIN}/{path}`. `PODS_GATEWAY_DOMAIN` example: `gw.geigerpods.app`, with wildcard DNS and a wildcard TLS cert.
- Path-based (local/dev, or when the wildcard is unavailable): `http://localhost:4000/{apiPublicId}/{stage}/{path}`, enabled by `PODS_GATEWAY_PATH_ROUTING=1`.
- Vercel adapter (ADR-1): `/gw/{apiPublicId}/{stage}/{path}` under the app's base path.
- Custom domains (S11) map host + base path → API + stage.
- Stage resolution (HTTP APIs): if the first segment equals a stage name, use it. Otherwise use `$default` if present. Otherwise → 404 `{"message":"Not Found"}`. REST: an unknown stage → 403 `{"message":"Forbidden"}`.

## 5. Runtime host (`gateway/`)

- `gateway/server.mjs`: `node:http` server (TLS terminated by the platform load balancer, or `node:https` when S11 mTLS is enabled). It converts `IncomingMessage` → Web `Request` (streaming body, honors client abort) and Web `Response` → `ServerResponse` (streaming, `flushHeaders` for S09). Default port `PORT=4000`. Health: `GET /_pods/health` (liveness) and `/_pods/ready` (artifact store reachable). It never matches under an API host.
- `gateway/loader.mjs`:
  - `resolve(host, path) → { api, stage, deployment, basePathStripped }`. Order: custom domain (S11) → default host pattern → path-based.
  - Store: Postgres via `@supabase/supabase-js` with `SUPABASE_SERVICE_ROLE_KEY`, read-only queries on `apis(public_id)`, `stages`, `deployments`.
  - Caches: artifacts keyed by deployment id, LRU 500 entries, immutable, never expire. Stage pointers expire after 5 s **and** are invalidated immediately on `pods:stage-changed` (KV pub/sub) or a Postgres `LISTEN pods_stage_changed` fallback. Negative cache for unknown hosts: 5 s.
  - **Propagation SLO:** a stage change serves the new deployment on every runtime instance within ≤ 5 s, measured in tests.
  - On a store outage, keep serving cached artifacts ("stale-if-error"). An unknown API during an outage → 503.
- Ports wiring (S01 §6): `fetch` (undici Agent with the SSRF lookup), `kv` (redis or memory), `secrets` (vault resolver with service role), `events` (S10 sink; no-op until S10), `clock`.
- `gateway/Dockerfile` (node:22-slim, non-root, `npm ci --omit=dev`, `node gateway/server.mjs`). `npm run gateway:dev` runs `node --watch gateway/server.mjs` with path routing on.
- Graceful shutdown: stop accepting, drain in-flight requests ≤ 30 s, close WebSockets with 1001 (S12).

## 6. Screens

- **Deploy button** (API header): dialog to pick an existing stage or create a new one, with a description. It shows compile warnings/errors inline, and an error links to the offending route/method.
- **Stages tab**: list (name, deployed revision, deployed at/by, invoke URL with copy, auto-deploy badge, canary badge). Stage detail sub-tabs: *Settings* (description, variables editor, client certificate), *Throttling* (S08), *Logs & tracing* (S10), *Cache* (S09), *Canary* (S09), *History* (pointer changes with a rollback action and a deployment diff viewer).
- **Deployments tab**: immutable list with digest prefix, description and creator, plus "deploy this revision to stage…" and compare.
- **Test tab** on a REST method: a request builder (path, query, headers, body, stage variables) with response and log panes.

## Acceptance tests

- `S05: compile is deterministic (same draft → same digest) and rejects a REST API without methods`.
- `S05: compile refuses missing integration, dangling authorizer, unsupported capability; returns warnings for unused models`.
- `S05: artifact contains no secret values (fixture with backend_auth secret)`.
- `S05 [runtime]: create HTTP API with $default route → deploy to $default stage → GET via host-based URL reaches upstream echo; path has no stage prefix`.
- `S05 [runtime]: REST stage "prod" serves /prod/pets; unknown stage → 403 Forbidden; HTTP unknown stage without $default → 404`.
- `S05 [runtime]: editing the draft does not change live responses until deploy`.
- `S05 [runtime]: rollback restores exact previous behavior; stage_history records both moves`.
- `S05 [runtime]: stage pointer change propagates to two runtime instances within 5 s via pub/sub; within TTL when pub/sub is down`.
- `S05: stage variables substitute in integration URI and are validated (key/value charset, ≤100)`.
- `S05: concurrent deploys to one API → one succeeds, other 409`.
- `S05: auto-deploy redeploys after a route change; a broken change leaves the stage on the previous deployment and sets last_deployment_status_message`.
- `S05: deleting a deployment referenced by a stage → 409 naming the stage`.
- `S05: test invoke bypasses authorizer/API key/throttle, does not change stage or usage, masks secrets in log`.
- `S05 [runtime]: store outage keeps serving cached artifact; graceful shutdown drains an in-flight slow request`.
- `S05 [db]: member cannot deploy; manager can deploy but cannot delete a stage; pointer change without pods.stage.promote is rejected by trigger`.
