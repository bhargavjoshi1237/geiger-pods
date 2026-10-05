/**
 * S10 [runtime]: 100 requests (90×200, 7×404, 3×502) → Count 100, 4XXError 7,
 * 5XXError 3 in metrics_minute rows; two instances' rows sum correctly.
 *
 * Fires real requests at gateway/server.mjs with an event sink subscribed to a
 * per-minute aggregator, then asserts on the upsert-ready rows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { createEventSink } from "../../lib/gateway/core/observe/event.mjs";
import { createMetricsAggregator } from "../../lib/gateway/core/observe/metrics.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

function restArtifact(upstreamUrl) {
  const draft = {
    projectId: "proj-1",
    apiId: "api-rest",
    apiPublicId: "s10r1s10r1",
    protocol: "REST",
    resources: [
      { id: "res-root", path: "/" },
      { id: "res-ok", path: "/ok" },
      { id: "res-missing", path: "/missing" },
      { id: "res-broken", path: "/broken" },
    ],
    methods: [
      { id: "m-ok", resourceId: "res-ok", httpMethod: "GET", authorizationType: "NONE", integrationId: "int-ok" },
      { id: "m-missing", resourceId: "res-missing", httpMethod: "GET", authorizationType: "NONE", integrationId: "int-missing" },
      { id: "m-broken", resourceId: "res-broken", httpMethod: "GET", authorizationType: "NONE", integrationId: "int-broken" },
    ],
    integrations: [
      { id: "int-ok", type: "HTTP_PROXY", uri: `${upstreamUrl}/status/200`, timeoutMs: 5000 },
      { id: "int-missing", type: "HTTP_PROXY", uri: `${upstreamUrl}/status/404`, timeoutMs: 5000 },
      { id: "int-broken", type: "HTTP_PROXY", uri: `${upstreamUrl}/status/502`, timeoutMs: 5000 },
    ],
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0);
  return { ...artifact, allowLoopback: true };
}

async function waitFor(predicate, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for events");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("S10 [runtime]: mixed traffic aggregates into metrics_minute rows", () => {
  it("90×200 + 7×404 + 3×502 → Count 100, 4XXError 7, 5XXError 3", async () => {
    const upstream = await startUpstream();
    const aggregator = createMetricsAggregator();
    const sink = createEventSink({ consumers: [(event) => aggregator.record(event)] });
    try {
      const artifact = restArtifact(upstream.url);
      const loader = createMemoryLoader({
        pathRouting: true,
        stages: new Map([[`${artifact.apiPublicId}:prod`, { artifact }]]),
      });
      const gateway = createGatewayServer({ loader, ports: { events: sink } });
      const port = await gateway.start(0);
      try {
        const base = `http://127.0.0.1:${port}/${artifact.apiPublicId}/prod`;
        const plan = [
          ["/ok", 90, 200],
          ["/missing", 7, 404],
          ["/broken", 3, 502],
        ];
        for (const [path, count, expected] of plan) {
          for (let i = 0; i < count; i += 1) {
            const response = await fetch(`${base}${path}`);
            assert.equal(response.status, expected, `${path} → ${expected}`);
            await response.text();
          }
        }
        await waitFor(() => sink.queue.length >= 100);
        // Drain the async fan-out, then flush minute rows.
        await new Promise((resolve) => setImmediate(resolve));
        await sink.flush();
        const rows = aggregator.flush();
        const counts = new Map();
        for (const row of rows) counts.set(row.metric, (counts.get(row.metric) ?? 0) + row.count);
        assert.equal(counts.get("Count"), 100);
        assert.equal(counts.get("4XXError"), 7);
        assert.equal(counts.get("5XXError"), 3);
        // Every row carries the minute + additive shape for on-conflict upserts.
        for (const row of rows) {
          assert.match(row.minute, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
          assert.ok(typeof row.sum === "number" && typeof row.count === "number");
          assert.equal(row.hist.length, 64);
        }
      } finally {
        await gateway.close();
      }
    } finally {
      await upstream.close();
    }
  });

  it("two gateway instances sum correctly", async () => {
    const upstream = await startUpstream();
    const aggA = createMetricsAggregator();
    const aggB = createMetricsAggregator();
    const sinkA = createEventSink({ consumers: [(event) => aggA.record(event)] });
    const sinkB = createEventSink({ consumers: [(event) => aggB.record(event)] });
    try {
      const artifact = restArtifact(upstream.url);
      const loader = createMemoryLoader({
        pathRouting: true,
        stages: new Map([[`${artifact.apiPublicId}:prod`, { artifact }]]),
      });
      const gatewayA = createGatewayServer({ loader, ports: { events: sinkA } });
      const gatewayB = createGatewayServer({ loader, ports: { events: sinkB } });
      const portA = await gatewayA.start(0);
      const portB = await gatewayB.start(0);
      try {
        for (let i = 0; i < 50; i += 1) {
          const response = await fetch(`http://127.0.0.1:${portA}/${artifact.apiPublicId}/prod/ok`);
          assert.equal(response.status, 200);
          await response.text();
        }
        for (let i = 0; i < 50; i += 1) {
          const response = await fetch(`http://127.0.0.1:${portB}/${artifact.apiPublicId}/prod/ok`);
          assert.equal(response.status, 200);
          await response.text();
        }
        await waitFor(() => sinkA.queue.length >= 50 && sinkB.queue.length >= 50);
        await sinkA.flush();
        await sinkB.flush();
        const total = [...aggA.flush(), ...aggB.flush()]
          .filter((row) => row.metric === "Count")
          .reduce((sum, row) => sum + row.count, 0);
        assert.equal(total, 100);
      } finally {
        await gatewayA.close();
        await gatewayB.close();
      }
    } finally {
      await upstream.close();
    }
  });
});
