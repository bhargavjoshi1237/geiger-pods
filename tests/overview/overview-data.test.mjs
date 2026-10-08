import assert from "node:assert/strict";
import test from "node:test";
import {
  apiHealth,
  buildApiRows,
  buildAttention,
  buildDemoDashboard,
  buildStats,
  formatLatency,
  periodDelta,
  scopeDaily,
  scopeTotals,
  trafficMix,
} from "../../components/internal/screens/overview/overview_data.mjs";

const DASHBOARD = {
  days: 2,
  current: { requests: 120, errors4xx: 6, errors5xx: 4, throttled: 2, cacheHits: 30, cacheMisses: 10, p90LatencyMs: 80 },
  previous: { requests: 100, errors4xx: 10, errors5xx: 0, throttled: 0, cacheHits: 0, cacheMisses: 0, p90LatencyMs: 100 },
  daily: [
    { day: "2026-10-13T00:00:00.000Z", requests: 50, errors: 4, throttled: 0 },
    { day: "2026-10-14T00:00:00.000Z", requests: 70, errors: 6, throttled: 2 },
  ],
  apis: [
    { apiId: "a1", requests: 100, errors4xx: 6, errors5xx: 0, throttled: 2, cacheHits: 30, cacheMisses: 10, p90LatencyMs: 70,
      daily: [{ requests: 40, errors: 2, throttled: 0 }, { requests: 60, errors: 4, throttled: 2 }] },
    { apiId: "a2", requests: 20, errors4xx: 0, errors5xx: 4, throttled: 0, cacheHits: 0, cacheMisses: 0, p90LatencyMs: 300,
      daily: [{ requests: 10, errors: 2, throttled: 0 }, { requests: 10, errors: 2, throttled: 0 }] },
  ],
};

const APIS = [
  { id: "a1", publicId: "orders", name: "Orders", protocol: "REST" },
  { id: "a2", publicId: "pay", name: "Payments", protocol: "HTTP" },
  { id: "a3", publicId: "idle", name: "Idle", protocol: "WEBSOCKET" },
];

test("overview: deltas carry tone separately from direction", () => {
  assert.deepEqual(periodDelta(120, 100), { delta: "+20%", direction: "up", tone: "good" });
  assert.deepEqual(periodDelta(120, 100, { upIsGood: false }), { delta: "+20%", direction: "up", tone: "bad" });
  assert.deepEqual(periodDelta(80, 100, { upIsGood: false }), { delta: "-20%", direction: "down", tone: "good" });
  assert.equal(periodDelta(5, 0).delta, null);
  assert.equal(periodDelta(null, 100).delta, null);
});

test("overview: stats read the dashboard windows", () => {
  const [requests, errors, latency, throttled] = buildStats(DASHBOARD);
  assert.equal(requests.value, "120");
  assert.equal(requests.tone, "good");
  assert.equal(errors.value, "10");
  assert.equal(errors.delta, "+0%");
  assert.equal(latency.value, "80 ms");
  assert.equal(latency.tone, "good");
  assert.equal(throttled.delta, null);
  assert.equal(requests.footer, "vs previous 2 days");
  assert.equal(formatLatency(1530), "1.5 s");
  assert.equal(formatLatency(null), "—");
});

test("overview: scope sums only the selected APIs", () => {
  assert.equal(scopeDaily(DASHBOARD, []), DASHBOARD.daily);
  assert.deepEqual(scopeDaily(DASHBOARD, ["a2"]).map((cell) => cell.requests), [10, 10]);
  assert.equal(scopeTotals(DASHBOARD, []).requests, 120);
  assert.deepEqual(scopeTotals(DASHBOARD, ["a1", "missing"]), { requests: 100, errors4xx: 6, errors5xx: 0, throttled: 2, cacheHits: 30, cacheMisses: 10 });
});

test("overview: API rows join traffic and grade health", () => {
  const rows = buildApiRows(APIS, DASHBOARD);
  assert.deepEqual(rows.map((row) => [row.name, row.requests, row.health]), [["Orders", 100, "healthy"], ["Payments", 20, "failing"], ["Idle", 0, "idle"]]);
  assert.equal(rows[0].ref, "orders");
  assert.equal(rows[1].errorRate, 0.2);
  assert.equal(apiHealth({ requests: 1000, errors4xx: 0, errors5xx: 20 }), "degraded");
  assert.equal(apiHealth({ requests: 1000, errors4xx: 120, errors5xx: 0 }), "degraded");
});

test("overview: traffic mix keeps the top five and folds the rest", () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ id: `a${index}`, name: `API ${index}`, requests: (index + 1) * 10 }));
  const mix = trafficMix([...rows, { id: "zero", name: "Zero", requests: 0 }]);
  assert.deepEqual(mix.map((item) => item.key), ["a6", "a5", "a4", "a3", "a2", "__other"]);
  assert.equal(mix.at(-1).value, 30);
});

test("overview: attention counts alarms, unhealthy and idle APIs", () => {
  const rows = buildApiRows(APIS, DASHBOARD);
  const alarms = [{ name: "5XX", state: "ALARM" }, { name: "p90", state: "OK" }, { name: "new", state: "INSUFFICIENT_DATA" }];
  const counts = Object.fromEntries(buildAttention({ alarms, rows, dashboard: DASHBOARD }).map((item) => [item.key, item.count]));
  assert.deepEqual(counts, { alarms: 1, failing: 1, degraded: 0, throttled: 2, idle: 1, waiting: 1 });
});

test("overview: demo dashboard is internally consistent", () => {
  const demo = buildDemoDashboard();
  assert.equal(demo.daily.length, demo.days);
  assert.equal(demo.daily.reduce((sum, cell) => sum + cell.requests, 0), demo.current.requests);
  assert.equal(demo.apis.reduce((sum, entry) => sum + entry.requests, 0), demo.current.requests);
});
