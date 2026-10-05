import assert from "node:assert/strict";
import test from "node:test";
import { partitionNameFor, partitionsOlderThan, runRollup, runRetention } from "../../lib/control/retention.mjs";
import { rollupToHour, mergeMinuteRow } from "../../lib/control/metrics.mjs";
import { createFakeDb } from "./fake-db.mjs";

test("S10: retention job drops partitions older than log_retention_days", async () => {
  assert.equal(partitionNameFor("access_logs", new Date(Date.UTC(2026, 9, 9))), "access_logs_2026_10_09");
  const existing = ["access_logs_2026_10_01", "access_logs_2026_10_08", "access_logs_2026_10_09", "unrelated", "execution_logs_2026_09_30"];
  assert.deepEqual(
    partitionsOlderThan("access_logs", new Date(Date.UTC(2026, 9, 9)), existing),
    ["access_logs_2026_10_01", "access_logs_2026_10_08"],
  );

  const db = createFakeDb();
  const now = new Date(Date.UTC(2026, 9, 9, 12, 0, 0));
  const old = new Date(now.getTime() - 40 * 86400 * 1000).toISOString();
  const fresh = new Date(now.getTime() - 2 * 86400 * 1000).toISOString();
  await db.insertAccessLogs([
    { project_id: "p1", api_id: "a1", stage: "prod", ts: old, request_id: "old", status: 200, route: null, source_ip: null, line: "old", fields: {} },
    { project_id: "p1", api_id: "a1", stage: "prod", ts: fresh, request_id: "new", status: 200, route: null, source_ip: null, line: "new", fields: {} },
  ]);
  await db.insertExecutionLogs([{ project_id: "p1", api_id: "a1", stage: "prod", request_id: "old", ts: old, level: "INFO", lines: [] }]);
  await db.insertSpans([{ project_id: "p1", api_id: "a1", stage: "prod", trace_id: "t", span_id: "s", request_id: "old", ts: new Date(now.getTime() - 8 * 86400 * 1000).toISOString(), name: "gateway", kind: "server" }]);
  db._rows.minuteRows.push({ project_id: "p1", api_id: "a1", stage: "prod", dims_hash: "", dims: {}, minute: old, metric: "Count", sum: 1, count: 1, min: 1, max: 1, hist: new Array(64).fill(0) });

  const summary = await runRetention(db, { now });
  assert.equal(summary.accessLogs, 1);
  assert.equal(summary.executionLogs, 1);
  assert.equal(summary.spans, 1);
  assert.equal(summary.metricsMinute, 1);
  const remaining = await db.queryAccessLogs({ projectId: "p1", limit: 10 });
  assert.equal(remaining.items.length, 1);
  assert.equal(remaining.items[0].request_id, "new");
});

test("S10: rollup merges minute rows into hour rows with additive sums", async () => {
  const db = createFakeDb();
  const minutes = ["2026-10-09T12:01:00.000Z", "2026-10-09T12:02:00.000Z"];
  const hist = new Array(64).fill(0);
  hist[10] = 2;
  db._rows.minuteRows.push(
    { project_id: "p1", api_id: "a1", stage: "prod", dims_hash: "d", dims: {}, minute: minutes[0], metric: "Count", sum: 3, count: 3, min: 1, max: 1, hist: [...hist] },
    { project_id: "p1", api_id: "a1", stage: "prod", dims_hash: "d", dims: {}, minute: minutes[1], metric: "Count", sum: 7, count: 7, min: 1, max: 1, hist: [...hist] },
  );
  const summary = await runRollup(db, { now: new Date(Date.UTC(2026, 9, 9, 13, 0, 0)) });
  assert.equal(summary.hours, 1);
  assert.equal(summary.minutes, 2);
  assert.equal(db._rows.hourRows.length, 1);
  assert.equal(db._rows.hourRows[0].hour, "2026-10-09T12:00:00.000Z");
  assert.equal(db._rows.hourRows[0].sum, 10);
  assert.equal(db._rows.hourRows[0].hist[10], 4);
  assert.equal(db._rows.minuteRows.length, 0);

  // Merge helper used by the Postgres upsert path.
  const merged = mergeMinuteRow(
    { sum: 3, count: 3, min: 2, max: 5, hist },
    { sum: 7, count: 7, min: 1, max: 9, hist },
  );
  assert.equal(merged.sum, 10);
  assert.equal(merged.count, 10);
  assert.equal(merged.min, 1);
  assert.equal(merged.max, 9);
  assert.equal(rollupToHour([], "2026-10-09T12:00:00.000Z"), null);
});
