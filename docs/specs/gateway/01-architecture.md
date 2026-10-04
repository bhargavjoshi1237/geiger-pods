# S01 — Architecture, conventions & shared engine contracts

**Wave 1 · Depends on: nothing · Blocks: every other spec**

This spec defines how Pods is split into a control plane and a data plane, where code lives, and the shared contracts every feature plugs into. These are the request pipeline, the context-variable catalog, gateway responses, the capability matrix, state-store interfaces and test rules. It also delivers the scaffolding: empty modules with real interfaces and tests.

## 1. Architecture

```
            ┌─────────────────────── Control plane (Next.js app, this repo) ───────────────────────┐
 Browser ──►│ Workspace UI (/project/[id]/...)  ──►  Management API (app/api/v1/**, route handlers) │
 CLI ──────►│                                         │  lib/control/** services (server only)      │
            │                                         ▼                                             │
            │                       Supabase Postgres, schema `pods` (RLS) + public.projects       │
            └─────────────────────────────────────────┬─────────────────────────────────────────────┘
                                                      │ published deployment artifacts (read-only)
            ┌────────────────── Data plane: gateway runtime (gateway/ — Node service) ──────────────┐
 Consumer ─►│ host/stage resolve → pipeline (lib/gateway/core/**) → integration adapters → backend  │
            │        ▲ state store (Redis-compatible KV: throttles, quotas, cache, authorizer cache) │
            │        └ event sink (request events → Postgres rollups / exporters)                   │
            └───────────────────────────────────────────────────────────────────────────────────────┘
```

### ADR-1: separate data-plane host, shared engine core

- **Engine core** `lib/gateway/core/**`: pure ES modules. Input is a Web `Request` plus a compiled artifact; output is a Web `Response`. No Next.js, Supabase or Node-only APIs except through injected ports (`fetch`, KV store, clock, crypto, event sink, secret resolver). All feature logic lives here and is unit-tested with `node --test`.
- **Primary runtime host** `gateway/`: a standalone Node ≥22 HTTP/1.1 + WebSocket server (`node:http`, `node:https` for mTLS, `ws` package for WebSocket). It is required for WebSocket (S12), mTLS client certificates (S11), long-lived streaming (S09), raw host-based routing and private connectors (S04). It runs locally via `npm run gateway:dev` and deploys as a container (Dockerfile in `gateway/`).
- **Optional Vercel adapter** `app/gw/[[...path]]/route.js`: a thin wrapper that calls the same engine for path-style invocation (`/gw/{apiId}/{stage}/...`), so HTTP/REST features work without the container. It must declare unsupported capabilities (WebSocket, mTLS, response streaming beyond the platform timeout) and return `API_CONFIGURATION_ERROR` if an artifact needs them.
- **Why:** Vercel Functions cannot terminate client TLS (mTLS), host WebSocket connections or hold connections open indefinitely, and Next's `basePath: '/pods'` prefixes every route. A gateway must control raw TLS, hosts and connections. **This needs the user's confirmation before S05 starts.** S01–S04 do not depend on it.

### ADR-2: AWS vocabulary for resources

The product brand is "Pods". Resources use AWS names so agents and users can map documentation one-to-one: **API** (protocol `REST` | `HTTP` | `WEBSOCKET`), **resource**, **method**, **route**, **integration**, **authorizer**, **model**, **request validator**, **deployment**, **stage**, **API key**, **usage plan**, **domain name**, **API mapping**, **connector** (VPC link), **client certificate**, **trust store**, **portal**. In UI copy, an API may also be called a "Pod". Code, tables and URLs use the AWS term.

### ADR-3: draft → compile → immutable artifact

Users edit a mutable **draft** (normalized tables in `pods.*`). **Deploy** compiles the draft into a single immutable JSON **artifact**, validates it, computes a SHA-256 digest and stores it in `pods.deployments`. Stages point at a deployment. The runtime only ever reads artifacts, never draft tables. The artifact contains **no secret plaintext**, only secret references (S02 vault).

