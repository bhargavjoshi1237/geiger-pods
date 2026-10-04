# Pods ⇄ AWS API Gateway parity — spec set

Written 5 October 2026. Research basis: AWS API Gateway Developer Guide (REST v1, HTTP/WebSocket v2), quotas pages, and release notes through the November 2025 launches (developer portals, REST response streaming, enhanced TLS security policies, ALB private integrations, routing rules, dual‑stack, private custom domains, SigV4a). Earlier notes: [`research/aws-api-gateway.md`](../../../research/aws-api-gateway.md), [`research/replacement-roadmap.md`](../../../research/replacement-roadmap.md).

**Goal:** Pods offers every feature of Amazon API Gateway (REST, HTTP and WebSocket APIs), with the same behavior. It runs on Geiger infrastructure, with Geiger identity, projects and UI. It does **not** copy AWS's management API wire format, ARNs, or IAM. Where AWS relies on an AWS service (IAM, Cognito, Lambda, CloudWatch, ACM, WAF, X‑Ray, VPC), the spec defines a Pods equivalent and, where useful, an optional AWS adapter.

## How to use these specs (for implementing agents)

1. Read [`01-architecture.md`](01-architecture.md) first, always. It sets module layout, naming, the request pipeline, the context-variable catalog, the gateway-response catalog, test rules and the definition of done. Every other spec assumes it.
2. Read `AGENTS.md`: this repo runs Next.js 16.3.8, which differs from older versions. Check `node_modules/next/dist/docs/` before writing Next code. Middleware is now `proxy.js`.
3. Implement one spec at a time, in wave order (below). Each spec lists its **Depends on** specs. Do not begin a spec until its dependencies are merged.
4. Each spec ends with **Acceptance tests**. A spec is done only when all its tests exist and pass, `npm run lint` and `npm run build` pass, and the parity matrix row is updated (see *Status tracking*).
5. Do not widen scope. If a spec is ambiguous, follow AWS's documented behavior (the cited link) and record the decision in the spec's *Decisions log* section in the PR.

## Spec list

| ID | Spec | Wave | Depends on | Roadmap phase |
|---|---|---|---|---|
| S01 | [Architecture, conventions & shared engine contracts](01-architecture.md) | 1 | — | 1 |
| S02 | [Data foundation: schema, authorization, audit, vault, management API base](02-data-foundation.md) | 1 | S01 | 1 |
| S03 | [API catalog & routing (HTTP routes, REST resources/methods)](03-api-catalog-routing.md) | 2 | S01, S02 | 1 |
| S04 | [Integrations (HTTP, mock, function, AWS service, private connectors, backend TLS)](04-integrations.md) | 2 | S01, S02 | 2 |
| S05 | [Deployments, stages & gateway runtime host](05-deployments-stages-runtime.md) | 3 | S03, S04 | 2 |
| S06 | [Request & response processing (CORS, mapping, models, validation, templates, binary, compression, gateway responses)](06-request-processing.md) | 3 | S03, S04 (core), S05 for runtime wiring | 4 |
| S07 | [Consumer authorization (IAM‑equivalent/SigV4, JWT, custom authorizers, resource policies)](07-authorization.md) | 4 | S05 | 3 |
| S08 | [API keys, usage plans, throttling & quotas](08-api-keys-usage-plans-throttling.md) | 4 | S05 | 3 |
| S09 | [Release controls: canary, caching, response streaming](09-release-controls.md) | 5 | S05, S06, S08 | 5 |
| S10 | [Observability: metrics, access/execution logs, tracing, alarms, audit](10-observability.md) | 4 | S05 | 6 |
| S11 | [Custom domains, TLS, mTLS, routing rules, endpoint types, private APIs, WAF](11-domains-networking-waf.md) | 5 | S05, S07 | 7 |
| S12 | [WebSocket APIs](12-websocket.md) | 5 | S05, S07, S08 | 8 |
| S13 | [Developer distribution: OpenAPI, docs, SDKs, portals](13-developer-distribution.md) | 5 | S03, S05, S06 | 9 |
| S14 | [Management API, CLI, declarative config & tags](14-management-api-cli.md) | 5 | S02, S03, S05 | 9 |
| S15 | [Limits, quotas, hardening & parity audit](15-limits-hardening-audit.md) | 6 | all | 10 |

