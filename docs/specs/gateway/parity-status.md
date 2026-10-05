# Pods ⇄ AWS API Gateway parity status

Source: the parity matrix in `docs/specs/gateway/00-index.md`.
Legend: **R** = REST, **H** = HTTP, **W** = WebSocket.
Status flow: `planned` → `designed` → `implemented` → `runtime-tested` → `production-validated`.
Created by S01; every spec updates the rows it delivers with evidence links.

## Endpoints & exposure

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| Default invoke URL per API/stage (`execute-api` equivalent) | R H W | S05 | planned | — |
| Regional endpoint | R H W | S11 | planned | — |
| Edge-optimized endpoint (global edge placement) | R | S11 | planned | — |
| Private API (reachable only via connector/allow-listed network) | R | S11 | planned | — |
| Disable default endpoint | R H W | S11 | planned | — |
| Dual-stack IPv4/IPv6 endpoint setting | R H W | S11 | planned | — |

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
| IAM authorization → Pods signed requests (SigV4-compatible algorithm, Pods principals and policies) | R H W | S07 | planned | — |
| SigV4a | R | S07 | planned | — |
| Cognito user pool authorizer → JWT/OIDC authorizer (any issuer) | R H W | S07 | planned | — |
| JWT authorizer (issuer, audiences, scopes per route) | H | S07 | planned | — |
| Lambda authorizer TOKEN / REQUEST, caching, IAM-policy or simple responses, context passthrough | R H W | S07 | planned | — |
| Resource policies (IP/CIDR, source connector, principal, explicit deny) | R | S07 | planned | — |
| Mutual TLS with trust store, client-cert context | R H | S11 | planned | — |
| WAF (IP sets, geo match, rate-based, size, SQLi/XSS, managed rule groups) | R | S11 | planned | — |
| TLS security policies (TLS 1.2, TLS 1.3, PQ/FIPS variants as profiles) | R H | S11 | planned | — |

## API management

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| API keys: generate/import, enable/disable, value reveal, HEADER/AUTHORIZER key source (WS: `apiKeySelectionExpression` on `$connect`) | R W | S08 | planned | — |
| Usage plans: API stages, throttle, quota (DAY/WEEK/MONTH), per-method throttles, keys | R W | S08 | planned | — |
| Account-level (project) throttle with burst (token bucket) | R H W | S08 | planned | — |
| Stage / route / method throttling | R H W | S08 | planned | — |
| Usage reports per key/day; extend/reset quota | R | S08 | planned | — |
| Developer portals, portal products, product pages, endpoint pages, branding, access control, preview/publish, sharing | R | S13 | planned | — |

## Development & release

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| Draft configuration vs immutable deployments | R H W | S05 | planned | — |
| Stages, stage variables, stage description, deployment pointer | R H W | S05 | planned | — |
| Automatic deployments | H | S05 | planned | — |
| `$default` stage (no stage prefix in URL) | H | S05 | planned | — |
| Test invocation (method and authorizer test) | R | S05/S07 | planned | — |
| Canary release (percent traffic, canary stage variables, promote) | R | S09 | runtime-tested | tests/s09/canary.test.mjs, tests/s09/runtime.test.mjs, tests/s09/control.test.mjs |
| Stage cache: capacity, TTL 0–3600 s, per-method override, cache keys, encryption, invalidation with `Cache-Control: max-age=0` + authorization policy | R | S09 | runtime-tested | tests/s09/cache.test.mjs (engine via handle()+upstream; flush via control service) |
| Response streaming (`STREAM` transfer mode, 15 min, idle timeouts) | R | S09 | runtime-tested | tests/s09/runtime.test.mjs, tests/s09/streaming-limits.test.mjs, tests/s09/streaming.test.mjs |
| OpenAPI 2.0/3.0 import (overwrite/merge, warnings), export (with/without extensions, Postman) | R H | S13 | planned | — |
| Documentation parts & documentation versions | R | S13 | planned | — |
| SDK generation (JS, TS, Python, Java, Ruby, Go, Swift/Android equivalents) | R | S13 | planned | — |
| Agent tool gateway (equivalent of REST API as AgentCore Gateway target → MCP tools) | R | S13 | planned | — |
| Tags on APIs, stages, keys, plans, domains | R H W | S14 | planned | — |
| Management API + CLI + declarative config (CloudFormation/SAM equivalent) | R H W | S14 | planned | — |

## Domains & networking

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| Custom domain names, ownership verification, managed certificates | R H W | S11 | planned | — |
| API mappings (single & multi-level base paths) | R H W | S11 | planned | — |
| Routing rules (header/base-path conditions, priorities, routing modes) | R | S11 | planned | — |
| Private custom domain names + access associations | R | S11 | planned | — |
| Wildcard custom domains | R H | S11 | planned | — |

## Monitoring

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| Metrics: Count, 4XXError, 5XXError, Latency, IntegrationLatency, CacheHitCount, CacheMissCount (+ HTTP: DataProcessed; WS: ConnectCount, MessageCount, ExecutionError, ClientError, IntegrationError) | R H W | S10 | planned | — |
| Detailed (per-route/method) metrics toggle | R H W | S10 | planned | — |
| Access logs with `$context` format (CLF, JSON, XML, CSV) | R H W | S10 | planned | — |
| Execution logs (ERROR/INFO, full request/response data tracing) | R W | S10 | planned | — |
| Log destinations: built-in store + streaming export (Firehose equivalent) | R | S10 | planned | — |
| Tracing (X-Ray equivalent: W3C trace context, sampling rules, OTLP export) | R | S10 | planned | — |
| Alarms (CloudWatch-alarm equivalent) | R H W | S10 | planned | — |
| Management audit trail (CloudTrail equivalent) | R H W | S02/S10 | planned | — |

## WebSocket

| Feature | Types | Spec | Status | Evidence |
|---|---|---|---|---|
| `$connect`, `$disconnect`, `$default`, custom routes; route selection expression | W | S12 | planned | — |
| Two-way integration responses; route responses; model selection expression | W | S12 | planned | — |
| `@connections` management API: POST (send), GET (info), DELETE (disconnect) | W | S12 | planned | — |
| Connection limits: 2 h duration, 10 min idle, 128 KB message / 32 KB frames | W | S12/S15 | planned | — |
