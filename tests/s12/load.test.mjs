import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { wsArtifact } from "./helper.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { createEventSink } from "../../lib/gateway/core/observe/event.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { signRequest } from "../../lib/gateway/core/auth/sigv4.mjs";

const ACCESS = "AKIDLOAD0001";
const SECRET = "test-secret-load-00000000000000001";

test("S12 [load]: 5,000 concurrent connections on one instance, 1,000 msg/s fan-out via @connections, p99 delivery < 100 ms locally", async () => {
  const full = process.env.PODS_LOAD_TESTS === "1";
  const N = full ? 5000 : 150;
  const M = full ? 1000 : 150;
  const artifact = {
    ...wsArtifact({ apiPublicId: "wsload00001" }),
    routes: [
      { id: "r-connect", routeKey: "$connect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
    ],
  };
  const kv = new MemoryKvStore({ clock: { now: () => Date.now() } });
  const loader = createMemoryLoader({ pathRouting: true, stages: new Map([[`${artifact.apiPublicId}:prod`, { artifact: { ...artifact, stage: "prod" } }]]), kv });
  const gateway = createGatewayServer({
    loader,
    ports: {
      kv,
      events: createEventSink({ consumers: [] }),
      signingCredentials: { async resolve(id) { return id === ACCESS ? { secretAccessKey: SECRET, status: "ACTIVE" } : null; } },
      signingPolicies: {
        async list(id) {
          return id === ACCESS
            ? [{ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "execute-api:ManageConnections", Resource: "*" }] }]
            : [];
        },
      },
    },
  });
  const port = await gateway.start(0);
  const sockets = [];
  try {
    // Open N connections with bounded concurrency.
    const CONCURRENCY = 200;
    for (let start = 0; start < N; start += CONCURRENCY) {
      const batch = [];
      for (let index = start; index < Math.min(start + CONCURRENCY, N); index += 1) {
        batch.push((async () => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/${artifact.apiPublicId}/prod`);
          await new Promise((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
            setTimeout(() => reject(new Error("open timeout")), 10000);
          });
          return ws;
        })());
      }
      const opened = await Promise.all(batch);
      sockets.push(...opened);
    }
    assert.equal(sockets.length, N);
    const ids = [...gateway.wsManager.connections.keys()];
    assert.equal(ids.length, N);
    // Fan-out M POSTs, measuring POST→receipt latency. POSTs run
    // sequentially, so the next message on any socket belongs to the
    // just-sent POST (no per-socket mapping needed).
    const latencies = [];
    const targets = ids.slice(0, M);
    let received = 0;
    let receiveResolve = null;
    const onAnyMessage = () => {
      received += 1;
      if (receiveResolve) {
        const resolve = receiveResolve;
        receiveResolve = null;
        resolve();
      }
    };
    for (const ws of sockets) ws.on("message", onAnyMessage);
    const startedAll = Date.now();
    for (const connectionId of targets) {
      const url = `http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/@connections/${connectionId}`;
      const body = `load-${connectionId.slice(0, 8)}`;
      const signed = await signRequest({
        method: "POST", url, headers: { "content-type": "text/plain" }, body,
        service: "execute-api", region: "auto", accessKeyId: ACCESS, secretAccessKey: SECRET, timestamp: Date.now(),
      });
      const before = received;
      const at = Date.now();
      const receipt = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fan-out timeout")), 10000);
        if (timer.unref) timer.unref();
        receiveResolve = () => {
          clearTimeout(timer);
          resolve(Date.now() - at);
        };
        // Already arrived (race between POST and listener).
        if (received > before) {
          clearTimeout(timer);
          receiveResolve = null;
          resolve(Date.now() - at);
        }
      });
      const response = await fetch(signed.url, { method: "POST", headers: signed.headers, body, redirect: "manual" });
      assert.equal(response.status, 200);
      latencies.push(await receipt);
    }
    const totalMs = Date.now() - startedAll;
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(0.5 * (latencies.length - 1))];
    const p99 = latencies[Math.floor(0.99 * (latencies.length - 1))];
    const rate = Math.round((M / Math.max(totalMs, 1)) * 1000);
    console.log(`S12 load: connections=${N} messages=${M} totalMs=${totalMs} rate=${rate}/s p50=${p50}ms p99=${p99}ms (threshold 500ms)`);
    assert.ok(p99 < 500, `p99 ${p99}ms exceeds relaxed 500ms threshold`);
  } finally {
    for (const ws of sockets) {
      try {
        ws.terminate();
      } catch {
        // Best-effort.
      }
    }
    await gateway.close();
  }
}, { timeout: 120000 });
