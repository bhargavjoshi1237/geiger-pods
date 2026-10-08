import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { wsArtifact, startWsGateway, stubFetch, jsonResponse } from "./helper.mjs";
import { IDLE_TIMEOUT_MS, MAX_DURATION_MS } from "../../lib/gateway/core/websocket/constants.mjs";

async function openOk(port, apiPublicId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${apiPublicId}/prod`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    setTimeout(() => reject(new Error("open timeout")), 5000);
  });
  return ws;
}

test("S12 [runtime]: idle 10 min and max 2 h enforced with injected clock; $disconnect invoked with reason", async () => {
  const disconnects = [];
  const fetch = stubFetch([{
    match: "fn-disc",
    handler: async (_url, init) => {
      disconnects.push(JSON.parse(String(init.body)));
      return jsonResponse({ statusCode: 200, body: "bye" });
    },
  }]);
  let now = Date.UTC(2026, 9, 6, 12, 0, 0);
  const clock = { now: () => now };
  const artifact = {
    ...wsArtifact({ apiPublicId: "wstime00001" }),
    routes: [
      { id: "r-connect", routeKey: "$connect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
      {
        id: "r-disc", routeKey: "$disconnect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: "int-disc",
      },
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
    ],
    integrations: { "int-disc": { type: "FUNCTION_PROXY", function: { provider: "webhook", url: "http://fn.local/fn-disc" } } },
  };
  const { gateway, port } = await startWsGateway(artifact, { ports: { fetch }, clock });
  try {
    assert.equal(IDLE_TIMEOUT_MS, 10 * 60 * 1000);
    assert.equal(MAX_DURATION_MS, 2 * 60 * 60 * 1000);
    // Idle: connect, advance past 10 min, expect 1001 + $disconnect.
    const idle = await openOk(port, artifact.apiPublicId);
    const idleClose = new Promise((resolve, reject) => {
      idle.once("close", (code) => resolve(code));
      setTimeout(() => reject(new Error("idle close timeout")), 5000);
    });
    now += IDLE_TIMEOUT_MS + 1000;
    await gateway.wsManager.checkTimeouts(now);
    assert.equal(await idleClose, 1001);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(disconnects.length >= 1);
    assert.match(JSON.stringify(disconnects[disconnects.length - 1]), /idle/);
    // Max duration: fresh connection, advance past 2 h.
    const long = await openOk(port, artifact.apiPublicId);
    const maxClose = new Promise((resolve, reject) => {
      long.once("close", (code) => resolve(code));
      setTimeout(() => reject(new Error("max close timeout")), 5000);
    });
    now += MAX_DURATION_MS + 1000;
    await gateway.wsManager.checkTimeouts(now);
    assert.equal(await maxClose, 1001);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match(JSON.stringify(disconnects[disconnects.length - 1]), /max duration/);
  } finally {
    await gateway.close();
  }
});

test("S12 [runtime]: graceful shutdown closes with 1001 and runs $disconnect for all connections", async () => {
  const disconnects = [];
  const fetch = stubFetch([{
    match: "fn-disc",
    handler: async (_url, init) => {
      disconnects.push(JSON.parse(String(init.body)));
      return jsonResponse({ statusCode: 200, body: "bye" });
    },
  }]);
  const artifact = {
    ...wsArtifact({ apiPublicId: "wsshut00001" }),
    routes: [
      { id: "r-connect", routeKey: "$connect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
      { id: "r-disc", routeKey: "$disconnect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: "int-disc" },
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
    ],
    integrations: { "int-disc": { type: "FUNCTION_PROXY", function: { provider: "webhook", url: "http://fn.local/fn-disc" } } },
  };
  const { gateway, port } = await startWsGateway(artifact, { ports: { fetch } });
  const sockets = [];
  for (let index = 0; index < 3; index += 1) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${artifact.apiPublicId}/prod`);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      setTimeout(() => reject(new Error("open timeout")), 5000);
    });
    sockets.push(ws);
  }
  const closes = sockets.map((ws) => new Promise((resolve, reject) => {
    ws.once("close", (code) => resolve(code));
    setTimeout(() => reject(new Error("shutdown close timeout")), 8000);
  }));
  await gateway.close();
  const codes = await Promise.all(closes);
  for (const code of codes) assert.equal(code, 1001);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(disconnects.length, 3);
});
