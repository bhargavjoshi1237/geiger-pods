# S07 — Consumer authorization

**Wave 4 · Depends on: S05 (S04 for function targets, S06 for context) · Blocks: S11 (mTLS context), S12 ($connect auth)**

Workspace RBAC (S02) controls who can **configure** an API. This spec controls who can **invoke** it. The two never share credentials.

AWS references: [access control overview](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-control-access-to-api.html), [IAM auth / SigV4](https://docs.aws.amazon.com/apigateway/latest/developerguide/permissions.html), [SigV4 signing process](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html), [Cognito authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html), [HTTP JWT authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html), [REST Lambda authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html), [HTTP Lambda authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html), [resource policies](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-resource-policies.html), [policy + authorizer evaluation](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-authorization-flow.html).

## 1. Authorization types (per method/route)

| Pods `authorization_type` | AWS | Protocols |
|---|---|---|
| `NONE` | NONE | R H W |
| `SIGNED` | AWS_IAM (SigV4) | R H W |
| `JWT` | REST `COGNITO_USER_POOLS`, HTTP `JWT` | R H |
| `CUSTOM` | `CUSTOM` (Lambda authorizer) | R H W ($connect only for W) |

## 2. Resource ARN format

AWS Lambda authorizers and policies use `methodArn`. Pods emits the same shape, so existing authorizer code that splits on `:` and `/` keeps working:

`arn:pods:execute-api:{region}:{projectId}:{apiPublicId}/{stage}/{METHOD}/{resourcePath without leading slash}`

Example: `arn:pods:execute-api:auto:7f3c…:a1b2c3d4e5/prod/GET/pets/42`. Policies also accept the `arn:aws:execute-api:` prefix as an alias.
Wildcards in policy resources: `*` matches any run of characters within a segment-agnostic glob, and `?` matches one character (IAM semantics).

## 3. Data model (`supabase/migrations/auth/`)

- `pods.authorizers` (`api_id`, `public_id`): `name`, `type` (`JWT` / `TOKEN` / `REQUEST`), `identity_source text[]` (REST TOKEN: one header expression like `method.request.header.Authorization`; REQUEST/HTTP: `$request.header.X`, `$request.querystring.x`, `$stageVariables.x`, `$context.x`; REST REQUEST uses `method.request.header.X` etc.), `identity_validation_expression` (TOKEN regex), `jwt` jsonb `{issuer, audience[] (≤50), algorithms[] default ["RS256"], clockSkewSec default 0}`, `function` jsonb (S04 function target), `payload_format_version` (HTTP `1.0`/`2.0`), `enable_simple_responses bool` (HTTP 2.0), `result_ttl_seconds int` (0–3600, default 300; HTTP default 0), `timeout_ms` (default 10000, 1000–29000), `credentials_ref` (secret for aws_lambda invocation).
- `pods.signing_credentials` (project-level): `name`, `access_key_id` (`PKIA` + 16 base32 uppercase chars, unique), `secret_ref` (vault), `status` (`ACTIVE`/`INACTIVE`), `last_used_at`, `expires_at null`, `tags`. The secret access key (40 chars base62) is shown **once**.
- `pods.signing_policies`: `credential_id`, `name`, `document jsonb` (identity policy, §6 grammar). One credential holds ≤10 policies.
- `pods.apis.resource_policy` jsonb (S03 column), ≤ 8192 chars serialized.

**RLS:** authorizers require `pods.authorizer.write`; signing credentials and policies require `pods.secret.write`; resource policy edits require `pods.resource_policy.write`.

## 4. JWT authorizer (`auth/jwt.mjs`)

- Token from the identity source. Default `$request.header.Authorization`; REST default `method.request.header.Authorization`. Strip a leading `Bearer ` (case-insensitive).
- Discovery: `GET {issuer}/.well-known/openid-configuration` → `jwks_uri`. JWKS cached in KV for 2 h. An unknown `kid` triggers one refetch, rate-limited to 1/min per issuer. Discovery and JWKS fetches use the SSRF-guarded fetch.
- Validate: header `alg` ∈ algorithms (never `none`; HS* never accepted). Signature by `kid` with WebCrypto. `iss` equals exactly. `exp` is required and in the future; `nbf`/`iat` are not in the future (± clockSkew). The audience check passes if `aud` (string or array) **or** `client_id` contains one of the configured audiences (AWS semantics).
- Scopes: if the route/method has `authorization_scopes`, the token's `scope` (space-delimited) or `scp` (array) must include **at least one** of them, otherwise 403 `{"message":"Forbidden"}`.
- Failures: missing token → 401 `UNAUTHORIZED`; invalid/expired → 401 (HTTP) / 401 `UNAUTHORIZED` (REST; `EXPIRED_TOKEN` is used for signed requests).
- On success: `$context.authorizer.claims.<name>` (stringified non-strings, as AWS does), `$context.authorizer.scopes`, `$context.authorizer.principalId = sub`. HTTP 2.0 events get `requestContext.authorizer.jwt.{claims, scopes}`.
- Geiger-native use: an issuer of `${NEXT_PUBLIC_SUPABASE_URL}/auth/v1` lets Geiger/Supabase users call APIs with their session JWT, when the Supabase project uses asymmetric signing keys. This is documented in the UI.

## 5. Custom (Lambda) authorizers (`auth/custom.mjs`)

**Inputs.**
- REST `TOKEN`: `{"type":"TOKEN","authorizationToken":"<value>","methodArn":"…"}`. If `identity_validation_expression` is set and the token does not match → 401 without invoking.
- REST `REQUEST`: `{"type":"REQUEST","methodArn","resource","path","httpMethod","headers","multiValueHeaders","queryStringParameters","multiValueQueryStringParameters","pathParameters","stageVariables","requestContext"}`.
- HTTP `1.0`: same as REST REQUEST plus `identitySource`. HTTP `2.0`: `{"version":"2.0","type":"REQUEST","routeArn","identitySource":[…],"routeKey","rawPath","rawQueryString","cookies","headers","queryStringParameters","requestContext","pathParameters","stageVariables"}`.
- WebSocket `$connect`: REQUEST with `requestContext.connectionId`, `eventType: CONNECT`.
- If **any** identity source is missing or empty → 401 `UNAUTHORIZED` without invoking (AWS behavior when identity sources are set).

**Outputs.**
- Policy format: `{ principalId, policyDocument: {Version, Statement:[{Action:"execute-api:Invoke", Effect:"Allow"|"Deny", Resource:[arn|glob]}]}, context: {k: string|number|boolean}, usageIdentifierKey? }`. Allow means some Allow statement matches the current `methodArn`/`routeArn` and no Deny statement matches.
- Simple format (HTTP 2.0 with `enable_simple_responses`): `{ isAuthorized: boolean, context: {...} }`.
- The function throwing/returning the error message `Unauthorized`, or a webhook returning HTTP 401 → 401 `UNAUTHORIZED`. Deny → 403 `ACCESS_DENIED` with message `User is not authorized to access this resource`. Timeout, function error or malformed output → 500 `AUTHORIZER_FAILURE` / `AUTHORIZER_CONFIGURATION_ERROR` (malformed policy). `context` values that are not scalars → `AUTHORIZER_CONFIGURATION_ERROR`.

**Caching.** When `result_ttl_seconds > 0`, the KV key is `authz:{authorizerId}:{sha256(identity values joined)}`, with value = the full output. **A cached policy is re-evaluated against each request's methodArn.** This is the well-known AWS behavior: a policy cached from `GET /pets` may deny `POST /pets`. A Deny or a 401 is cached too, but errors are not.

**Context propagation.** `$context.authorizer.principalId` and `$context.authorizer.<key>` are available to mappings, templates, logs and function events (`requestContext.authorizer`). `usageIdentifierKey` feeds S08 when `api_key_source = AUTHORIZER`.

**Test authorizer** (REST, control plane) `POST …/authorizers/{id}/test {headers, queryString, stageVariables, methodArn?}` → `{status, principalId, policy, context, latencyMs, log}`. Uses no cache and masks secrets.

## 6. Signed requests — IAM equivalent (`auth/sigv4.mjs`, `auth/policy.mjs`)

- **Algorithm:** AWS Signature Version 4 exactly: canonical request, `AWS4-HMAC-SHA256`, credential scope `{date}/{region}/execute-api/aws4_request`, signing-key derivation. Both header auth (`Authorization: AWS4-HMAC-SHA256 Credential=…, SignedHeaders=…, Signature=…`) and presigned query auth (`X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires` ≤ 7 d, `X-Amz-SignedHeaders`, `X-Amz-Signature`) are supported. `x-amz-content-sha256` is honored (`UNSIGNED-PAYLOAD` accepted); otherwise the body hash is computed. The region in the scope must equal the gateway region string (`PODS_REGION`, default `auto`) or `*` when `features.signedAnyRegion`. Because of this, standard AWS SDK signers (`@smithy/signature-v4`, `aws4`, botocore) sign Pods requests with Pods credentials.
- Errors (403, AWS messages): no `Authorization` header and no query auth → `MISSING_AUTHENTICATION_TOKEN`; unknown or inactive key → `INVALID_SIGNATURE` "The security token included in the request is invalid."; signature mismatch → `INVALID_SIGNATURE` "The request signature we calculated does not match the signature you provided…"; clock skew > 5 min → `INVALID_SIGNATURE` "Signature expired: …"; presigned URL past expiry → `EXPIRED_TOKEN`.
- **Policy grammar** (identity and resource policies share one evaluator): `{Version:"2012-10-17", Statement:[{Sid?, Effect, Principal? (resource policies only: "*" | {"Pods": [credential ARN | "*"]} with alias "AWS"), Action: "execute-api:Invoke"|"execute-api:*"|"*" (or list), NotAction?, Resource|NotResource, Condition?}]}`. Condition operators: `StringEquals`, `StringNotEquals`, `StringLike`, `StringNotLike`, `IpAddress`, `NotIpAddress`, `DateGreaterThan`, `DateLessThan`, `Bool`, `Null`, each with the `ForAnyValue:`/`ForAllValues:` prefixes for multi-valued keys. Keys: `aws:SourceIp`, `aws:SourceVpce` (= connector id, for private APIs, S11), `aws:SourceVpc`, `aws:UserAgent`, `aws:Referer`, `aws:CurrentTime`, `aws:EpochTime`, `aws:SecureTransport`, `aws:PrincipalArn`, `aws:PrincipalTag/<k>`; the `pods:` prefix is accepted as a synonym. Unknown keys or operators are invalid at save time.
- Evaluation: explicit Deny > Allow > implicit deny (IAM). The principal ARN of a credential is `arn:pods:iam::{projectId}:credential/{accessKeyId}`.
- Context: `$context.identity.accessKey`, `.caller` (= access key id), `.user`, `.userArn` (= principal ARN).
- SigV4a (P2): ECDSA P-256 with the derived key per the AWS spec and `X-Amz-Region-Set`. Behind `features.sigv4a`.

## 7. Resource policy evaluation (REST, `auth/resource-policy.mjs`)

Phase 8 (pre-auth): evaluate statements that don't depend on the principal. An **explicit Deny** → 403 `ACCESS_DENIED` "User: anonymous is not authorized to perform: execute-api:Invoke on resource: {arn}" **before** invoking any authorizer.
Phase 10 (post-auth): final decision per auth type (AWS authorization-flow table):

| Auth type | Resource policy result | Authorizer/identity result | Outcome |
|---|---|---|---|
| NONE | Allow | — | Allow |
| NONE | Implicit (no match) | — | **Deny** (when a policy exists) |
| any | Explicit Deny | any | Deny |
| SIGNED | Allow | any (same project) | Allow |
| SIGNED | Implicit | identity policy Allow | Allow |
| SIGNED | Implicit | identity policy implicit | Deny |
| CUSTOM / JWT | Allow | Allow | Allow |
| CUSTOM / JWT | Implicit | Allow | Allow |
| CUSTOM / JWT | Allow/Implicit | Deny/401 | Deny/401 |

With no resource policy, only the authorizer result counts.
Policy changes take effect **on the next deployment** (AWS requires a redeploy). The compile step (S05) snapshots the policy into the artifact.

## 8. Screens

- **Authorizers tab** (API): list and create (JWT / Custom TOKEN / Custom REQUEST per capability), identity source builder, caching TTL, function target picker, a "test authorizer" panel (REST) and a JWT debugger box that decodes a pasted token against the config with no network call except JWKS.
- Method/route auth picker on the S03 method panel: type, authorizer, scopes, API key required (REST).
- **Signing credentials** (`/access/credentials`): create (shows secret once with copy buttons and SDK snippets for `@smithy/signature-v4` and Python `botocore`), deactivate, delete, last used, attach policies (JSON editor with schema validation).
- **Resource policy** editor (REST API settings): JSON editor, templates (IP allow-list, deny IP range, connector-only private API, cross-project principal allow), and a **policy simulator** (`methodArn`, sourceIp, principal → Allow/Deny with the matched statement).

## Acceptance tests

- `S07: JWT valid token allowed; wrong iss, expired, wrong aud, alg none, HS256 rejected 401; missing token 401`.
- `S07: aud check passes on client_id claim; scopes require at least one listed scope else 403`.
- `S07: unknown kid triggers single JWKS refetch; second unknown kid within a minute does not refetch`.
- `S07: TOKEN authorizer respects identityValidationExpression without invoking`.
- `S07: missing identity source → 401 without invoking function (spy)`.
- `S07: cached Allow policy for GET /pets denies POST /pets when policy resource only covers GET` (AWS caching gotcha).
- `S07: simple response isAuthorized false → 403; function throws "Unauthorized" → 401; timeout → 500 AUTHORIZER_FAILURE`.
- `S07: authorizer context exposed as $context.authorizer.x and in function proxy event requestContext.authorizer`.
- `S07: SigV4 golden vectors — AWS official sigv4 test suite cases (get-vanilla, post-x-www-form-urlencoded, get-vanilla-query-order-key, etc.) verify`.
- `S07 [runtime]: request signed by @smithy/signature-v4 with Pods credentials succeeds; tampered body fails; skew 6 min fails; presigned URL works then expires`.
- `S07: policy evaluator — explicit deny beats allow; IpAddress CIDR v4/v6; StringLike wildcard; NotResource; ForAnyValue`.
- `S07: resource-policy × auth-type table (§7) — each row a test`.
- `S07: pre-auth IP deny never invokes authorizer (spy)`.
- `S07: secret access key is returned exactly once and never by GET`.
