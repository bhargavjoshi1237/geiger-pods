# S09 — Release controls: canary releases, stage caching, response streaming

**Wave 5 · Depends on: S05, S06, S08 (S07 for cache authorization) · REST-only features (capabilities `deploy.canary`, `cache`, `streaming`)**

AWS references: [canary releases](https://docs.aws.amazon.com/apigateway/latest/developerguide/canary-release.html), [API caching](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-caching.html), [response streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html), [Lambda response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html).

## 1. Canary releases (`release/canary.mjs`)

**Configuration** (`stages.canary` jsonb): `{ deploymentId, percentTraffic (0.0–100.0, one decimal), stageVariableOverrides: {k: v}, useStageCache: bool }`.

**Operations** (`lib/control/canary.mjs`):
- *Create canary*: set `canary` on the stage. Its `deploymentId` starts as the stage's current deployment.
- *Deploy to canary*: `POST …/deployments {stageName, canary: {percentTraffic, stageVariableOverrides, useStageCache}}` creates a deployment and points **only** the canary at it (AWS `CreateDeployment` with `canarySettings`).
- *Update percentage / overrides*: requires `pods.stage.write`.
- *Promote*: requires `pods.stage.promote`. The stage `deploymentId` ← the canary's. Optionally merge overrides into the stage variables (AWS console option). The canary is then either reset to 0 % on the new deployment or removed (user choice). Recorded in `stage_history` (reason `canary_promote`).
- *Delete canary*: all traffic returns to the base deployment.

**Runtime** (phase 7): with a canary present, draw `rng() * 100 < percentTraffic`. The RNG is injected, so tests seed it. A canary request uses the canary artifact, stage variables merged with the overrides, and the stage cache only if `useStageCache`. It sets `$context.isCanaryRequest = "true"`. The canary deployment's artifact is cached like any other (S05).
- Observability: metrics carry the dimension `stage = "{stage}/Canary"` and logs carry `canary: true`. AWS separates canary metrics and log groups the same way (S10).
- Pods extension (off by default): `canary.sticky = {source: "header"|"cookie", name}`. Hashing the value assigns the same client consistently.

## 2. Stage cache (`release/cache.mjs`)

**Stage settings:** `cache_cluster_enabled`, `cache_cluster_size`, chosen from the AWS sizes `0.5 | 1.6 | 6.1 | 13.5 | 28.4 | 58.2 | 118 | 237` (GB). Pods maps each size to a byte budget per stage enforced in KV: 0.5 → 64 MB, 1.6 → 256 MB, 6.1 → 1 GB, larger sizes → `PODS_CACHE_MAX_BYTES`. Budgets are documented as Pods-specific. Eviction: TTL plus approximate LRU. When the budget is exceeded, skip storing new entries and count `CacheStoreSkipped`.
**Method settings** (`stages.method_settings`, path `"{resourcePath}/{METHOD}"` or `"*/*"`): `cachingEnabled`, `cacheTtlInSeconds` (0–3600, default 300), `cacheDataEncrypted`, `requireAuthorizationForCacheControl` (default true), `unauthorizedCacheControlHeaderStrategy` ∈ `FAIL_WITH_403 | SUCCEED_WITH_RESPONSE_HEADER (default) | SUCCEED_WITHOUT_RESPONSE_HEADER`. When the stage cache is enabled, AWS caches only `GET` methods by default. Pods does the same, and other methods require an explicit override.

**Cache key:** `sha256(stageId | flushEpoch | cache_namespace or resourceId | METHOD | resourcePath | selected key parameters)`.
- Key parameters: `integration.cache_key_parameters` entries such as `method.request.querystring.page`, `method.request.header.Accept`, `method.request.path.id`. For proxy resources, `{proxy}` is always part of the key. Header names are case-insensitive. Query parameters not listed are **ignored** (AWS behavior; the UI warns about this).
- **Pods safety rule (deviation from AWS, on by default):** if the method's `authorization_type ≠ NONE` or `api_key_required`, the caller identity (`principalId`, access key id, JWT `sub`, or API key id) is appended to the key. Authenticated responses therefore never cross consumers. A project can disable this with `features.cacheSharedAcrossPrincipals` (explicit opt-in to AWS behavior, with a warning in the UI).

**Lookup/store** (phase 15 / phase 19):
- Hit → return the stored status, headers and body, and skip the integration. Mark `$context.cacheHit`. Metrics `CacheHitCount`, otherwise `CacheMissCount`.
- Store only `200` responses whose body is ≤ 1,048,576 bytes (AWS item limit). Never store streamed responses, responses with `Set-Cookie`, or responses with backend `Cache-Control: no-store|private`.
- `cacheDataEncrypted`: AES-256-GCM using a per-stage DEK from the vault (S02), so the cache never holds plaintext bodies.
- TTL 0 disables caching for that method.

**Client-driven invalidation:** a request with `Cache-Control: max-age=0` bypasses the lookup and refreshes the entry. If `requireAuthorizationForCacheControl` is true, the caller must be authorized for the action `execute-api:InvalidateCache` on the method ARN (S07 policy evaluator, SIGNED callers). Otherwise the configured strategy applies: `FAIL_WITH_403` → 403 `ACCESS_DENIED`; `SUCCEED_WITH_RESPONSE_HEADER` → serve normally without invalidating and add header `x-pods-cache-invalidation: unauthorized`; `SUCCEED_WITHOUT_RESPONSE_HEADER` → serve normally and silently.

**Flush:** `DELETE …/stages/{name}/cache` (`pods.cache.flush`) increments `cache:epoch:{stageId}` in KV. This invalidates in O(1), and old entries expire by TTL.

## 3. Response streaming (`release/streaming.mjs`)

- `integration.response_transfer_mode = STREAM` is allowed only for `HTTP_PROXY` and `FUNCTION_PROXY` on REST APIs (compile error otherwise).
- It is incompatible with stage caching for that method, response compression (§S06-8) and response mapping templates. Compile errors name the conflict.
- Runtime: forward headers as soon as the upstream sends them (`flushHeaders`), then pipe chunks with backpressure (Web Streams → `ServerResponse`). No buffering, no 10 MB limit, and the 29 s integration timeout applies only to **time to first byte**.
- Limits (AWS): total stream duration ≤ 15 min; idle timeout (no bytes) 5 min for `REGIONAL`/`PRIVATE` and 30 s for `EDGE`. The first 10 MB are unthrottled, and after that bandwidth is capped at 2 MB/s by a token-bucket byte limiter (configurable per project `features.streamBandwidthCapBytesPerSec`, default 2 MiB/s for parity).
- Client disconnect → abort the upstream fetch or function invocation immediately. Upstream error mid-stream → the client connection is terminated (no trailers), and it is logged as `integration.error = "stream_aborted"`.
- `FUNCTION_PROXY` streaming:
  - `aws_lambda`: `InvokeWithResponseStream`. Parse the event-stream frames. The first payload part is the JSON metadata prelude `{statusCode, headers, cookies}`, followed by 8 NUL bytes, then the body bytes (AWS Lambda HTTP streaming format).
  - `webhook`: a chunked HTTP response with the same prelude-and-delimiter framing.
- Server-Sent Events (`text/event-stream`) pass through untouched.
- The Vercel adapter (ADR-1) caps the stream at the platform function duration and declares it with a warning at deploy.

## 4. Screens

- **Stage → Canary** sub-tab: create canary, traffic slider (0–100, 0.1 steps), variable overrides, use-stage-cache toggle, current canary deployment vs base with a diff link, *Promote* (with merge-variables checkbox) and *Delete canary* buttons. A live split chart shows base vs canary requests and 4XX/5XX from S10 metrics.
- **Stage → Cache** sub-tab: enable, capacity, default TTL, encryption, per-method overrides table, "Flush entire cache" (type stage name to confirm), and the authorization strategy. A warning banner explains the safety rule.
- **Integration editor**: transfer mode selector (Buffered/Stream) with incompatibility hints, plus a cache key parameters picker.

## Acceptance tests

- `S09: seeded RNG with 10% canary routes 10%±1% of 100k simulated requests to canary (chi-square p > 0.01)`.
- `S09: canary request sees overridden stage variable; base request does not; isCanaryRequest set`.
- `S09: promote moves stage to canary deployment, merges overrides when chosen, writes stage_history`.
- `S09 [runtime]: deploy-to-canary leaves base deployment serving ~ (100-p)% of traffic`.
- `S09: GET cached for TTL; POST not cached by default; TTL 0 disables`.
- `S09: query param not in cache keys is ignored (same entry); listed param splits entries`.
- `S09: two different JWT subjects never receive each other's cached response (safety rule); with cacheSharedAcrossPrincipals they do`.
- `S09: Cache-Control max-age=0 from unauthorized caller → each strategy behaves per table; authorized SIGNED caller refreshes entry`.
- `S09: flush increments epoch; next request is a miss`.
- `S09: >1 MB response and Set-Cookie response not stored; encrypted cache stores no plaintext (inspect KV)`.
- `S09 [runtime]: STREAM — first byte reaches client before upstream finishes (upstream /stream sends 5 chunks 500 ms apart)`.
- `S09 [runtime]: client disconnect aborts upstream within 100 ms`.
- `S09 [runtime]: stream idle > configured idle timeout is closed; stream beyond 10 MB is rate-capped (injected clock)`.
- `S09: STREAM with cache enabled / VTL response template → compile error`.
- `S09: Lambda streaming prelude + 8 NUL delimiter parsed into status/headers/body`.
