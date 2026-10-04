# S06 — Request & response processing

**Pure modules: wave 2 (after S01). Runtime wiring: wave 3 (after S05) · Depends on: S03, S04 · Blocks: S09, S12, S13**

Covers CORS, parameter mapping (HTTP and REST), models, request validation, mapping templates (a VTL-compatible language), passthrough behavior, integration and method responses, binary media and content handling, compression, and custom gateway responses.

AWS references: [HTTP CORS](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-cors.html), [REST CORS](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-cors.html), [HTTP parameter mapping](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-parameter-mapping.html), [REST data transformations](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-data-transformations.html), [mapping template reference / `$input` `$util`](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-mapping-template-reference.html), [request validation](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-method-request-validation.html), [models](https://docs.aws.amazon.com/apigateway/latest/developerguide/models-mappings-models.html), [override params with templates](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-override-request-response-parameters.html), [binary support](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-payload-encodings.html), [compression](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-gzip-compression-decompression.html), [gateway responses](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-gatewayResponse-definition.html).

## 1. Data model (`supabase/migrations/processing/`)

- `pods.models`: `api_id`, `name` (`^[A-Za-z0-9]{1,128}$`, unique per API), `content_type` (default `application/json`), `schema jsonb`, `description`. The sum of schema sizes per API is ≤ 400 KB (AWS).
- `pods.request_validators`: `api_id`, `name`, `validate_request_body bool`, `validate_request_parameters bool`.
- `pods.method_responses`: `method_id`, `status_code` (`^[1-5]\d\d$`), `response_parameters jsonb` (`{"method.response.header.X-Req": true}` = required), `response_models jsonb` (content type → model id).
- `pods.gateway_responses`: `api_id`, `response_type` (S01 catalog), `status_code null`, `response_parameters jsonb`, `response_templates jsonb`. Unique `(api_id, response_type)`.
- Integration fields (`request_parameters`, `request_templates`, `passthrough_behavior`, `content_handling`, `response_parameters`) and `integration_responses` were created by S04. This spec defines their semantics.

**RLS:** models and request validators require `pods.model.write`; method responses require `pods.route.write`; gateway responses require `pods.gateway_response.write` (all API-scoped).

## 2. CORS (`processing/cors.mjs`)

**HTTP API — managed CORS** (`apis.cors`): `{ allowOrigins[], allowMethods[], allowHeaders[], exposeHeaders[], maxAge (0–86400), allowCredentials }`.
- With CORS configured, the gateway answers every preflight (an `OPTIONS` request with `Origin` and `Access-Control-Request-Method`) itself. It returns 204 with the configured headers, does **not** invoke an authorizer or integration, and does not require an OPTIONS route (pipeline phase 6). A non-preflight `OPTIONS` goes through normal routing.
- On actual responses, it adds `Access-Control-Allow-Origin` (the echoed origin when listed, or `*`), `Access-Control-Expose-Headers` and `Access-Control-Allow-Credentials`, and `Vary: Origin` when echoing. CORS headers returned by the backend are **replaced** by the configured ones (AWS: the API's CORS configuration takes precedence).
- Validation: `allowCredentials: true` with `*` in allowOrigins → 400 (AWS rejects it). Origins match exactly (scheme+host+port). `*` matches any. Pods extension: `https://*.example.com` subdomain wildcards, off unless `features.corsWildcardSubdomains`.
- A disallowed origin → no CORS headers. The request itself still proceeds, since browsers enforce CORS.

**REST — "Enable CORS" action** (control-plane helper, not runtime magic, as in AWS): for a selected resource it (a) creates an `OPTIONS` method with a MOCK integration returning 200 and the `Access-Control-Allow-{Origin,Methods,Headers}` response parameters, (b) adds `method.response.header.Access-Control-Allow-Origin` to selected methods' 200 responses and mappings, (c) optionally adds the same header to the `DEFAULT_4XX`/`DEFAULT_5XX` gateway responses. The user can edit everything afterwards.

## 3. Parameter mapping (`processing/param-mapping.mjs`)

### HTTP APIs (exactly the AWS grammar)
- Request keys: `append|overwrite|remove:header.<name>`, `append|overwrite|remove:querystring.<name>`, `overwrite:path`.
- Response keys (per backend status code, `integration.response_parameters`): `append|overwrite|remove:header.<name>`, `overwrite:statuscode`.
- Values: `$request.header.<n>`, `$request.querystring.<n>`, `$request.body.<jsonpath>` (body truncated to 100 KB before evaluation), `$request.path`, `$request.path.<n>`, `$response.header.<n>`, `$response.body.<jsonpath>`, `$context.<v>`, `$stageVariables.<v>`, and static strings. `${…}` interpolation allows mixing, e.g. `"${request.path.name} ${request.path.id}"`. Multi-valued headers and query params are joined with commas.
- Reserved headers that cannot be mapped (config error at compile): `access-control-*`, `apigw-*`, `authorization`, `connection`, `content-encoding`, `content-length`, `content-location`, `forwarded`, `keep-alive`, `origin`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailers`, `transfer-encoding`, `upgrade`, `x-amz-*`, `x-amzn-*`, `x-pods-*`, `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-proto`, `via`.
- Operation order: remove → overwrite → append, applied after S04 builds the default outbound request.

### REST APIs
- Integration request: `integration.request.{header|querystring|path}.<name>` = `method.request.{header|querystring|path|multivalueheader|multivaluequerystring}.<name>` | `method.request.body` | `method.request.body.<JSONPath>` | `'static'` | `context.<v>` | `stageVariables.<v>`.
- Method response: `method.response.header.<name>` = `integration.response.header.<name>` | `integration.response.multivalueheader.<name>` | `integration.response.body` | `integration.response.body.<JSONPath>` | `'static'` | `context.<v>` | `stageVariables.<v>`. The header must be declared in `method_responses.response_parameters`, otherwise compile error.
- Path params referenced in the integration URI (`{id}`) default to `method.request.path.id` when unmapped (AWS console behavior for proxy resources).

## 4. Models & request validation (`processing/validation.mjs`)

- Schemas are JSON Schema **draft-04** (AWS) via `ajv` + `ajv-draft-04`. Add those dependencies with pinned versions, and compile at deploy (S05), caching validators per deployment. `$ref` between models uses `https://pods.geiger/apis/{apiPublicId}/models/{name}`. OpenAPI import (S13) rewrites AWS's `https://apigateway.amazonaws.com/restapis/{id}/models/{name}` to this form.
- Validator on a method (or the API default validator):
  - Parameters: each required `method.request.{header,querystring,path}.<n>` must be present and non-empty → otherwise 400 `BAD_REQUEST_PARAMETERS`, message `Missing required request parameters: [a, b]`.
  - Body: pick the model by request Content-Type (lowercased, params stripped). Fall back to the `$default` key. With no model, the body is not validated. If the content type is JSON and the JSON is invalid, or schema validation fails → 400 `BAD_REQUEST_BODY`, message `Invalid request body`, with `$context.error.validationErrorString` set to AWS-style text: `[object has missing required properties (["name"])]`.
- WebSocket uses `model_selection_expression` and route `request_models` (S12).

## 5. Mapping templates (`processing/templates/`)

A sandboxed **Velocity-compatible** interpreter. It parses at deploy and evaluates per request, without `eval` or `Function`. Imported AWS templates should run unchanged.

**Grammar subset (must support):**
- Text with references `$a`, `${a}`, quiet `$!a`, property chains `$a.b.c`, index `$a[0]`, `$a['k']`, method calls `$a.m(x, y)`.
- Directives: `#set($x = expr)`, `#if/#elseif/#else/#end`, `#foreach($i in $list) … #end` with `$foreach.index`, `$foreach.count`, `$foreach.hasNext`, `$velocityCount`, `$velocityHasNext`; `#break`, `#stop`; comments `## …` and `#* … *#`; escapes `\$`, `\#`.
- Expressions: string (`"…"` interpolating, `'…'` literal), number, boolean, `null`, list `[…]`, map `{"k": v}`, range `[1..5]`, operators `== != < > <= >= && || ! and or not + - * / %`.
- Java-ish methods on values: strings `length() isEmpty() contains() startsWith() endsWith() indexOf() substring() replace() replaceAll() split() toLowerCase() toUpperCase() trim() equals() equalsIgnoreCase() matches()`; lists `size() isEmpty() get() add() contains()`; maps `get() put() keySet() entrySet() containsKey() size() isEmpty()`.

**Built-ins:**
- `$input.body` (raw string), `$input.json(path)` (JSON string of the selection), `$input.path(path)` (object of the selection), `$input.params()` (`{header, querystring, path}`), `$input.params(name)` (searches path → querystring → header).
- `$util.escapeJavaScript(s)`, `$util.parseJson(s)`, `$util.urlEncode(s)`, `$util.urlDecode(s)`, `$util.base64Encode(s)`, `$util.base64Decode(s)`.
- `$context.*` (S01 catalog) including writable overrides `$context.requestOverride.header.<n>`, `.querystring.<n>`, `.path.<n>` (request templates) and `$context.responseOverride.status`, `.header.<n>` (response templates).
- `$stageVariables.*`, `$method` is not supported (AWS doesn't support it either).

**JSONPath** (`$input.path/json`, `$request.body.*`, REST `body.<JSONPath>`): `$`, `.name`, `['name']`, `[n]`, `[-n]`, `[a:b]`, `[*]`, `..name` (templates only; HTTP mapping rejects `..` and filters as AWS does), filter `[?(@.x == 'y')]` (templates only, P2).

**Limits:** template ≤ 300 KB; `#foreach` ≤ 1000 iterations per loop (AWS); a step budget of 1e6 AST evaluations; output ≤ 10 MB. Exceeding any limit → 500 `API_CONFIGURATION_ERROR` (request) or `DEFAULT_5XX` (response).

**Selection and passthrough (request):** pick the request template by the request Content-Type (default `application/json` when absent).
- `WHEN_NO_MATCH`: no template for this type → pass the body through unchanged.
- `WHEN_NO_TEMPLATES`: no templates defined → pass through; templates defined but none match → 415 `UNSUPPORTED_MEDIA_TYPE`.
- `NEVER`: no matching template → 415.
Proxy integrations ignore templates (AWS).

## 6. Integration & method responses (REST, `processing/responses.mjs`)

1. Select an integration response. For HTTP integrations, test each `selection_pattern` regex (full match) against the backend status code string. For FUNCTION/AWS integrations, test against the function `errorMessage` (on error) or status. If nothing matches, use the **default** response (empty pattern). With no default, the result is 500 `API_CONFIGURATION_ERROR` "Internal server error". MOCK selects by the rendered request template `statusCode`.
2. The selected `status_code` must have a `method_responses` row; compile enforces this.
3. Apply response parameters (§3), then the response template chosen by the request's `Accept` header. If no template matches, use `application/json` if defined, else the first defined; with none, pass the body through. Content type: the template's key.
4. `$context.responseOverride.*` from the template overrides the status and headers last.

## 7. Binary media & content handling (`processing/content.mjs`)

- `binary_media_types` entries are a MIME type or wildcard (`image/*`, `*/*`). A request body is **binary** when its Content-Type matches.
- Request conversion via `integration.content_handling`:
  - binary body + null (passthrough) → bytes to the integration unchanged (templates see a base64 string).
  - `CONVERT_TO_TEXT` → base64-encode binary for the integration.
  - `CONVERT_TO_BINARY` → base64-decode a text body into bytes.
- Response: the integration response's `content_handling` applies the same rules. A response is returned as binary when the request's `Accept` header (first type) matches `binary_media_types` (AWS uses `Accept`). Function-proxy responses with `isBase64Encoded: true` are decoded to bytes when the `Accept`/Content-Type is binary-listed. Otherwise the base64 text is returned (AWS parity, documented gotcha).
- Byte preservation: no re-encoding of bodies on proxy integrations. Round-trip tests use random bytes, including invalid UTF‑8.

## 8. Compression (`processing/compression.mjs`)

When `minimum_compression_size` is set (0–10485760):
- Requests with `Content-Encoding: gzip|deflate` are decompressed before validation/templates (proxy integrations receive the original encoded body plus header). Unknown encodings → 415.
- Responses with a body ≥ the threshold, a client `Accept-Encoding` containing `gzip`/`deflate` (`br` is a Pods extension, off by default) and no backend `Content-Encoding` are compressed with `node:zlib`. `Vary: Accept-Encoding` is added. Never for streaming (S09) or 204/304.

## 9. Gateway response customization (`gateway-responses.mjs` extension)

For a gateway-generated error of type T: use the customization for T if present. Otherwise, if T's status is 4xx/5xx, use `DEFAULT_4XX`/`DEFAULT_5XX` customization. Otherwise use the built-in default (S01).
- `status_code` override.
- `response_parameters`: `gatewayresponse.header.<n>` = `'static'` | `method.request.header.<n>` | `method.request.querystring.<n>` | `method.request.path.<n>` | `method.request.multivalueheader.<n>` | `method.request.multivaluequerystring.<n>` | `stageVariables.<n>` | `context.<v>`.
- `response_templates`: content type → template (§5 interpreter), with `$context.error.*` available. Selected by `Accept`, default `application/json`.
- The UI lists all 21 types with their defaults and "customized" badges.

## 10. Runtime wiring (after S05)

Implement pipeline phases `cors` (6), `validate` (14), `integrationRequest` (16), `integrationResponse` (18) and `methodResponse` (19), using S01's phase registry. The compile step (S05) must parse templates, compile schemas, check mapping grammar and reserved headers, and verify method-response declarations, so that configuration errors fail at deploy rather than at request time.

## 11. Screens

- **CORS tab** (HTTP): form with origin chips, method checkboxes, headers, max age, credentials; inline validation error for `*` + credentials.
- **Enable CORS** dialog (REST resource): AWS-style options and a preview of the methods and headers to be created.
- **Method request / Integration request / Integration response / Method response** editors on the REST method panel (S03 diagram): parameter tables, validator picker, request models per content type, mapping table with autocomplete of sources, and a template editor (monospace, syntax highlighting via a lightweight tokenizer, "Generate template from model" helper, "Test template" box that evaluates against a sample body/params/context).
- **Parameter mapping** editor on HTTP integrations (request + per-status response).
- **Models tab**: list, JSON editor with schema validation, "generate from sample JSON".
- **Gateway responses tab** (REST): the 21 types, an editor for status/headers/templates, and reset to default.
- **Settings**: binary media types and compression, already placed by S03.

## Acceptance tests

- `S06: HTTP preflight answered 204 without calling authorizer or integration; backend CORS headers replaced; * + credentials rejected`.
- `S06: REST Enable CORS creates OPTIONS mock and 200 header mappings` (control-plane test).
- `S06: HTTP mapping append/overwrite/remove for header and querystring; overwrite:path; response overwrite:statuscode for 500→403`.
- `S06: reserved header mapping rejected at compile`.
- `S06: ${request.path.name} ${request.path.id} interpolation; $request.body.a.b truncation at 100 KB`.
- `S06: required query param missing → 400 BAD_REQUEST_PARAMETERS "Missing required request parameters: [page]"`.
- `S06: body failing draft-04 schema → 400 Invalid request body; validationErrorString AWS-style; $default model fallback`.
- `S06: VTL conformance suite — 40+ golden cases ported from AWS docs examples (foreach with hasNext commas, #if/else, $util.escapeJavaScript, $input.json('$.items[0]'), $input.params(), requestOverride/responseOverride)`.
- `S06: template foreach >1000 iterations → 500 API_CONFIGURATION_ERROR; parse error caught at deploy`.
- `S06: passthrough behaviors WHEN_NO_MATCH/WHEN_NO_TEMPLATES/NEVER produce passthrough/415 per table`.
- `S06: integration response selected by status regex; function errorMessage regex; default fallback; undeclared method response fails compile`.
- `S06: binary round trip of 1 MB random bytes through HTTP_PROXY and FUNCTION_PROXY with Accept image/png; CONVERT_TO_TEXT / CONVERT_TO_BINARY`.
- `S06: gzip request body decompressed for templates; response ≥ threshold compressed only with Accept-Encoding gzip; below threshold not`.
- `S06: custom THROTTLED response status/header/template; unspecified type falls back to DEFAULT_4XX customization`.