### ADR-4: state store port

Throttling, quotas, caching, authorizer-result caching, WebSocket connection registry and JWKS caching use a `KvStore` port (§6) with two implementations: `memory` (tests, single process) and `redis` (production; any Redis-protocol server, e.g. Upstash via Vercel Marketplace). Connection string env: `PODS_KV_URL`. If the KV store is down, the gateway fails open for caching and fails closed for quotas. Throttling is configurable per project, and the default is fail-open with a local in-memory token bucket.

### ADR-5: identifiers

- DB primary keys: `uuid` (`gen_random_uuid()`).
- Public API id: 10 chars `[a-z0-9]` (like AWS `a1b2c3d4e5`), unique, immutable, used in hostnames: `lib/gateway/ids.mjs#newPublicId()` using `crypto.getRandomValues`, rejection-sampled.
- Other public short ids (resource, route, integration, authorizer, deployment, key, plan): 6–10 char `[a-z0-9]`, unique per API/project. These appear in `$context` variables and logs.
- Request ids: UUID v4. The extended request id is a base32 timestamp+random (like AWS `extendedRequestId`).

## 2. Repository layout and module ownership

```
lib/gateway/
  capabilities.mjs           S01  protocol × feature matrix (single source of truth)
  ids.mjs                    S01
  artifact/                  S05  compile(draft) → artifact, validate, digest
  core/
    pipeline.mjs             S01  ordered phase runner + extension registry
    context.mjs              S01  $context builder and variable resolver
    gateway-responses.mjs    S01  response-type catalog + renderer (S06 adds customization)
    errors.mjs               S01  GatewayError(type, message, extra)
    limits.mjs               S01/S15
    match/                   S03  http-routes.mjs, rest-resources.mjs
    integrations/            S04  http.mjs, mock.mjs, function.mjs, aws.mjs, connector.mjs
    processing/              S06  cors.mjs, param-mapping.mjs, validation.mjs, templates/ (VTL), content.mjs, compression.mjs
    auth/                    S07  sigv4.mjs, jwt.mjs, custom.mjs, resource-policy.mjs
    usage/                   S08  api-key.mjs, throttle.mjs, quota.mjs
    release/                 S09  canary.mjs, cache.mjs, streaming.mjs
    observe/                 S10  access-log.mjs, execution-log.mjs, metrics.mjs, tracing.mjs
    edge/                    S11  host-resolve.mjs, routing-rules.mjs, waf.mjs, mtls.mjs
    websocket/               S12
  state/                     S01  kv.mjs (port), memory-kv.mjs, redis-kv.mjs
lib/control/                 S02+ server-only services, one file per resource (apis.mjs, routes.mjs, …)
lib/vault/                   S02  envelope encryption + secret refs
app/api/v1/**                S02+ management route handlers (thin: auth → service → JSON)
gateway/                     S05  runtime host (server.mjs, loader.mjs, Dockerfile)
components/internal/screens/<area>/   each spec its own folder
supabase/migrations/<area>/  each spec its own subfolder (geiger-orm supports subfolders)
tests/gateway/**, tests/control/**    node:test, *.test.mjs
docs/specs/gateway/parity-status.md   S01 creates; every spec updates its rows
```

Shared-file extension points, so parallel specs don't collide:
- **Pipeline phases** are registered in `lib/gateway/core/phases/index.mjs` as an ordered list of imports. Each spec adds one line for its phase module. The order is fixed by §3.
- **Capabilities**: each spec adds its keys to `capabilities.mjs` in its own clearly delimited block.
- **Workspace navigation**: S02 changes `SECTIONS`/`resolveSection` to support nested routes via a registry. Each spec then registers screens in `components/internal/screens/registry.jsx` with one entry.
- **package.json**: S01 changes the test script to `node --test "tests/**/*.test.mjs"` and adds `gateway:dev`. Other specs only add dependencies.

