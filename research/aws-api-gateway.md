# AWS API Gateway: replacement feature map

Research date: 4 October 2026. Primary sources only. Scope: build comparable capabilities inside Geiger, preserving its identities, projects, authorization, and UI. This is a behavioral feature map, not a promise of AWS scale, certification, or wire-compatible management APIs.

## Protocol families

REST is the broader management surface; HTTP provides streamlined routing; WebSocket provides bidirectional connections. The AWS protocol differences are real, so Pods should store a protocol on each API and enforce capability availability. AWS documents REST-only management features such as usage plans, validation, caching, canaries, and execution logging; HTTP includes native JWT authorization and auto-deployment. [AWS comparison](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html).

| AWS family | Pods configuration | Initial implementation order |
|---|---|---|
| HTTP | Method/path routes, HTTP integrations, CORS, JWT, stages | First working runtime |
| REST | Resource tree and methods, models, mappings, usage controls | After HTTP runtime |
| WebSocket | Route-selection expression and message integrations | Dedicated persistent runtime |

Do not model an API as a Geiger project. A shared Geiger project owns multiple API definitions; an API owns routes, integrations, authorizers, deployments, and stages. AWS's resource vocabulary is the reference. [API Gateway concepts](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-basic-concept.html).

## Capability inventory and completion criteria

The implementation and acceptance columns below are our design recommendations. Source links establish the AWS behavior; they do not establish that Pods already supports it.

| Area | AWS reference behavior | Pods work | Acceptance evidence |
|---|---|---|---|
| Routing | Resources, methods, greedy proxy paths; HTTP routes | API-scoped path matcher, precedence, duplicate checks | Exact/parameter/greedy/ANY/default matching tests |
| Integrations | HTTP proxy, Lambda, AWS service, mock | Adapter contract, timeouts, backend credentials | Real upstream invocation; failure propagation |
| Private connectivity | VPC links and private load-balancer integrations | Connector/agent plus private network policy | Traffic stays inside intended network |
| Endpoint exposure | Regional, edge, private APIs | Runtime placement and exposure policies | Unauthorized network cannot reach private APIs |

Sources: [HTTP proxy integration](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-set-up-simple-proxy.html), [private integrations](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-private.html), [endpoint types](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-endpoint-types.html).

| Area | AWS reference behavior | Pods work | Acceptance evidence |
|---|---|---|---|
| Consumer authorization | IAM/SigV4, Cognito, custom Lambda, HTTP JWT | Authorizer adapters; issuer/audience/scope validation | Invalid, expired, wrong audience, insufficient scope rejected |
| Resource policies | REST resource policy | Network/client restrictions evaluated before integration | Denial does not call backend |
| API keys | Client identification and usage-plan association | Generated keys; hashed storage; rotate/revoke | Plaintext shown once; revoked key rejected |
| Usage plans | Stage/method quotas and throttles | Atomic counters; key-to-stage associations | Concurrent requests honor documented limit semantics |
| Abuse protection | REST WAF association | WAF/provider adapter and request policies | Blocked request produces audit evidence |

Workspace RBAC controls who can configure an API; API consumer authorization controls who can invoke it. Keep them separate. AWS explicitly says API keys are not authentication and quotas are best effort. Pods must publish its own enforcement semantics rather than claim hard cost limits. [Usage plans](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html), [REST access control](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-control-access-to-api.html), [HTTP JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html), [WAF](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-control-access-aws-waf.html).

| Area | AWS reference behavior | Pods work | Acceptance evidence |
|---|---|---|---|
| Validation | Request parameters and body models | Versioned schemas, required fields, size limits | Malformed request fails before backend |
| Transformations | Parameter/body mappings and integration responses | Restricted transformations, content negotiation | Fixtures cover request and response conversion |
| CORS | REST preflight / HTTP managed configuration | Allowed origins/methods/headers and credentials | Browser preflight and credentialed request work |
| Payloads | Binary media and compression | Byte-preserving transport, compression controls | Binary round trip; no double encoding |
| Gateway responses | Custom REST error responses | Stable error envelope and templates | Auth, throttle, validation, upstream failures distinguished |
| Testing | REST console test invocations | Authorized test runner against draft configuration | Draft tests do not change published stage |

