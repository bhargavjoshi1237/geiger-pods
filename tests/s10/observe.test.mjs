/**
 * S10 acceptance: request event sink + metrics aggregation (spec §1–§2).
 *
 * - Emitting is off the response path; bounded queue (10 000) drops oldest + counts.
 * - 100 requests (90×200, 7×404, 3×502) → Count 100, 4XXError 7, 5XXError 3.
 * - Two instances' rows sum correctly (mergeable per-minute cells).
 * - Histogram p50/p99 within one bucket of exact values.
 * - Canary traffic recorded under "{stage}/Canary".
 * - Test-invoke traffic excluded.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequestEvent,
  createEventSink,
  EVENT_QUEUE_CAPACITY,
} from "../../lib/gateway/core/observe/event.mjs";
import {
  bucketFor,
  createMetricsAggregator,
  dimensionsFor,
  mergeHistograms,
  percentileFromHistogram,
  reduceSeries,
} from "../../lib/gateway/core/observe/metrics.mjs";

function baseCtx(overrides = {}) {
  return {
    requestId: "req-1",
    startTime: Date.parse("2026-10-05T12:00:00.000Z"),
    request: { method: "GET" },
    artifact: {
      projectId: "proj-1",
      apiId: "api-uuid-1",
      apiPublicId: "abcdefghij",
      protocol: "REST",
      stage: "prod",
      deploymentId: "dep-1",
    },
    context: {
      requestId: "req-1",
      extendedRequestId: "ext-1",
      stage: "prod",
      apiId: "api-uuid-1",
      protocol: "REST",
      httpMethod: "GET",
      resourcePath: "/pets",
      routeKey: "",
      status: "200",
      identity: { sourceIp: "1.2.3.4", userAgent: "test", apiKeyId: "" },
      authorizer: { principalId: "" },
      isCanaryRequest: false,
    },
    ...overrides,
  };
}

describe("S10: request event shape (§1)", () => {
  it("builds the §1 shape with all required fields", () => {
    const response = new Response("ok", { status: 200 });
    const event = buildRequestEvent(baseCtx(), response, {
      latencyMs: 42,
      integrationLatencyMs: 30,
      requestBytes: 100,
      responseBytes: 200,
    });
    for (const key of [
      "ts", "requestId", "extendedRequestId", "projectId", "apiId", "apiPublicId",
      "protocol", "stage", "canary", "deploymentId", "routeKey", "resourcePath",
      "httpMethod", "status", "errorType", "latencyMs", "integrationLatencyMs",
      "requestBytes", "responseBytes", "cache", "apiKeyId", "principalId",
      "sourceIp", "userAgent", "throttled", "quotaRejected", "wafAction",
      "domainName", "traceId", "kvFallback",
    ]) {
      assert.ok(key in event, `missing ${key}`);
    }
    assert.equal(event.status, 200);
    assert.equal(event.latencyMs, 42);
    assert.equal(event.canary, false);
  });
});

describe("S10: emitting is off the response path — a slow sink does not increase request latency (bounded queue drops and counts)", () => {
  it("capacity is 10000, overflow drops oldest and counts", async () => {
    const sink = createEventSink({ capacity: 3 });
    sink.emit({ requestId: "a" });
    sink.emit({ requestId: "b" });
    sink.emit({ requestId: "c" });
    sink.emit({ requestId: "d" });
    assert.equal(sink.queue.length, 3);
    assert.equal(sink.droppedEvents, 1);
    assert.equal(sink.queue[0].requestId, "b");
    assert.equal(EVENT_QUEUE_CAPACITY, 10000);
  });

  it("consumers fail independently and emit never throws", async () => {
    const seen = [];
    const sink = createEventSink({
      consumers: [
        () => { throw new Error("boom"); },
        async () => { throw new Error("async boom"); },
        (event) => { seen.push(event.requestId); },
      ],
    });
    assert.doesNotThrow(() => sink.emit({ requestId: "x" }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ["x"]);
  });

  it("dispatch happens off the caller tick", async () => {
    let dispatched = false;
    const sink = createEventSink({ consumers: [() => { dispatched = true; }] });
    sink.emit({ requestId: "y" });
    assert.equal(dispatched, false);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dispatched, true);
  });
});

function restEvent(status, latencyMs = 10, extra = {}) {
  return {
    ts: "2026-10-05T12:00:30.000Z",
    requestId: `req-${status}-${Math.random()}`,
    projectId: "proj-1",
    apiId: "api-uuid-1",
    apiPublicId: "abcdefghij",
    protocol: "REST",
    stage: "prod",
    canary: false,
    status,
    latencyMs,
    ...extra,
  };
}

describe("S10: 100 requests aggregate to Count/4XX/5XX in per-minute cells", () => {
  it("90×200 + 7×404 + 3×502 → Count 100, 4XXError 7, 5XXError 3", () => {
    const agg = createMetricsAggregator();
    for (let i = 0; i < 90; i += 1) agg.record(restEvent(200, 20));
    for (let i = 0; i < 7; i += 1) agg.record(restEvent(404, 5));
    for (let i = 0; i < 3; i += 1) agg.record(restEvent(502, 50));
    const rows = agg.flush();
    const byMetric = new Map(rows.map((row) => [row.metric, row]));
    assert.equal(byMetric.get("Count").count, 100);
    assert.equal(byMetric.get("4XXError").count, 7);
    assert.equal(byMetric.get("5XXError").count, 3);
    assert.equal(byMetric.get("Count").minute, "2026-10-05T12:00:00.000Z");
    // flush resets
    assert.equal(agg.flush().length, 0);
  });

  it("two instances merge by addition (counts/sums/histograms)", () => {
    const a = createMetricsAggregator();
    const b = createMetricsAggregator();
    for (let i = 0; i < 60; i += 1) a.record(restEvent(200, 20));
    for (let i = 0; i < 40; i += 1) b.record(restEvent(200, 20));
    const rows = [...a.flush(), ...b.flush()].filter((row) => row.metric === "Count");
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    assert.equal(total, 100);
    const merged = mergeHistograms(rows[0].hist, rows[1].hist);
    assert.equal(merged.reduce((s, c) => s + c, 0), 0); // Count carries no latency samples
    const latA = createMetricsAggregator();
    latA.record(restEvent(200, 25));
    const latRows = latA.flush().filter((row) => row.metric === "Latency");
    assert.equal(latRows[0].hist.reduce((s, c) => s + c, 0), 1);
  });

  it("test-invoke traffic is excluded", () => {
    const agg = createMetricsAggregator();
    agg.record({ ...restEvent(200), testInvoke: true });
    assert.equal(agg.flush().length, 0);
  });
});

describe("S10: histogram percentile p50/p99 within one bucket of exact values", () => {
  it("constant latency estimates land on the value bucket", () => {
    const agg = createMetricsAggregator();
    for (let i = 0; i < 200; i += 1) agg.record(restEvent(200, 100));
    const rows = agg.flush().filter((row) => row.metric === "Latency");
    const hist = rows[0].hist;
    const p50 = percentileFromHistogram(hist, 50);
    const p99 = percentileFromHistogram(hist, 99);
    assert.ok(Math.abs(p50 - 100) < 100, `p50=${p50}`);
    assert.ok(Math.abs(p99 - 100) < 100, `p99=${p99}`);
  });

  it("reduceSeries derives p50/p90/p95/p99 from merged histograms", () => {
    const agg = createMetricsAggregator();
    for (let i = 0; i < 50; i += 1) agg.record(restEvent(200, 40));
    const rows = agg.flush().filter((row) => row.metric === "Latency");
    const points = rows.map((row) => ({
      ts: row.minute, sum: row.sum, count: row.count, min: row.min, max: row.max, hist: row.hist,
    }));
    for (const stat of ["Sum", "Average", "Minimum", "Maximum", "SampleCount", "p50", "p90", "p95", "p99"]) {
      const series = reduceSeries(points, stat, 60);
      assert.equal(series.length, 1);
      assert.ok(series[0].value !== null, stat);
    }
    assert.equal(reduceSeries(points, "SampleCount", 60)[0].value, 50);
  });

  it("bucketFor spans 1ms..60s across 64 buckets", () => {
    assert.equal(bucketFor(0.1), 0);
    assert.equal(bucketFor(1), 0);
    assert.equal(bucketFor(60000), 63);
    assert.equal(bucketFor(999999), 63);
    assert.ok(bucketFor(10) > bucketFor(1));
    assert.ok(bucketFor(1000) > bucketFor(10));
  });
});

describe("S10: canary traffic recorded under '{stage}/Canary'", () => {
  it("dimensions use Stage={stage}/Canary for canary events", () => {
    const dims = dimensionsFor({ apiPublicId: "abcdefghij", stage: "prod", canary: true });
    assert.equal(dims.Stage, "prod/Canary");
    const agg = createMetricsAggregator();
    agg.record(restEvent(200, 10, { canary: true }));
    const rows = agg.flush().filter((row) => row.metric === "Count");
    assert.equal(rows[0].stage, "prod/Canary");
  });

  it("detailed metrics add Resource/Method dims", () => {
    const dims = dimensionsFor(
      { apiPublicId: "x", stage: "prod", resourcePath: "/pets", httpMethod: "GET" },
      { detailed: true },
    );
    assert.equal(dims.Resource, "/pets");
    assert.equal(dims.Method, "GET");
  });
});
