# Pods ⇄ AWS API Gateway parity report

Generated 2026-10-08T03:51:08.753Z from `parity-status.md`.
Status flow: `planned` → `designed` → `implemented` → `runtime-tested` → `production-validated`.
No row may be marked beyond its evidence (S15 gate).

| Section | Feature | Types | Spec | Status | Evidence | Evidence check |
|---|---|---|---|---|---|---|
| Endpoints & exposure | Default invoke URL per API/stage (`execute-api` equivalent) | R H W | S05 | planned | — | ok |
| Endpoints & exposure | Regional endpoint | R H W | S11 | runtime-tested | tests/s11/endpoints.test.mjs (custom-domain 200 via real gateway), tests/s11/domains.test.mjs | ok |
| Endpoints & exposure | Edge-optimized endpoint (global edge placement) | R | S11 | implemented | tests/s11/edge-config.test.mjs (Via + 30 s idle + compile); infra per docs/ops/edge.md, production validation is S15 | ok |
| Endpoints & exposure | Private API (reachable only via connector/allow-listed network) | R | S11 | runtime-tested | tests/s11/endpoints.test.mjs (connector-ingress 200 via real gateway, direct 403, compile refusal) | ok |
| Endpoints & exposure | Disable default endpoint | R H W | S11 | runtime-tested | tests/s11/endpoints.test.mjs (default host 403, custom domain 200) | ok |
| Endpoints & exposure | Dual-stack IPv4/IPv6 endpoint setting | R H W | S11 | implemented | tests/s11/edge-config.test.mjs (ipv4 rejects IPv6, dualstack serves); `::` bind configurable, not live-tested | ok |
| Routing & API model | HTTP routes `METHOD /path`, `ANY`, `{param}`, `{proxy+}`, `$default` | H | S03 | planned | — | ok |
| Routing & API model | REST resource tree, methods, `ANY`, `{proxy+}` resources | R | S03 | planned | — | ok |
| Routing & API model | WebSocket route keys and route selection expression | W | S12 | planned | — | ok |
| Routing & API model | API key source, binary media types, minimum compression size, `disableExecuteApiEndpoint` API settings | R | S03/S06/S11 | planned | — | ok |
| Integrations | HTTP proxy (`HTTP_PROXY`) | R H W | S04 | planned | — | ok |
| Integrations | HTTP custom (`HTTP`, with mappings) | R W | S04 | planned | — | ok |
| Integrations | Mock (`MOCK`) | R W | S04 | planned | — | ok |
| Integrations | Function proxy (`AWS_PROXY`/Lambda), payload v1.0 and v2.0 | R H W | S04 | planned | — | ok |
| Integrations | Function custom (`AWS`/Lambda non-proxy) | R W | S04 | planned | — | ok |
| Integrations | AWS service integrations (REST: any action; HTTP: first-class subtypes SQS/SNS/EventBridge/Kinesis/Step Functions/AppConfig) | R H W | S04 | planned | — | ok |
| Integrations | Private integrations (VPC link → NLB/ALB/Cloud Map equivalent: Pods Connector) | R H W | S04 | planned | — | ok |
| Integrations | Integration timeouts (50 ms – 29 s default, raisable) | R H W | S04 | planned | — | ok |
| Integrations | Backend client certificates (gateway-generated) | R | S04 | planned | — | ok |
| Integrations | Backend TLS options (`insecureSkipVerification`, SNI `serverNameToVerify`) | R H | S04 | planned | — | ok |
| Integrations | Integration credentials vault (Pods extension: inject secrets) | R H W | S04 | planned | — | ok |
| Request/response processing | CORS (REST: OPTIONS mock + headers; HTTP: managed CORS config) | R H | S06 | planned | — | ok |
| Request/response processing | HTTP parameter mapping (append/overwrite/remove headers, query, path; response header/status) | H | S06 | planned | — | ok |
| Request/response processing | REST request/response parameter mapping | R | S06 | planned | — | ok |
| Request/response processing | Models (JSON Schema) | R W | S06 | planned | — | ok |
| Request/response processing | Request validators (body / params / both) | R | S06 | planned | — | ok |
| Request/response processing | Mapping templates (VTL-compatible), passthrough behavior, content-type selection | R W | S06 | planned | — | ok |
| Request/response processing | Method responses / integration responses with selection patterns | R | S06 | planned | — | ok |
| Request/response processing | Binary media types, content handling (CONVERT_TO_TEXT/BINARY) | R | S06 | planned | — | ok |
| Request/response processing | Payload compression (minimumCompressionSize) | R | S06 | planned | — | ok |
| Request/response processing | Custom gateway responses (all response types) | R | S06 | planned | — | ok |
| Request/response processing | Payload limits (10 MB), header limits, URL length | R H W | S06/S15 | planned | — | ok |
| Security & access | IAM authorization → Pods signed requests (SigV4-compatible algorithm, Pods principals and policies) | R H W | S07 | implemented | tests/s07/sigv4.test.mjs (golden vectors, presigned, skew), tests/s07/phases.test.mjs, tests/s07/authorize.test.mjs | ok |
| Security & access | SigV4a | R | S07 | planned | — | ok |
| Security & access | Cognito user pool authorizer → JWT/OIDC authorizer (any issuer) | R H W | S07 | implemented | tests/s07/jwt.test.mjs (iss/aud/alg/kid, phases), tests/s07/custom.test.mjs | ok |
| Security & access | JWT authorizer (issuer, audiences, scopes per route) | H | S07 | implemented | tests/s07/jwt.test.mjs (aud/scopes, 403 on scope miss) | ok |
| Security & access | Lambda authorizer TOKEN / REQUEST, caching, IAM-policy or simple responses, context passthrough | R H W | S07 | implemented | tests/s07/custom.test.mjs (TOKEN/REQUEST, cache gotcha, simple responses, context), tests/s07/phases.test.mjs | ok |
| Security & access | Resource policies (IP/CIDR, source connector, principal, explicit deny) | R | S07 | runtime-tested | tests/s07/resource-policy.test.mjs + policy.test.mjs (§7 table); tests/s11/endpoints.test.mjs (SourceVpce allow via real gateway) | ok |
| Security & access | Mutual TLS with trust store, client-cert context | R H | S11 | runtime-tested | tests/s11/mtls.test.mjs (real HTTPS: no/untrusted/expired/CRL → 403, trusted → 200 + context) | ok |
| Security & access | WAF (IP sets, geo match, rate-based, size, SQLi/XSS, managed rule groups) | R | S11 | runtime-tested | tests/s11/waf-engine.test.mjs (all statements, corpus), tests/s11/waf-runtime.test.mjs (real gateway 403 + sampled) | ok |
| Security & access | TLS security policies (TLS 1.2, TLS 1.3, PQ/FIPS variants as profiles) | R H | S11 | runtime-tested | tests/s11/tls.test.mjs (SNI per-domain certs, TLS floor enforcement via real HTTPS); PQ feature-detected (FIPS out of scope) | ok |
| API management | API keys: generate/import, enable/disable, value reveal, HEADER/AUTHORIZER key source (WS: `apiKeySelectionExpression` on `$connect`) | R W | S08 | implemented | tests/s08/*.test.mjs (create/reveal/import/rotate/disable, key-source, covering-plan) | ok |
| API management | Usage plans: API stages, throttle, quota (DAY/WEEK/MONTH), per-method throttles, keys | R W | S08 | implemented | tests/s08/*.test.mjs (plan CRUD, method throttles, DAY/WEEK/MONTH quotas, capability gate) | ok |
| API management | Account-level (project) throttle with burst (token bucket) | R H W | S08 | runtime-tested | tests/s08/concurrency.test.mjs (two gateway instances, shared KV, 1000 concurrent) | ok |
| API management | Stage / route / method throttling | R H W | S08 | implemented | tests/s08/*.test.mjs (token-bucket order, 429s, headers, KV-outage fallback) | ok |
| API management | Usage reports per key/day; extend/reset quota | R | S08 | implemented | tests/s08/*.test.mjs (GetUsage AWS shape, extend/reset/set, allowance) | ok |
| API management | Developer portals, portal products, product pages, endpoint pages, branding, access control, preview/publish, sharing | R | S13 | implemented | tests/s13/portals.test.mjs (preview auth, snapshot freeze + republish, disable 404, email-domain filter, sanitizer, sharing revoke), tests/s13/portal-access.… | ok |
| Development & release | Draft configuration vs immutable deployments | R H W | S05 | planned | — | ok |
| Development & release | Stages, stage variables, stage description, deployment pointer | R H W | S05 | planned | — | ok |
| Development & release | Automatic deployments | H | S05 | planned | — | ok |
| Development & release | `$default` stage (no stage prefix in URL) | H | S05 | planned | — | ok |
| Development & release | Test invocation (method and authorizer test) | R | S05/S07 | planned | — | ok |
| Development & release | Canary release (percent traffic, canary stage variables, promote) | R | S09 | runtime-tested | tests/s09/canary.test.mjs, tests/s09/runtime.test.mjs, tests/s09/control.test.mjs | ok |
| Development & release | Stage cache: capacity, TTL 0–3600 s, per-method override, cache keys, encryption, invalidation with `Cache-Control: max-age=0` + authorization policy | R | S09 | runtime-tested | tests/s09/cache.test.mjs (engine via handle()+upstream; flush via control service) + tests/s09/cache-host.test.mjs (second GET served from cache via real gat… | ok |
| Development & release | Response streaming (`STREAM` transfer mode, 15 min, idle timeouts) | R | S09 | runtime-tested | tests/s09/runtime.test.mjs, tests/s09/streaming-limits.test.mjs, tests/s09/streaming.test.mjs | ok |
| Development & release | OpenAPI 2.0/3.0 import (overwrite/merge, warnings), export (with/without extensions, Postman) | R H | S13 | implemented | tests/s13/import.test.mjs (PetStore zero-warning, Lambda/VPC_LINK, failOnWarnings/merge/overwrite), tests/s13/export.test.mjs (stage-not-draft, postman v2.1 … | ok |
| Development & release | Documentation parts & documentation versions | R | S13 | implemented | tests/s13/documentation.test.mjs (RESPONSE * inheritance, snapshot immutability, doc import/export round-trip) | ok |
| Development & release | SDK generation (JS, TS, Python, Java, Ruby, Go, Swift/Android equivalents) | R | S13 | runtime-tested | tests/s13/sdk.test.mjs (generated TS compiles with tsc --noEmit and calls a deployed stage with API key through a real local gateway fixture; JS/Python/exten… | ok |
| Development & release | Agent tool gateway (equivalent of REST API as AgentCore Gateway target → MCP tools) | R | S13 | runtime-tested | tests/s13/mcp.test.mjs (tools/list schema from params+model; tools/call through authorizer spy + throttle spy via the normal pipeline), tests/s13/mcp-runtime… | ok |
| Development & release | Tags on APIs, stages, keys, plans, domains | R H W | S14 | planned | — | ok |
| Development & release | Management API + CLI + declarative config (CloudFormation/SAM equivalent) | R H W | S14 | planned | — | ok |
| Domains & networking | Custom domain names, ownership verification, managed certificates | R H W | S11 | runtime-tested | tests/s11/domains.test.mjs (TXT/DoH, cert validation) + control.test.mjs (lifecycle) + endpoints.test.mjs (routing via real gateway) | ok |
| Domains & networking | API mappings (single & multi-level base paths) | R H W | S11 | runtime-tested | tests/s11/domains.test.mjs (longest-prefix) + endpoints.test.mjs (mapping 200 via real gateway) | ok |
| Domains & networking | Routing rules (header/base-path conditions, priorities, routing modes) | R | S11 | implemented | tests/s11/routing-rules.test.mjs (AWS glob table) + control.test.mjs (CRUD/reorder); no gateway-host runtime test yet | ok |
| Domains & networking | Private custom domain names + access associations | R | S11 | implemented | tests/s11/control.test.mjs (associations CRUD); runtime isolation gap tracked as F34 | ok |
| Domains & networking | Wildcard custom domains | R H | S11 | implemented | tests/s11/domains.test.mjs (one-level match, domainPrefix); engine-level only | ok |
| Monitoring | Metrics: Count, 4XXError, 5XXError, Latency, IntegrationLatency, CacheHitCount, CacheMissCount (+ HTTP: DataProcessed; WS: ConnectCount, MessageCount, ExecutionError, ClientError, IntegrationError) | R H W | S10 | runtime-tested | tests/s10/runtime.test.mjs + metrics.test.mjs (100-req mix via real gateway, two instances sum, HTTP/WS variants, F31 CacheStoreSkipped) | ok |
| Monitoring | Detailed (per-route/method) metrics toggle | R H W | S10 | runtime-tested | tests/s10/metrics.test.mjs (Resource/Method dims) + control.test.mjs (stage settings gate writes) | ok |
| Monitoring | Access logs with `$context` format (CLF, JSON, XML, CSV) | R H W | S10 | runtime-tested | tests/s10/access-log.test.mjs + logs.test.mjs (AWS preset strings, validation, searchable rows) + tests/s10/stage-observability.test.mjs (rendered lines + ro… | ok |
| Monitoring | Execution logs (ERROR/INFO, full request/response data tracing) | R W | S10 | runtime-tested | tests/s10/execution-log.test.mjs (AWS vocabulary, redaction, 1 KB trace cap) + tests/s10/stage-observability.test.mjs (rows at the writer via real gateway) | ok |
| Monitoring | Log destinations: built-in store + streaming export (Firehose equivalent) | R | S10 | runtime-tested | tests/s10/sinks.test.mjs + emit-sinks-alarms.test.mjs (signed NDJSON, backoff, s3 keys) + tests/s10/stage-observability.test.mjs (rows reach writers via real… | ok |
| Monitoring | Tracing (X-Ray equivalent: W3C trace context, sampling rules, OTLP export) | R | S10 | runtime-tested | tests/s10/tracing.test.mjs (Amzn conversion, forward, seeded sampling, OTLP spans) + tests/s10/stage-observability.test.mjs (spans at the writer via real gat… | ok |
| Monitoring | Alarms (CloudWatch-alarm equivalent) | R H W | S10 | implemented | tests/s10/alarms.test.mjs (2-of-3, missing-data variants, exactly-once notify, history; unit only, no gateway-host runtime test yet) | ok |
| Monitoring | Management audit trail (CloudTrail equivalent) | R H W | S02/S10 | implemented | S02 audit hook (F20 test) + tests/s10/control.test.mjs (filters, redacted CSV export; control-plane only, no gateway-host runtime test yet) | ok |
| WebSocket | `$connect`, `$disconnect`, `$default`, custom routes; route selection expression | W | S12 | runtime-tested | tests/s12/selection.test.mjs, tests/s12/connect.test.mjs (CONNECT + CUSTOM + apiKey via real gateway) | ok |
| WebSocket | Two-way integration responses; route responses; model selection expression | W | S12 | runtime-tested | tests/s12/message.test.mjs (two-way/one-way via real gateway), tests/s12/validation.test.mjs, tests/s12/control.test.mjs (route-responses) | ok |
| WebSocket | `@connections` management API: POST (send), GET (info), DELETE (disconnect) | W | S12 | runtime-tested | tests/s12/connections.test.mjs (SigV4 ManageConnections + cross-instance via real gateways), app/api/v1/.../connections/[connectionId]/route.js | ok |
| WebSocket | Connection limits: 2 h duration, 10 min idle, 128 KB message / 32 KB frames | W | S12/S15 | runtime-tested | tests/s12/message.test.mjs (129KB→1009, fragmented 100KB ok), tests/s12/timeouts.test.mjs (idle/max with injected clock) | ok |

Rows: 78. Rows beyond evidence: 0.

