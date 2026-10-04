# S04 — Integrations

**Wave 2 · Depends on: S01, S02 · Blocks: S05; consumed by S06, S09, S12**

AWS references: [integration types](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-integration-types.html), [HTTP proxy for REST](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-set-up-simple-proxy.html), [HTTP API HTTP proxy](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-http.html), [Lambda proxy & payload formats](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html), [REST Lambda proxy input/output](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html), [mock](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-mock-integration.html), [AWS service integrations for HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-aws-services-reference.html), [private integrations](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-private.html), [backend client certificates](https://docs.aws.amazon.com/apigateway/latest/developerguide/getting-started-client-side-ssl-authentication.html).

## 1. Integration types

| Pods `type` | AWS equivalent | Protocols | Pri |
|---|---|---|---|
| `HTTP_PROXY` | `HTTP_PROXY` | R H W | P0 |
| `HTTP` | `HTTP` (custom, uses mappings/templates) | R W | P1 |
| `MOCK` | `MOCK` | R W | P0 |
| `FUNCTION_PROXY` | `AWS_PROXY` (Lambda proxy) | R H W | P1 |
| `FUNCTION` | `AWS` with Lambda (custom) | R W | P1 |
| `AWS_SERVICE` | `AWS` (REST: any service action/path; HTTP: first-class subtypes) | R H W | P2 |

A **function** target has a `provider`:
- `aws_lambda`: `{ functionArn, qualifier? }`, invoked through the Lambda Invoke API with SigV4, using an `aws_credentials` secret.
- `webhook`: `{ url }`. Pods POSTs the Lambda-format event as JSON and expects a Lambda-format response. Requests are signed with `x-pods-signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + body)>`. This gives function semantics without AWS. Any Vercel/Cloudflare/Node function can be a target.

## 2. Data model (`supabase/migrations/integrations/`)

`pods.integrations` (`api_id`, `public_id`):
| Column | Notes |
|---|---|
| `type` | §1 |
| `integration_method` | HTTP method sent to backend (`ANY` = pass through client method, proxy only) |
| `uri` | URL template. May contain `{param}` (method/route path param, e.g. `https://b.example.com/{proxy}`), `${stageVariables.name}` and `${request.path.x}` |
| `function` | jsonb `{provider, functionArn|url, qualifier}` |
| `aws` | jsonb `{service, region, action|path, subtype, roleSecretRef}` |
| `connection_type` | `INTERNET` / `CONNECTOR` |
| `connector_id` | null unless CONNECTOR |
| `timeout_ms` | 50–29000 (REST/WS default 29000), HTTP default 30000 max 30000. Project setting `max_integration_timeout_ms` may raise REST up to 300000 (AWS allows increases) |
| `payload_format_version` | `1.0` / `2.0` (FUNCTION_PROXY on HTTP APIs; REST always 1.0) |
| `passthrough_behavior` | `WHEN_NO_MATCH` (default) / `WHEN_NO_TEMPLATES` / `NEVER` (S06) |
| `content_handling` | null / `CONVERT_TO_TEXT` / `CONVERT_TO_BINARY` (S06) |
| `request_parameters` | jsonb (S06) |
| `request_templates` | jsonb content-type → template (S06) |
| `response_parameters` | jsonb (HTTP API status → mapping, S06) |
| `cache_key_parameters`, `cache_namespace` | S09 |
| `response_transfer_mode` | `BUFFERED` / `STREAM` (S09) |
| `tls` | jsonb `{ insecureSkipVerification: false, serverNameToVerify: null }` |
| `backend_auth` | jsonb, Pods vault injection, §5 |
| `description` | |

`pods.integration_responses` (REST/WS, S06 owns semantics): `integration_id`, `status_code`, `selection_pattern` (regex), `response_parameters`, `response_templates`, `content_handling`.

`pods.connectors`: `name`, `status` (`PENDING`/`AVAILABLE`/`DEGRADED`/`FAILED`/`DELETING`), `status_message`, `allowed_targets text[]` (host:port or CIDR:port), `last_seen_at`, `agent_count`. `pods.connector_tokens`: `connector_id`, `token_hash` (sha256), `prefix`, `created_at`, `revoked_at`.

`pods.client_certificates` (REST backend auth): `public_id`, `description`, `certificate_pem` (public), `private_key_ref` (vault secret), `expires_at` (created + 365 d), `created_at`.

**RLS:** integrations and integration_responses require `pods.integration.write` (API-scoped). Connectors and tokens require `pods.connector.write`. Client certificates require `pods.client_cert.write`.

## 3. Adapter contract (`lib/gateway/core/integrations/`)

```js
/** @returns {Promise<{status:number, headers:Headers, body:ReadableStream|Uint8Array|null,
 *   latencyMs:number, error?:{kind:'timeout'|'network'|'tls'|'protocol'|'function', message:string}}>} */
export async function invoke(ctx, integration, outbound, ports)
// outbound = { method, url, headers: Headers, body: Uint8Array|ReadableStream|null }  (built by S06 integrationRequest)
```

`index.mjs` dispatches on `type`. Every adapter must:
1. Apply `timeout_ms` with `AbortController`, and abort when the client disconnects (`ctx.signal`).
2. Record `ctx.integration.{status, latency, error, requestId}` for `$context`.
3. Never follow redirects. 3xx is returned to the client as-is (AWS parity).
4. Enforce the buffered response limit of 10 MB, unless streaming (S09).

### 3.1 HTTP / HTTP_PROXY (`http.mjs`)
- URI rendering: substitute `{name}` from path params (greedy keeps `/`), then `${stageVariables.x}`. Values are percent-encoded per segment, except greedy params, which keep their slashes. Rendering a URL with an empty host or a non-http(s) scheme → `API_CONFIGURATION_ERROR`.
- **HTTP API**: for the `$default` route, or an `ANY /{proxy+}` route whose URI has no `{proxy}`, append the full request path (without stage) to the URI path, as AWS does for `$default`. Pass the query string through.
- **REST HTTP_PROXY**: pass the method (unless `integration_method` is fixed), all headers except hop-by-hop, the query string and the raw body.
- Outbound headers: strip hop-by-hop (`connection`, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `proxy-authorization`, `proxy-authenticate`) and any inbound `x-pods-*`. Set `host` to the backend host. Append to `x-forwarded-for`. Set `x-forwarded-proto`, `x-forwarded-port`, and `forwarded` (HTTP APIs add `Forwarded`). Propagate `traceparent` (S10).
- Response: pass status, headers and body. Strip hop-by-hop. If an upstream header collides with a gateway-reserved header (`x-pods-request-id`, `date`, `server`), rename it to `x-pods-remapped-<name>`. AWS does the same with `x-amzn-Remapped-*`.
- **SSRF guard** (`INTERNET` only): resolve DNS with a custom `lookup` at connect time (an undici `Agent` with `connect.lookup`). Reject loopback, RFC1918, link-local (incl. `169.254.169.254`), CGNAT `100.64/10`, `0.0.0.0/8`, ULA `fc00::/7`, `fe80::/10`, IPv4-mapped forms and the gateway's own hosts. Allowed schemes are `http`/`https`; ports are any. The check runs on every connection, which prevents DNS rebinding. Private targets require a connector.
- TLS: verify by default. `insecureSkipVerification` disables chain validation only. `serverNameToVerify` overrides SNI and hostname check. Present the stage's client certificate (§6) when configured.

### 3.2 MOCK (`mock.mjs`)
No network. The status comes from the rendered request template's JSON `statusCode` (default 200), then integration responses (S06) produce the body and headers. With no template → 200 and an empty body.

### 3.3 FUNCTION_PROXY (`function.mjs`)
- Build the event. **REST** = format 1.0 with `resource`, `path`, `httpMethod`, `headers`, `multiValueHeaders`, `queryStringParameters`, `multiValueQueryStringParameters`, `pathParameters`, `stageVariables`, `requestContext` (resourceId, resourcePath, identity incl. clientCert, authorizer, requestTime…), `body`, `isBase64Encoded`. **HTTP** = 1.0 or 2.0 exactly as the AWS payload-format reference shows (2.0: `version`, `routeKey`, `rawPath`, `rawQueryString`, `cookies`, comma-joined `headers`/`queryStringParameters`, `requestContext.http`, `requestContext.authentication.clientCert`, `requestContext.authorizer.{jwt|lambda|iam}`, `time`, `timeEpoch`). Header names are lowercased in 2.0. Bodies are base64-encoded when the content type is binary (S06) or not valid UTF‑8.
- Parse the response:
  - 1.0: `{statusCode, headers, multiValueHeaders, body, isBase64Encoded}`. Missing `statusCode` or invalid JSON → REST 502 `{"message":"Internal server error"}`, HTTP 500 `{"message":"Internal Server Error"}`.
  - 2.0: if the output is valid JSON without `statusCode`, infer `{statusCode:200, content-type: application/json, body: JSON.stringify(output)}`. A string output becomes the body. `cookies[]` → separate `set-cookie` headers.
- `aws_lambda`: on `X-Amz-Function-Error`, treat as a function error. Proxy → 502 (REST), 500 (HTTP).
- `webhook`: a non-2xx HTTP status from the webhook host is a function error.

### 3.4 FUNCTION (custom, non-proxy)
The request body is the rendered template output (S06), or a passthrough. On success, the function's JSON result is the integration response body, with status selected by integration responses. On function error, the error payload `{errorMessage, errorType, stackTrace}` is matched: `selection_pattern` regexes are tested against `errorMessage` (AWS semantics). With no match, the default integration response is used.

### 3.5 AWS_SERVICE (`aws.mjs`, P2)
- REST: `aws = {service, region, action}` → `POST https://{service}.{region}.amazonaws.com/` with `Action=…` query/form, or `{path}` → path-style. Signed with SigV4 (`lib/gateway/core/auth/sigv4.mjs` signer, shared with S07) using the secret's credentials.
- HTTP API first-class subtypes: `SQS-SendMessage`, `SQS-ReceiveMessage`, `SQS-DeleteMessage`, `SQS-PurgeQueue`, `EventBridge-PutEvents`, `Kinesis-PutRecord`, `StepFunctions-StartExecution`, `StepFunctions-StartSyncExecution`, `StepFunctions-StopExecution`, `AppConfig-GetConfiguration`. Each has a parameter table (required/optional) copied from the AWS reference. Request parameters map `$request.*` → subtype params (S06 mapping syntax).

### 3.6 Error mapping (gateway responses, S01 §5)

| Condition | REST | HTTP | WS |
|---|---|---|---|
| Timeout | 504 `INTEGRATION_TIMEOUT` "Endpoint request timed out" | 503 `{"message":"Service Unavailable"}` | error frame (S12) |
| Network/TLS failure | 504 `INTEGRATION_FAILURE` | 500 `{"message":"Internal Server Error"}` | |
| Malformed function-proxy response / function error (proxy) | 502 `DEFAULT_5XX` "Internal server error" | 500 | |
| Template/URI configuration error | 500 `API_CONFIGURATION_ERROR` | 500 | |
| Buffered response > 10 MB | 502 `DEFAULT_5XX` | 500 | |

## 4. Private integrations: Pods Connector (VPC link equivalent)

AWS uses VPC links to reach NLB/ALB/Cloud Map targets inside a VPC. Pods uses an **outbound agent**:
- `connector/` (new package dir): `node connector/agent.mjs --url wss://<gateway>/_connector --token pods_ctr_…`. The agent dials **out** to the gateway runtime, so no inbound firewall rules are needed. It authenticates with its connector token, and the gateway compares the token hash.
- Tunnel protocol: one WebSocket per agent. Frames are JSON control frames (`hello`, `ping`, `open{streamId, method, url, headers}`, `close{streamId,status}`, `error`) plus binary data frames prefixed with a 4-byte streamId. Per-stream credit-based flow control uses a 256 KB window. Specify this in `connector/PROTOCOL.md`.
- The agent enforces `allowed_targets` locally, as well as the gateway checking it. It resolves DNS inside the private network, which covers Cloud Map / internal DNS. Multiple agents per connector: the gateway round-robins and marks agents dead after 3 missed 10 s pings. Connector status: `AVAILABLE` if ≥1 agent is healthy, `DEGRADED` if some agents are lost, `FAILED` if none have been seen for 5 min.
- Integration `uri` is the private URL (e.g. `http://orders.internal:8080/{proxy}`). The SSRF guard is skipped; the allow-list applies instead.
- Token lifecycle: create (shown once, `pods_ctr_` + 32 random bytes base62), revoke, rotate. Up to 5 active tokens per connector.

## 5. Backend credential injection (Pods vault extension, P0)

`backend_auth` = `{ type, secretRef, headerName?, awsService?, awsRegion? }`, where type is one of:
- `header`: secret `{name, value}` → sets header.
- `bearer`: `Authorization: Bearer <token>`.
- `basic_auth`: `Authorization: Basic …`.
- `query`: secret value added to query param `headerName`.
- `oauth_client_credentials`: fetch a token from `tokenUrl` and cache it in KV until `expires_in - 60s`. A 401 from the backend triggers one refresh and one retry.
- `aws_sigv4`: sign the outbound request for `awsService`/`awsRegion`.
- `client_certificate`: mTLS to backend with a vault certificate.

Secrets are resolved through `ports.secrets` at invoke time and cached in-process for ≤ 60 s. They never enter `$context`, logs, traces or test-invoke output; the value is masked as `****`. Client-supplied headers with the same name are **overwritten**, never merged. That is the core "hide your upstream key" guarantee.

## 6. Backend client certificates (REST)

Generate an RSA-2048 self-signed or Pods-CA-signed certificate (AWS generates one per request). Store the PEM publicly and the private key in the vault. A stage selects `client_certificate_id` (S05), and HTTP integrations present it to backends. The UI shows the PEM for download, so backends can trust it, plus the expiry date. Rotation: create a new certificate, switch the stage, delete the old one.

## 7. Screens

- **Integrations tab** (API detail): list and editor per type. The URI field supports path params and stage-variable tokens with live validation. Timeout slider (50 ms–max). Connection-type selector with a connector picker. TLS options. Backend-auth picker that lists only secrets of compatible kinds (requires `pods.secret.use`). Attach to routes/methods.
- **Connectors** (`/connectors`): list with status dot, agents online, last seen. Create flow shows the token once plus a copy-paste `docker run`/`node` command. Detail page: agents, allowed targets, tokens (rotate/revoke).
- **Client certificates** (`/apis/settings` or `/security/client-certs`): generate, view PEM, expiry, delete.

## 8. Shared test fixture

`tests/fixtures/upstream.mjs`: a `node:http` server that echoes method, path, query, headers and body as JSON. It has `/status/{code}`, `/sleep/{ms}`, `/bytes/{n}`, `/stream/{chunks}` (chunked, for S09), `/redirect` and `/large/{mb}`, plus a Lambda-format webhook endpoint `/fn` whose behavior is controlled by headers. Every runtime spec reuses it.

## Acceptance tests

- `S04: HTTP_PROXY forwards method/path/query/body/headers; strips hop-by-hop and x-pods-*; sets X-Forwarded-For`.
- `S04: {proxy} greedy substitution preserves slashes; {id} is percent-encoded`.
- `S04: HTTP API $default route appends full path to integration URI`.
- `S04: 3xx from backend is returned, not followed`.
- `S04: timeout → REST 504 INTEGRATION_TIMEOUT, HTTP 503; client abort cancels upstream request` (verify the upstream saw the socket close).
- `S04: SSRF guard blocks 127.0.0.1, 10.0.0.1, 169.254.169.254, [::1], and a hostname that resolves to 127.0.0.1`.
- `S04: payload 2.0 event matches AWS reference shape (snapshot) and 1.0 event matches REST reference shape`.
- `S04: 2.0 response inference: string → 200 json body; object without statusCode → 200 JSON; cookies → set-cookie headers`.
- `S04: malformed function response → REST 502 / HTTP 500`.
- `S04: webhook function requests carry a valid x-pods-signature`.
- `S04: FUNCTION custom error selects integration response by errorMessage regex`.
- `S04: MOCK returns statusCode from rendered template`.
- `S04: backend_auth header overwrites client-supplied header; secret value never appears in ctx, logs or error bodies`.
- `S04: oauth client-credentials token cached and refreshed once on 401`.
- `S04: connector tunnel round-trips a request to a private echo server; disallowed target rejected by agent and gateway; agent loss → DEGRADED/FAILED`.
- `S04: buffered upstream body > 10 MB → REST 502`.
- `S04: client certificate is presented to an mTLS backend` (local https server that requires a client cert).