## 3. The request pipeline (REST/HTTP)

`pipeline.mjs` runs phases in this fixed order. Each phase is `async (ctx) => void | Response`. Returning a `Response`, or throwing `GatewayError`, short-circuits to the response phase. Each phase checks `capabilities` for the API's protocol and is a no-op when the feature is off.

| # | Phase | Spec | AWS behavior mirrored |
|---|---|---|---|
| 1 | `receive` — request id, start time, limits (URL length, header bytes, body bytes) | S01/S15 | 413 `REQUEST_TOO_LARGE`, 414 |
| 2 | `resolveEndpoint` — host → domain/default endpoint → API + stage (mappings, routing rules, `$default` stage) | S05/S11 | 403 `{"message":"Forbidden"}` for unknown API/stage on REST |
| 3 | `endpointAccess` — disabled default endpoint, private API, mTLS verification | S11 | 403 |
| 4 | `waf` | S11 | 403 `WAF_FILTERED` |
| 5 | `match` — route/resource+method; path params; greedy | S03 | REST: 403 `MISSING_AUTHENTICATION_TOKEN`; HTTP: 404 `{"message":"Not Found"}` |
| 6 | `cors` — managed preflight (HTTP API) before auth | S06 | HTTP CORS answers OPTIONS without authorizer |
| 7 | `canary` — pick canary or base deployment | S09 | |
| 8 | `resourcePolicy` (pre-auth: IP/source conditions) | S07 | 403 `ACCESS_DENIED` |
| 9 | `authorize` — NONE / signed / JWT / custom | S07 | 401 `UNAUTHORIZED`, 403 `ACCESS_DENIED`/`INVALID_SIGNATURE`/`EXPIRED_TOKEN`, 500 `AUTHORIZER_*` |
| 10 | `resourcePolicy` (post-auth: principal conditions) | S07 | |
| 11 | `apiKey` — required key, enabled, associated with a plan for this stage | S08 | 403 `INVALID_API_KEY` |
| 12 | `throttle` — project → plan/key(+method) → stage/route/method | S08 | 429 `THROTTLED` |
| 13 | `quota` | S08 | 429 `QUOTA_EXCEEDED` |
| 14 | `validate` — request validator: params, body (model by content type) | S06 | 400 `BAD_REQUEST_PARAMETERS`/`BAD_REQUEST_BODY`, 415 `UNSUPPORTED_MEDIA_TYPE` |
| 15 | `cacheLookup` | S09 | |
| 16 | `integrationRequest` — param mapping, template, content handling | S06 | 500 `API_CONFIGURATION_ERROR` on template error |
| 17 | `invoke` — integration adapter with timeout, streaming option | S04/S09 | 504 `INTEGRATION_TIMEOUT`, 502/504 `INTEGRATION_FAILURE` |
| 18 | `integrationResponse` — selection pattern, mappings, templates | S06 | |
| 19 | `methodResponse` — CORS response headers, compression, cache store | S06/S09 | |
| 20 | `emit` — access log, execution log, metrics, trace span (post-response, never blocks) | S10 | |

A thrown `GatewayError` produces a **gateway response** (§5). Every response gets the headers `x-pods-request-id` (AWS: `x-amzn-RequestId`) and, on gateway-generated errors, `x-pods-error-type` (AWS: `x-amzn-ErrorType`). Trace context: `traceparent` is propagated (S10).

## 4. Context variable catalog (`lib/gateway/core/context.mjs`)

One builder produces the `$context` object used by mapping (S06), templates (S06), access-log formats (S10), authorizer inputs (S07) and gateway responses. The names follow AWS so imported AWS configs work unchanged. `accountId` is set to the Geiger project id.