### Waves (parallelism)

```
Wave 1:  S01 ──► S02
Wave 2:  S03   S04                       (parallel)
Wave 3:  S05 ──► S06 runtime wiring      (S06 pure modules can start in wave 2)
Wave 4:  S07   S08   S10                 (parallel)
Wave 5:  S09   S11   S12   S13   S14     (parallel)
Wave 6:  S15
```

Within a wave, specs touch different directories (see S01 *Module ownership*). Shared files (`lib/gateway/core/pipeline.mjs`, `lib/gateway/capabilities.mjs`, `lib/workspace/model.mjs`, sidebar navigation, `package.json`) change only through the extension points S01 defines. That keeps parallel branches mergeable.

## Parity matrix (AWS feature → spec)

Legend: **R** = REST API, **H** = HTTP API, **W** = WebSocket API, matching AWS availability. Priority **P0** = needed for the first usable gateway, **P1** = full parity, **P2** = parity with recent or niche AWS launches. Pods enforces AWS's per-protocol availability through `lib/gateway/capabilities.mjs` (S01).

### Endpoints & exposure
| Feature | Types | Spec | Pri |
|---|---|---|---|
| Default invoke URL per API/stage (`execute-api` equivalent) | R H W | S05 | P0 |
| Regional endpoint | R H W | S11 | P0 |
| Edge-optimized endpoint (global edge placement) | R | S11 | P2 |
| Private API (reachable only via connector/allow-listed network) | R | S11 | P1 |
| Disable default endpoint | R H W | S11 | P1 |
| Dual-stack IPv4/IPv6 endpoint setting | R H W | S11 | P2 |

### Routing & API model
| Feature | Types | Spec | Pri |
|---|---|---|---|
| HTTP routes `METHOD /path`, `ANY`, `{param}`, `{proxy+}`, `$default` | H | S03 | P0 |
| REST resource tree, methods, `ANY`, `{proxy+}` resources | R | S03 | P0 |
| WebSocket route keys and route selection expression | W | S12 | P1 |
| API key source, binary media types, minimum compression size, `disableExecuteApiEndpoint` API settings | R | S03/S06/S11 | P1 |

### Integrations
| Feature | Types | Spec | Pri |
|---|---|---|---|
| HTTP proxy (`HTTP_PROXY`) | R H W | S04 | P0 |
| HTTP custom (`HTTP`, with mappings) | R W | S04 | P1 |
| Mock (`MOCK`) | R W | S04 | P0 |
| Function proxy (`AWS_PROXY`/Lambda), payload v1.0 and v2.0 | R H W | S04 | P1 |
| Function custom (`AWS`/Lambda non-proxy) | R W | S04 | P1 |
| AWS service integrations (REST: any action; HTTP: first-class subtypes SQS/SNS/EventBridge/Kinesis/Step Functions/AppConfig) | R H W | S04 | P2 |
| Private integrations (VPC link → NLB/ALB/Cloud Map equivalent: Pods Connector) | R H W | S04 | P1 |
| Integration timeouts (50 ms – 29 s default, raisable) | R H W | S04 | P0 |
| Backend client certificates (gateway-generated) | R | S04 | P1 |
| Backend TLS options (`insecureSkipVerification`, SNI `serverNameToVerify`) | R H | S04 | P1 |
| Integration credentials vault (Pods extension: inject secrets) | R H W | S04 | P0 |

### Request/response processing
| Feature | Types | Spec | Pri |
|---|---|---|---|
| CORS (REST: OPTIONS mock + headers; HTTP: managed CORS config) | R H | S06 | P0 |
| HTTP parameter mapping (append/overwrite/remove headers, query, path; response header/status) | H | S06 | P1 |
| REST request/response parameter mapping | R | S06 | P1 |
| Models (JSON Schema) | R W | S06 | P1 |
| Request validators (body / params / both) | R | S06 | P1 |
| Mapping templates (VTL-compatible), passthrough behavior, content-type selection | R W | S06 | P1 |
| Method responses / integration responses with selection patterns | R | S06 | P1 |
| Binary media types, content handling (CONVERT_TO_TEXT/BINARY) | R | S06 | P1 |
| Payload compression (minimumCompressionSize) | R | S06 | P1 |
| Custom gateway responses (all response types) | R | S06 | P1 |
| Payload limits (10 MB), header limits, URL length | R H W | S06/S15 | P0 |

