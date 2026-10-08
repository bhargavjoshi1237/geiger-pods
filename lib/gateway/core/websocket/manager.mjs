/**
 * WebSocket runtime manager (S12 §2/§4/§5).
 *
 * Owns one gateway instance's sockets: upgrade authentication (`$connect`),
 * message routing, `@connections` delivery (local + cross-instance via the
 * KV port), idle/max timers (injected clock), heartbeats and graceful
 * shutdown (1001 + `$disconnect`).
 *
 * Uses the `ws` package for RFC 6455 framing (justification in S12 report:
 * hand-rolling framing risks interop bugs; `ws` is small, maintained and
 * already a dependency). Limits (128 KB message, 10 min idle, 2 h max,
 * 1 MB outbound) are enforced here; the 32 KB per-frame quota (S12 §2) is
 * enforced by the streaming sniffer in `./frames.mjs`, which watches the
 * inbound byte stream ahead of `ws` reassembly (F37).
 *
 * @module lib/gateway/core/websocket/manager
 */

import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { buildContext } from "../context.mjs";
import { GatewayError } from "../errors.mjs";
import { buildRequestEvent } from "../observe/event.mjs";
import {
  MAX_MESSAGE_BYTES,
  OUTBOUND_QUEUE_MAX_BYTES,
  IDLE_TIMEOUT_MS,
  MAX_DURATION_MS,
  PING_INTERVAL_MS,
  CROSS_INSTANCE_TIMEOUT_MS,
  INSTANCE_HEARTBEAT_MS,
  instanceChannel,
  replyChannel,
} from "./constants.mjs";
import { findConnectRoute, authenticateConnect } from "./connect.mjs";
import { handleWsMessage } from "./message.mjs";
import { selectRoute, forbiddenFrame, integrationErrorFrame } from "./selection.mjs";
import { parseMessageBody } from "./selection.mjs";
import { createFrameMonitor, closeFrame } from "./frames.mjs";
import { newConnectionId, registerConnection, deleteConnection, getConnection, touchConnection, heartbeatInstance } from "./registry.mjs";
import { buildConnectEvent, buildDisconnectEvent } from "./events.mjs";
import { authorizeManageConnections, assertPostBodySize } from "./connections-api.mjs";

/**
 * @typedef {object} WsManagerOptions
 * @property {object} loader - `resolve(host, path)` (S05).
 * @property {object} [ports] - Engine ports (`kv`, `fetch`, `events`, `clock`, `log`, ...).
 * @property {string} [instanceId]
 * @property {{ now(): number }} [clock]
 */

