# S11 — Custom domains, TLS, mTLS, routing rules, endpoint types, private APIs, WAF

**Wave 5 · Depends on: S05, S07 (S04 connectors for private APIs) · Independent parts. Assign A–D to different agents if needed. Part A comes first, and B/D need A's TLS server.**

AWS references: [custom domains (REST)](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-custom-domains.html), [HTTP custom domains](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-custom-domain-names.html), [API mappings / multi-level base paths](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-mappings.html), [routing rules](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-routing-rules.html), [security policies](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-security-policies.html), [wildcard custom domains](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-custom-domain-names.html), [REST mTLS](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-mutual-tls.html), [endpoint types](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-endpoint-types.html), [private APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-private-apis.html), [private custom domains](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-private-custom-domains.html), [disable default endpoint](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-disable-default-endpoint.html), [AWS WAF with API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-control-access-aws-waf.html), [WAF rule statements](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statements-list.html).

## Part A — Custom domains, certificates, API mappings, routing rules (P0 except routing rules P2)

### A1. Data model (`supabase/migrations/domains/`)
- `pods.domain_names`: `domain_name` (lowercase FQDN, or wildcard `*.example.com`; globally unique among non-deleted rows across **all** projects), `endpoint_type` (`REGIONAL`/`EDGE`/`PRIVATE`), `ip_address_type` (`ipv4`/`dualstack`), `security_policy` (§A3), `certificate_mode` (`managed`/`imported`), `certificate_ref` (vault `client_certificate` kind holding cert chain + key), `certificate_expires_at`, `verification_token`, `status` (`PENDING_VERIFICATION` → `PENDING_CERTIFICATE` → `AVAILABLE`; `UPDATING`; `FAILED` + `status_message`), `target_hostname` (e.g. `d-7h3k2m.gw.geigerpods.app`, analogous to AWS's regional domain name), `routing_mode` (`API_MAPPING_ONLY` default / `ROUTING_RULE_THEN_API_MAPPING` / `ROUTING_RULE_ONLY`), `mtls` jsonb (Part B), `tags`.
- `pods.api_mappings`: `domain_id`, `api_id`, `stage_name`, `base_path` (`''` = none; segments `[A-Za-z0-9$\-_.+!*'()]`, multi-level `a/b/c`, no leading/trailing `/`). Unique `(domain_id, base_path)`. ≤ 200 multi-level mappings per domain.
- `pods.routing_rules`: `domain_id`, `priority int` (1–1,000,000, unique per domain), `conditions jsonb` (`{ matchHeaders: [{header, valueGlob}] (≤2, AND), matchBasePaths: [basePath] (≤1) }`), `action jsonb` (`{ invokeApi: { apiId, stage, stripBasePath } }`). ≤ 50 per domain.
- **RLS:** `pods.domain.write` for all three.

### A2. Ownership verification and certificates
1. Create domain → generate `verification_token` and show two DNS records: `TXT _pods-challenge.{domain} = {token}` and `CNAME {domain} → {target_hostname}` (for an apex, use ALIAS/ANAME, or A/AAAA to the published runtime IPs).
2. A verifier job (every minute while pending, max 72 h) resolves the TXT record over DNS-over-HTTPS (a fixed resolver, not the system one) and moves the domain to `PENDING_CERTIFICATE`.
3. **Managed certificates**: ACME (Let's Encrypt; directory URL env `PODS_ACME_DIRECTORY`). HTTP-01 is served by the runtime at `/.well-known/acme-challenge/*` on that host. Wildcards need DNS-01 and therefore **imported** certificates, unless a DNS provider adapter is configured. Renew at 30 days before expiry, retrying daily, and alarm (S10) when 14 days are left.
4. **Imported certificates**: PEM chain + key, validated (key matches cert, covers the domain or wildcard, not expired, chain completes to a public root).
5. An unverified domain **never** routes. A request for an unknown host → TLS default certificate + 403 `{"message":"Forbidden"}`.

### A3. TLS security policies
Pods profiles map to Node `tls.createSecureContext` options:
| Profile | AWS analogue | minVersion | Ciphers/groups |
|---|---|---|---|
| `TLS_1_2` (default) | `TLS_1_2` | TLSv1.2 | ECDHE-AES-GCM / CHACHA20 only |
| `TLS13_1_2_STRICT` | `SecurityPolicy_TLS13_1_2_2021_06` | TLSv1.2 | TLS1.3 suites + ECDHE-GCM |
| `TLS13_ONLY` | `SecurityPolicy_TLS13_1_3_2025_09` | TLSv1.3 | TLS1.3 suites |
| `TLS13_1_2_PQ` | `SecurityPolicy_TLS13_1_2_PQ_2025_09` | TLSv1.2 | adds `X25519MLKEM768` group **if** the runtime's OpenSSL supports it (feature-detected at boot; otherwise the profile is hidden) |
FIPS variants are out of scope; the UI says so. TLS 1.0 is not offered.

### A4. Runtime host resolution (`edge/host-resolve.mjs`, called by S05 loader)
1. Exact domain match, else wildcard match on the parent label (one level). `$context.domainName`; `domainPrefix` = first label.
2. `ROUTING_RULE_*` modes: evaluate rules by ascending priority. A rule matches when **all** conditions hold:
   - header name case-insensitive; value glob case-sensitive; only `*x`, `x*`, `*x*` or exact;
   - base path condition matches a path prefix at segment boundaries, case-sensitive.
   The first match invokes its API stage, stripping the base path if configured, and sets `$context.customDomain.routingRuleIdMatched`. With `ROUTING_RULE_THEN_API_MAPPING`, no rule match falls back to mappings. With `ROUTING_RULE_ONLY`, no match → 404 `{"message":"Not Found"}`.
   - Restricted condition headers (rejected at save): `access-control-*`, `apigw-*`, `authorization`, `connection`, `content-encoding`, `content-length`, `content-location`, `forwarded`, `keep-alive`, `origin`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailers`, `transfer-encoding`, `upgrade`, `x-amz-*`, `x-amzn-*`, `x-pods-*`, `x-forwarded-*`, `via`. Header name < 40 chars, glob value < 128, infix glob < 40 (AWS).
3. API mappings: the **longest** matching base path at segment boundaries wins, else the `''` mapping, else 403 `Forbidden`. The base path is stripped before stage-less routing: the mapped stage is fixed, so the stage segment is **not** expected in the path. `$context.customDomain.basePathMatched`.
4. Results are cached per host for 5 s and invalidated on `pods:domain-changed`.

## Part B — Mutual TLS (REST + HTTP, P1)

- `domain_names.mtls = { truststoreUri: "pods://truststores/{id}", truststoreVersion }`. `pods.trust_stores`: `name`, `pem_bundle text` (≤ 1000 certs, ≤ 1 MB, public data), `version int`, `warnings jsonb` (expired/expiring certs, AWS-style warnings), `crl_pem text null` (Pods extension).
- Requirement (AWS): mTLS requires the API's **default endpoint to be disabled** (Part C). Saving mTLS on a domain whose mapped APIs have the default endpoint enabled is allowed, but a warning is shown and the compile step warns.
- Runtime: the TLS server uses `SNICallback` to choose a per-domain secure context with `requestCert: true` and `rejectUnauthorized: false`. Verify in code: a cert is present, the chain builds to the truststore, it is within validity, and (if CRL is set) it is not revoked. On failure, complete the handshake and return HTTP 403 `{"message":"Forbidden"}` with execution-log reason `Access denied. Reason: Client cert …` (no request reaches the pipeline beyond phase 3).
- Context: `$context.identity.clientCert.{clientCertPem, subjectDN, issuerDN, serialNumber, validity.notBefore, validity.notAfter}`, also in function events (S04) and authorizer inputs (S07), so authorizers can implement revocation, as AWS recommends.

## Part C — Endpoint types, default endpoint, dual-stack, private APIs

- **Disable default endpoint** (`apis.disable_default_endpoint`): requests arriving on `{apiPublicId}.{PODS_GATEWAY_DOMAIN}` (or path routing) → 403 `{"message":"Forbidden"}`. It takes effect on the next deployment (AWS parity).
- **REGIONAL**: served by the runtime region(s) listed in `PODS_REGION`.
- **EDGE** (REST, P2): the API is fronted by Pods' global edge layer (multi-region runtime behind anycast or a CDN). Config surface now: `endpoint_type = EDGE`, which changes the stream idle timeout to 30 s (S09) and adds a `Via` header. Infra requirements go in `docs/ops/edge.md`. Acceptance at this stage is config-level only; production validation is S15.
- **Dual-stack**: `ip_address_type = dualstack` publishes AAAA records for the target and requires the runtime to bind `::`. Resource-policy IPv6 conditions work (S07). An `ipv4` API rejects requests whose source is IPv6 with 403 (AWS behavior for IPv4-only endpoints with dual-stack domains).
- **PRIVATE APIs** (REST): reachable only through a Pods Connector running in **ingress** mode (`connector/agent.mjs --ingress 0.0.0.0:8443`). The agent accepts local clients and tunnels their requests to the runtime (S04 protocol, frame `ingress-open`), tagged with the connector id. The runtime sets `aws:SourceVpce` = connector id and `aws:SourceVpc` = connector network label.
  - A private API **must** have a resource policy that allows some `aws:SourceVpce`/`aws:SourceVpc`. Compile error otherwise ("Private REST API doesn't have a resource policy attached to it", AWS message).
  - A request for a private API not arriving through ingress → 403 `Forbidden`.
  - Private API invoke host inside the network: `{apiPublicId}-{connectorPublicId}.connector.local` (agent-served name), or a private custom domain.
- **Private custom domains** (P2): `domain_names.endpoint_type = PRIVATE` with `pods.domain_access_associations (domain_id, connector_id)`, plus a domain-level resource policy (`domain_names.policy` jsonb, S07 grammar). They are reachable only through associated connectors. Routing rules and mappings may target only private APIs (no mixing; AWS restriction).

## Part D — WAF (REST, P1)

### D1. Data model
- `pods.ip_sets`: `name`, `ip_version` (`IPV4`/`IPV6`), `addresses cidr[]` (≤ 10 000).
- `pods.regex_sets`: `name`, `patterns text[]` (RE2-safe subset; reject backreferences and lookaround to avoid ReDoS; evaluated with a linear-time engine or `re2` npm if installable, else bounded-length input).
- `pods.web_acls`: `name`, `default_action` (`ALLOW`/`BLOCK`), `rules jsonb` (ordered list), `custom_responses jsonb`, `visibility` (`sampled_requests: bool`, `metrics: bool`), `version`.
- `pods.web_acl_associations`: `web_acl_id`, `api_id`, `stage_name`. One ACL per stage.
- **RLS:** `pods.waf.write`.

### D2. Rule model (subset of AWS WAF, same names)
Rule: `{ name, priority, action: ALLOW|BLOCK|COUNT, statement, ruleLabels?, overrideAction? (for groups: NONE|COUNT) }`. A BLOCK action may reference a custom response `{statusCode, headers, bodyKey}`.
Statements:
- `IPSetReferenceStatement {arn: ipSetId, forwardedIPConfig?}` (forwarded IP only from a header trusted by `features.trustedProxyHeader`).
- `GeoMatchStatement {countryCodes[]}`. The country comes from a configured trusted header (`cf-ipcountry`, `x-vercel-ip-country`, …) or a MaxMind mmdb at `PODS_GEOIP_DB`. If neither is available, the statement cannot be saved.
- `ByteMatchStatement {fieldToMatch, positionalConstraint: EXACTLY|STARTS_WITH|ENDS_WITH|CONTAINS|CONTAINS_WORD, searchString, textTransformations[]}`.
- `RegexMatchStatement`, `RegexPatternSetReferenceStatement`.
- `SizeConstraintStatement {fieldToMatch, comparisonOperator: EQ|NE|LE|LT|GE|GT, size}`.
- `SqliMatchStatement`, `XssMatchStatement` (with `sensitivityLevel` LOW|HIGH for SQLi).
- `RateBasedStatement {limit (≥10), evaluationWindowSec: 60|120|300|600, aggregateKeyType: IP|FORWARDED_IP|CONSTANT|CUSTOM_KEYS, scopeDownStatement?}`, counted in KV sliding windows.
- `AndStatement`, `OrStatement`, `NotStatement`.
- `LabelMatchStatement` (labels added by earlier rules).
- `ManagedRuleGroupStatement {name, excludedRules[], ruleActionOverrides[]}`.
Fields: `UriPath`, `QueryString`, `SingleQueryArgument`, `AllQueryArguments`, `SingleHeader`, `Headers`, `Method`, `Body` (first 8 KB, `oversizeHandling: CONTINUE|MATCH|NO_MATCH`), `JsonBody` (match scope ALL/KEY/VALUE), `Cookies`.
Text transformations: `NONE`, `LOWERCASE`, `URL_DECODE`, `URL_DECODE_UNI`, `HTML_ENTITY_DECODE`, `COMPRESS_WHITE_SPACE`, `CMD_LINE`, `BASE64_DECODE`, `REMOVE_NULLS`, `NORMALIZE_PATH`, applied in order (≤10).

### D3. Pods managed rule groups
Versioned JSON in `lib/gateway/core/edge/waf-managed/`: `PodsCommonRuleSet` (size limits, path traversal, LFI/RFI, bad user agents, EC2-metadata SSRF strings), `PodsSQLiRuleSet`, `PodsKnownBadInputsRuleSet` (Log4j JNDI, Java deserialization, host-header localhost), `PodsAdminProtectionRuleSet` (`/admin` paths). Each rule has a stable name so it can be excluded or overridden. IP reputation lists are out of scope until a feed is chosen.

### D4. Runtime (phase 4, `edge/waf.mjs`)
Rules are evaluated in priority order. `ALLOW` and `BLOCK` are terminating; `COUNT` adds labels and continues. If nothing terminates, the default action applies. A block → 403 `WAF_FILTERED` `{"message":"Forbidden"}`, or the custom response. Set `$context.waf.{status, latency, error}`, `$context.wafResponseCode` (`WAF_ALLOW`/`WAF_BLOCK`/`WAF_FILTERED`) and `$context.webaclArn`. The SQLi/XSS detectors must pass a corpus test: OWASP CRS regression payload subset ≥ 95 % detection, with ≤ 1 % false positives on a benign corpus of real JSON/API traffic fixtures. The test files live in `tests/fixtures/waf/`.
**Sampled requests:** keep the last 3 h of up to 100 matched requests per rule per stage in KV, shown in the UI (AWS "sampled requests"). The WAF fields are also in the access log.
Budget: WAF evaluation p99 < 2 ms for the managed common rule set on a 4 KB body.

## Screens
- **Custom domains** (`/domains`): list with status, endpoint type, certificate expiry and mappings count. Create wizard: domain → DNS records to add (copy buttons) → live verification status → certificate (managed/import) → security policy. Detail tabs: *API mappings* (add mapping with API/stage/base path, longest-prefix preview tester), *Routing rules* (priority list with drag-reorder that renumbers with gaps, condition builder, routing-mode selector, host+headers+path tester), *mTLS* (truststore picker, warnings), *Access associations* (private).
- **Trust stores** (`/domains/truststores`): upload a PEM bundle, list certs with expiry, version history.
- **API settings** (S03): endpoint type, IP address type, disable default endpoint (with mTLS hint), and a private API connector + policy helper.
- **WAF** (`/waf`): web ACLs list; ACL editor (rules table with priority and action, statement builder, JSON view, managed rule group picker with per-rule overrides, custom responses); IP sets; regex sets; associations; sampled requests; metrics (allowed/blocked/counted per rule).

## Acceptance tests
- `S11A: unverified domain never routes; TXT verification moves to PENDING_CERTIFICATE (DoH mocked)`.
- `S11A: imported cert with mismatched key or wrong SAN rejected`.
- `S11A [runtime]: SNI serves the right cert per domain; TLS 1.1 rejected under TLS_1_2; TLS 1.2 rejected under TLS13_ONLY`.
- `S11A: longest base path wins (a/b over a); '' mapping fallback; no match → 403`.
- `S11A: routing rules AWS examples — header globs *a, a*, *a*, two headers AND, base path strip true/false table — all rows pass`.
- `S11A: ROUTING_RULE_THEN_API_MAPPING falls back to mappings; ROUTING_RULE_ONLY → 404 on no match; restricted header rejected`.
- `S11A: wildcard domain *.example.com routes a.example.com; domainPrefix = a`.
- `S11B [runtime]: mTLS — no cert, untrusted cert, expired cert → 403; trusted cert → 200 with clientCert context; CRL-revoked → 403`.
- `S11C: disable_default_endpoint → default host 403, custom domain 200`.
- `S11C [runtime]: private API reachable via connector ingress with allowing policy; direct request 403; private API without policy fails compile`.
- `S11D: each statement type has positive/negative tests; text transformations applied in order; COUNT continues with labels; default action applies`.
- `S11D: rate-based 10 per 60 s per IP blocks the 11th; scope-down statement limits counting`.
- `S11D: SQLi/XSS corpus thresholds met; regex sets reject catastrophic patterns`.
- `S11D: blocked request → 403 WAF_FILTERED and access-log waf fields; sampled request recorded`.
