# Pods Connector tunnel protocol

S04 §4. One WebSocket per agent. The agent dials **out** to the gateway
runtime (`wss://<gateway>/_connector`), so no inbound firewall rules are
needed. The gateway implementation is `lib/gateway/core/integrations/connector.mjs`
(hub); the agent is `connector/agent.mjs`.

## Connection setup

1. The agent opens a WebSocket to the gateway URL with
   `Authorization: Bearer <token>` (also carried in `hello`).
2. The agent sends a JSON control frame:
   `{ "type": "hello", "token": "pods_ctr_…", "agentId": "…", "allowedTargets": ["host:port", "CIDR:port"] }`.
3. The gateway looks the token up by sha256 hash, rejects unknown/revoked
   tokens with `{ "type": "error", "streamId": 0, "message": "…" }` and closes
   with code 4001, otherwise attaches the socket and replies
   `{ "type": "hello-ack", "agentId": "…" }`.

## Frames

- **Control frames** are JSON text messages with a `type` field:
  - `hello` / `hello-ack` — handshake (above).
  - `ping {id}` / `pong {id}` — gateway heartbeat every 10 s. An agent that
    misses 3 pings is marked dead; the connector is `AVAILABLE` with ≥1
    healthy agent, `DEGRADED` when some are lost, `FAILED` when none have
    been seen for 5 min.
  - `open {streamId, method, url, headers}` — gateway asks the agent to fetch
    a private URL. The gateway checks `allowed_targets` first; the agent
    enforces them locally too and replies `error` when denied.
  - `response-head {streamId, status, headers}` — agent answers a stream.
  - `credit {streamId, bytes}` — flow-control replenishment (below).
  - `end {streamId, direction}` — `direction` is `"request"` (client body
    fully sent) or `"response"` (upstream body fully sent).
  - `close {streamId}` — abort a stream (timeout, oversize body, shutdown).
  - `error {streamId, message}` — stream failed with a message (no secrets).
- **Data frames** are binary: a 4-byte big-endian unsigned `streamId` prefix
  followed by up to 64 KB of payload.

## Stream lifecycle

```
gateway → open(s=1, POST https://orders.internal:8080/items, headers)
gateway → data[1] … (request body chunks, only when non-empty)
gateway → end(s=1, "request")
agent   → response-head(s=1, 200, headers)
agent   → data[1] … (response body chunks)
agent   → end(s=1, "response")
```

The agent buffers the request body until `end("request")` and then performs
one private `fetch` (streaming proxying is a future optimization). Response
bodies stream back as data frames, so large payloads never sit whole in
either side's memory beyond the window.

## Flow control

Per-stream credit-based window of **256 KB** (`WINDOW_BYTES`). A sender may
have at most 256 KB of unacknowledged bytes outstanding per stream; the
receiver sends `credit {streamId, bytes}` as it consumes. Both directions
(chunked request upload, chunked response download) honor the same window.
Data frames are at most 64 KB (`CHUNK_BYTES`).

## Multiple agents

A connector may run many agents (availability zones, scale-out). The gateway
round-robins streams across healthy agents. Agents are independent: any
agent may serve any stream for its connector.

## Security properties

- Tokens authenticate the agent; only hashes are stored gateway-side.
- `allowed_targets` (`host:port` or `CIDR:port`) is enforced twice:
  gateway-side before `open`, agent-side before `fetch`.
- The SSRF guard is skipped for connector streams; the allow-list applies
  instead. `http(s)` schemes only.
- Secrets never cross the tunnel; backend auth is applied gateway-side.