function formatClfTime(when) {
  const date = new Date(when);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getUTCDate())}/${months[date.getUTCMonth()]}/${date.getUTCFullYear()}:${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

function sourceIpFrom(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "";
}

/**
 * Creates a WebSocket manager for one gateway instance.
 *
 * @param {WsManagerOptions} options
 * @returns {{ instanceId: string, connections: Map, attach(server): void,
 *   handleConnectionsHttp(args): Promise<Response>, checkTimeouts(now:number): Promise<void>,
 *   shutdown(): Promise<void>, close(): Promise<void> }}
 */
export function createWebSocketManager({ loader, ports = {}, instanceId = null, clock = null } = {}) {
  if (!loader || typeof loader.resolve !== "function") throw new TypeError("createWebSocketManager requires loader.resolve.");
  const useClock = clock ?? ports.clock ?? { now: () => Date.now() };
  const usePorts = { ...ports, clock: useClock, kv: ports.kv ?? null };
  const id = instanceId ?? `inst-${randomUUID().slice(0, 8)}`;
  /** connectionId → { ws, record, lastActiveAt, connectedAt, timers } */
  const connections = new Map();
  let wss = null;
  let heartbeatTimer = null;
  let pingTimer = null;
  let accepting = true;
  const kv = () => usePorts.kv;

  function emitWsEvent({ ctxBase, status, eventType, routeKey, connectionId, latencyMs = null, integrationLatencyMs = null }) {
    try {
      const ctx = ctxBase ?? {};
      const eventCtx = {
        requestId: ctx.requestId ?? "",
        startTime: ctx.startTime ?? useClock.now(),
        context: {
          ...(ctx.context ?? {}),
          eventType,
          routeKey: routeKey ?? ctx.context?.routeKey ?? "",
          connectionId,
          status: String(status),
        },
        artifact: ctx.artifact ?? {},
        stage: ctx.stage ?? ctx.artifact?.stage ?? "",
        apiPublicId: ctx.apiPublicId ?? ctx.artifact?.apiPublicId ?? "",
      };
      const response = new Response(null, { status });
      const event = buildRequestEvent(eventCtx, response, { latencyMs, integrationLatencyMs });
      event.eventType = eventType;
      event.connectionId = connectionId;
      usePorts.events?.emit?.(event);
    } catch {
      // Observability never breaks the data path.
    }
  }

  async function invokeDisconnect(record, reason, code) {
    if (!record) return;
    try {
      const artifact = record.artifact ?? null;
      if (!artifact) return;
      const route = (artifact.routes ?? []).find((entry) => entry?.routeKey === "$disconnect") ?? null;
      if (!route?.integrationId) return;
      const integration = artifact.integrations?.[route.integrationId] ?? null;
      if (!integration) return;
      const event = buildDisconnectEvent({
        stage: record.stage ?? "",
        connectedAt: record.connectedAt ?? 0,
        requestTimeEpoch: useClock.now(),
        requestTime: formatClfTime(useClock.now()),
        requestId: `req-${randomUUID().slice(0, 8)}`,
        extendedRequestId: `ext-${randomUUID().slice(0, 8)}`,
        connectionId: record.connectionId,
        apiId: artifact.apiPublicId ?? artifact.apiId ?? "",
        sourceIp: record.sourceIp ?? "",
        userAgent: record.userAgent ?? "",
        authorizer: record.authorizerContext ?? null,
        disconnectStatusCode: code,
        disconnectReason: reason,
      });
      const fetchFn = usePorts.fetch ?? globalThis.fetch;
      const url = integration.function?.url ?? integration.uri ?? null;
      if (!url) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event), signal: controller.signal, redirect: "manual" }).catch(() => null);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Best-effort ($disconnect results are ignored).
    }
  }

  async function removeConnection(connectionId, { code = 1000, reason = "" } = {}) {
    const entry = connections.get(connectionId);
    if (entry) {
      connections.delete(connectionId);
      try {
        if (entry.ws?.readyState === WebSocket.OPEN) entry.ws.close(code, reason);
      } catch {
        // Best-effort.
      }
    }
    if (kv()) await deleteConnection(kv(), connectionId);
    if (entry?.record) {
      await invokeDisconnect(entry.record, reason || "close", code);
      emitWsEvent({ ctxBase: entry.ctx, status: 200, eventType: "DISCONNECT", routeKey: "$disconnect", connectionId });
    }
  }

  /**
   * Checks idle (10 min) and max-duration (2 h) expirations with an
   * injected clock (deterministic for tests; the background pinger calls
   * this with `clock.now()`).
   *
   * @param {number} now
   */
  async function checkTimeouts(now) {
    const expired = [];
    for (const [connectionId, entry] of connections) {
      const idleFor = now - (entry.lastActiveAt ?? entry.connectedAt ?? now);
      const age = now - (entry.connectedAt ?? now);
      if (age >= MAX_DURATION_MS) expired.push({ connectionId, reason: "max duration", code: 1001 });
      else if (idleFor >= IDLE_TIMEOUT_MS) expired.push({ connectionId, reason: "idle", code: 1001 });
    }
    for (const { connectionId, reason, code } of expired) {
      const entry = connections.get(connectionId);
      if (entry) {
        try {
          entry.ws.close(code, reason);
        } catch {
          // Best-effort.
        }
      }
      await removeConnection(connectionId, { code, reason });
    }
  }

  function startTimers() {
    if (kv()) {
      void heartbeatInstance(kv(), id, useClock.now());
      heartbeatTimer = setInterval(() => {
        void heartbeatInstance(kv(), id, useClock.now()).catch(() => {});
      }, INSTANCE_HEARTBEAT_MS);
      if (heartbeatTimer.unref) heartbeatTimer.unref();
    }
    pingTimer = setInterval(() => {
      void checkTimeouts(useClock.now()).catch(() => {});
      for (const entry of connections.values()) {
        try {
          if (entry.ws?.readyState === WebSocket.OPEN) entry.ws.ping();
        } catch {
          // Best-effort.
        }
      }
    }, PING_INTERVAL_MS);
    if (pingTimer?.unref) pingTimer.unref();
    // Cross-instance channel.
    try {
      kv()?.subscribe?.(instanceChannel(id), (message) => {
        void handleInstanceMessage(message).catch(() => {});
      });
    } catch {
      // Best-effort (memory KV always supports subscribe).
    }
  }

  async function handleInstanceMessage(message) {
    let parsed = null;
    try {
      parsed = JSON.parse(String(message));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const { op, connectionId, payload, replyTo } = parsed;
    const entry = connections.get(connectionId);
    if (op === "send") {
      if (!entry || entry.ws?.readyState !== WebSocket.OPEN) {
        if (replyTo && kv()) await kv().publish(replyChannel(replyTo.split(":")[1] ?? replyTo), JSON.stringify({ ok: false, gone: true })).catch(() => {});
        // Fallback: publish on the exact reply channel name.
        if (replyTo && kv()) await kv().publish(replyTo, JSON.stringify({ ok: false, gone: true })).catch(() => {});
        return;
      }
      const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
      const queued = (entry.ws.bufferedAmount ?? 0) + Buffer.byteLength(text, "utf8");
      if (queued > OUTBOUND_QUEUE_MAX_BYTES) {
        try {
          entry.ws.close(1008, "outbound queue full");
        } catch {
          // Best-effort.
        }
        if (replyTo && kv()) await kv().publish(replyTo, JSON.stringify({ ok: false, full: true })).catch(() => {});
        return;
      }
      entry.ws.send(text, { binary: parsed.binary === true }, (error) => {
        if (replyTo && kv()) {
          void kv().publish(replyTo, JSON.stringify(error ? { ok: false, gone: false } : { ok: true })).catch(() => {});
        }
      });
      emitWsEvent({ ctxBase: entry.ctx, status: 200, eventType: "MESSAGE", routeKey: "@connections", connectionId });
    } else if (op === "close") {
      if (!entry) {
        if (replyTo && kv()) await kv().publish(replyTo, JSON.stringify({ ok: false, gone: true })).catch(() => {});
        return;
      }
      try {
        entry.ws.close(1000, "manage connections delete");
      } catch {
        // Best-effort.
      }
      await removeConnection(connectionId, { code: 1000, reason: "manage connections delete" });
      if (replyTo && kv()) await kv().publish(replyTo, JSON.stringify({ ok: true })).catch(() => {});
    }
  }

  async function requestRemote(instance, message) {
    if (!kv() || typeof kv().publish !== "function") return { ok: false, gone: true };
    const nonce = randomUUID().replace(/-/g, "").slice(0, 12);
    const channel = replyChannel(nonce);
    const outcome = await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, timeout: true });
        }
      }, CROSS_INSTANCE_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      let unsub = null;
      const onReply = (raw) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          unsub?.();
        } catch {
          // Best-effort.
        }
        try {
          resolve(JSON.parse(String(raw)));
        } catch {
          resolve({ ok: false });
        }
      };
      try {
        const maybe = kv().subscribe(channel, onReply);
        if (maybe && typeof maybe.then === "function") {
          maybe.then((fn) => {
            unsub = fn;
          }).catch(() => {});
        } else {
          unsub = maybe;
        }
      } catch {
        clearTimeout(timer);
        resolve({ ok: false, timeout: true });
        return;
      }
      void kv().publish(instanceChannel(instance), JSON.stringify({ ...message, replyTo: channel })).then(() => {}).catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, timeout: true });
        }
      });
    });
    return outcome;
  }

  async function deliverToConnection(record, payload, { binary = false } = {}) {
    const connectionId = record?.connectionId ?? "";
    const entry = connections.get(connectionId);
    if (entry && entry.ws?.readyState === WebSocket.OPEN) {
      const text = typeof payload === "string" ? payload : String(payload ?? "");
      const queued = (entry.ws.bufferedAmount ?? 0) + Buffer.byteLength(text, "utf8");
      if (queued > OUTBOUND_QUEUE_MAX_BYTES) {
        try {
          entry.ws.close(1008, "outbound queue full");
        } catch {
          // Best-effort.
        }
        const error = new GatewayError("THROTTLED", "Too Many Requests");
        error.status = 429;
        throw error;
      }
      await new Promise((resolve, reject) => {
        entry.ws.send(text, { binary }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      emitWsEvent({ ctxBase: entry.ctx, status: 200, eventType: "MESSAGE", routeKey: "@connections", connectionId });
      return;
    }
    // Cross-instance.
    const owner = record?.instanceId ?? null;
    if (owner && owner !== id && kv()) {
      const reply = await requestRemote(owner, { op: "send", connectionId, payload: typeof payload === "string" ? payload : String(payload ?? ""), binary });
      if (reply?.ok) {
        emitWsEvent({ ctxBase: null, status: 200, eventType: "MESSAGE", routeKey: "@connections", connectionId });
        return;
      }
      if (reply?.gone) {
        const error = new GatewayError("RESOURCE_NOT_FOUND", "Gone");
        error.status = 410;
        throw error;
      }
      if (reply?.full) {
        const error = new GatewayError("THROTTLED", "Too Many Requests");
        error.status = 429;
        throw error;
      }
      // Timeout: re-check the registry (410 when gone, else 504).
      const fresh = await getConnection(kv(), connectionId).catch(() => null);
      if (!fresh) {
        const error = new GatewayError("RESOURCE_NOT_FOUND", "Gone");
        error.status = 410;
        throw error;
      }
      const error = new GatewayError("INTEGRATION_TIMEOUT", "Endpoint request timed out");
      error.status = 504;
      throw error;
    }
    const error = new GatewayError("RESOURCE_NOT_FOUND", "Gone");
    error.status = 410;
    throw error;
  }

  /**
   * Handles `@connections` HTTP (called by `gateway/server.mjs` before the
   * REST/HTTP pipeline). Returns a Web `Response`.
   */
  async function handleConnectionsHttp({ request, apiPublicId, stage, connectionId, body, resolved = null }) {
    const effective = resolved ?? await loader.resolve(request.headers.get("host") ?? "", `/${apiPublicId}/${stage}/@connections/${connectionId}`).catch(() => null);
    const artifact = effective?.artifact ?? null;
    if (!artifact || (artifact.protocol ?? "WEBSOCKET") !== "WEBSOCKET") {
      return new Response(JSON.stringify({ message: "Gone" }), { status: 410, headers: { "content-type": "application/json" } });
    }
    const fullArtifact = { ...artifact, stage: effective.stage ?? stage, stageVariables: effective.stageVariables ?? {} };
    const method = (request.method ?? "GET").toUpperCase();
    try {
      await authorizeManageConnections(request, { artifact: fullArtifact, stage: effective.stage ?? stage, connectionId, method, ports: usePorts });
    } catch {
      return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
    }
    const record = kv() ? await getConnection(kv(), connectionId).catch(() => null) : connections.get(connectionId)?.record ?? null;
    if (method === "GET") {
      if (!record) {
        return new Response(JSON.stringify({ message: "Gone" }), { status: 410, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        connectedAt: new Date(record.connectedAt ?? Date.now()).toISOString(),
        identity: { sourceIp: record.sourceIp ?? "", userAgent: record.userAgent ?? "" },
        lastActiveAt: new Date(record.lastActiveAt ?? record.connectedAt ?? Date.now()).toISOString(),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "DELETE") {
      if (!record) {
        return new Response(JSON.stringify({ message: "Gone" }), { status: 410, headers: { "content-type": "application/json" } });
      }
      const owner = record.instanceId ?? null;
      if ((!owner || owner === id) && connections.has(connectionId)) {
        await removeConnection(connectionId, { code: 1000, reason: "manage connections delete" });
        return new Response(null, { status: 204 });
      }
      if (owner && owner !== id && kv()) {
        const reply = await requestRemote(owner, { op: "close", connectionId });
        if (reply?.ok || reply?.gone) {
          if (reply?.gone) await deleteConnection(kv(), connectionId).catch(() => {});
          else await deleteConnection(kv(), connectionId).catch(() => {});
          return reply?.ok ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ message: "Gone" }), { status: 410, headers: { "content-type": "application/json" } });
        }
        const fresh = await getConnection(kv(), connectionId).catch(() => null);
        if (!fresh) return new Response(JSON.stringify({ message: "Gone" }), { status: 410, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ message: "Endpoint request timed out" }), { status: 504, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "Gone" }), { status: 410, headers: { "content-type": "application/json" } });
    }
    // POST: deliver.
    if (method === "POST") {
      try {
        assertPostBodySize(body);
      } catch {
        return new Response(JSON.stringify({ message: "Request Too Long" }), { status: 413, headers: { "content-type": "application/json" } });
      }
      if (!record) {
        return new Response(JSON.stringify({ message: "Gone" }), { status: 410, headers: { "content-type": "application/json" } });
      }
      const contentType = request.headers.get("content-type") ?? "";
      const binary = contentType.includes("application/octet-stream");
      const payload = body ? Buffer.from(body).toString(binary ? "base64" : "utf8") : "";
      // For binary, deliver raw bytes; for text, the UTF-8 string.
      const wire = binary ? Buffer.from(body) : payload;
      try {
        // Local fast path keeps binary frames binary; remote JSON carries base64.
        if (connections.has(connectionId)) {
          const entry = connections.get(connectionId);
          const queued = (entry.ws.bufferedAmount ?? 0) + (wire?.length ?? 0);
          if (queued > OUTBOUND_QUEUE_MAX_BYTES) {
            return new Response(JSON.stringify({ message: "Too Many Requests" }), { status: 429, headers: { "content-type": "application/json" } });
          }
          await new Promise((resolve, reject) => {
            entry.ws.send(wire, { binary }, (error) => {
              if (error) reject(error);
              else resolve();
            });
          });
          emitWsEvent({ ctxBase: entry.ctx, status: 200, eventType: "MESSAGE", routeKey: "@connections", connectionId });
          return new Response(null, { status: 200 });
        }
        await deliverToConnection(record, binary ? Buffer.from(body).toString("base64") : payload, { binary });
        return new Response(null, { status: 200 });
      } catch (error) {
        const status = error?.status ?? 500;
        if (status === 410) return new Response(JSON.stringify({ message: "Gone" }), { status: 410, headers: { "content-type": "application/json" } });
        if (status === 429) return new Response(JSON.stringify({ message: "Too Many Requests" }), { status: 429, headers: { "content-type": "application/json" } });
        if (status === 504) return new Response(JSON.stringify({ message: "Endpoint request timed out" }), { status: 504, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ message: "Internal server error" }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  }

  async function handleUpgradeRaw(req, socket, head) {
    if (!accepting) {
      socket.destroy();
      return;
    }
    const host = req.headers.host ?? "";
    const rawPath = (req.url ?? "/").split("?")[0] || "/";
    // `@connections` never upgrades.
    if (rawPath.includes("@connections")) {
      socket.destroy();
      return;
    }
    let resolved = null;
    try {
      resolved = await loader.resolve(host, rawPath);
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    const artifact = resolved?.artifact ?? {};
    if ((artifact.protocol ?? "WEBSOCKET") !== "WEBSOCKET") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    const fullArtifact = {
      ...artifact,
      stage: resolved.stage ?? artifact.stage ?? "",
      stageVariables: resolved.stageVariables ?? {},
      deploymentId: resolved.deploymentId ?? artifact.deploymentId ?? null,
    };
    // Build a Web Request for the upgrade (headers + query preserved).
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const entry of value) headers.append(name, entry);
      } else {
        headers.append(name, String(value));
      }
    }
    const upgradeRequest = new Request(`http://${host}${req.url ?? "/"}`, { method: "GET", headers });
    const connectionId = newConnectionId();
    const now = useClock.now();
    const sourceIp = sourceIpFrom(req);
    const userAgent = req.headers["user-agent"] ?? "";
    const ctx = buildContext(upgradeRequest, fullArtifact, usePorts);
    ctx.requestId = ctx.requestId ?? connectionId;
    ctx.stage = resolved.stage ?? "";
    ctx.apiPublicId = resolved.apiPublicId ?? "";
    ctx.context.connectionId = connectionId;
    ctx.context.connectedAt = now;
    ctx.context.eventType = "CONNECT";
    ctx.context.routeKey = "$connect";
    ctx.context.stage = resolved.stage ?? "";
    ctx.match = { routeKey: "$connect" };
    // Endpoint access + WAF reuse (best-effort, same semantics as HTTP).
    try {
      const { run: runEndpoint } = await import("../phases/endpoint-access.mjs");
      const { run: runWaf } = await import("../phases/waf.mjs");
      if (resolved.customDomainMatch) ctx.customDomainMatch = resolved.customDomainMatch;
      ctx.viaDefaultEndpoint = resolved.viaDefaultEndpoint ?? true;
      const endpointOut = await runEndpoint(ctx);
      if (endpointOut instanceof Response) {
        socket.write(`HTTP/1.1 ${endpointOut.status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
        return;
      }
      const wafOut = await runWaf(ctx);
      if (wafOut instanceof Response) {
        socket.write(`HTTP/1.1 ${wafOut.status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
        return;
      }
    } catch (error) {
      const status = error instanceof GatewayError ? (error.status ?? 403) : 403;
      socket.write(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    const connectRoute = findConnectRoute(fullArtifact);
    let authorizerContext = null;
    let usageKey = null;
    if (connectRoute) {
      // `$connect`-only auth: authorization_type CUSTOM/SIGNED on $connect.
      if (connectRoute.auth?.type && !["NONE", "SIGNED", "CUSTOM"].includes(connectRoute.auth.type)) {
        socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      ctx.match = { routeKey: "$connect", routeId: connectRoute.id ?? null };
      try {
        const authenticated = await authenticateConnect(ctx, connectRoute);
        authorizerContext = authenticated.authorizerContext;
        if (ctx.usageKey) usageKey = ctx.usageKey;
      } catch (error) {
        const status = error instanceof GatewayError ? (error.status ?? 403) : 403;
        socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
        emitWsEvent({ ctxBase: ctx, status, eventType: "$connect", routeKey: "$connect", connectionId });
        return;
      }
      try {
        const { run: runThrottle } = await import("../phases/throttle.mjs");
        const { run: runQuota } = await import("../phases/quota.mjs");
        await runThrottle(ctx);
        await runQuota(ctx);
      } catch (error) {
        const status = error instanceof GatewayError ? (error.status ?? 429) : 429;
        socket.write(`HTTP/1.1 ${status} ${status === 429 ? "Too Many Requests" : "Forbidden"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
        emitWsEvent({ ctxBase: ctx, status, eventType: "$connect", routeKey: "$connect", connectionId });
        return;
      }
      // `$connect` integration: non-2xx rejects the upgrade with that status.
      if (connectRoute.integrationId) {
        const integration = fullArtifact.integrations?.[connectRoute.integrationId] ?? null;
        if (integration) {
          try {
            const { buildConnectEvent: buildConnect } = await import("./events.mjs");
            const url = new URL(upgradeRequest.url);
            const headersObj = {};
            const multi = {};
            for (const [key, value] of upgradeRequest.headers.entries()) {
              headersObj[key] = value;
              multi[key] = [value];
            }
            const event = buildConnect({
              stage: resolved.stage ?? "",
              connectedAt: now,
              requestTimeEpoch: now,
              requestTime: formatClfTime(now),
              requestId: ctx.requestId,
              extendedRequestId: ctx.context.extendedRequestId,
              connectionId,
              apiId: fullArtifact.apiPublicId ?? "",
              sourceIp,
              userAgent,
              headers: headersObj,
              multiValueHeaders: multi,
              queryStringParameters: url.searchParams.size > 0 ? Object.fromEntries(url.searchParams.entries()) : null,
              multiValueQueryStringParameters: url.searchParams.size > 0 ? Object.fromEntries([...url.searchParams.entries()].map(([k, v]) => [k, [v]])) : null,
              authorizer: authorizerContext,
            });
            const { invokeWsIntegration } = await import("./message.mjs");
            const invoked = await invokeWsIntegration(ctx, integration, event, "");
            const subprotocol = null;
            void subprotocol;
            if (invoked.status < 200 || invoked.status >= 300) {
              socket.write(`HTTP/1.1 ${invoked.status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
              socket.destroy();
              emitWsEvent({ ctxBase: ctx, status: invoked.status, eventType: "$connect", routeKey: "$connect", connectionId });
              return;
            }
          } catch (error) {
            const status = error instanceof GatewayError ? (error.status ?? 500) : 500;
            socket.write(`HTTP/1.1 ${status} Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            socket.destroy();
            emitWsEvent({ ctxBase: ctx, status, eventType: "$connect", routeKey: "$connect", connectionId });
            return;
          }
        }
      }
    }
    // Complete the handshake via `ws`.
    if (!wss) {
      socket.destroy();
      return;
    }
    // F37: per-frame 32 KB accounting (S12 §2). The monitor sniffs the
    // inbound byte stream ahead of `ws` reassembly: a single frame over
    // 32 KB closes with 1009 even though the reassembled message would fit
    // in 128 KB, while fragmented messages of small frames still pass. The
    // listener is registered before `handleUpgrade` so it always runs first
    // (clients must wait for the 101 before sending frames, so no bytes are
    // missed in the handover window). Closing is delegated to `ws` itself:
    // writing our own close frame to the socket races `ws`'s receiver error
    // path (it destroys the socket and the client observes a bare 1009-less
    // 1006 instead).
    let frameViolated = false;
    let wsRef = null;
    let frameCloseSent = false;
    const closeForFrameViolation = () => {
      if (frameCloseSent) return;
      frameCloseSent = true;
      frameViolated = true;
      if (wsRef) {
        try {
          wsRef.close(1009, "frame too large");
        } catch {
          // Best-effort.
        }
      } else {
        // No `ws` yet (violation inside `head`): no close handshake is
        // possible, so write the close frame and end the socket directly.
        try {
          if (!socket.destroyed) socket.end(closeFrame(1009, "frame too large"));
        } catch {
          // Best-effort.
        }
      }
    };
    const frameMonitor = createFrameMonitor({ onViolation: closeForFrameViolation });
    // `head` may already carry frame bytes (pipelined sends): account them
    // before `ws` parses them so violations there are caught too.
    if (head && head.length > 0) frameMonitor.feed(head);
    const sniffInbound = (chunk) => {
      frameMonitor.feed(chunk);
    };
    socket.on("data", sniffInbound);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wsRef = ws;
      if (frameViolated) {
        // A violation was already found in `head`: `ws` parsed those bytes
        // during the upgrade (its own error path covers > 128 KB); make
        // sure smaller single frames still close with 1009.
        try {
          if (ws.readyState === WebSocket.OPEN) ws.close(1009, "frame too large");
        } catch {
          // Best-effort.
        }
      }
      const record = {
        connectionId,
        instanceId: id,
        apiId: fullArtifact.apiId ?? "",
        apiPublicId: resolved.apiPublicId ?? fullArtifact.apiPublicId ?? "",
        stage: resolved.stage ?? "",
        deploymentId: fullArtifact.deploymentId ?? null,
        connectedAt: now,
        lastActiveAt: now,
        sourceIp,
        userAgent,
        authorizerContext,
        apiKey: ctx.usageKey ? { keyId: ctx.usageKey.keyId } : null,
        usageKey: usageKey ?? ctx.usageKey ?? null,
        plan: usageKey?.plan ?? ctx.usageKey?.plan ?? null,
        artifact: fullArtifact,
      };
      connections.set(connectionId, { ws, record, ctx, connectedAt: now, lastActiveAt: now });
      if (kv()) void registerConnection(kv(), connectionId, record).catch(() => {});
      emitWsEvent({ ctxBase: ctx, status: 101, eventType: "$connect", routeKey: "$connect", connectionId });
      // Subprotocol echo: when the $connect integration selects one, the
      // manager would negotiate here (AWS behavior). With no selection the
      // handshake completes with no subprotocol (handled by `ws`).
      let messageBytes = 0;
      let fragments = [];
      let fragmented = false;
      ws.on("message", (data, isBinary) => {
        void (async () => {
          const entry = connections.get(connectionId);
          if (!entry) return;
          // F37: the frame sniffer already closed the socket for an
          // oversized frame; never process the reassembled bytes as a
          // valid message (the close may still be flushing).
          if (frameViolated) {
            try {
              if (ws.readyState === WebSocket.OPEN) ws.close(1009, "frame too large");
            } catch {
              // Best-effort.
            }
            await removeConnection(connectionId, { code: 1009, reason: "frame too large" });
            return;
          }
          const at = useClock.now();
          entry.lastActiveAt = at;
          if (kv()) void touchConnection(kv(), connectionId, at).catch(() => {});
          const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
          // 128 KB message / 32 KB reassembled-chunk guard: `ws` already
          // caps reassembled messages at 128 KB (`maxPayload`); an
          // individual chunk over 32 KB that would overflow a single
          // frame closes with 1009 (fragmented 100 KB stays accepted).
          void fragments;
          void fragmented;
          void messageBytes;
          if (chunk.byteLength > MAX_MESSAGE_BYTES) {
            try {
              ws.close(1009, "message too large");
            } catch {
              // Best-effort.
            }
            await removeConnection(connectionId, { code: 1009, reason: "message too large" });
            return;
          }
          const started = useClock.now();
          const { handleWsMessage: handleOne } = await import("./message.mjs");
          const outcome = await handleOne({
            artifact: entry.record.artifact,
            body: chunk,
            isBase64: Boolean(isBinary),
            record: entry.record,
            ctxBase: { ...entry.ctx, ports: usePorts, usageKey: entry.record.usageKey ?? entry.ctx.usageKey },
          });
          const latency = useClock.now() - started;
          emitWsEvent({
            ctxBase: { ...entry.ctx, context: { ...(entry.ctx.context ?? {}), routeKey: outcome.routeKey ?? "$default" } },
            status: outcome.status,
            eventType: "MESSAGE",
            routeKey: outcome.routeKey ?? "$default",
            connectionId,
            latencyMs: latency,
          });
          if (outcome.frame !== null && outcome.frame !== undefined) {
            const frameBytes = Buffer.byteLength(outcome.frame, "utf8");
            const queued = (ws.bufferedAmount ?? 0) + frameBytes;
            if (queued > OUTBOUND_QUEUE_MAX_BYTES) {
              try {
                ws.close(1008, "outbound queue full");
              } catch {
                // Best-effort.
              }
              await removeConnection(connectionId, { code: 1008, reason: "outbound queue full" });
              return;
            }
            if (ws.readyState === WebSocket.OPEN) ws.send(outcome.frame);
          }
        })().catch(() => {});
      });
      ws.on("pong", () => {
        const entry = connections.get(connectionId);
        if (entry) {
          entry.lastActiveAt = useClock.now();
          if (kv()) void touchConnection(kv(), connectionId, entry.lastActiveAt).catch(() => {});
        }
      });
      ws.on("close", (code) => {
        void removeConnection(connectionId, { code, reason: "close" }).catch(() => {});
      });
      ws.on("error", () => {
        // `close` follows; nothing to do.
      });
    });
  }

  function attach(server) {
    wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    server.on("upgrade", (req, socket, head) => {
      const rawPath = (req.url ?? "/").split("?")[0] || "/";
      // Only WS APIs upgrade; the manager resolves + rejects otherwise.
      // `@connections` never upgrades.
      if (rawPath.includes("@connections")) {
        socket.destroy();
        return;
      }
      void handleUpgradeRaw(req, socket, head).catch(() => {
        try {
          socket.destroy();
        } catch {
          // Best-effort.
        }
      });
    });
    startTimers();
  }

  async function shutdown() {
    accepting = false;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pingTimer) clearInterval(pingTimer);
    const entries = [...connections.entries()];
    const workers = [];
    const queue = [...entries];
    async function worker() {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) return;
        const [connectionId, entry] = next;
        try {
          if (entry.ws?.readyState === WebSocket.OPEN) entry.ws.close(1001, "server shutdown");
        } catch {
          // Best-effort.
        }
        await removeConnection(connectionId, { code: 1001, reason: "server shutdown" });
      }
    }
    const { SHUTDOWN_CONCURRENCY, SHUTDOWN_TIMEOUT_MS } = await import("./constants.mjs");
    for (let index = 0; index < Math.min(SHUTDOWN_CONCURRENCY, Math.max(entries.length, 1)); index += 1) {
      workers.push(worker());
    }
    let shutdownTimer = null;
    await Promise.race([
      Promise.allSettled(workers).finally(() => {
        if (shutdownTimer) clearTimeout(shutdownTimer);
      }),
      new Promise((resolve) => {
        shutdownTimer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        if (shutdownTimer.unref) shutdownTimer.unref();
      }),
    ]);
    if (shutdownTimer) clearTimeout(shutdownTimer);
  }

  async function close() {
    await shutdown().catch(() => {});
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pingTimer) clearInterval(pingTimer);
    try {
      wss?.close();
    } catch {
      // Best-effort.
    }
  }

  return { instanceId: id, connections, attach, handleConnectionsHttp, checkTimeouts, shutdown, close, emitWsEvent, deliverToConnection, requestRemote };
}
