# S08 — API keys, usage plans, throttling & quotas

**Wave 4 · Depends on: S05 (S07 for `AUTHORIZER` key source) · Blocks: S09, S12, S13 (portal key self-service)**

AWS references: [usage plans & API keys](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html), [API key sources](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-key-source.html), [import API keys](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-key-file-format.html), [request throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html), [HTTP API throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html), [usage reports / update usage](https://docs.aws.amazon.com/apigateway/latest/api/API_GetUsage.html).

AWS states that API keys identify clients; they do not authenticate them, and that quota/throttle enforcement is best-effort. Pods keeps both statements in the UI and docs, and publishes its own accuracy bounds (§6).

## 1. Data model (`supabase/migrations/usage/`)

- `pods.api_keys` (project-level): `public_id`, `name`, `description`, `enabled bool`, `customer_id text null`, `value_ref` (vault secret holding the key value, so it can be revealed later as in AWS), `value_hmac bytea unique` (HMAC-SHA256 with `PODS_KEY_PEPPER`, used for lookup), `value_prefix text` (first 6 chars), `last_used_at`, `tags`, `generate_distinct_id bool`.
  Value rules: generated = 40 chars base62; imported/custom = 20–128 chars `[A-Za-z0-9_-]` (AWS minimum 20).
- `pods.usage_plans`: `public_id`, `name`, `description`, `throttle jsonb {rateLimit (rps, double), burstLimit (int)} null`, `quota jsonb {limit int, offset int, period: DAY|WEEK|MONTH} null`, `tags`.
- `pods.usage_plan_stages`: `plan_id`, `api_id`, `stage_name`, `method_throttles jsonb` (`{"/pets/GET": {rateLimit, burstLimit}}`, ≤20 entries — AWS), unique `(plan_id, api_id, stage_name)`. REST and WebSocket stages (capability `usage.plans`).
- `pods.usage_plan_keys`: `plan_id`, `api_key_id`. A key may belong to ≤10 plans. A key **cannot** be in two plans that cover the same API stage: the service enforces this and returns 409 with the conflicting plan (AWS parity).
- `pods.usage_daily`: `project_id`, `plan_id`, `api_key_id`, `api_id`, `stage_name`, `day date`, `count bigint`, `throttled bigint`, `quota_rejected bigint`. Unique on all dimensions + day. Written by the S10 rollup.
- `pods.quota_adjustments` (append-only): `plan_id`, `api_key_id`, `period_start`, `delta int` (positive extends the allowance, negative consumes it) or `set_remaining int`, `actor_id`, `created_at`.

**RLS:** keys, plans, plan stages and plan keys require `pods.api_key.write` / `pods.usage_plan.write`. Selecting the value is never possible through RLS; reveal goes through the server (`pods.api_key.reveal`). Usage tables require `pods.usage.view`.

## 2. API keys

- **Create**: generate or accept a value. Store `value_ref` (vault) and `value_hmac`. The response contains the value **once**, as in AWS console "Show".
- **Reveal**: `GET …/api-keys/{id}?includeValue=true` requires `pods.api_key.reveal` and is audited. This matches AWS `GetApiKey includeValue`.
- **Enable/disable**: a disabled key → 403 at runtime within the propagation SLO.
- **Rotate** (Pods extension of the AWS create-new/delete-old flow): creates a new key copying name, plans and tags with a ` (rotated)` suffix. The old key stays enabled until the user disables it or until optional `expiresAt`.
- **Import** `POST …/api-keys/import` (CSV, AWS format): header `Name,Key,Description,Enabled,UsagePlanIds`, with `failOnWarnings`. Response: `{ids[], warnings[]}`.
- **Key source** (`apis.api_key_source`): `HEADER` reads `x-api-key`. `AUTHORIZER` uses the custom authorizer's `usageIdentifierKey` (S07); if absent → 403.

## 3. Runtime: key check (phase 11, `usage/api-key.mjs`)

Applies when the matched method has `api_key_required` (REST) or the route has `api_key_required` (WebSocket `$connect`).
1. Get the key value from its source. Missing → 403 `{"message":"Forbidden"}` (type `INVALID_API_KEY`; AWS uses "Forbidden" here).
2. Look up by `value_hmac`. Unknown or disabled → 403.
3. Find the plan that contains the key and covers `{api, stage}`. None → 403.
4. Set `$context.identity.apiKey` (the value; it is redacted in logs unless the stage enables data trace, S10) and `$context.identity.apiKeyId`.
- Lookup cache: KV `apikey:{hmac}` → `{keyId, enabled, plans[]}` for 60 s, invalidated on any key/plan mutation via the pub/sub channel `pods:usage-changed`. Key and plan changes **do not require a redeploy** (AWS parity).

## 4. Throttling (phase 12, `usage/throttle.mjs`)

Token bucket: `rate` tokens/s refill and `burst` capacity, using `KvStore.tokenBucket` (atomic).
Checks run in this order (AWS order). A request must pass **all** applicable buckets, and the first failing bucket rejects:
1. Usage plan per-key per-method (`method_throttles["/{resourcePath}/{METHOD}"]`). Bucket key: `tb:plan:{planId}:key:{keyId}:m:{methodKey}`.
2. Usage plan per-key (`plan.throttle`). Bucket key: `tb:plan:{planId}:key:{keyId}`.
3. Stage per-method (`stages.method_settings["{path}/{METHOD}"].throttlingRateLimit/BurstLimit`), else stage default (`"*/*"`). HTTP/WS: `route_settings[routeKey]`, else `default_route_settings`. Bucket key: `tb:stage:{stageId}:{methodKey|*}`.
4. Project (account) level: `project_settings.throttle_rate/burst`, default 10000 rps / 5000 burst (AWS account defaults). Bucket key: `tb:project:{projectId}`.

A plan or stage value may not exceed the project level; the control plane validates this and returns 422. Rejection → 429 `THROTTLED` `{"message":"Too Many Requests"}`. Setting rate 0 / burst 0 blocks all traffic (AWS: a route with throttle 0 returns 429). Pods extension `features.rateLimitHeaders` adds `RateLimit-Limit/Remaining/Reset` and `Retry-After`; it is off by default for parity.

KV failure: behavior per `project_settings.throttle_kv_failure`. `open` (default) falls back to a per-instance in-memory bucket with `rate / instanceCount` (instance count comes from a KV heartbeat, default 1). `closed` returns 429. Fall-backs are counted in metrics (S10).

## 5. Quotas (phase 13, `usage/quota.mjs`)

- Counter key: `q:{planId}:{keyId}:{periodStart}`. The period is a UTC day; a week starting Sunday 00:00 UTC; or a calendar month starting on day 1, 00:00 UTC.
- `offset` follows AWS: the number of requests subtracted from the limit **in the initial period** (the period in which the plan was created or the quota changed).
- Enforcement: `INCR`. If the result exceeds `limit - offset(initial period) + adjustments`, return 429 `QUOTA_EXCEEDED` `{"message":"Limit Exceeded"}`. The increment is kept, as AWS counts rejected requests as attempts. Pods counts only requests that reach this phase; earlier rejections do not consume quota.
- KV failure → `QUOTA_EXCEEDED` is **not** returned (fail-open for availability) only if `project_settings.features.quotaFailOpen`. The default is **fail closed** (429) per ADR-4.
- **Get usage** `GET …/usage-plans/{id}/usage?keyId=&startDate=&endDate=` → AWS shape `{ usagePlanId, startDate, endDate, items: { "<keyId>": [[used, remaining], …per day] }, position }`. Today's numbers come from KV live counters; past days come from `usage_daily`.
- **Update usage** `PATCH …/usage-plans/{id}/keys/{keyId}/usage {op: "extend"|"reset"|"set", value}` writes `quota_adjustments` and updates KV atomically (AWS `UpdateUsage` with `/remaining` patch).

## 6. Published semantics (put in docs and UI tooltips)

- Throttles and quotas are enforced across all runtime instances through the shared KV, with ≤ 1 request of overrun per concurrent in-flight request at the moment of crossing.
- Propagation of key, plan and stage throttle changes: ≤ 60 s worst case, ≤ 5 s typical (pub/sub).
- When KV is unavailable, behavior follows §4/§5 settings, and every fallback decision is counted in metrics.

## 7. Screens

- **Usage plans** (`/usage-plans`): list; detail with tabs *Settings* (throttle, quota), *Associated stages* (add API+stage, per-method throttles table), *API keys* (add existing / create, remove), *Usage* (date range, per-key daily used/remaining chart and table, export CSV, extend/reset quota dialog).
- **API keys** (`/api-keys`): list (name, prefix, enabled, plans, last used, customer id); create (auto/custom value) with the one-time value display; reveal (permission-gated, audited); enable/disable; rotate; import CSV with a preview and warnings; delete.
- **Stage throttling** sub-tab (S05 stage detail): default rate/burst and per-method/route overrides, validated against project limits.
- **Project settings**: project-level throttle (S02 screen).

## Acceptance tests

- `S08: missing key, unknown key, disabled key, key not in a plan for this stage → 403 Forbidden`.
- `S08: key cannot join two plans covering the same API stage (409)`.
- `S08: AUTHORIZER key source uses usageIdentifierKey from custom authorizer`.
- `S08: import CSV (AWS format) creates keys and plan associations; bad row → warning, failOnWarnings → 400 and nothing created`.
- `S08: value shown once on create; reveal needs pods.api_key.reveal and writes audit`.
- `S08: token bucket order — per-key-per-method limit 1 rps rejects while stage limit 100 allows; project limit applies across two APIs`.
- `S08: throttle 0/0 on route → 429`.
- `S08 [runtime]: two gateway instances sharing Redis enforce a 10 rps burst 10 limit within ±1 over 1000 concurrent requests`.
- `S08: DAY quota of 5 → sixth request 429 Limit Exceeded; resets at 00:00 UTC (injected clock); WEEK starts Sunday; MONTH starts day 1`.
- `S08: quota offset applies only to the initial period`.
- `S08: extend usage +10 lets 10 more requests through today; reset restores full limit`.
- `S08: GetUsage returns AWS-shaped items with used/remaining per day`.
- `S08: KV outage → throttle falls back to local bucket (open) or 429 (closed); quota fails closed by default`.
- `S08: disabling a key takes effect without redeploy within 5 s (pub/sub) and 60 s (TTL only)`.
- `S08: HTTP API rejects usage plan association (capability) with 400 capability_unsupported`.
