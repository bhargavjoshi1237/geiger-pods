# API Gateway replacement: step-by-step roadmap

Research date: 4 October 2026. Execute in dependency order. Each phase requires its own detailed implementation plan and acceptance checks before calling it complete. The linked [feature inventory](aws-api-gateway.md) is the coverage checklist.

| Phase | Deliverable | Completion gate |
|---|---|---|
| 0 | Geiger foundation: public `/`, inherited session, shared `/project` resolver, workspace shell, overview, roadmap, project details | Build/lint/unit checks; anonymous and inherited-session browser flows |
| 1 | API catalog and persistent Pods authorization | Two-user/two-project RLS tests; real CRUD; no unauthorized role escalation |
| 2 | First deployable HTTP gateway | Real request through a published stage to a real backend |
| 3 | API authorization and consumer controls | JWT/custom authorization, keys, quotas, rotation and revocation tested at runtime |
| 4 | REST management and request processing | Resource/method parity, models, mappings, binary/compression and errors tested |
| 5 | Release controls | Immutable revisions, stages, variables, rollback, canaries and cache isolation |
| 6 | Operations | Traffic-derived metrics, redacted logs, traces, alerts and audit history |
| 7 | Domains and private networking | Domain verification/TLS/mTLS, routing priorities, private connectors and WAF adapters |
| 8 | WebSocket gateway | Connection/message lifecycle, send/disconnect APIs, load and reconnect tests |
| 9 | Developer distribution | OpenAPI round trips, SDKs, versioned docs, branded portals and sharing |
| 10 | Production parity audit | Every inventory row has evidence; limits, recovery, billing, load and failure testing |

## Phase 0: foundation (this request)

1. Pin the Geiger packages to the Events revisions. Match its Geiger tokens, shared header/topbar/sidebar, font and content width.
2. Match Dash's cookie client configuration and production `/pods` rewrite contract. Keep sign-in and project creation in Dash.
3. Read shared projects, validate org membership, react to auth changes, distinguish signed-out/config/error/empty/inaccessible states.
4. Resolve `/project` to an accessible remembered project, with storage failures tolerated. Exclude stale/inaccessible remembered IDs.
5. Implement `/project/[projectId]`, `/overview`, `/settings` and `/roadmap`. Future gateway sections describe their phase and cannot perform actions.
6. Test selection, malformed/unknown routes, project switching, revocation/sign-out state clearing, and read-only inherited role decisions.

## Phase 1: catalog and storage

1. Create `pods.apis`, `pods.routes`, `pods.integrations`, `pods.authorizers` and `pods.role_grants` through `npm run db:new`; product rows reference `public.projects(id)`.
2. Define resource-scoped permission keys in `geiger-rbac.config.js`. Generate predicates through `@geiger/rbac`; explicitly restrict access to project membership and active grants in RLS.
3. Review generated grant policies before applying: never adopt demo `using (true)` policies or client-side role seeding as security controls. Bootstrap only the current verified member through a constrained server/database operation; a revoked grant stays revoked.
4. Add pure `lib/supabase/<area>.js` access files. Normalize snake_case at the boundary. Validate protocol, unique name/path/method, ownership and deleted rows.
5. Build real API list/create/detail screens with Geiger screen-kit, dialogs, fields, table, empty/loading/error states. Counts on overview must come from storage.
6. Verify owner, editor, viewer, nonmember and cross-project paths at the database and application layers before exposing mutations.

## Phase 2: HTTP runtime

1. Choose a gateway data-plane deployment separately from the Next.js management console. An AWS-backed adapter is useful for comparison but is not an independent replacement.
2. Define an immutable deployment artifact: `projectId`, `apiId`, revision digest, routes, integration bindings, authorizer configuration and policy settings. No plaintext secrets in the artifact.
3. Implement host/stage lookup, method/path matching and an HTTP proxy adapter. Resolve secrets on the server; protect against unintended internal URL access; define private destinations via explicit connectors.
4. Implement stage promotion with compare-and-swap revision checks. A runtime loads only published, validated artifacts. Draft edits do not affect traffic.
5. Verify method/query/header/body forwarding, errors, timeouts, CORS, cancellation and project isolation with a real upstream test service.

## Phases 3–5: security, REST and releases

1. Implement JWT signature/issuer/audience/expiry/scope checks, custom authorizer caching and invalidation. Keep Geiger workspace sessions separate from consumer tokens.
2. Add key generation/hashed storage, one-time reveal, rotation/revocation, usage plans and atomic distributed rate counters. Document best-effort versus strict limits.
3. Add resource tree/methods, schema models, request validation, restricted mapping templates, responses, binary media, compression, mock and provider integration adapters.
4. Test Lambda/AWS service adapters with scoped server-side credentials. Native IAM/SigV4 compatibility requires canonical-request tests, not just a checkbox in UI.
5. Add named stages, secret references, release history, rollback, optional HTTP auto-deploy, weighted canaries and cache keys partitioned by identity/tenant.
6. Implement response streaming in compatible adapters and verify client disconnect/backpressure behavior.

## Phases 6–7: operating a real gateway

1. Emit one sanitized request event per invocation; aggregate real request/error/latency data. Separate access, execution and management audit logs.
2. Add trace propagation, alert rules, redaction, retention and export. Test failures without recording tokens, credentials or private bodies.
3. Verify custom domain ownership, certificate lifecycle and API mappings; apply routing rules in priority order with an explicit fallback.
4. Introduce a private network agent/connector, trust-store/mTLS and WAF provider adapters. Test bypass attempts and credential rotation.

## Phases 8–10: connections, distribution, parity

1. Deploy a persistent WebSocket runtime, then implement lifecycle routes, selection expressions, connection registry and management send/disconnect operations.
2. Specify reconnect/idle/lifetime/message limits and backpressure. Test multiple runtime instances and sudden node loss.
3. Import/export supported OpenAPI versions with conflict reports and extension preservation. Generate SDKs from published revisions.
4. Build consumer portals with product groupings, endpoint pages, docs versions, preview/publication and explicit sharing. Consumer sign-in differs from staff workspace access.
5. Publish an evidence-backed parity report. Mark provider-dependent features, unsupported extensions and known limits explicitly. Validate restore, rollback, tenant isolation, concurrency, uptime and billable usage.
