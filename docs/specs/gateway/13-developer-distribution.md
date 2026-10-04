# S13 — Developer distribution: OpenAPI, documentation, SDKs, portals, agent tools

**Wave 5 · Depends on: S03, S05, S06 (S07/S08 for portal auth and keys, S11 for portal domains) · Parts A–E can be assigned separately (A first)**

AWS references: [import REST API](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-import-api.html), [import HTTP API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-open-api.html), [OpenAPI extensions](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-swagger-extensions.html), [export REST API](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-export-api.html), [documentation](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-documenting-api.html), [documentation content inheritance](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-documenting-api-content-representation.html), [SDK generation](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-generate-sdk.html), [portals](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-portals.html), [portal products](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-portals-portal-product.html), [AgentCore Gateway target (Dec 2025)](https://docs.aws.amazon.com/apigateway/latest/developerguide/amazon-apigateway-release-notes.rss).

## Part A — OpenAPI import & export (P1)

**Import** `POST …/apis/import` (new API) and `PUT …/apis/{apiId}/import?mode=overwrite|merge` (existing):
- Inputs: OpenAPI 3.0.x (and 3.1 as a Pods extension) or Swagger 2.0, JSON or YAML (add the `yaml` package), ≤ 6 MB. Query options mirror AWS: `failOnWarnings`, `basepath=ignore|prepend|split` (REST), `endpointConfigurationTypes`, `ignore=documentation`, `protocol=REST|HTTP` (new API).
- Mapping: paths/operations → resources+methods (REST) or routes (HTTP); `components.schemas`/`definitions` → models (OAS 3.0 schemas are down-converted to draft-04 with warnings for unsupported keywords); parameters with `required` → method request parameters; `securitySchemes` → authorizers where extensions describe them.
- **Extensions:** accept every `x-amazon-apigateway-*` extension and the identically shaped `x-pods-*` alias. Integration, any-method, authorizer, authtype, request-validators, request-validator, binary-media-types, gateway-responses, cors, api-key-source, minimum-compression-size, policy, endpoint-configuration, documentation, importexport-version, tag-value, integrations (HTTP API components) and their nested fields.
  - Translations: Lambda URIs `arn:aws:apigateway:{region}:lambda:path/2015-03-31/functions/{functionArn}/invocations` → `FUNCTION[_PROXY]` with provider `aws_lambda`. `connectionType: VPC_LINK` → `CONNECTOR` (unmapped connection ids are warnings). `type: aws` service URIs → `AWS_SERVICE`. `$stageVariables` references are preserved.
  - Unknown or unsupported constructs become **warnings** `{path, message}`. With `failOnWarnings=true`, any warning aborts with 400 and nothing is written.
- `overwrite` replaces the whole draft in one transaction, keeping the API id. `merge` adds and updates by `(path, method)`/route key and model name and never deletes. Both produce a change summary (`added/updated/unchanged/removed`) and audit entries. Both affect only the **draft**; a deploy is still required (AWS parity). HTTP auto-deploy stages redeploy as usual.

**Export** `GET …/apis/{apiId}/stages/{stage}/export?type=oas30|swagger&format=json|yaml&extensions=none|pods|aws|postman&includeDocs=true` is generated from the stage's **deployed artifact**, never the draft (AWS exports a stage). The `servers`/`host`+`basePath` contain the stage invoke URL (or custom domain if `?domain=`). `extensions=aws` emits `x-amazon-apigateway-*` so the API can be moved back to AWS. `postman` emits a Postman Collection v2.1 (AWS export option). Draft export is a Pods extension: `GET …/apis/{apiId}/export?source=draft`.

## Part B — Documentation parts & versions (REST, P1)

- `pods.documentation_parts`: `api_id`, `location jsonb {type, path, method, statusCode, name}`, where `type ∈ API, AUTHORIZER, MODEL, RESOURCE, METHOD, PATH_PARAMETER, QUERY_PARAMETER, REQUEST_HEADER, REQUEST_BODY, RESPONSE, RESPONSE_HEADER, RESPONSE_BODY`. `properties jsonb` holds OpenAPI-style keys (`description`, `summary`, `tags`, `info`, …), ≤ 2000 parts per API. Unique by location.
- **Content inheritance** (AWS rules): a part whose location uses `method: "*"`, `statusCode: "*"` or a parent `path` applies to more specific locations unless they define the same property. Implement `resolveDocumentation(parts, location)` and test it against the AWS representation examples.
- `pods.documentation_versions`: `api_id`, `version` (unique), `description`, `snapshot jsonb` (all parts at creation time), `created_at`. `stages.documentation_version` associates a version with a stage. Export and portals use the stage's documentation version.
- Import/export documentation alone: `PUT …/documentation/import?mode=overwrite|merge` from an OpenAPI file with `x-amazon-apigateway-documentation`, plus export.
- **RLS:** `pods.documentation.write`.

## Part C — SDK generation (REST, P1 for JS/TS/Python, P2 for others)

- `POST …/stages/{stage}/sdks {language, config}` → job → zip download (`GET …/sdks/{jobId}`). Cache key `(deploymentId, docsVersion, language, config hash)`.
- **Native generators** in `lib/sdk/`, written in-house and template-based from the export:
  - `javascript`: ESM, fetch-based, one method per operation.
  - `typescript`: typed models from schemas.
  - `python`: `requests`-based.
  Each supports: base URL override, API key header, bearer token, SigV4 signing hook (uses the standard signer packages of that ecosystem), timeouts and retries on 429/5xx with backoff. Config: `{packageName, version, className}` (AWS-like `serviceName` / `javaPackageName` naming).
- **Extended languages** (P2): `java`, `android` (Java), `swift` (iOS), `ruby`, `go`, `kotlin`. These run through an `openapi-generator` container worker (`workers/sdkgen/Dockerfile`, pinned version), invoked by a job endpoint. They are documented as using OpenAPI Generator.
- Generated SDKs have smoke tests: a generated JS client calls the deployed test stage in a runtime test.

## Part D — Developer portals (REST, P1)

AWS (Nov 2025): portals contain **portal products**; products group REST API endpoints and documentation; there are product pages (custom docs), product REST endpoint pages (per path/method/stage), branding, access control, preview/publish, cross-account sharing and try-it.

**Data model (`supabase/migrations/portals/`):**
- `pods.portals`: `name`, `slug` (unique globally), `domain_id null` (S11 custom domain; otherwise `https://{slug}.portals.{PODS_PORTAL_DOMAIN}` or path `/portal/{slug}` on the app), `branding jsonb {logoAssetId, faviconAssetId, primaryColor, accentColor, theme: light|dark|system, headerLinks[], footerMarkdown}`, `access jsonb {mode: public|authenticated, oidc: {issuer, clientId, scopes, allowedEmailDomains[]}}` (AWS uses Cognito; Pods takes any OIDC provider, including the suite's Supabase auth), `analytics_enabled`, `status` (`DRAFT`/`PUBLISHED`/`DISABLED`), `published_snapshot jsonb`, `published_at`, `preview_token`.
- `pods.portal_products`: `name`, `description`, `display_order`, `usage_plan_id null` (Pods extension for self-service keys), `sharing jsonb {projects: [projectId], organizations: [orgId]}` (cross-project sharing instead of AWS cross-account RAM).
- `pods.portal_product_links`: `portal_id`, `product_id`, `order`.
- `pods.product_pages`: `product_id`, `title`, `slug`, `body_markdown`, `order`.
- `pods.product_endpoint_pages`: `product_id`, `api_id`, `stage_name`, `resource_path`, `http_method`, `operation_name`, `display_override_markdown null` (otherwise generated from documentation parts and models), `try_it_enabled bool`.
- **RLS:** `pods.portal.write`; publish requires `pods.portal.publish`. Shared products are readable by members of target projects/orgs (`pods.can('pods.portals.view', target)`), who can add them to their own portals but not edit them.

**Behavior:**
- **Preview:** renders the current draft at `/portal/{slug}?preview={preview_token}`, for authenticated workspace users only.
- **Publish:** freeze a snapshot (products, pages, endpoint pages with resolved docs/models from each stage's documentation version, branding) into `published_snapshot`. The public portal only reads snapshots. Disable → 404 page.
- **Rendering:** a public Next route group `app/portal/[slug]/…`, outside the workspace and not using the suite session. For custom domains, `proxy.js` rewrites by host to `/portal/{slug}` (check Next 16 `proxy.js` docs; respect `basePath`). Pages: home (product cards), product page (markdown, sanitized with an allow-list renderer), endpoint page (method, path, parameters table, request/response schema, example), **Try it** (request builder that calls the real stage URL from the browser, with API key/bearer input and a CORS warning when the API lacks CORS).
- **Access control:** `authenticated` mode runs OIDC Authorization Code + PKCE with a session cookie scoped to the portal host, with an allowed-email-domain filter. This is separate from Geiger workspace sessions.
- **Self-service keys** (Pods extension, P2): signed-in consumers on a product linked to a usage plan can create **one** API key (S08), shown once, see their usage and rotate it. Consumer identity is stored on `api_keys.customer_id = oidc sub`.
- **Analytics** (AWS uses CloudWatch RUM): page views and try-it calls counted in `pods.portal_events`, shown on the portal settings page.
- Quotas: AWS portal throttles are 250k rps without access control and 10k rps with it. Pods serves published portals as static-rendered pages with ISR/`use cache` tagging (`revalidateTag` on publish), so rendering cost is not per request.

## Part E — Agent tool gateway (MCP, P2)

The equivalent of "REST API as an Amazon Bedrock AgentCore Gateway target" (Dec 2025): an opt-in per stage, `stages.agent_tools = {enabled, allowOperations[], auth: "passthrough"}`.
- Endpoint: `https://{apiPublicId}.{domain}/{stage}/_mcp`, MCP **Streamable HTTP** transport (check the current MCP spec before implementing).
- `tools/list`: one tool per allowed operation. Name = `operationName` or `METHOD_path` sanitized. Description from documentation parts. Input JSON Schema built from path/query/header params and the request body model.
- `tools/call`: build an HTTP request and run it through the normal pipeline in-process, so authorization, keys, throttling, WAF and logs all apply. The caller's `Authorization`/`x-api-key` are forwarded. Results are returned as text/JSON content.

## Screens

- **Import** wizard (API list and API settings): upload/paste, options, warnings preview (dry-run endpoint `?dryRun=true`), change summary, confirm.
- **Export** dialog on a stage: type, format, extensions, include docs, download.
- **Docs** tab (REST API): tree of locations with inheritance indicators, property editor, versions list (create version, associate with stage).
- **SDKs** on stage: language picker, config form, generate and download, history.
- **Portals** (`/portals`): list; portal editor (branding with live preview, access settings, linked products, preview link, publish/disable, analytics); products (pages markdown editor, endpoint page picker from deployed stages, sharing); shared-with-me products.
- **Agent tools** sub-tab on stage: enable, operation allow-list, MCP URL and a client config snippet.

## Acceptance tests

- `S13A: AWS PetStore OpenAPI (with x-amazon-apigateway-integration HTTP and mock) imports with zero warnings; deploy + export(aws) round-trips semantically (same routes, integrations, mappings)`.
- `S13A: Lambda ARN integration URI translated to aws_lambda function provider; VPC_LINK becomes connector warning when unmapped`.
- `S13A: failOnWarnings aborts with no writes; merge never deletes; overwrite replaces draft but keeps API id`.
- `S13A: export reflects deployed stage, not draft edits made after deploy`.
- `S13A: postman export opens as valid v2.1 collection (schema validation)`.
- `S13B: documentation inheritance — RESPONSE method "*" description applies to GET and POST unless overridden` (AWS examples).
- `S13B: documentation version snapshot is immutable after later part edits`.
- `S13C: generated TS SDK compiles (tsc --noEmit in test) and calls deployed stage with API key successfully`.
- `S13D: preview requires workspace auth; published snapshot unaffected by draft edits until republish; disabled portal 404`.
- `S13D: authenticated portal rejects disallowed email domain; markdown sanitizer strips script/iframe/on* attributes`.
- `S13D: shared product visible to target project, not editable there; revoking sharing removes it from their portals on next publish`.
- `S13E: tools/list derives input schema from params+model; tools/call goes through authorizer and throttling (spy)`.
