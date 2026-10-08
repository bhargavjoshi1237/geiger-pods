# Pods ⇄ AWS API Gateway parity status

Source: the parity matrix in `docs/specs/gateway/00-index.md`.
Legend: **R** = REST, **H** = HTTP, **W** = WebSocket.
Status flow: `planned` → `designed` → `implemented` → `runtime-tested` → `production-validated`.
Created by S01; every spec updates the rows it delivers with evidence links.

## Endpoints & exposure

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| Default invoke URL per API/stage (`execute-api` equivalent) | R H W | S05 | planned | — |
| Regional endpoint | R H W | S11 | runtime-tested | tests/s11/endpoints.test.mjs (custom-domain 200 via real gateway), tests/s11/domains.test.mjs |
| Edge-optimized endpoint (global edge placement) | R | S11 | implemented | tests/s11/edge-config.test.mjs (Via + 30 s idle + compile); infra per docs/ops/edge.md, production validation is S15 |
| Private API (reachable only via connector/allow-listed network) | R | S11 | runtime-tested | tests/s11/endpoints.test.mjs (connector-ingress 200 via real gateway, direct 403, compile refusal) |
| Disable default endpoint | R H W | S11 | runtime-tested | tests/s11/endpoints.test.mjs (default host 403, custom domain 200) |
| Dual-stack IPv4/IPv6 endpoint setting | R H W | S11 | implemented | tests/s11/edge-config.test.mjs (ipv4 rejects IPv6, dualstack serves); `::` bind configurable, not live-tested |

## Routing & API model

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| HTTP routes `METHOD /path`, `ANY`, `{param}`, `{proxy+}`, `$default` | H | S03 | planned | — |
| REST resource tree, methods, `ANY`, `{proxy+}` resources | R | S03 | planned | — |
| WebSocket route keys and route selection expression | W | S12 | planned | — |
| API key source, binary media types, minimum compression size, `disableExecuteApiEndpoint` API settings | R | S03/S06/S11 | planned | — |

## Integrations

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| HTTP proxy (`HTTP_PROXY`) | R H W | S04 | planned | — |
| HTTP custom (`HTTP`, with mappings) | R W | S04 | planned | — |
| Mock (`MOCK`) | R W | S04 | planned | — |
| Function proxy (`AWS_PROXY`/Lambda), payload v1.0 and v2.0 | R H W | S04 | planned | — |
| Function custom (`AWS`/Lambda non-proxy) | R W | S04 | planned | — |
| AWS service integrations (REST: any action; HTTP: first-class subtypes SQS/SNS/EventBridge/Kinesis/Step Functions/AppConfig) | R H W | S04 | planned | — |
| Private integrations (VPC link → NLB/ALB/Cloud Map equivalent: Pods Connector) | R H W | S04 | planned | — |
| Integration timeouts (50 ms – 29 s default, raisable) | R H W | S04 | planned | — |
| Backend client certificates (gateway-generated) | R | S04 | planned | — |
| Backend TLS options (`insecureSkipVerification`, SNI `serverNameToVerify`) | R H | S04 | planned | — |
| Integration credentials vault (Pods extension: inject secrets) | R H W | S04 | planned | — |

## Request/response processing

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| CORS (REST: OPTIONS mock + headers; HTTP: managed CORS config) | R H | S06 | planned | — |
| HTTP parameter mapping (append/overwrite/remove headers, query, path; response header/status) | H | S06 | planned | — |
| REST request/response parameter mapping | R | S06 | planned | — |
| Models (JSON Schema) | R W | S06 | planned | — |
| Request validators (body / params / both) | R | S06 | planned | — |
| Mapping templates (VTL-compatible), passthrough behavior, content-type selection | R W | S06 | planned | — |
| Method responses / integration responses with selection patterns | R | S06 | planned | — |
| Binary media types, content handling (CONVERT_TO_TEXT/BINARY) | R | S06 | planned | — |
| Payload compression (minimumCompressionSize) | R | S06 | planned | — |
| Custom gateway responses (all response types) | R | S06 | planned | — |
| Payload limits (10 MB), header limits, URL length | R H W | S06/S15 | planned | — |

