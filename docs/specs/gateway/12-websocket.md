# S12 — WebSocket APIs

**Wave 5 · Depends on: S05, S07, S08 (S06 for templates/models, S10 for metrics) · Runtime: `gateway/` only, not the Vercel adapter**

AWS references: [WebSocket API overview](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html), [routes & route selection](https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-develop-routes.html), [`$connect`/`$disconnect`](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-route-keys-connect-disconnect.html), [integrations & responses](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-integration-responses.html), [route responses](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-route-response.html), [selection expressions](https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-selection-expressions.html), [`@connections` API](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html), [WebSocket quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html), [WebSocket logging/metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-logging.html).

## 1. Configuration (reuses S03/S04/S06 tables)

- API: `protocol = WEBSOCKET`, `route_selection_expression` (required; e.g. `$request.body.action`, or `${request.body.action}` style), `api_key_selection_expression` (default `$request.header.x-api-key`).
- Routes (`pods.http_routes` rows with free-form `route_key`): `$connect`, `$disconnect`, `$default` and custom keys. Per route: `authorization_type` (`NONE`/`SIGNED`/`CUSTOM`, **`$connect` only**), `api_key_required` (`$connect` only), `integration_id`, `request_models` + `model_selection_expression` (message validation, S06 draft-04), `route_response_selection_expression` (`$default` enables two-way responses).
- `pods.route_responses`: `route_id`, `route_response_key` (`$default`), `response_models`, `model_selection_expression`.
- Integrations: `HTTP_PROXY`, `HTTP`, `MOCK`, `FUNCTION_PROXY`, `FUNCTION`, `AWS_SERVICE`, plus `integration_response_selection_expression` (`${integration.response.statuscode}`) and `template_selection_expression` (for request templates; default `\$default`).
- Integration responses: keyed by `integration_response_key` (`$default` or `/4\d\d/`-style regex on status).

## 2. Connection lifecycle (`core/websocket/`)

1. **Upgrade request** (`GET` with `Upgrade: websocket` on `wss://{apiPublicId}.{domain}/{stage}` or a custom domain mapping). Run phases 1–5 (resolve, endpoint access, WAF), then for the `$connect` route: authorization (S07 — SIGNED or CUSTOM REQUEST authorizer with `eventType: CONNECT`), API key check (S08), throttle (stage/route + project), and integration invoke if `$connect` has one.
   - Integration success (2xx / function proxy `statusCode` 2xx) → complete the handshake (`101`). Otherwise reject the upgrade with that HTTP status (e.g. 401/403/500), and do not create the connection. If the authorizer denies → 401/403 HTTP response.
   - **Subprotocols:** if the `$connect` integration response includes `Sec-WebSocket-Protocol`, echo it. Otherwise none is selected (AWS behavior).
   - No `$connect` route → connect with no integration.
2. **Connection id**: 16-char base64url (e.g. `L0SM9cOFvHcCIhw=`-like) via `crypto.randomBytes(12)`. Register it in KV as `ws:conn:{connectionId}` → `{instanceId, apiId, stage, deploymentId, connectedAt, sourceIp, userAgent, authorizer context, apiKeyId, lastActiveAt}`. TTL = max duration + 60 s.
3. **Messages** (client → gateway): a text or binary frame. Messages > **128 KB** or frames > **32 KB** → close with 1009 (AWS quotas). Fragmented frames are reassembled up to 128 KB.
   - Route selection: evaluate `route_selection_expression` against the message. A JSON body is required for `$request.body.*`; non-JSON → `$default`. A selected key with no matching route → `$default`. No `$default` → send the error frame `{"message": "Forbidden", "connectionId":"…", "requestId":"…"}`.
   - Per message: route throttling, model validation (`model_selection_expression`, failure → error frame `{"message":"Could not parse request body into json…"}` / validation message), request template (selected by `template_selection_expression`), integration invoke.
   - **Two-way**: if the route has `route_response_selection_expression = $default`, the integration response (after integration-response templates) is sent back to the client as a frame. Otherwise the result is discarded.
   - Integration failure → error frame `{"message":"Internal server error","connectionId":"…","requestId":"…"}`.
   - Each message gets its own `requestId`, `messageId` and `$context.eventType = MESSAGE`, `messageDirection = IN`.
4. **`$disconnect`**: invoked best-effort after the socket closes, for any reason (client close, idle, max duration, `DELETE @connections`, server shutdown). It cannot send to the connection. Its result is ignored. `$context.disconnectStatusCode` and `disconnectReason` are set.
5. **Limits:** max connection duration **2 h** (close 1001 `Going away`). Idle timeout **10 min** without client frames; pings count (close 1001). The runtime sends a protocol ping every 30 s to detect dead peers. New connection rate is limited by the project throttle (AWS: 500 new connections/s per account). Each connection's outbound queue is capped at 1 MB; over the cap → close 1008.

## 3. Event formats (`FUNCTION_PROXY`)

