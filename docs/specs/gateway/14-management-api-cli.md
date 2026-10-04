# S14 — Management API, CLI, declarative config & tags

**Wave 5 · Depends on: S02, S03, S05 (covers resources from every spec as they land) · AWS analogues: API Gateway management API (v1/v2), AWS CLI, CloudFormation/SAM, resource tagging, CloudTrail → EventBridge**

AWS references: [API Gateway REST management API](https://docs.aws.amazon.com/apigateway/latest/api/API_Operations.html), [API Gateway v2 API](https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/api-reference.html), [tagging](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-tagging.html), [tag restrictions](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-tagging-restrictions.html), [CloudFormation API Gateway resources](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/AWS_ApiGateway.html), [control-plane quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html).

Pods does not copy AWS wire formats. It provides the same *capabilities*: everything doable in the console is doable through a documented API, a CLI and a declarative file.

## 1. Public management API

- The route handlers created by S02–S13 under `/api/v1/projects/{projectId}/…` **are** the public API. This spec makes them consistent and documented:
  - Maintain `docs/api/pods-management.openapi.yaml` (OAS 3.1). A test walks `app/api/v1/**/route.js` and fails if a handler/method is missing from the document, or the other way round.
  - Conventions from S01 §8: JSON camelCase, cursor pagination, `If-Match` versions, error envelope, `x-pods-request-id`.
  - `Idempotency-Key` header on every `POST`. Store `(tokenOrUser, key) → response` for 24 h in `pods.idempotency_keys`. A replay returns the stored response; the same key with a different body → 422.
  - Control-plane rate limit per project: 10 rps sustained, burst 40 (AWS "total operations" quota), plus AWS-style per-operation limits for heavy operations: deployments 1/2 s per API (S05), domain create 1/30 s, import 1/3 s. Exceeding → 429 with `Retry-After`.
- **Authentication:** browser session cookies (UI) or `Authorization: Bearer <token>`.

## 2. Access tokens

- `pods.access_tokens`: `project_id`, `kind` (`personal` bound to `user_id`, or `service` bound to the project), `name`, `prefix` (`pods_pat_`/`pods_svc_` + 6 chars shown in lists), `token_hash` (sha256), `scopes text[]` (permission keys/patterns from S02's catalog), `expires_at` (required for personal tokens, ≤ 1 year), `last_used_at`, `last_used_ip`, `revoked_at`, `created_by`.
- Effective permission = token scopes ∩ (personal: the user's **current** project permissions; service: the scopes themselves, but creating a service token requires `pods.token.write` and holding every scope granted). Revocation is immediate. When a user leaves the org, their personal tokens stop working because the intersection becomes empty.
- Token values: 32 random bytes base62, shown once. `actor_type = token` in audit with `tokenId`.
- Screen: `/settings/tokens` with create (scopes picker by permission group, expiry), list and revoke.

## 3. CLI (`cli/`, published as the npm bin `pods`)

Node ≥ 22, no heavy frameworks (`node:util.parseArgs`). Config at `~/.config/pods/config.json` (profiles: `{baseUrl, projectId, token}`). Env overrides `PODS_TOKEN`, `PODS_PROJECT`, `PODS_BASE_URL`.

| Command | Purpose |
|---|---|
| `pods login --token … [--profile]`, `pods whoami` | auth |
| `pods apis list|get|create|delete|clone` | API catalog |
| `pods routes|resources|methods|integrations|authorizers|models …` | build |
| `pods deploy --api <id|name> --stage <name> [--description] [--canary 10]` | S05/S09 |
| `pods stages list|get|update|rollback|flush-cache` | S05/S09 |
| `pods import <file> [--api] [--mode merge|overwrite] [--fail-on-warnings]`, `pods export --api --stage [--type oas30] [--extensions aws]` | S13 |
| `pods keys …`, `pods plans …`, `pods usage --plan --key --from --to` | S08 |
| `pods domains …`, `pods connectors …` (incl. printing the agent command) | S11/S04 |
| `pods logs tail --api --stage [--filter status>=500]`, `pods metrics --metric Latency --stat p99` | S10 |
| `pods test-invoke --api --resource /pets --method GET [--body @file]` | S05 |
| `pods ws send|get|disconnect --api --stage --connection` | S12 |
| `pods plan -f pods.yaml`, `pods apply -f pods.yaml [--prune] [--auto-approve]`, `pods drift -f pods.yaml` | §4 |

Output defaults to human tables; `--output json|yaml`. Exit codes: 0 ok, 1 error, 2 usage, 3 plan has changes (for `plan --detailed-exitcode`).

## 4. Declarative configuration ("stacks", CloudFormation/SAM equivalent)

- File `pods.yaml`, with a JSON Schema in `docs/api/pods-config.schema.json`:
```yaml
version: 1
stack: payments
apis:
  - name: payments-api
    protocol: REST
    openapi: ./openapi.yaml          # or inline routes/resources
    settings: { endpointType: REGIONAL, apiKeySource: HEADER, binaryMediaTypes: [image/png] }
    authorizers: [ { name: jwt, type: JWT, jwt: { issuer: https://…, audience: [api] } } ]
    stages:
      - name: prod
        variables: { backend: api.internal }
        throttle: { rate: 500, burst: 1000 }
        accessLog: { format: JSON, destinations: [pods] }
        cache: { enabled: true, size: "0.5", ttl: 300 }
usagePlans: [ { name: gold, throttle: { rateLimit: 100, burstLimit: 200 }, quota: { limit: 100000, period: MONTH }, stages: [ payments-api/prod ] } ]
domains: [ { name: api.example.com, securityPolicy: TLS_1_2, mappings: [ { api: payments-api, stage: prod, basePath: v1 } ] } ]
secrets: [ { name: stripe-key, kind: bearer } ]   # declared only; values set out-of-band (`pods secrets set`)
```
- Server endpoints `POST /api/v1/projects/{p}/stacks/{stack}/plan` and `…/apply`. The server computes the diff against resources tagged `pods:stack = <stack>`, using `name` as the stable identity, and returns ordered operations (`create|update|replace|delete|noop`, with field-level diffs). `apply` executes in dependency order: secrets → connectors → APIs/draft → deployments → stages → plans → keys → domains/mappings → WAF → portals. Each step is idempotent. A partial failure stops, reports which steps were applied, and is re-runnable. Deletion of resources removed from the file happens only with `--prune`.
- Stack records: `pods.stacks (name, last_applied_hash, last_applied_at, status, last_error)`. Drift = live resources tagged with the stack that differ from `last_applied` or the file.
- Secrets values and API key values are never accepted in the file.

## 5. Tags

- Taggable: APIs, stages, API keys, usage plans, domain names, connectors, client certificates, web ACLs, portals, portal products, secrets, signing credentials.
- Rules (AWS): ≤ 50 tags per resource. Key 1–128 chars, value 0–256 chars, case-sensitive, `[\p{L}\p{Z}\p{N}_.:/=+\-@]`. The prefixes `aws:` and `pods:` are reserved for the system, so users cannot set them.
- Stage tags (AWS) and stage-variable-like propagation: stages inherit nothing; tags are explicit.
- API: `GET/PUT/DELETE /api/v1/projects/{p}/tags/{resourceType}/{resourceId}` plus `?tag:Key=Value` filters on all list endpoints.
- Tags appear in usage exports (S08) and metric dimensions are **not** tagged. This matches AWS cost-allocation use, so the UI lists tags as "for organization and usage reports".

## 6. Management event webhooks (EventBridge equivalent, P2)

`pods.event_subscriptions`: `name`, `event_types text[]` (from audit actions: `deployment.create`, `stage.update`, `api_key.create`, `domain.status_changed`, `alarm.state_changed`, `connector.status_changed`, …), `target` (`https` URL + signing secret ref), `enabled`. Delivered from `audit_events` inserts by a dispatcher job, signed `x-pods-signature`, retried with backoff for 24 h, with a delivery log.

## Acceptance tests

- `S14: every app/api/v1 route+method appears in pods-management.openapi.yaml and vice versa`.
- `S14: personal token permissions = scopes ∩ current user permissions; removing the user from the org makes the token useless immediately`.
- `S14: service token cannot be granted scopes the creator lacks`.
- `S14: Idempotency-Key replay returns identical response and creates one resource; different body → 422`.
- `S14: control-plane burst 40 then 429 with Retry-After`.
- `S14: CLI e2e against a local app instance: login → apis create → deploy → logs tail sees a request` (runtime test with fixture DB).
- `S14: plan on unchanged stack → no changes (exit 0); edited throttle → one update; removed API without --prune → reported, not deleted`.
- `S14: apply is re-runnable after an injected mid-run failure and converges`.
- `S14: tag rules — 51st tag rejected, reserved prefix rejected, unicode allowed`.
- `S14: event subscription receives signed deployment.create webhook`.
