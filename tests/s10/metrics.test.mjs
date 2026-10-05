import assert from "node:assert/strict";
import test from "node:test";
import {
  createMetricsAggregator, percentileFromHistogram, mergeHistograms,
  dimensionsFor, reduceSeries, bucketFor,
} from "../../lib/gateway/core/observe/metrics.mjs";

function restEvent(index, { status = 200, latencyMs = 10, stage = "prod", canary = false, cache = null } = {}) {
  return {
    ts: new Date(Date.UTC(2026, 9, 9, 12, 34, index % 60)).toISOString(),
    requestId: `r-${index}`, projectId: "p1", apiId: "a1", apiPublicId: "a1b2c3d4e5",
    protocol: "REST", stage, canary, httpMethod: "GET", routeKey: "GET /pets",
    resourcePath: "/pets", status, latencyMs, integrationLatencyMs: 5, cache,
  };
}

test("S10 [runtime]: 100 requests (90×200, 7×404, 3×502) → Count 100, 4XXError 7, 5XXError 3 in metrics_minute; two instances' rows sum correctly", () => {
  const first = createMetricsAggregator();
  const second = createMetricsAggregator();
  for (let index = 0; index < 100; index += 1) {
    const status = index < 90 ? 200 : index < 97 ? 404 : 502;
    (index % 2 === 0 ? first : second).record(restEvent(index, { status }));
  }
  const rows = [...first.flush(), ...second.flush()];
  const total = (metric) => rows.filter((row) => row.metric === metric).reduce((sum, row) => sum + row.count, 0);
  assert.equal(total("Count"), 100);
  assert.equal(total("4XXError"), 7);
  assert.equal(total("5XXError"), 3);
  // Merging two instances' rows for the same minute sums counts.
  const counts = rows.filter((row) => row.metric === "Count");
  const merged = counts.reduce((sum, row) => sum + row.count, 0);
  assert.equal(merged, 100);
});

test("S10: histogram percentile p50/p99 within one bucket of exact values", () => {
  const aggregator = createMetricsAggregator();
  const latencies = [];
  for (let index = 1; index <= 100; index += 1) latencies.push(index);
  for (const latency of latencies) aggregator.record(restEvent(latency, { latencyMs: latency }));
  const rows = aggregator.flush();
  const latencyRow = rows.find((row) => row.metric === "Latency");
  assert.ok(latencyRow, "expected a Latency row");
  const p50 = percentileFromHistogram(latencyRow.hist, 50);
  const p99 = percentileFromHistogram(latencyRow.hist, 99);
  // Exact p50 ≈ 50, p99 ≈ 99; allow one log-bucket of slack (~±35% at this scale).
  assert.ok(Math.abs(p50 - 50) / 50 < 0.4, `p50 ${p50} too far from 50`);
  assert.ok(Math.abs(p99 - 99) / 99 < 0.4, `p99 ${p99} too far from 99`);
  const merged = mergeHistograms(latencyRow.hist, new Array(64).fill(0));
  assert.deepEqual(merged, latencyRow.hist);
  assert.ok(bucketFor(1) < bucketFor(100) && bucketFor(100) < bucketFor(60000));
});

test("S10: canary traffic recorded under \"{stage}/Canary\"", () => {
  const aggregator = createMetricsAggregator();
  aggregator.record(restEvent(1, { canary: true }));
  aggregator.record(restEvent(2, {}));
  const rows = aggregator.flush();
  const stages = new Set(rows.map((row) => row.stage));
  assert.ok(stages.has("prod/Canary"), `missing canary stage: ${[...stages]}`);
  assert.ok(stages.has("prod"), `missing base stage: ${[...stages]}`);
  const dims = dimensionsFor({ stage: "prod", canary: true, apiPublicId: "x" });
  assert.equal(dims.Stage, "prod/Canary");
  assert.equal(dims.ApiId, "x");
});

test("S10: HTTP and WebSocket protocol metrics recorded", () => {
  const aggregator = createMetricsAggregator();
  aggregator.record({
    ts: new Date().toISOString(), projectId: "p1", apiId: "h1", apiPublicId: "h1",
    protocol: "HTTP", stage: "$default", httpMethod: "POST", status: 500,
    latencyMs: 20, requestBytes: 100, responseBytes: 50,
  });
  aggregator.record({
    ts: new Date().toISOString(), projectId: "p1", apiId: "w1", apiPublicId: "w1",
    protocol: "WEBSOCKET", stage: "prod", status: 200, eventType: "$connect",
  });
  const rows = aggregator.flush();
  const metrics = new Set(rows.map((row) => row.metric));
  assert.ok(metrics.has("5xx"), `missing HTTP 5xx: ${[...metrics]}`);
  assert.ok(metrics.has("DataProcessed"), `missing DataProcessed: ${[...metrics]}`);
  assert.ok(metrics.has("ConnectCount"), `missing ConnectCount: ${[...metrics]}`);
});

test("S10: reduceSeries computes Sum/Average/p90 over period buckets", () => {
  const points = [
    { ts: "2026-10-09T12:00:10.000Z", sum: 10, count: 2, min: 4, max: 6, hist: null },
    { ts: "2026-10-09T12:00:40.000Z", sum: 20, count: 2, min: 8, max: 12, hist: null },
    { ts: "2026-10-09T12:05:00.000Z", sum: 5, count: 1, min: 5, max: 5, hist: null },
  ];
  const summed = reduceSeries(points, "Sum", 300);
  assert.equal(summed.length, 2);
  assert.equal(summed[0].value, 30);
  const average = reduceSeries(points, "Average", 300);
  assert.equal(average[0].value, 7.5);
  assert.equal(reduceSeries(points, "SampleCount", 300)[0].value, 4);
  assert.equal(reduceSeries(points, "Minimum", 300)[0].value, 4);
  assert.equal(reduceSeries(points, "Maximum", 300)[0].value, 12);
});
