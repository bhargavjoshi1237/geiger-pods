import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { wsArtifact, startWsGateway } from "./helper.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { createEventSink } from "../../lib/gateway/core/observe/event.mjs";
import { signRequest } from "../../lib/gateway/core/auth/sigv4.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";

const ACCESS = "AKIDTEST0001";
const SECRET = "test-secret-000000000000000000000001";

function signingPorts() {
  return {
    signingCredentials: {
      async resolve(accessKeyId) {
        if (accessKeyId !== ACCESS) return null;
        return { secretAccessKey: SECRET, status: "ACTIVE" };
      },
    },
    signingPolicies: {
      async list(accessKeyId) {
        if (accessKeyId !== ACCESS) return [];
        return [{
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Action: "execute-api:ManageConnections", Resource: "*" }],
        }];
      },
    },
  };
}

async function signedFetch(url, { method = "GET", body = null, contentType = null } = {}) {
  const headers = {};
  if (contentType) headers["content-type"] = contentType;
  const signed = await signRequest({
    method,
    url,
    headers,
    body: body === null ? "" : (typeof body === "string" ? body : Buffer.from(body).toString("utf8")),
    service: "execute-api",
    region: "auto",
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    timestamp: Date.now(),
  });
  return fetch(signed.url, {
    method,
    headers: signed.headers,
    body: body === null ? undefined : body,
    redirect: "manual",
  });
}

async function openOk(port, apiPublicId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${apiPublicId}/prod`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    setTimeout(() => reject(new Error("open timeout")), 5000);
  });
  return ws;
}

test("S12 [runtime]: @connections POST/GET/DELETE with SigV4 ManageConnections policy; unsigned → 403; unknown id → 410", async () => {
  const artifact = {
    ...wsArtifact({ apiPublicId: "wsconnmgmt1" }),
    routes: [
      { id: "r-connect", routeKey: "$connect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
    ],
  };
  const { gateway, port } = await startWsGateway(artifact, { ports: signingPorts() });
  try {
    const ws = await openOk(port, artifact.apiPublicId);
    try {
      const connectionId = [...gateway.wsManager.connections.keys()][0];
      assert.ok(connectionId);
      const base = `http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/@connections/${connectionId}`;
      // GET signed → 200.
      const get = await signedFetch(base, { method: "GET" });
      assert.equal(get.status, 200);
      const info = await get.json();
      assert.ok(info.connectedAt);
      assert.ok(info.lastActiveAt);
      // POST signed → client receives.
      const incoming = new Promise((resolve, reject) => {
        ws.once("message", (data) => resolve(String(data)));
        setTimeout(() => reject(new Error("delivery timeout")), 5000);
      });
      const post = await signedFetch(base, { method: "POST", body: "hello-back", contentType: "text/plain" });
      assert.equal(post.status, 200);
      assert.equal(await incoming, "hello-back");
      // POST unsigned → 403.
      const unsigned = await fetch(base, { method: "POST", body: "nope" });
      assert.equal(unsigned.status, 403);
      // Unknown id signed → 410.
      const gone = await signedFetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/@connections/does-not-exist`, { method: "GET" });
      assert.equal(gone.status, 410);
      // DELETE signed → 204 + socket closed 1000.
      const closed = new Promise((resolve, reject) => {
        ws.once("close", (code) => resolve(code));
        setTimeout(() => reject(new Error("delete close timeout")), 5000);
      });
      const del = await signedFetch(base, { method: "DELETE" });
      assert.equal(del.status, 204);
      assert.equal(await closed, 1000);
    } finally {
      try {
        ws.terminate();
      } catch {
        // Best-effort.
      }
    }
  } finally {
    await gateway.close();
  }
});

test("S12 [runtime]: two runtime instances — POST via instance B delivers to client on instance A; instance A killed → POST returns 410 within 30 s", async () => {
  const artifact = {
    ...wsArtifact({ apiPublicId: "wstwoinst01" }),
    routes: [
      { id: "r-connect", routeKey: "$connect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
    ],
  };
  const kv = new MemoryKvStore({ clock: { now: () => Date.now() } });
  const stages = new Map([[`${artifact.apiPublicId}:prod`, { artifact: { ...artifact, stage: "prod" } }]]);
  const loaderA = createMemoryLoader({ pathRouting: true, stages, kv });
  const loaderB = createMemoryLoader({ pathRouting: true, stages, kv });
  const gatewayA = createGatewayServer({ loader: loaderA, ports: { kv, events: createEventSink({ consumers: [] }), ...signingPorts() } });
  const gatewayB = createGatewayServer({ loader: loaderB, ports: { kv, events: createEventSink({ consumers: [] }), ...signingPorts() } });
  const portA = await gatewayA.start(0);
  const portB = await gatewayB.start(0);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${portA}/${artifact.apiPublicId}/prod`);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      setTimeout(() => reject(new Error("open timeout")), 5000);
    });
    try {
      const connectionId = [...gatewayA.wsManager.connections.keys()][0];
      assert.ok(connectionId);
      // POST via B delivers to A.
      const incoming = new Promise((resolve, reject) => {
        ws.once("message", (data) => resolve(String(data)));
        setTimeout(() => reject(new Error("cross-instance timeout")), 8000);
      });
      const post = await signedFetch(`http://127.0.0.1:${portB}/${artifact.apiPublicId}/prod/@connections/${connectionId}`, {
        method: "POST", body: "cross-hi", contentType: "text/plain",
      });
      // Re-sign for B's host (signature covers host; helper already signs per-URL).
      assert.equal(post.status, 200);
      assert.equal(await incoming, "cross-hi");
      // Kill A → POST via B is 410 quickly (well within 30 s).
      await gatewayA.close();
      ws.terminate();
      const started = Date.now();
      const gone = await signedFetch(`http://127.0.0.1:${portB}/${artifact.apiPublicId}/prod/@connections/${connectionId}`, { method: "GET" });
      assert.equal(gone.status, 410);
      assert.ok(Date.now() - started < 30000);
    } finally {
      try {
        ws.terminate();
      } catch {
        // Best-effort.
      }
    }
  } finally {
    try {
      await gatewayA.close();
    } catch {
      // Already closed.
    }
    await gatewayB.close();
  }
});