### Security & access
| Feature | Types | Spec | Pri |
|---|---|---|---|
| IAM authorization → Pods signed requests (SigV4-compatible algorithm, Pods principals and policies) | R H W | S07 | P1 |
| SigV4a | R | S07 | P2 |
| Cognito user pool authorizer → JWT/OIDC authorizer (any issuer) | R H W | S07 | P0 |
| JWT authorizer (issuer, audiences, scopes per route) | H | S07 | P0 |
| Lambda authorizer TOKEN / REQUEST, caching, IAM-policy or simple responses, context passthrough | R H W | S07 | P1 |
| Resource policies (IP/CIDR, source connector, principal, explicit deny) | R | S07 | P1 |
| Mutual TLS with trust store, client-cert context | R H | S11 | P1 |
| WAF (IP sets, geo match, rate-based, size, SQLi/XSS, managed rule groups) | R | S11 | P1 |
| TLS security policies (TLS 1.2, TLS 1.3, PQ/FIPS variants as profiles) | R H | S11 | P2 |

### API management
| Feature | Types | Spec | Pri |
|---|---|---|---|
| API keys: generate/import, enable/disable, value reveal, HEADER/AUTHORIZER key source (WS: `apiKeySelectionExpression` on `$connect`) | R W | S08 | P0 |
| Usage plans: API stages, throttle, quota (DAY/WEEK/MONTH), per-method throttles, keys | R W | S08 | P0 |
| Account-level (project) throttle with burst (token bucket) | R H W | S08 | P0 |
| Stage / route / method throttling | R H W | S08 | P0 |
| Usage reports per key/day; extend/reset quota | R | S08 | P1 |
| Developer portals, portal products, product pages, endpoint pages, branding, access control, preview/publish, sharing | R | S13 | P1 |

### Development & release
| Feature | Types | Spec | Pri |
|---|---|---|---|
| Draft configuration vs immutable deployments | R H W | S05 | P0 |
| Stages, stage variables, stage description, deployment pointer | R H W | S05 | P0 |
| Automatic deployments | H | S05 | P0 |
| `$default` stage (no stage prefix in URL) | H | S05 | P0 |
| Test invocation (method and authorizer test) | R | S05/S07 | P1 |
| Canary release (percent traffic, canary stage variables, promote) | R | S09 | P1 |
| Stage cache: capacity, TTL 0–3600 s, per-method override, cache keys, encryption, invalidation with `Cache-Control: max-age=0` + authorization policy | R | S09 | P1 |
| Response streaming (`STREAM` transfer mode, 15 min, idle timeouts) | R | S09 | P1 |
| OpenAPI 2.0/3.0 import (overwrite/merge, warnings), export (with/without extensions, Postman) | R H | S13 | P1 |
| Documentation parts & documentation versions | R | S13 | P1 |
| SDK generation (JS, TS, Python, Java, Ruby, Go, Swift/Android equivalents) | R | S13 | P2 |
| Agent tool gateway (equivalent of REST API as AgentCore Gateway target → MCP tools) | R | S13 | P2 |
| Tags on APIs, stages, keys, plans, domains | R H W | S14 | P1 |
| Management API + CLI + declarative config (CloudFormation/SAM equivalent) | R H W | S14 | P1 |

### Domains & networking
| Feature | Types | Spec | Pri |
|---|---|---|---|
| Custom domain names, ownership verification, managed certificates | R H W | S11 | P0 |
| API mappings (single & multi-level base paths) | R H W | S11 | P0 |
| Routing rules (header/base-path conditions, priorities, routing modes) | R | S11 | P2 |
| Private custom domain names + access associations | R | S11 | P2 |
| Wildcard custom domains | R H | S11 | P2 |