## Security & access

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| IAM authorization → Pods signed requests (SigV4-compatible algorithm, Pods principals and policies) | R H W | S07 | implemented | tests/s07/sigv4.test.mjs (golden vectors, presigned, skew), tests/s07/phases.test.mjs, tests/s07/authorize.test.mjs |
| SigV4a | R | S07 | planned | — |
| Cognito user pool authorizer → JWT/OIDC authorizer (any issuer) | R H W | S07 | implemented | tests/s07/jwt.test.mjs (iss/aud/alg/kid, phases), tests/s07/custom.test.mjs |
| JWT authorizer (issuer, audiences, scopes per route) | H | S07 | implemented | tests/s07/jwt.test.mjs (aud/scopes, 403 on scope miss) |
| Lambda authorizer TOKEN / REQUEST, caching, IAM-policy or simple responses, context passthrough | R H W | S07 | implemented | tests/s07/custom.test.mjs (TOKEN/REQUEST, cache gotcha, simple responses, context), tests/s07/phases.test.mjs |
| Resource policies (IP/CIDR, source connector, principal, explicit deny) | R | S07 | runtime-tested | tests/s07/resource-policy.test.mjs + policy.test.mjs (§7 table); tests/s11/endpoints.test.mjs (SourceVpce allow via real gateway) |
| Mutual TLS with trust store, client-cert context | R H | S11 | runtime-tested | tests/s11/mtls.test.mjs (real HTTPS: no/untrusted/expired/CRL → 403, trusted → 200 + context) |
| WAF (IP sets, geo match, rate-based, size, SQLi/XSS, managed rule groups) | R | S11 | runtime-tested | tests/s11/waf-engine.test.mjs (all statements, corpus), tests/s11/waf-runtime.test.mjs (real gateway 403 + sampled) |
| TLS security policies (TLS 1.2, TLS 1.3, PQ/FIPS variants as profiles) | R H | S11 | runtime-tested | tests/s11/tls.test.mjs (SNI per-domain certs, TLS floor enforcement via real HTTPS); PQ feature-detected (FIPS out of scope) |

