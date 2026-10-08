import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDb } from "./fake-db.mjs";
import { getDashboard } from "../../lib/control/metrics.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

const PROJECT = "p1";
const MEMBER = { type: "user", userId: "u-member" };
const NOW = Date.parse("2026-10-14T12:00:00.000Z");

function latencyHist(bucket, count) {
  const hist = new Array(64).fill(0);
  hist[bucket] = count;
  return hist;
}

function minute(apiId, ts, metric, count, extra = {}) {
  return {
    project_id: PROJECT, api_id: apiId, stage: "prod", dims_hash: "", dims: {},
    minute: ts, metric, sum: count, count, min: 1, max: 1, hist: new Array(64).fill(0), ...extra,
  };
}

function dbWithTraffic() {
  const db = createFakeDb({ roles: { "u-member": "member" } });
  db._rows.minuteRows.push(
    // Current window (Oct 1 – Oct 14 for days=14).
    minute("a1", "2026-10-14T09:00:00.000Z", "Count", 10),
    minute("a1", "2026-10-14T09:00:00.000Z", "4XXError", 2),
    minute("a1", "2026-10-14T09:00:00.000Z", "Latency", 10, { hist: latencyHist(20, 10) }),
    minute("a1", "2026-10-14T09:00:00.000Z", "CacheHitCount", 3),
    minute("a2", "2026-10-13T09:00:00.000Z", "Count", 5),
    minute("a2", "2026-10-13T09:00:00.000Z", "5xx", 1),
    minute("a3", "2026-10-01T00:30:00.000Z", "MessageCount", 4),
    minute("a3", "2026-10-01T00:30:00.000Z", "ThrottleCount", 1),
    // Previous window (Sep 17 – Sep 30).
    minute("a1", "2026-09-20T09:00:00.000Z", "Count", 8),
    // Outside both windows.
    minute("a1", "2026-09-01T09:00:00.000Z", "Count", 100),
    // Another project.
    { ...minute("a1", "2026-10-14T09:00:00.000Z", "Count", 50), project_id: "p2" },
  );
  db._rows.hourRows.push({
    project_id: PROJECT, api_id: "a2", stage: "prod", dims_hash: "", dims: {},
    hour: "2026-10-05T03:00:00.000Z", metric: "Count", sum: 7, count: 7, min: 1, max: 1, hist: new Array(64).fill(0),
  });
  return db;
}

test("S10 dashboard: folds protocol variants into current/previous totals", async () => {
  const result = await getDashboard(dbWithTraffic(), MEMBER, { projectId: PROJECT, days: 14, nowMs: NOW });
  assert.equal(result.from, "2026-10-01T00:00:00.000Z");
  assert.equal(result.current.requests, 10 + 5 + 4 + 7);
  assert.equal(result.current.errors4xx, 2);
  assert.equal(result.current.errors5xx, 1);
  assert.equal(result.current.throttled, 1);
  assert.equal(result.current.cacheHits, 3);
  assert.ok(result.current.p90LatencyMs > 0);
  assert.equal(result.previous.requests, 8);
  assert.equal(result.previous.p90LatencyMs, null);
});

test("S10 dashboard: daily series covers the window, today last", async () => {
  const result = await getDashboard(dbWithTraffic(), MEMBER, { projectId: PROJECT, days: 14, nowMs: NOW });
  assert.equal(result.daily.length, 14);
  assert.equal(result.daily[0].day, "2026-10-01T00:00:00.000Z");
  assert.deepEqual(result.daily[0], { day: "2026-10-01T00:00:00.000Z", requests: 4, errors: 0, throttled: 1 });
  assert.equal(result.daily[4].requests, 7);
  assert.deepEqual(result.daily[13], { day: "2026-10-14T00:00:00.000Z", requests: 10, errors: 2, throttled: 0 });
});

test("S10 dashboard: per-API breakdown sorted by requests", async () => {
  const result = await getDashboard(dbWithTraffic(), MEMBER, { projectId: PROJECT, days: 14, nowMs: NOW });
  assert.deepEqual(result.apis.map((api) => [api.apiId, api.requests]), [["a2", 12], ["a1", 10], ["a3", 4]]);
  const a1 = result.apis.find((api) => api.apiId === "a1");
  assert.equal(a1.errors4xx, 2);
  assert.equal(a1.daily[13].requests, 10);
});

test("S10 dashboard: idle project returns zeros; bad window rejected", async () => {
  const db = createFakeDb({ roles: { "u-member": "member" } });
  const result = await getDashboard(db, MEMBER, { projectId: PROJECT, days: 7, nowMs: NOW });
  assert.equal(result.current.requests, 0);
  assert.equal(result.daily.length, 7);
  assert.deepEqual(result.apis, []);
  for (const days of [0, 46, 2.5, "x"]) {
    await assert.rejects(getDashboard(db, MEMBER, { projectId: PROJECT, days, nowMs: NOW }),
      (error) => error instanceof HttpError && error.status === 422);
  }
});