| Variable | Meaning |
|---|---|
| `requestId`, `extendedRequestId`, `requestTime` (CLF `dd/MMM/yyyy:HH:mm:ss +0000`), `requestTimeEpoch` (ms) | request identity |
| `accountId`, `apiId`, `stage`, `deploymentId`, `domainName`, `domainPrefix` | where it landed |
| `httpMethod`, `path` (full, with stage), `resourcePath`, `resourceId`, `routeKey`, `protocol` | what matched |
| `identity.sourceIp`, `identity.userAgent`, `identity.apiKey`, `identity.apiKeyId`, `identity.caller`, `identity.user`, `identity.userArn` (Pods principal ref), `identity.accessKey` | caller |
| `identity.clientCert.clientCertPem`, `.subjectDN`, `.issuerDN`, `.serialNumber`, `.validity.notBefore`, `.validity.notAfter` | mTLS (S11) |
| `authorizer.principalId`, `authorizer.claims.<name>`, `authorizer.scopes`, `authorizer.<key>`, `authorizer.error`, `authorizer.latency`, `authorizer.status`, `authorizer.integrationLatency`, `authorizer.requestId` | S07 |
| `authenticate.error`, `authenticate.latency`, `authenticate.status` | S07 |
| `integration.status`, `integration.latency`, `integration.error`, `integration.requestId`, `integration.integrationStatus`, `integrationLatency`, `integrationStatus` | S04 |
| `responseLatency`, `responseLength`, `status` | final |
| `error.message`, `error.messageString` (quoted), `error.responseType`, `error.validationErrorString` | S01/S06 |
| `waf.error`, `waf.latency`, `waf.status`, `wafResponseCode`, `webaclArn` (Pods WAF ACL ref) | S11 |
| `traceId` (AWS `xrayTraceId`) | S10 |
| `isCanaryRequest` | S09 |
| `connectionId`, `connectedAt`, `eventType`, `messageId`, `messageDirection` | S12 |
| `customDomain.basePathMatched`, `customDomain.routingRuleIdMatched` | S11 |

Resolver: `resolveVariable(ctx, "context.identity.sourceIp")` returns a string or `""`. Unknown names resolve to `""` and are flagged by config validation, not at runtime. Also exposed: `$stageVariables.<name>`, `$request.*` (HTTP mapping), `$input`/`$util` (templates, S06).

## 5. Gateway responses (`gateway-responses.mjs`)

Catalog, with default status codes as in AWS:

| Type | Status | Type | Status |
|---|---|---|---|
| `ACCESS_DENIED` | 403 | `INVALID_API_KEY` | 403 |
| `API_CONFIGURATION_ERROR` | 500 | `INVALID_SIGNATURE` | 403 |
| `AUTHORIZER_CONFIGURATION_ERROR` | 500 | `MISSING_AUTHENTICATION_TOKEN` | 403 |
| `AUTHORIZER_FAILURE` | 500 | `QUOTA_EXCEEDED` | 429 |
| `BAD_REQUEST_PARAMETERS` | 400 | `REQUEST_TOO_LARGE` | 413 |
| `BAD_REQUEST_BODY` | 400 | `RESOURCE_NOT_FOUND` | 404 |
| `DEFAULT_4XX` | — | `THROTTLED` | 429 |
| `DEFAULT_5XX` | — | `UNAUTHORIZED` | 401 |
| `EXPIRED_TOKEN` | 403 | `UNSUPPORTED_MEDIA_TYPE` | 415 |
| `INTEGRATION_FAILURE` | 504 | `WAF_FILTERED` | 403 |
| `INTEGRATION_TIMEOUT` | 504 | | |

The default body is `{"message":$context.error.messageString}`, with content type `application/json`. Default messages: `Unauthorized`, `Forbidden`, `Missing Authentication Token`, `Too Many Requests`, `Limit Exceeded`, `Endpoint request timed out`, `Internal server error`, `Invalid request body`, `Request Too Long`, `Unsupported Media Type`, matching AWS strings. Customization (status, headers, templates per type, fallback DEFAULT_4XX/DEFAULT_5XX) is S06. HTTP APIs use the fixed defaults only (capability `gatewayResponses.custom` = REST only).

