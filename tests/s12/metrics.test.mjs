import assert from "node:assert/strict";
import test from "node:test";
import { createMetricsAggregator } from "../../lib/gateway/core/observe/metrics.mjs";

test("S12: metrics ConnectCount/MessageCount reconcile with test traffic", () => {
  const aggregator = createMetricsAggregator();
  const ts = new Date().toISOString();
  // 3 connects + 7 messages (2 toward $default, 5 custom).
  for (let index = 0; index < 3; index += 1) {
    aggregator.record({ ts, projectId: "p1", apiId: "a1", apiPublicId: "ws1", protocol: "WEBSOCKET", stage: "prod", status: 101, eventType: "$connect" });
  }
  for (let index = 0; index < 7; index += 1) {
    aggregator.record({ ts, projectId: "p1", apiId: "a1", apiPublicId: "ws1", protocol: "WEBSOCKET", stage: "prod", status: 200, eventType: "MESSAGE", routeKey: "sendmessage" });
  }
  const rows = aggregator.flush();
  const count = (metric) => rows.filter((row) => row.metric === metric).reduce((sum, row) => sum + row.count, 0);
  assert.equal(count("ConnectCount"), 3);
  assert.equal(count("MessageCount"), 7);
});
