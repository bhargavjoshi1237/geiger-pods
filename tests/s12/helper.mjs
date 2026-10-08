/**
 * S12 test helpers: fixture artifacts, memory loader, stub ports, WS client.
 *
 * @module tests/s12/helper
 */

import { WebSocket } from "ws";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { createEventSink } from "../../lib/gateway/core/observe/event.mjs";
import { hmacForValue } from "../../lib/gateway/core/usage/api-key.mjs";

export const PEPPER = "test-pepper-s12";

/**
 * Builds a minimal WEBSOCKET artifact (already compiled shape, no DB).
 */
export function wsArtifact({ apiPublicId = "ws12345678", overrides = {} } = {}) {
  const base = {
    schemaVersion: 1,
    projectId: "proj-s12",
    apiId: "api-ws",
    apiPublicId,
    protocol: "WEBSOCKET",
    stage: "prod",
    settings: {
      routeSelectionExpression: "$request.body.action",
      apiKeySelectionExpression: "$request.header.x-api-key",
    },
    routes: [
      { id: "r-connect", routeKey: "$connect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
      { id: "r-disconnect", routeKey: "$disconnect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
    ],
    integrations: {},
    authorizers: {},
    models: {},
    ...overrides,
  };
  return base;
}

export function withRoute(artifact, route) {
  return { ...artifact, routes: [...(artifact.routes ?? []), route] };
}

/**
 * Starts a gateway with a WS artifact on path routing.
 */
export async function startWsGateway(artifact, { ports = {}, stage = "prod", clock = null } = {}) {
  const kv = ports.kv ?? new MemoryKvStore({ clock: clock ?? { now: () => Date.now() } });
  const sink = ports.events ?? createEventSink({ consumers: [] });
  const loader = createMemoryLoader({
    pathRouting: true,
    stages: new Map([[`${artifact.apiPublicId}:${stage}`, { artifact: { ...artifact, stage } }]]),
    kv,
  });
  const gateway = createGatewayServer({ loader, ports: { kv, events: sink, ...ports }, clock });
  const port = await gateway.start(0);
  return { gateway, port, kv, sink, loader, url: `http://127.0.0.1:${port}` };
}

/**
 * Opens a WS client to the gateway (path routing).
 */
export function openWs({ port, apiPublicId, stage = "prod", headers = {}, query = "" }) {
  const url = `ws://127.0.0.1:${port}/${apiPublicId}/${stage}${query}`;
  return new WebSocket(url, { headers });
}

export function waitOpen(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function waitMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws message timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    });
  });
}

export function waitClose(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws close timeout")), timeoutMs);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
  });
}

/**
 * Stub `fetch` routing by URL substring: `{ match: string, handler: (url, init) => Response }`.
 */
export function stubFetch(routes = []) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    for (const { match, handler } of routes) {
      if (href.includes(match)) return handler(href, init);
    }
    return new Response(JSON.stringify({ statusCode: 200, body: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  fetch.calls = calls;
  return fetch;
}

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

export function keyRecord({ keyId = "key-1", hmac, apiId = "api-ws", stage = "prod", planId = "plan-1" } = {}) {
  return { keyId, publicId: "pub-1", enabled: true, plans: [{ planId, apiId, stage }] };
}

export function usagePorts({ records = new Map(), pepper = PEPPER } = {}) {
  return {
    keyPepper: pepper,
    usage: {
      async loadKeyRecord(hmac) {
        return records.get(hmac) ?? null;
      },
    },
  };
}

export function hmacFor(value, pepper = PEPPER) {
  return hmacForValue(value, pepper);
}