## 6. Ports (dependency injection)

```js
// lib/gateway/core/ports.mjs — JSDoc typedefs only
/** @typedef {{ get(k):Promise<string|null>, set(k,v,{ttlMs}?):Promise<void>, del(k):Promise<void>,
 *   incrBy(k,n,{ttlMs}?):Promise<number>, tokenBucket(k,{rate,burst,cost}):Promise<{allowed:boolean,remaining:number,retryAfterMs:number}>,
 *   publish?(ch,msg), subscribe?(ch,fn) }} KvStore */
/** @typedef {{ resolve(ref:string):Promise<string> }} SecretResolver   // S02 vault, server-side only */
/** @typedef {{ emit(event:object):void }} EventSink                     // S10 */
/** @typedef {{ now():number }} Clock */
/** @typedef {{ fetch:typeof fetch, kv:KvStore, secrets:SecretResolver, events:EventSink, clock:Clock, log:Function }} Ports */
```

`tokenBucket` must be atomic (a Lua script in Redis; a single-threaded map in memory). The memory KV must use the injected clock so tests are deterministic.

## 7. Capability matrix (`capabilities.mjs`)

```js
export const CAPABILITIES = {
  "routing.resources": ["REST"], "routing.routes": ["HTTP"], "routing.websocket": ["WEBSOCKET"],
  "integration.http": ["REST","HTTP","WEBSOCKET"], "integration.httpCustom": ["REST","WEBSOCKET"],
  "integration.mock": ["REST","WEBSOCKET"], "integration.function": ["REST","HTTP","WEBSOCKET"],
  "auth.jwt": ["REST","HTTP"] /* REST = Cognito-style */, "auth.custom": ["REST","HTTP","WEBSOCKET"],
  "auth.signed": ["REST","HTTP","WEBSOCKET"], "auth.resourcePolicy": ["REST"],
  "usage.apiKeys": ["REST","WEBSOCKET"], "usage.plans": ["REST","WEBSOCKET"], "deploy.auto": ["HTTP"], "deploy.canary": ["REST"],
  "cache": ["REST"], "streaming": ["REST"], "validation": ["REST","WEBSOCKET"], "templates": ["REST","WEBSOCKET"],
  "mapping.params": ["REST","HTTP"], "gatewayResponses.custom": ["REST"], "waf": ["REST"],
  "endpoint.private": ["REST"], "endpoint.edge": ["REST"], "logs.execution": ["REST","WEBSOCKET"],
  "tracing": ["REST"], "portal": ["REST"], "docs.parts": ["REST"], "sdk": ["REST"], "testInvoke": ["REST"],
  "mtls": ["REST","HTTP"], "backendClientCert": ["REST"], "routingRules": ["REST"],
  // each spec appends its keys in its own block
};
export const supports = (protocol, key) => CAPABILITIES[key]?.includes(protocol) ?? false;
```

The UI hides controls for unsupported capabilities, and the control plane rejects writes with `400 {code:"capability_unsupported"}`. The matrix mirrors AWS exactly. Relaxing it later is a product decision recorded in this file.

## 8. Control-plane conventions