### Monitoring
| Feature | Types | Spec | Pri |
|---|---|---|---|
| Metrics: Count, 4XXError, 5XXError, Latency, IntegrationLatency, CacheHitCount, CacheMissCount (+ HTTP: DataProcessed; WS: ConnectCount, MessageCount, ExecutionError, ClientError, IntegrationError) | R H W | S10 | P0 |
| Detailed (per-route/method) metrics toggle | R H W | S10 | P1 |
| Access logs with `$context` format (CLF, JSON, XML, CSV) | R H W | S10 | P0 |
| Execution logs (ERROR/INFO, full request/response data tracing) | R W | S10 | P1 |
| Log destinations: built-in store + streaming export (Firehose equivalent) | R | S10 | P1 |
| Tracing (X-Ray equivalent: W3C trace context, sampling rules, OTLP export) | R | S10 | P1 |
| Alarms (CloudWatch-alarm equivalent) | R H W | S10 | P1 |
| Management audit trail (CloudTrail equivalent) | R H W | S02/S10 | P0 |

### WebSocket
| Feature | Types | Spec | Pri |
|---|---|---|---|
| `$connect`, `$disconnect`, `$default`, custom routes; route selection expression | W | S12 | P1 |
| Two-way integration responses; route responses; model selection expression | W | S12 | P1 |
| `@connections` management API: POST (send), GET (info), DELETE (disconnect) | W | S12 | P1 |
| Connection limits: 2 h duration, 10 min idle, 128 KB message / 32 KB frames | W | S12/S15 | P1 |

### Out of scope (explicitly)
- AWS Marketplace SaaS integration for usage plans. Billing is a later Geiger-wide concern. S08 exposes the usage data needed.
- CloudFormation/CDK compatibility, AWS ARNs, AWS CLI/API wire compatibility. S14 defines Pods-native equivalents.
- Hard real-time accuracy guarantees for quotas. AWS documents quotas and throttles as best-effort; Pods publishes its own semantics (S08).

## Open decisions (confirm before the listed spec starts)

| # | Decision | Recommendation in specs | Blocks |
|---|---|---|---|
| D1 | Where the data plane runs | Standalone Node container (`gateway/`) plus an optional Vercel route adapter (S01 ADR-1). Vercel Functions alone cannot do WebSocket, mTLS or long streams | S05 |
| D2 | Shared KV store | Any Redis-protocol store via `PODS_KV_URL` (e.g. Upstash from the Vercel Marketplace) (ADR-4) | S05 (memory KV is enough for S01–S04) |
| D3 | Gateway hostname | `PODS_GATEWAY_DOMAIN` with wildcard DNS + TLS, e.g. `*.gw.geigerpods.app` | S05 runtime tests in prod, S11 |
| D4 | Cache identity partitioning (deviation from AWS, safer) | On by default (S09) | S09 |

## Agent hand-off template

Paste this to each implementing agent, replacing `<ID>`:

```
You are implementing spec <ID> of the Pods AWS API Gateway parity project in C:\Pro\geiger-pods.
1. Read docs/specs/gateway/00-index.md, 01-architecture.md, then docs/specs/gateway/<ID>-*.md fully. Read AGENTS.md
   and the relevant node_modules/next/dist/docs/ pages before writing any Next.js code.
2. Confirm every spec listed under "Depends on" is merged; if not, stop and report.
3. Work test-first: write the spec's Acceptance tests (named "<ID>: …") before the implementation.
4. Stay inside the directories S01 §2 assigns to <ID>; touch shared files only via the S01 extension points.
5. Done = all acceptance tests pass, npm test / npm run lint / npm run build pass, migrations have @up/@down,
   parity-status.md rows updated with evidence, and a PR note listing "Deviations from AWS" and decisions made.
```

## Status tracking

Each row above is tracked in `docs/specs/gateway/parity-status.md`, created by S01, as one of: `planned` → `designed` → `implemented` → `runtime-tested` → `production-validated`. An agent completing a spec updates the rows it delivered, cites test files as evidence, and never marks a row past `runtime-tested` without production evidence (S15).

## Sources (primary)

- [REST vs HTTP feature comparison](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)
- [Quotas (account, REST, HTTP, WebSocket)](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html), [REST execution quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html)
- [Release notes RSS](https://docs.aws.amazon.com/apigateway/latest/developerguide/amazon-apigateway-release-notes.rss)
- [Routing rules](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-routing-rules.html), [response streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html), [portals](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-portals.html), [HTTP parameter mapping](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-parameter-mapping.html)
- [Developer portal launch, Nov 2025](https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-developer-portal-capabilities)
- Per-spec sources are cited inside each spec.
