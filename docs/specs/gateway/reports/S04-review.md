# S04 review — Integrations (defects found and fixed)

Date: 5 October 2026. Reviewer scope: spec `docs/specs/gateway/04-integrations.md`,
report `docs/specs/gateway/reports/S04.md`, every file that report lists, and `tests/s04/`.
Next.js docs were consulted only for the two thin UI touch-ups (no Next APIs were changed).

Method: read the spec, the report, all listed implementation files and all S04 tests;
reproduced each suspected defect with a scratch script before writing a regression test;
fixed only confirmed defects. Regression tests live in `tests/s04/review.test.mjs`
(names `S04 review: <behavior>`). Each failed before its fix and passes after.

## Findings

severity | file:line | defect | status
---|---|---|---
high | `lib/gateway/core/integrations/uri.mjs:94-102` | `maybeAppendDefaultPath` checked the *rendered* URL for `{proxy}`. Rendering substitutes every placeholder away, so the check was always true and `ANY /{proxy+}` integrations whose URI contains `{proxy}` got the request path appended twice (`/a/b` → `/a/b/a/b`). | fixed + `S04 review: ANY /{proxy+} with {proxy} in URI does not double-append path`
high | `lib/gateway/core/integrations/function.mjs:344-346,384` | Webhook and `aws_lambda` fetches used default `redirect: "follow"`, violating adapter rule §3.3 ("never follow redirects"). Verified live: a webhook `/redirect` was followed to `/final`. A backend-controlled redirect could route the signed request at an arbitrary host. | fixed + `S04 review: webhook function does not follow redirects`
high | `connector/agent.mjs:128` | Private fetch used default redirect-following, bypassing the allow-list: the gateway and agent check only the original URL, so `http://orders.internal:8080/x` → 302 → `http://169.254.169.254/` escaped both checks. | fixed (`redirect: "manual"`) + `S04 review: connector tunnel does not follow redirects`
high | `lib/gateway/core/integrations/function.mjs:48-77` | `multiValue`/`queryParams` used plain `{}` accumulators keyed by consumer-controlled header/query names. `?__proto__=x` threw `TypeError: [... ] is not iterable` (consumer-triggered 500; confirmed live). | fixed (null-prototype accumulators) + `S04 review: __proto__ header/query keys cannot crash function event builders`
high | `lib/control/integrations.mjs:104,285,338` | `pods.secret.use` was enforced only for `backendAuth.secretRef`. `function.secretRef`, `function.credentialsRef` and `aws.roleSecretRef` had no check, so an actor with only `pods.integration.write` could arm the gateway with someone else's secret (confirmed: all three created `201` pre-fix). | fixed (`requireSecretUseForRefs`, create + update) + `S04 review: function/aws secret refs require pods.secret.use`
medium | `lib/gateway/core/integrations/http.mjs:151-157` | With the default dispatcher (production path, no injected `lookup`) the pre-flight SSRF check was skipped; a blocked host (verified: `169.254.169.254`) surfaced as `INTEGRATION_FAILURE`/504 because undici wraps the connect-time guard error. | fixed (pre-flight via `nodeLookup`; IP literals never touch DNS; connect-time guard still re-checks) + `S04 review: SSRF block maps to API_CONFIGURATION_ERROR on the default path`
medium | `lib/gateway/core/integrations/http.mjs:103-112` | When rendering from the `uri` template (`outbound.url == null`), the client query string was silently dropped; only S06-supplied `queryString` was forwarded. | fixed (falls back to request query only when no caller URL exists) + `S04 review: query string passes through when rendering from uri template`
medium | `lib/gateway/core/integrations/function.mjs:135-136` | Payload 2.0 `cookies` returned the raw `Cookie` header as one entry (`["a=1; b=2"]`); AWS splits on `;`. | fixed + `S04 review: payload 2.0 splits Cookie header into cookies array`
medium | `lib/gateway/core/integrations/function.mjs:148` | Payload 2.0 `requestContext.time` was ISO-8601 with milliseconds zeroed; the AWS reference (and S01 `$context.requestTime`) is CLF. The old test only asserted an ISO-shaped regex, so it proved nothing. | fixed (uses `ctx.context.requestTime`, `formatClfTime` fallback) + `S04 review: payload 2.0 time uses CLF requestTime`; updated `tests/s04/function-mock.test.mjs` to assert CLF equality
medium | `lib/gateway/core/integrations/function.mjs:367` | Custom `FUNCTION` over `aws_lambda` ignored `outbound.renderedTemplate` and always sent the proxy event, although the report claims "the engine consumes it" (true only for webhooks). | fixed (template wins; proxy path unchanged since it never sets one) + `S04 review: FUNCTION custom aws_lambda uses renderedTemplate`
medium | `lib/gateway/core/integrations/aws.mjs:104-141,193` | `validateSubtypeParams` / `buildSubtypeRequest` / `buildRestAwsRequest` threw plain `Error`s, so a config problem (unknown subtype, missing params/region/service) mapped to `INTEGRATION_FAILURE`/504 instead of `API_CONFIGURATION_ERROR`/500. | fixed (`GatewayError`, detail kept in `extra`, wire message generic) + `S04 review: AWS subtype config errors are API_CONFIGURATION_ERROR`; updated `tests/s04/aws-service.test.mjs` assertions accordingly
medium | `lib/gateway/core/integrations/index.mjs:297` | `invokeAws` fetch followed redirects; AWS-service 3xx must be returned as-is per adapter rule §3.3. | fixed (`redirect: "manual"`) + `S04 review: aws_service fetch does not follow redirects`
medium | `lib/gateway/core/integrations/backend-auth.mjs:96-105` | Query-auth with a missing/null URL threw a raw `TypeError: Invalid URL` (verified live). Now a masked `backend_auth_failed` (`****`, no URL echo). | fixed + `S04 review: query backend_auth with missing url fails masked, not TypeError`
medium | `lib/gateway/core/integrations/index.mjs:166-182` | Same root cause as above one layer up: query-auth needs a URL, but the template was rendered only later inside `invokeHttp`, so the combination always crashed. | fixed (pre-render for the `query` type) + `S04 review: query backend_auth applies to the rendered integration url`
medium | `lib/gateway/core/integrations/index.mjs:120-153` | CONNECTOR branch was a second, weaker implementation: no `${request.path.x}` rendering, no HTTP `$default`/ANY-proxy path append, and no OAuth 401 refresh-and-retry (spec §5 requires it on every transport). | fixed (same vars, `maybeAppendDefaultPath` with template, one refresh+retry) + `S04 review: connector appends $default path and renders request.path tokens` and `S04 review: connector oauth refreshes once on 401`
medium | `lib/gateway/core/integrations/backend-auth.mjs:210-216` | OAuth token fetch followed redirects; a 307/308 would re-send `client_secret` to the redirect target. | fixed (`redirect: "manual"`, fails closed) + `S04 review: oauth token fetch does not follow redirects`
medium | `lib/control/integrations.mjs:232` | `CONNECTOR` HTTP integrations could be created without `uri`, but spec §4 says the URI *is* the private URL — every such integration 500s at invoke. | fixed (uri required for `HTTP_PROXY`/`HTTP` regardless of connection type) + `S04 review: CONNECTOR integrations require a uri`
medium | `lib/control/integrations.mjs:122,280,327` | `tls: {serverNameToVerify: null}` — the migration default and what GET returns — failed validation (`expected a string`), so every UI round-trip (GET → PATCH) 422'd. | fixed (`normalizeTlsInput`, create + update) + `S04 review: tls serverNameToVerify null round-trips`
medium | `lib/gateway/core/phases/invoke.mjs:195-201` | `renderRefined` answers HTTP 503/500 and REST 502 directly with `x-pods-error-type` but **no `x-pods-request-id`**, violating S01 §3 (every response carries it). | reported-not-fixed: `phases/*` is off-limits to this review; owner should add the header (or rethrow so the pipeline renderer does it)
medium | `tests/s04/backend-auth.test.mjs:65` | `assert.ok(!...includes("not found") \|\| true)` — tautology, passes regardless. | fixed (assert the real masking property)
low | `lib/control/integrations.mjs:141-149` | `validateUriTemplate` accepted `https://{host}/x` (probe replaces it with `p`), which always fails at invoke with `API_CONFIGURATION_ERROR`. | fixed (placeholders rejected in the authority; UI `validateUri` mirrored) + `S04 review: uri with host placeholder is rejected`
low | `lib/control/connectors.mjs:65` | `allowedTargets` accepted ports up to 99999 (`\d{1,5}`), e.g. `internal:99999`. | fixed (0–65535 or `*`) + `S04 review: connector target port range is validated`
low | `components/internal/screens/integrations/integrations_tab.jsx:43-52,65` | URI field skipped validation for CONNECTOR (now required server-side) and did not flag host placeholders. | fixed (validate for all HTTP types + authority check)
low | `lib/gateway/core/integrations/function.mjs:45` | `verifyWebhookSignature` compares HMAC hex with `===` (timing-unsafe). | reported-not-fixed: no behavioral test can distinguish it, and the gateway never calls it (it only *signs* outbound webhooks; verification runs on the customer's host). Recommend `timingSafeEqual` when touched
low | `connector/agent.mjs:137` | `serveStream` buffers the entire private response (`arrayBuffer()`) although `PROTOCOL.md` claims responses stream under the window. Bounded by the hub's 10 MB cap, so impact is memory (≤10 MB per stream ×2), not correctness. | reported-not-fixed: true streaming is a rewrite, out of scope for this review
low | `lib/control/connectors.mjs:47-52` | `randomTokenSecret` uses `byte % 62` (tiny modulo bias) instead of rejection sampling like `newPublicId`. | reported-not-fixed: 32 chars ≈ 190 bits either way; no behavioral test can distinguish
low | `lib/gateway/core/integrations/function.mjs:265-278` | `selectCustomResponse` compiles owner-supplied `selection_pattern` with `new RegExp` (ReDoS surface if the pattern is pathological). | reported-not-fixed: patterns are owner-controlled and validated at the control plane; consumer input only reaches them via the owner's backend `errorMessage`. No action beyond noting
low | `supabase/migrations/integrations/20261007000001_integrations.sql:159-175` | `integration_responses_write` does not check the parent's `deleted_at`, so responses can be added to soft-deleted integrations (the read policy does check). Cosmetic. | reported-not-fixed: S04 migration file is applied/owned; needs an owner edit
low | `lib/control/connectors.mjs:recordHeartbeat` | No actor/permission check (db-only service). Safe only if S05 exposes it on a service-role path, never to users. | reported-not-fixed: contractual note for S05, nothing to test here
low | `lib/gateway/core/integrations/connector.mjs` + agent | `x-forwarded-port` reports the backend port; `Connection`-listed headers are forwarded despite naming hop-by-hop headers (RFC 7230 completeness nits). No AWS-parity impact found. | reported-not-fixed: nits, correctly left alone

## Verified clean (no defect found)

- **SigV4 signer**: the `iam ListUsers` vector was re-derived with an independent
  `node:crypto` HMAC chain — `b2e4af44cfad96d9ffa3c5653674a927b9b0995c33de22e1f843745ce37c1d5e`,
  byte-identical to the module and to the AWS documentation value.
- **RLS** (`20261007000001_integrations.sql`): all tables have read policies plus
  `FOR ALL ... USING + WITH CHECK` write policies; no `SECURITY DEFINER`
  functions in this migration (nothing to set `search_path` on); token hashes
  are insert/select-restricted by design with the service-role path in
  `supabase-db.mjs` (`getConnectorTokenByHash` filters `revoked_at`), and the
  service layer re-checks `pods.connector.write` — revoked-token bypass was
  specifically tested and does not exist.
- **Secrets**: no plaintext in artifacts (refs only), audit `redact()` covers
  credential-shaped keys including an explicit `__proto__` guard, token
  show-once/prefix/metadata verified by test, UI never fetches secret values
  (free-text `secret:<id>` ref + token-once panel).
- **Contract stability**: exported names/signatures used by later specs
  (`invoke`, `mapInvocationError`, `renderIntegrationUri`,
  `maybeAppendDefaultPath`, `buildRestEvent`/`buildHttpEvent`,
  `parseProxyResponse10/20`, `selectCustomResponse`, `signWebhookBody`,
  `AWS_SUBTYPES`, `createHub`/`acceptAgentSocket`, control services, route
  shapes) are unchanged; `capabilities.mjs` S04 block matches the spec's
  protocol matrix. (`maybeAppendDefaultPath` gained one optional opt,
  `uriTemplate`; all existing callers behave as before when it is absent.)
- **Security review with nothing significant**: authorization bypass (besides
  the fixed `secret.use` gap — RLS and route-level + service-level permission
  checks are otherwise consistent), injection (no SQL/template injection
  surface in S04 files; VTL is S06), fail-open paths (KV-down behavior is
  S01-owned and untouched).

## Test evidence (final, after fixes)

- `node --test "tests/s04/*.test.mjs"` → **51 tests, 50 pass, 0 fail, 1 skipped**
  (the skip is the pre-existing `[db]` RLS placeholder requiring
  `PODS_TEST_DB_URL`; live-DB proof is still missing, as the S04 report honestly states).
- `node --test tests/*.test.mjs` → **16 pass, 0 fail**.
- `npx eslint` over all 14 changed/added files → clean.
- `node --check` over all changed non-JSX sources → clean.
- `npm run build` / `next dev` / db commands not run per instructions; UI changes
  are two small validation conditions verified by lint only.