- **Management API**: `app/api/v1/projects/[projectId]/<resource>/...`, JSON, camelCase. Errors are `{ error: { code, message, details? } }` with HTTP 400/401/403/404/409/422/429/500. List endpoints use cursor pagination: `?limit=` (max 100, default 25) & `?cursor=`, returning `{ items, nextCursor }`. Optimistic concurrency: every mutable row has a `version int`, and writes send `If-Match: <version>`, giving 409 on mismatch.
- **Auth**: route handlers create a Supabase server client from request cookies (same cookie options as `lib/supabase/client.js`) or a Pods personal access token (S14). Every mutation (a) re-derives the project role server-side (§S02), (b) checks the permission key with `@geiger/rbac`, (c) writes through RLS-protected queries as the user. A service-role key (`SUPABASE_SERVICE_ROLE_KEY`, server only) is used only by the gateway runtime loader, the vault, and jobs, never in a route handler acting for a user unless the spec says so.
- **Services** `lib/control/<resource>.mjs` export pure-ish functions `(db, actor, input) → result`. They validate input with a small local validator (no new heavy dependency unless the spec names one) and append an audit entry (S02) in the same transaction (RPC) or immediately after.
- **UI**: use `@geiger/ui` screen-kit (`ScreenHeader`, `SectionCard`, `EmptyState`, tables, dialogs), `LogoLoading` for loading states, and `sonner` toasts. Respect Events' layout (56px topbar, 85% content width). No fake data: an empty chart says "No traffic yet".
- **JS only.** The repo uses `.js/.mjs/.jsx` with JSDoc types. Do not introduce TypeScript.

## 9. Testing rules

- Unit tests (`node --test`) for all `lib/gateway/**`, `lib/control/**` and `lib/vault/**` logic. The engine is tested by building an artifact fixture and calling `handle(new Request(...), artifact, ports)`.
- Runtime tests (`tests/runtime/**`) start the real `gateway/server.mjs` on an ephemeral port, plus a local upstream `node:http` echo server (`tests/fixtures/upstream.mjs`, created in S04). They make real HTTP requests.
- Database tests (`tests/db/**`) run against a disposable Postgres when `PODS_TEST_DB_URL` is set, and are skipped otherwise, with a clear skip message. They verify RLS with two users and two projects.
- No test may hit the internet or production Supabase.
- Each spec's acceptance tests are named `<spec-id>: <behavior>`, e.g. `S03: greedy path does not match parent`.

## 10. Definition of done (every spec)

1. All acceptance tests in the spec exist and pass: `npm test`.
2. `npm run lint` and `npm run build` pass.
3. Migrations have `@up` and `@down`, apply cleanly to an empty `pods` schema and roll back.
4. UI screens: loading, empty, error and permission-denied states exist and use shared components.
5. No secret plaintext in artifacts, logs, API responses (after first reveal) or client bundles. `grep` evidence goes in the PR.
6. `parity-status.md` rows updated with evidence links.
7. AWS behaviors cited in the spec match. Any deviation is listed in the PR under "Deviations from AWS".

## 11. Deliverables of S01 itself

1. `lib/gateway/{capabilities,ids}.mjs`, `lib/gateway/core/{pipeline,context,gateway-responses,errors,limits,ports}.mjs`, `core/phases/index.mjs` with the 20 phase names wired to no-op stubs.
2. `lib/gateway/state/{kv,memory-kv,redis-kv}.mjs`. Redis is implemented over a minimal RESP client or the `redis` npm package. Pick `redis` (official) and pin the version.
3. `handle(request, artifact, ports)` entry in `lib/gateway/core/index.mjs`. With stubs, it returns `MISSING_AUTHENTICATION_TOKEN` for REST and 404 for HTTP.
4. `package.json`: test glob, `gateway:dev` placeholder script.
5. `docs/specs/gateway/parity-status.md` with every parity-matrix row at `planned`.

## Acceptance tests (S01)

- `S01: newPublicId returns 10 lowercase alnum chars and 10k ids are unique`
- `S01: pipeline runs phases in the documented order and stops at the first Response`
- `S01: GatewayError(THROTTLED) renders 429 {"message":"Too Many Requests"} with x-pods-error-type`
- `S01: every response carries x-pods-request-id`
- `S01: context resolver returns "" for unknown variables and quotes messageString`
- `S01: requestTime uses CLF format in UTC`
- `S01: memory tokenBucket allows burst then refills at rate using injected clock`
- `S01: supports("HTTP","usage.apiKeys") is false and supports("REST","usage.apiKeys") is true`
- `S01: unknown route on stub artifact → REST 403 Missing Authentication Token, HTTP 404 Not Found`