Sources: [request validation](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-method-request-validation.html), [mapping templates](https://docs.aws.amazon.com/apigateway/latest/developerguide/models-mappings.html), [CORS](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-cors.html), [binary payloads](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-payload-encodings.html), [gateway responses](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-gatewayResponse-definition.html).

| Area | AWS reference behavior | Pods work | Acceptance evidence |
|---|---|---|---|
| Deployments | Deployable API snapshot | Immutable revision plus config digest | Editing draft never mutates live traffic |
| Stages | Named deployment target and variables | Promotion, rollback, environment bindings | Rollback returns to exact known revision |
| Auto-deploy | HTTP automatic publication | Explicit opt-in and audited promotion | Failed validation leaves live revision untouched |
| Canaries | REST weighted release | Deterministic weighted routing and rollback | Traffic split verified under load |
| Caching | REST stage/method cache | Shared cache; TTL, keying, invalidation | Authenticated responses never cross consumers |
| Streaming | REST proxy response streaming | Streaming HTTP/Lambda adapter | First byte arrives before completion; disconnect cancels upstream |

Sources: [REST deployments](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-deploy-api.html), [HTTP stages](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-stages.html), [canaries](https://docs.aws.amazon.com/apigateway/latest/developerguide/canary-release.html), [cache](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-caching.html), [response streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html). Streaming support has integration restrictions; carry those into adapter capability tests.

| Area | AWS reference behavior | Pods work | Acceptance evidence |
|---|---|---|---|
| Custom domains | Certificates and API mappings | Verified domain, TLS lifecycle, path mapping | Unverified host cannot route to project |
| Routing rules | Header/path conditions and priorities | Ordered domain rule evaluator | Priority and fallback cases tested |
| mTLS | Certificate trust store | Trust store and revocation policy | Untrusted/expired client rejected |
| Backend certificates | Backend TLS authentication | Secret-backed certificate bindings | Rotation without plaintext disclosure |

Sources: [domains](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-custom-domains.html), [routing rules](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-routing-rules.html), [mTLS](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-mutual-tls.html), [backend certificates](https://docs.aws.amazon.com/apigateway/latest/developerguide/getting-started-client-side-ssl-authentication.html).

| Area | AWS reference behavior | Pods work | Acceptance evidence |
|---|---|---|---|
| Metrics | Requests, latency, integration latency, errors | Aggregated metrics by project/API/stage/route | Counts reconcile with test traffic |
| Access/execution logs | Request and execution records | Structured logs, redaction, retention, export | Tokens, key values and sensitive bodies excluded |
| Tracing | REST X-Ray | Trace propagation and provider export | Gateway-to-backend trace correlated |
| Alarms | CloudWatch-based alerts | Alert thresholds and notification connector | Test breach emits exactly the configured alert |
| Audit | Management activity | Append-only configuration history | Actor, project, action and revision recorded |

Sources: [REST monitoring](https://docs.aws.amazon.com/apigateway/latest/developerguide/monitoring-cloudwatch.html), [HTTP monitoring](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-monitor.html), [tracing](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-xray.html). Pods metrics must come from actual runtime events; an empty chart must not contain sample production traffic.

| Area | AWS reference behavior | Pods work | Acceptance evidence |
|---|---|---|---|
| OpenAPI | Import/export with extensions | Validated import, conflict report, export | Supported document round trips without semantic loss |
| SDK generation | REST client SDKs | Versioned generators from published specification | Generated client invokes deployed endpoint |
| Documentation | API documentation and versions | Docs attached to API revisions | Published docs describe published revision |
| Portals | REST product bundles, pages, branding and publishing | Consumer portal distinct from team workspace | Publication snapshot; consumer access tested |
| Sharing | Cross-account portal products | Explicit project/org sharing boundary | Revocation blocks future publication/access |

Sources: [OpenAPI](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-import-api.html), [SDKs](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-generate-sdk.html), [documentation](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-documenting-api.html), [portals](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-portals.html), [portal products](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-portals-portal-product.html). AWS portals currently center on REST; document any Pods extensions separately.

## WebSocket workstream

Implement connection lifecycle, route-selection expressions, `$connect`, `$disconnect`, `$default`, message integration responses, and a management API for sending to connected clients. Authentication occurs on connection establishment; connection authorization and quotas need their own model. Define idle/lifetime/message limits, backpressure, reconnects, and scaling explicitly. [WebSocket overview](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html), [connection management](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html).

## Parity policy

Track each item as researched, designed, configured, runtime-tested, or production-validated. AWS-native integrations require AWS credentials and provider adapters. VPC networking, edge presence, TLS termination, WAF and WebSocket connection hosting need runtime infrastructure beyond a Next.js console. Their acceptance tests must run on that infrastructure. AWS limits are a compatibility reference, not the capacity of Pods. [AWS quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html).
