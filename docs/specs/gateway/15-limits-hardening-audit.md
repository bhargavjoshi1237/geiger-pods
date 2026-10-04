# S15 — Limits, quotas, hardening & parity audit

**Wave 6 · Depends on: all specs · Roadmap phase 10 "Production validation"**

AWS references: [quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html), [REST execution quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html), [security best practices](https://docs.aws.amazon.com/apigateway/latest/developerguide/security-best-practices.html), [pricing dimensions](https://aws.amazon.com/api-gateway/pricing/).

## 1. Published limits (`lib/gateway/core/limits.mjs` + `docs/limits.md`)

Defaults match AWS. Columns: **adjustable** means a project override in `project_settings.features.limits` (set by Geiger staff via SQL, not by users). Every limit has one constant in `limits.mjs`, and both the control plane (409/422 `limit_exceeded {limit, value}`) and the runtime use those constants.

| Limit | Default | Adjustable |
|---|---|---|
| APIs per project (regional / private / edge) | 600 / 600 / 120 | yes |
| Resources per REST API | 300 | yes |
| Routes per HTTP/WS API | 300 | yes |
| Integrations per HTTP API | 300 | yes |
| Stages per API | 10 | yes |
| Stage variables per stage (key 64, value 512 chars) | 100 | no |
| Authorizers per API | 10 | yes |
| JWT audiences per authorizer / scopes per route | 50 / 10 | no |
| Models size per API | 400 KB | no |
| Documentation parts per API | 2000 | yes |
| API keys per project | 10 000 | no |
| Usage plans per project / per key | 300 / 10 | yes |
| Method throttles per plan stage | 20 | yes |
| Custom domains per project (public / private) | 120 / 50 | yes |
| Multi-level mappings per domain / routing rules per domain | 200 / 50 | no / yes |
| Connectors per project | 20 | yes |
| Client certificates per project | 60 | yes |
| Trust store | 1000 certs, 1 MB | no |
| Resource policy length | 8192 chars | yes |
| Access log format | 3 KB | no |
| Mapping template size / `#foreach` iterations | 300 KB / 1000 | no |
| Import file size | 6 MB | no |
| Payload (request/response, buffered) | 10 MB | no |
| Header bytes total (REST / HTTP) | 20 480 / 10 240 | no |
| URL length (regional / edge / private) | 10 240 / 8192 / 8192 | no |
| Integration timeout REST/WS / HTTP | 50 ms–29 s (raise to 300 s) / 30 s | REST yes |
| Idle client connection (HTTP keep-alive) | 310 s | no |
| Cache TTL / cached item | 0–3600 s / 1 MB | no |
| Streaming duration / idle (regional, edge) | 15 min / 5 min, 30 s | no |
| WS message / frame | 128 KB / 32 KB | no |
| WS connection duration / idle | 2 h / 10 min | no |
| WS new connections per second per project | 500 | yes |
| Project throttle (rps / burst) | 10 000 / 5 000 | yes |
| Control plane (rps / burst) | 10 / 40 | no |

`docs/limits.md` is generated from `limits.mjs` by `scripts/gen-limits-doc.mjs`, and a test checks they stay in sync. The UI shows usage vs limit on list screens near the cap (≥ 80 %).

## 2. Hardening checklist (each item = test or documented review)

**HTTP parsing & smuggling.** Node's strict parser (`insecureHTTPParser: false`). Reject requests with both `Content-Length` and `Transfer-Encoding`, duplicate `Content-Length`, invalid chunk sizes, obs-fold headers, and CR/LF/NUL in header values (including values produced by mappings/templates; config validation plus a runtime check → 500 `API_CONFIGURATION_ERROR`). `server.headersTimeout = 60 s`, `requestTimeout = 300 s` (stream-aware), `keepAliveTimeout = 310 s` (AWS idle). Slowloris test.

**Paths.** No `..` normalization (AWS forwards paths as received, but `..` segments never match resources). Encoded `%2F` inside a segment stays in one param. Host header: only configured hosts. Unknown → 403, with no reflection in the body.

**SSRF.** S04 guard on every integration, discovery/JWKS fetch, OAuth token URL, webhook sink, ACME, and portal OIDC discovery. Test with DNS rebinding (TTL 0 resolver flipping public → 127.0.0.1).

**ReDoS.** Integration-response `selection_pattern`, routing-rule globs, WAF regexes and identity-validation expressions are validated at save (length ≤ 512, no nested quantifiers on overlapping classes; reject backreferences/lookaround where RE2-incompatible). Runtime evaluation has a bounded input length. Fuzz with `ReDoS` corpus payloads; each evaluation must stay < 10 ms.

**Sandboxes.** The VTL interpreter has no access to host objects (prototype-free `Object.create(null)` maps, no `constructor`/`__proto__` property reads, step budget). Fuzz 10 000 random templates: no exceptions escape as 500s other than `API_CONFIGURATION_ERROR`, and no prototype pollution (assert `({}).polluted === undefined`).

**Crypto & auth.** Timing-safe comparisons for HMACs, token hashes and signatures (`crypto.timingSafeEqual`). JWT alg allow-list. Vault AAD binding. Secrets never logged: a test scans all log sinks, execution logs, error bodies, artifacts and API responses after a full e2e run for every secret value used (canary strings).

**Tenant isolation.** A two-project matrix test: project B's credentials, keys, JWTs, connectors, domains and cache entries can never reach project A's APIs, at every layer (control plane, RLS, runtime lookups, KV key prefixes, cache keys, `@connections`).

**Supply chain.** Pinned dependencies, `npm audit --omit=dev` clean (record exceptions), runtime container non-root, read-only FS, no shell. SBOM generated in CI (`npm sbom`).

## 3. Performance & resilience targets (benchmarks in `bench/`)

- Gateway overhead (no auth, HTTP_PROXY to local upstream, keep-alive): p50 ≤ 3 ms, p99 ≤ 15 ms at 1,000 rps on 2 vCPU. With JWT (cached JWKS) + API key + throttle on Redis: p99 ≤ 25 ms.
- Throughput: ≥ 3,000 rps per 2-vCPU instance for 1 KB payloads.
- Chaos: KV down (behavior per ADR-4, no crash), DB down (cached artifacts keep serving), upstream blackhole (timeouts honored, sockets freed), instance kill mid-stream (client gets a reset; WS clients reconnect), clock skew ±2 min between instances (quota periods correct).
- Recovery: a project config backup is `pods apply`-format export (S14) plus vault ciphertext. A restore drill is documented in `docs/ops/restore.md` with RPO = DB PITR window, and RTO ≤ 1 h.

## 4. Metering (for future Geiger billing, no charging)

`pods.metering_daily (project_id, day, dimension, quantity)`. Dimensions mirror AWS pricing units: `rest_requests`, `http_requests` (counted in 512 KB increments as AWS does), `ws_messages` (32 KB increments), `ws_connection_minutes`, `cache_gb_hours` (by configured size), `stream_bytes`, `data_transfer_out_bytes`, `portal_page_views`. Fed by the S10 rollup. Shown read-only on the project settings page.

## 5. Parity audit

1. `scripts/parity-report.mjs` reads `docs/specs/gateway/parity-status.md` (S01) and the latest test run's JSON reporter output (`node --test --test-reporter=json`). It writes `docs/specs/gateway/parity-report.md`: per row, status, evidence tests (pass/fail), deviations, and production evidence links.
2. Every **Deviation from AWS** listed in PRs is collected into `docs/specs/gateway/deviations.md`, with rationale. The known ones are: cache identity partitioning (S09), connector instead of VPC link (S04), OIDC instead of Cognito (S07/S13), SigV4 with Pods credentials (S07), Pods managed WAF rule sets (S11), and quota counting of pre-quota rejections (S08).
3. Production validation (marks rows `production-validated`): runtime deployed in ≥ 2 instances behind a real wildcard domain with real TLS; a custom domain with a managed certificate; mTLS with a real CA; a connector across a real NAT; a 24 h soak at 500 rps with canary and cache enabled; and a WebSocket soak of 10k connections for 2 h. Evidence (dashboards, logs, timestamps) goes in `docs/specs/gateway/production-evidence/`.
4. Update `lib/workspace/roadmap.js` phase statuses and the landing page claims **only** from the parity report. No claim is made without evidence (Phase‑0 rule).

## Acceptance tests

- `S15: limits.mjs and docs/limits.md in sync; each limit enforced (one test per row: N allowed, N+1 rejected)`.
- `S15: smuggling suite (CL+TE, duplicate CL, bad chunk) rejected with 400 and connection closed`.
- `S15: CRLF in mapped header value → config rejected; runtime-computed CRLF → 500 API_CONFIGURATION_ERROR`.
- `S15: DNS-rebinding SSRF test blocked on second resolution`.
- `S15: ReDoS corpus — every evaluation < 10 ms`.
- `S15: VTL fuzz — no prototype pollution, only API_CONFIGURATION_ERROR failures`.
- `S15: secret canary strings absent from all outputs after full e2e run`.
- `S15: two-project isolation matrix (≥ 30 cases) all denied`.
- `S15: bench results recorded; p99 thresholds asserted at 2× target to avoid CI flakiness`.
- `S15: parity-report generated with no row marked beyond its evidence`.
