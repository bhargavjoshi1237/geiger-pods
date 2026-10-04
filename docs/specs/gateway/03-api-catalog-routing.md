# S03 — API catalog & routing

**Wave 2 · Depends on: S01, S02 · Blocks: S05, S06, S13**

AWS references: [REST resources & methods](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-method-settings.html), [proxy resources `{proxy+}`](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-set-up-simple-proxy.html), [HTTP routes](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-routes.html), [API endpoint types](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-endpoint-types.html).

## 1. Scope

- Create, read, update, delete and clone APIs of protocol `REST`, `HTTP` or `WEBSOCKET`. WebSocket route semantics are in S12; this spec only stores WS route rows.
- REST: resource tree (`/`, literal parts, `{param}`, `{param+}`), methods per resource.
- HTTP: route keys (`GET /pets/{id}`, `ANY /{proxy+}`, `$default`).
- Pure route matchers for both models (`lib/gateway/core/match/`).
- Workspace screens for the API list, API detail, and resource/route editors.

Out of scope: integrations (S04), authorizer configuration (S07), models/validators/mappings (S06), deployments (S05).

## 2. Data model (`supabase/migrations/catalog/`)

`pods.apis`
| Column | Type | Notes |
|---|---|---|
| `public_id` | text unique | S01 `newPublicId()`; immutable |
| `name` | text | 1–128, unique per project among non-deleted |
| `description` | text | ≤ 1024 |
| `protocol` | text | `REST`/`HTTP`/`WEBSOCKET`; immutable after create |
| `api_version` | text null | free-form version label (OpenAPI `info.version`) |
| `endpoint_type` | text | `REGIONAL` (default) / `EDGE` / `PRIVATE`; EDGE/PRIVATE REST-only (S11) |
| `ip_address_type` | text | `ipv4` / `dualstack` (S11) |
| `disable_default_endpoint` | bool | default false (S11) |
| `api_key_source` | text | `HEADER` (default) / `AUTHORIZER`; REST (S08) |
| `api_key_selection_expression` | text | WS only: default `$request.header.x-api-key` |
| `binary_media_types` | text[] | REST (S06), e.g. `image/png`, `*/*` |
| `minimum_compression_size` | int null | REST 0–10485760, null = disabled (S06) |
| `route_selection_expression` | text null | WS (S12), e.g. `$request.body.action` |
| `cors` | jsonb null | HTTP managed CORS (S06) |
| `resource_policy` | jsonb null | REST (S07) |
| `missing_route_behavior` | text | REST default `aws` (403 Missing Authentication Token); `not_found` → 404 `RESOURCE_NOT_FOUND`. Pods extension, default keeps AWS parity |
| `tags` | jsonb | S14 |

`pods.rest_resources` (REST only): `api_id`, `parent_id null` (null only for root), `path_part text`, `path text` (maintained by trigger: parent path + `/` + part; root is `/`), unique `(api_id, path)`.
`path_part` rules: matches `^[A-Za-z0-9._~:@!$&'()*,;=-]+$` (literal) or `^\{[A-Za-z_][A-Za-z0-9_.-]*\+?\}$`. A greedy `{x+}` part cannot have children. Siblings may contain **at most one** variable part (AWS rule). Two variable siblings, even with different names, give 409. Literal siblings must be unique.

`pods.rest_methods`: `api_id`, `resource_id`, `http_method` (`GET POST PUT PATCH DELETE HEAD OPTIONS ANY`), unique `(resource_id, http_method)`. Columns: `authorization_type` (`NONE`/`SIGNED`/`JWT`/`CUSTOM`; JWT = AWS `COGNITO_USER_POOLS`), `authorizer_id null`, `authorization_scopes text[]`, `api_key_required bool`, `operation_name text`, `request_validator_id null` (S06), `request_parameters jsonb` (`{"method.request.querystring.page": true}` = required), `request_models jsonb` (`{"application/json": "<modelId>"}`), `integration_id null` (S04), `settings jsonb` (S08/S09/S10 per-method stage overrides live on the stage, not here).

`pods.http_routes` (HTTP and WS): `api_id`, `route_key text` (unique per API), `authorization_type` (`NONE`/`SIGNED`/`JWT`/`CUSTOM`), `authorizer_id`, `authorization_scopes text[]`, `api_key_required bool` (WS only), `integration_id null` (S04 "target"), `operation_name`, `request_parameters jsonb` (WS), `request_models jsonb` (WS), `model_selection_expression`, `route_response_selection_expression` (WS).
HTTP route key grammar: `$default` | `<METHOD> <path>`, where METHOD ∈ `GET POST PUT PATCH DELETE HEAD OPTIONS ANY` and path segments follow the REST `path_part` rules, with greedy last only. WS route keys are free strings (`$connect`, `$disconnect`, `$default`, `sendmessage`).

**RLS:** `apis` writes require `pods.api.create` (insert), `pods.api.update` (update) and `pods.api.delete` (soft delete). `rest_resources`, `rest_methods` and `http_routes` require `pods.route.write` scoped to the API.

## 3. Route matching (pure, `lib/gateway/core/match/`)

Both matchers compile once per artifact into a trie (S05 stores the compiled form or compiles on load) and return `{ routeId|methodId, resourcePath, routeKey, pathParameters }` or `null`.