```json
{ "requestContext": { "routeKey": "sendmessage", "eventType": "MESSAGE", "messageId": "…", "extendedRequestId": "…",
    "requestTime": "…", "messageDirection": "IN", "stage": "prod", "connectedAt": 1710000000000,
    "requestTimeEpoch": 1710000000123, "identity": { "sourceIp": "…", "userAgent": "…" }, "requestId": "…",
    "domainName": "…", "connectionId": "…", "apiId": "…", "authorizer": { /* from $connect */ } },
  "body": "{\"action\":\"sendmessage\",\"data\":\"hi\"}", "isBase64Encoded": false }
```
`$connect` events also include `headers`, `multiValueHeaders`, `queryStringParameters` and `multiValueQueryStringParameters`, with `eventType: "CONNECT"`. `$disconnect` has `eventType: "DISCONNECT"`, `disconnectStatusCode` and `disconnectReason`. The response for two-way routes is `{statusCode, body}`, or a plain body.

## 4. `@connections` management API

Exposed on the runtime at `https://{apiPublicId}.{domain}/{stage}/@connections/{connectionId}`, and on custom domains through their mappings:
- `POST` — body (≤ 128 KB) sent to the client as a text frame (binary if `Content-Type: application/octet-stream`). Returns 200 when delivered to the owning instance's socket buffer, 410 `GoneException` if the connection doesn't exist, 413 if too large, 429 if the connection's outbound queue is full.
- `GET` — `{ "connectedAt": "ISO", "identity": {"sourceIp","userAgent"}, "lastActiveAt": "ISO" }`, or 410.
- `DELETE` — close the connection with 1000 and run `$disconnect`. 204, or 410.
- **Authorization:** SIGNED (S07) with action `execute-api:ManageConnections` on `arn:pods:execute-api:{region}:{projectId}:{apiPublicId}/{stage}/POST/@connections/{connectionId}` (and `GET`/`DELETE` variants). These are the same semantics as AWS IAM for `@connections`.
- **Control-plane mirror:** `POST/GET/DELETE /api/v1/projects/{p}/apis/{apiId}/stages/{stage}/connections/{connectionId}` (permission `pods.connection.manage`), for testing from the UI.
- **Cross-instance delivery:** if the connection's `instanceId` ≠ the current instance, publish `{op, connectionId, payload, replyTo}` on KV channel `ws:inst:{instanceId}` and await the reply on `ws:reply:{nonce}` (timeout 5 s → 410 if the registry entry is gone, else 504). The owning instance acknowledges after enqueueing to the socket.
- **Instance liveness:** heartbeat `ws:instance:{id}` every 10 s with a 30 s TTL. Registry entries pointing to a dead instance are treated as gone (410) and cleaned up lazily.

## 5. Scaling, shutdown, reconnects

- Any number of runtime instances; connections are sticky to the instance holding the socket.
- Graceful shutdown: stop accepting upgrades, close all sockets with 1001, and run `$disconnect` for each (bounded concurrency 50, total ≤ 20 s).
- Clients are expected to reconnect. The docs include a reconnect-with-backoff snippet. Pods does not resume sessions (AWS parity).

## 6. Observability & usage

Metrics (S10): `ConnectCount`, `MessageCount` (both directions, as AWS counts), `IntegrationError`, `ClientError`, `ExecutionError` and `IntegrationLatency`, with dimensions `ApiId`, `Stage` and `Route` (detailed). Access log per connect, message and disconnect event, with `$context.eventType`, `connectionId`, `messageId`. Execution logs per route-level `loggingLevel`. Quota (S08) counts `$connect` plus each message against the key identified at connect.

## 7. Screens

- WebSocket API detail: *Routes* tab (route selection expression editor with a live evaluator, routes list including `$connect`/`$disconnect`/`$default`, per-route integration, models, two-way toggle, route responses), *Integrations* with integration-response keys and template selection expression.
- Stage page: the connection URL (`wss://…`) and the `@connections` URL. A **live test console** connects to the deployed stage from the browser, sends JSON frames, shows received frames, and can POST/DELETE via the control-plane mirror.

## Acceptance tests

- `S12 [runtime]: connect → $connect function invoked with CONNECT event; non-2xx rejects upgrade with that status`.
- `S12 [runtime]: CUSTOM authorizer on $connect with query-string identity source; deny → 403 upgrade response; context available in later MESSAGE events`.
- `S12 [runtime]: api key required on $connect via apiKeySelectionExpression`.
- `S12: route selection — JSON action match, unknown action → $default, non-JSON → $default, no $default → Forbidden error frame`.
- `S12 [runtime]: two-way route returns integration response frame; one-way route returns nothing`.
- `S12 [runtime]: 129 KB message closed with 1009; fragmented 100 KB message accepted`.
- `S12 [runtime]: idle 10 min and max 2 h enforced with injected clock; $disconnect invoked with reason`.
- `S12 [runtime]: @connections POST/GET/DELETE with SigV4 ManageConnections policy; unsigned → 403; unknown id → 410`.
- `S12 [runtime]: two runtime instances — POST via instance B delivers to client on instance A; instance A killed → POST returns 410 within 30 s`.
- `S12 [runtime]: graceful shutdown closes with 1001 and runs $disconnect for all connections`.
- `S12: model validation failure returns error frame and does not invoke integration`.
- `S12: metrics ConnectCount/MessageCount reconcile with test traffic`.
- `S12 [load]: 5,000 concurrent connections on one instance, 1,000 msg/s fan-out via @connections, p99 delivery < 100 ms locally` (printed benchmark; threshold asserted at 500 ms).
