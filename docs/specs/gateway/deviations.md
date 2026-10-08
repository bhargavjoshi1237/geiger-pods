# Pods ⇄ AWS API Gateway deviations

Spec S15 §5.2. Every intentional deviation from AWS behavior, with rationale.
Per-spec reports carry the full lists; this file collects the six named in
the spec plus the gateway-wide deviations closed during S15.

Status: no production validation yet (see `production-evidence/`).
`parity-status.md` is the source of truth; `parity-report.md` is generated
from it by `scripts/parity-report.mjs` (gate: 0 rows beyond evidence).

## Spec-named deviations

1. **Cache identity partitioning (S09).** Cache keys partition by caller
   identity where AWS would share. Rationale: prevents cross-tenant cache
   poisoning in a multi-project gateway. Evidence: `tests/s09/cache.test.mjs`.
2. **Connector instead of VPC link (S04).** Private integrations dial via the
   Pods Connector (`x-pods-connector-id` + token-hash verification) rather
   than AWS VPC links. Rationale: works behind existing LB/TLS termination
   with no new ports. Evidence: `tests/s15/hardening.test.mjs`
   (`F36 [runtime]`), `lib/gateway/core/integrations/connector.mjs`.
3. **OIDC instead of Cognito (S07/S13).** JWT/OIDC authorizers accept any
   issuer; portals reuse the suite Supabase session. Rationale: no Cognito
   dependency. Evidence: `tests/s07/jwt.test.mjs`, `tests/s13/portal-access.test.mjs`.
4. **SigV4 with Pods credentials (S07).** Signing uses Pods principals and
   policies; verification covers the client-sent URL (`ctx.originalUrl`).
   Rationale: AWS parity (sign what you send); the prior stripped-path check
   false-rejected every correctly-signed gateway request (F46).
   Evidence: `tests/s07/sigv4.test.mjs`, `tests/s15/secrets-canary.test.mjs`.
5. **Pods managed WAF rule sets (S11).** `waf-managed/` ships Common/SQLi/
   bad-inputs/admin groups instead of AWS managed groups. Rationale: no vendor
   feed. Evidence: `tests/s11/waf-engine.test.mjs` + corpus.
6. **Quota counting of pre-quota rejections (S08).** Rejected-before-quota
   requests still count in usage rows. Rationale: documented counter
   semantics; billing is metering-only (no charging). Evidence: `tests/s08/`.

## Gateway-wide S15 deviations (with reasons)

- **Slowloris guard is application-level.** Node 24 `headersTimeout` does not
  reap pure header stalls; the host arms its own per-socket timer (408 +
  destroy), cleared on request/upgrade so streams and WebSocket are
  unaffected. Evidence: `tests/s15/smuggling.test.mjs`.
- **Loopback literals accepted at OpenAPI import (F41).** Non-loopback blocked
  literals are 422 at import; loopback stays a runtime decision, mirroring
  `createIntegration`. Production refuses `PODS_ALLOW_LOOPBACK` (F4).
  Evidence: `tests/s15/hardening.test.mjs` (F4, F41).
- **Domain policies govern network ingress (F34).** Associations + domain
  policy are evaluated pre-auth with connector facts (fail closed);
  user-Principal statements are not matched post-auth — the API resource
  policy owns user authorization. Evidence: `tests/s15/hardening.test.mjs`.
- **WS frame quota: strict per-frame (F37).** Single frames > 32 KB close 1009;
  fragmented messages ≤ 128 KB pass. Closing delegates to the `ws` object
  (reliable delivery). Evidence: `tests/s15p/f37-ws-frames.test.mjs`.
- **MCP transport is POST-only JSON (S13).** No GET/SSE stream; `/{stage}/_mcp`
  shadows greedy REST resources only when agent tools are enabled.
  Evidence: `tests/s13/mcp-runtime.test.mjs`.
- **Portal 403 renders with HTTP 200 (S13).** `forbidden()` needs the
  experimental flag; anonymous sees a sign-in prompt and disallowed domains
  see a denied page (both snapshot-free); only missing/disabled → 404.
- **SDK extended languages render a pinned stub offline (S13).** The worker
  Dockerfile is the real pipeline; the stub names generator + version.
  Multi-instance job persistence is open (F43).
- **Load tests are scaled by default (S12).** Full 5,000 conns / 1,000 msgs
  behind `PODS_LOAD_TESTS=1`; default 150/150 asserts the same p99.
  Evidence: `tests/s12/load.test.mjs`.
- **Bench asserts at 2× target (S15).** In-process `handle()` overhead:
  target p50 ≤ 3 ms / p99 ≤ 15 ms; CI asserts p99 ≤ 30 ms to avoid flakiness.
  Heavy gateway + Redis runs behind `PODS_BENCH_HEAVY=1`.
  Evidence: `tests/s15/bench.test.mjs`, `bench/results.json`.

## Further reading

Full per-spec deviation lists live in the spec reports:
S01, S02, S03, S04, S05, S06, S09, S10, S11, S12, S13, S14, S15 (part 1),
S15-parallel, S15 (part 2). Each names the AWS behavior, the Pods behavior, and why.