### HTTP API (`http-routes.mjs`) — AWS priority rules
1. Full match on route and method (static and `{param}` segments). Among full matches, a literal segment beats a `{param}` segment at the same depth, comparing left to right.
2. Match through a greedy `{proxy+}` route. The longest literal prefix wins.
3. `$default` route.
At each level, a route with the exact method beats `ANY` for the same path. `ANY` matches only methods not explicitly defined for that path.
- The path is matched **without** the stage segment and without the API-mapping base path (S11).
- Matching is case-sensitive. Path params are URL-decoded after matching (AWS decodes parameters before passing them on). Empty segments (`//`) never match a `{param}`.
- A greedy param must capture ≥1 segment: `/pets/{proxy+}` does not match `/pets`.
- No match → 404 `{"message":"Not Found"}` (S01 §3).

The AWS example table must pass verbatim: routes `GET /pets/dog/1`, `GET /pets/dog/{id}`, `GET /pets/{proxy+}`, `ANY /{proxy+}`, `$default`. `GET /pets/dog/1` → #1; `GET /pets/dog/2` → #2; `GET /pets/cat/1` → #3; `POST /test/5` → #4.

### REST API (`rest-resources.mjs`)
- Walk the resource tree segment by segment. Literal child first. Then the single variable child. Then a greedy child, which consumes the rest. Backtrack if a deeper branch fails, so `/a/{b}/c` vs `/a/x/{d}` resolves by most-specific literal.
- Method selection on the matched resource: exact method, else `ANY`. If the resource matches but has no method → `MISSING_AUTHENTICATION_TOKEN` (403), or 404 if `missing_route_behavior = not_found`.
- One trailing slash on the request path is ignored (`/pets/` ≡ `/pets`), as in REST APIs.
- `HEAD` does **not** fall back to `GET` (AWS parity); `ANY` covers it.

## 4. Control-plane services & API

`lib/control/apis.mjs`, `lib/control/rest-resources.mjs`, `lib/control/http-routes.mjs`. Invariants are enforced in service code **and** constraints:
- Creating a REST API inserts the root resource `/`.
- Creating an HTTP API with `quickCreate: { target: "https://…" }` creates a `$default` route plus an HTTP proxy integration (S04) and a `$default` stage with auto-deploy (S05). This mirrors the AWS quick create.
- Deleting a resource deletes its descendants and methods after confirmation (`?recursive=true` required when it has children).
- `protocol` is immutable. Changing it gives 422.
- **Clone API** (`POST …/apis/{id}/clone`) deep-copies the draft (resources, methods, routes, integrations, models, validators, authorizers, gateway responses, docs) with new ids. AWS lets you create a REST API by cloning one.

| Method & path | Permission |
|---|---|
| `GET/POST /api/v1/projects/{p}/apis` | view / `pods.api.create` |
| `GET/PATCH/DELETE …/apis/{apiId}` | view / `pods.api.update` / `pods.api.delete` |
| `POST …/apis/{apiId}/clone` | `pods.api.create` |
| `GET/POST …/apis/{apiId}/resources`, `PATCH/DELETE …/resources/{rid}` | `pods.route.write` |
| `PUT/GET/PATCH/DELETE …/resources/{rid}/methods/{httpMethod}` | `pods.route.write` |
| `GET/POST …/apis/{apiId}/routes`, `GET/PATCH/DELETE …/routes/{routeId}` | `pods.route.write` |
| `POST …/apis/{apiId}/match` body `{method, path}` → which route/method matches the **draft** (debug helper used by UI "route tester") | view |

## 5. Screens

- **APIs list** (`/apis`): table (name, protocol badge, endpoint type, id, stages count, last deployed, created by). Create dialog with protocol picker cards: REST, HTTP, WebSocket, each with the AWS-style one-line summary. HTTP quick-create (backend URL) and "Import OpenAPI" (S13) entry points. Empty state explains the three API types.
- **API detail** (`/apis/{apiId}/{tab}`), tabs filtered by capability: `overview`, `resources` (REST) or `routes` (HTTP/WS), `integrations` (S04), `authorizers` (S07), `models` (S06, REST/WS), `cors` (HTTP), `gateway-responses` (REST), `deployments`/`stages` (S05), `settings`, `docs` (S13).
- **Resources tab** (REST): tree on the left, method panel on the right, with the AWS console's "Method request → Integration request → Integration → Integration response → Method response" flow diagram. Each box links to the editor owned by S06/S04/S07, and boxes for unimplemented specs show "Coming in S0x".
- **Routes tab** (HTTP): flat list grouped by path, method badges, attached integration and authorizer. A route-tester box shows which route a sample `METHOD /path` hits, using `/match`.
- **Settings tab**: name, description, version label, endpoint type, API key source, binary media types, compression, missing-route behavior, delete API (type-to-confirm).

## Acceptance tests

- `S03: AWS HTTP route priority table resolves exactly` (§3 example).
- `S03: exact method beats ANY on same path; ANY does not shadow defined methods`.
- `S03: greedy requires at least one segment; /pets/{proxy+} does not match /pets`.
- `S03: literal segment beats param segment; REST backtracks to a less specific branch when needed`.
- `S03: REST trailing slash ignored; HTTP route matching is case-sensitive`.
- `S03: path params are URL-decoded after match; encoded slash %2F stays inside one param`.
- `S03: REST missing method → 403 Missing Authentication Token; with missing_route_behavior=not_found → 404`.
- `S03: two variable siblings rejected (409); greedy resource cannot have children (422)`.
- `S03: invalid route keys rejected: "GET pets", "FETCH /a", "GET /{a+}/b"`.
- `S03: REST create inserts root "/"; protocol change is 422`.
- `S03: clone produces identical match results with new ids`.
- `S03 [db]: manager can create routes; member cannot; grant scoped to API A cannot edit API B routes`.
- `S03: matcher handles 300 routes / 300 resources in < 1 ms p99 per match` (micro-benchmark, printed, not flaky-asserted above 5 ms).