## API management

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| API keys: generate/import, enable/disable, value reveal, HEADER/AUTHORIZER key source (WS: `apiKeySelectionExpression` on `$connect`) | R W | S08 | implemented | tests/s08/*.test.mjs (create/reveal/import/rotate/disable, key-source, covering-plan) |
| Usage plans: API stages, throttle, quota (DAY/WEEK/MONTH), per-method throttles, keys | R W | S08 | implemented | tests/s08/*.test.mjs (plan CRUD, method throttles, DAY/WEEK/MONTH quotas, capability gate) |
| Account-level (project) throttle with burst (token bucket) | R H W | S08 | runtime-tested | tests/s08/concurrency.test.mjs (two gateway instances, shared KV, 1000 concurrent) |
| Stage / route / method throttling | R H W | S08 | implemented | tests/s08/*.test.mjs (token-bucket order, 429s, headers, KV-outage fallback) |
| Usage reports per key/day; extend/reset quota | R | S08 | implemented | tests/s08/*.test.mjs (GetUsage AWS shape, extend/reset/set, allowance) |
| Developer portals, portal products, product pages, endpoint pages, branding, access control, preview/publish, sharing | R | S13 | implemented | tests/s13/portals.test.mjs (preview auth, snapshot freeze + republish, disable 404, email-domain filter, sanitizer, sharing revoke), tests/s13/portal-access.test.mjs (authenticated portal: anonymous → 401 no content, disallowed domain → 403, allowed domain → content, public → content, off-snapshot product → 404), tests/s13/cde.test.mjs (portals migration contract, portals stack kind); public Next pages gate through the tested resolver, not live-tested |

## Development & release

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| Draft configuration vs immutable deployments | R H W | S05 | planned | — |
| Stages, stage variables, stage description, deployment pointer | R H W | S05 | planned | — |
| Automatic deployments | H | S05 | planned | — |
| `$default` stage (no stage prefix in URL) | H | S05 | planned | — |
| Test invocation (method and authorizer test) | R | S05/S07 | planned | — |
| Canary release (percent traffic, canary stage variables, promote) | R | S09 | runtime-tested | tests/s09/canary.test.mjs, tests/s09/runtime.test.mjs, tests/s09/control.test.mjs |
| Stage cache: capacity, TTL 0–3600 s, per-method override, cache keys, encryption, invalidation with `Cache-Control: max-age=0` + authorization policy | R | S09 | runtime-tested | tests/s09/cache.test.mjs (engine via handle()+upstream; flush via control service) + tests/s09/cache-host.test.mjs (second GET served from cache via real gateway) |
| Response streaming (`STREAM` transfer mode, 15 min, idle timeouts) | R | S09 | runtime-tested | tests/s09/runtime.test.mjs, tests/s09/streaming-limits.test.mjs, tests/s09/streaming.test.mjs |
| OpenAPI 2.0/3.0 import (overwrite/merge, warnings), export (with/without extensions, Postman) | R H | S13 | implemented | tests/s13/import.test.mjs (PetStore zero-warning, Lambda/VPC_LINK, failOnWarnings/merge/overwrite), tests/s13/export.test.mjs (stage-not-draft, postman v2.1 schema, swagger+yaml), tests/s13/cli.test.mjs; engine-level only, no gateway-host runtime test yet |
| Documentation parts & documentation versions | R | S13 | implemented | tests/s13/documentation.test.mjs (RESPONSE * inheritance, snapshot immutability, doc import/export round-trip) |
| SDK generation (JS, TS, Python, Java, Ruby, Go, Swift/Android equivalents) | R | S13 | runtime-tested | tests/s13/sdk.test.mjs (generated TS compiles with tsc --noEmit and calls a deployed stage with API key through a real local gateway fixture; JS/Python/extended builders), tests/s13/cde.test.mjs (job cache, REST capability gate) |
| Agent tool gateway (equivalent of REST API as AgentCore Gateway target → MCP tools) | R | S13 | runtime-tested | tests/s13/mcp.test.mjs (tools/list schema from params+model; tools/call through authorizer spy + throttle spy via the normal pipeline), tests/s13/mcp-runtime.test.mjs (tools/list + authorized/unauthorized tools/call through a real gateway `/{stage}/_mcp`, disabled stage → 404), tests/s13/cde.test.mjs (stage config round-trip) |
| Tags on APIs, stages, keys, plans, domains | R H W | S14 | planned | — |
| Management API + CLI + declarative config (CloudFormation/SAM equivalent) | R H W | S14 | planned | — |

## Domains & networking

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| Custom domain names, ownership verification, managed certificates | R H W | S11 | runtime-tested | tests/s11/domains.test.mjs (TXT/DoH, cert validation) + control.test.mjs (lifecycle) + endpoints.test.mjs (routing via real gateway) |
| API mappings (single & multi-level base paths) | R H W | S11 | runtime-tested | tests/s11/domains.test.mjs (longest-prefix) + endpoints.test.mjs (mapping 200 via real gateway) |
| Routing rules (header/base-path conditions, priorities, routing modes) | R | S11 | implemented | tests/s11/routing-rules.test.mjs (AWS glob table) + control.test.mjs (CRUD/reorder); no gateway-host runtime test yet |
| Private custom domain names + access associations | R | S11 | implemented | tests/s11/control.test.mjs (associations CRUD); runtime isolation gap tracked as F34 |
| Wildcard custom domains | R H | S11 | implemented | tests/s11/domains.test.mjs (one-level match, domainPrefix); engine-level only |

## Monitoring

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| Metrics: Count, 4XXError, 5XXError, Latency, IntegrationLatency, CacheHitCount, CacheMissCount (+ HTTP: DataProcessed; WS: ConnectCount, MessageCount, ExecutionError, ClientError, IntegrationError) | R H W | S10 | runtime-tested | tests/s10/runtime.test.mjs + metrics.test.mjs (100-req mix via real gateway, two instances sum, HTTP/WS variants, F31 CacheStoreSkipped) |
| Detailed (per-route/method) metrics toggle | R H W | S10 | runtime-tested | tests/s10/metrics.test.mjs (Resource/Method dims) + control.test.mjs (stage settings gate writes) |
| Access logs with `$context` format (CLF, JSON, XML, CSV) | R H W | S10 | runtime-tested | tests/s10/access-log.test.mjs + logs.test.mjs (AWS preset strings, validation, searchable rows) + tests/s10/stage-observability.test.mjs (rendered lines + rows at the writer via real gateway) |
| Execution logs (ERROR/INFO, full request/response data tracing) | R W | S10 | runtime-tested | tests/s10/execution-log.test.mjs (AWS vocabulary, redaction, 1 KB trace cap) + tests/s10/stage-observability.test.mjs (rows at the writer via real gateway) |
| Log destinations: built-in store + streaming export (Firehose equivalent) | R | S10 | runtime-tested | tests/s10/sinks.test.mjs + emit-sinks-alarms.test.mjs (signed NDJSON, backoff, s3 keys) + tests/s10/stage-observability.test.mjs (rows reach writers via real gateway) |
| Tracing (X-Ray equivalent: W3C trace context, sampling rules, OTLP export) | R | S10 | runtime-tested | tests/s10/tracing.test.mjs (Amzn conversion, forward, seeded sampling, OTLP spans) + tests/s10/stage-observability.test.mjs (spans at the writer via real gateway) |
| Alarms (CloudWatch-alarm equivalent) | R H W | S10 | implemented | tests/s10/alarms.test.mjs (2-of-3, missing-data variants, exactly-once notify, history; unit only, no gateway-host runtime test yet) |
| Management audit trail (CloudTrail equivalent) | R H W | S02/S10 | implemented | S02 audit hook (F20 test) + tests/s10/control.test.mjs (filters, redacted CSV export; control-plane only, no gateway-host runtime test yet) |

## WebSocket

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| `$connect`, `$disconnect`, `$default`, custom routes; route selection expression | W | S12 | runtime-tested | tests/s12/selection.test.mjs, tests/s12/connect.test.mjs (CONNECT + CUSTOM + apiKey via real gateway) |
| Two-way integration responses; route responses; model selection expression | W | S12 | runtime-tested | tests/s12/message.test.mjs (two-way/one-way via real gateway), tests/s12/validation.test.mjs, tests/s12/control.test.mjs (route-responses) |
| `@connections` management API: POST (send), GET (info), DELETE (disconnect) | W | S12 | runtime-tested | tests/s12/connections.test.mjs (SigV4 ManageConnections + cross-instance via real gateways), app/api/v1/.../connections/[connectionId]/route.js |
| Connection limits: 2 h duration, 10 min idle, 128 KB message / 32 KB frames | W | S12/S15 | runtime-tested | tests/s12/message.test.mjs (129KB→1009, fragmented 100KB ok), tests/s12/timeouts.test.mjs (idle/max with injected clock) |
