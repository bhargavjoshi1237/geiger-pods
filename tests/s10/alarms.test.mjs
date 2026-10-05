import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAlarm, applyTransition, isBreaching } from "../../lib/gateway/core/observe/alarm-eval.mjs";
import { evaluateAllAlarms } from "../../lib/control/alarms.mjs";
import { createFakeDb } from "./fake-db.mjs";

function point(minute, value) {
  return { ts: minute, value };
}

test("S10: alarm 2-of-3 datapoints breaching → ALARM once; treatMissingData variants; notification sent exactly once per transition", async () => {
  assert.equal(isBreaching(11, ">", 10), true);
  assert.equal(isBreaching(10, ">", 10), false);
  assert.equal(isBreaching(10, ">=", 10), true);

  // 2 of the newest 3 breach → ALARM.
  const alarm = evaluateAlarm(
    [point("t1", 1), point("t2", 11), point("t3", 12)],
    { comparison: ">", threshold: 10, evaluationPeriods: 3, datapointsToAlarm: 2, treatMissingData: "missing" },
  );
  assert.equal(alarm.state, "ALARM");
  assert.equal(alarm.breaching, 2);

  // Only 1 of 3 → OK.
  assert.equal(evaluateAlarm(
    [point("t1", 1), point("t2", 2), point("t3", 12)],
    { comparison: ">", threshold: 10, evaluationPeriods: 3, datapointsToAlarm: 2, treatMissingData: "missing" },
  ).state, "OK");

  // Missing-data variants over [breach, missing, missing], 2-of-3.
  const sparse = [point("t1", 12), point("t2", null), point("t3", null)];
  assert.equal(evaluateAlarm(sparse, { comparison: ">", threshold: 10, evaluationPeriods: 3, datapointsToAlarm: 2, treatMissingData: "missing" }).state, "INSUFFICIENT_DATA");
  assert.equal(evaluateAlarm(sparse, { comparison: ">", threshold: 10, evaluationPeriods: 3, datapointsToAlarm: 2, treatMissingData: "breaching" }).state, "ALARM");
  assert.equal(evaluateAlarm(sparse, { comparison: ">", threshold: 10, evaluationPeriods: 3, datapointsToAlarm: 2, treatMissingData: "notBreaching" }).state, "OK");
  assert.equal(evaluateAlarm(sparse, { comparison: ">", threshold: 10, evaluationPeriods: 3, datapointsToAlarm: 2, treatMissingData: "ignore" }).state, "ALARM");
  assert.equal(evaluateAlarm(
    [point("t1", null), point("t2", null), point("t3", null)],
    { comparison: ">", threshold: 10, evaluationPeriods: 3, datapointsToAlarm: 2, treatMissingData: "ignore" },
  ).state, "INSUFFICIENT_DATA");
  // Definitively OK even with `missing`: breaches + missing cannot reach M.
  assert.equal(evaluateAlarm(
    [point("t1", 1), point("t2", null), point("t3", 1)],
    { comparison: ">", threshold: 10, evaluationPeriods: 3, datapointsToAlarm: 3, treatMissingData: "missing" },
  ).state, "OK");

  // No transition → null (the job notifies only on change).
  assert.equal(applyTransition({ state: "OK" }, "OK", "same"), null);
  const changed = applyTransition({ state: "OK" }, "ALARM", "2 of 3 breaching", "2026-10-09T00:00:00.000Z");
  assert.equal(changed.state, "ALARM");
  assert.equal(changed.state_updated_at, "2026-10-09T00:00:00.000Z");
});

test("S10: evaluator writes history and notifies exactly once per transition", async () => {
  const db = createFakeDb({ roles: { "u-admin": "admin" } });
  const channel = await db.insertNotificationChannel({ project_id: "p1", name: "ops", type: "webhook", config: { url: "https://hooks.local/ops" } });
  const saved = await db.insertAlarm({
    project_id: "p1", name: "high-5xx", metric: "5XXError", statistic: "Sum",
    period_sec: 60, evaluation_periods: 3, datapoints_to_alarm: 2,
    comparison: ">", threshold: 2, treat_missing_data: "missing",
    actions: { ok: [], alarm: [channel.id], insufficientData: [] },
  });
  const now = new Date(Date.UTC(2026, 9, 9, 12, 5, 0));
  for (const minute of ["2026-10-09T12:02:00.000Z", "2026-10-09T12:03:00.000Z", "2026-10-09T12:04:00.000Z"]) {
    db._rows.minuteRows.push({
      project_id: "p1", api_id: "a1", stage: "prod", dims_hash: "ApiId=x|Stage=prod",
      dims: {}, minute, metric: "5XXError", sum: 5, count: 5, min: 5, max: 5, hist: new Array(64).fill(0),
    });
  }
  const notifications = [];
  const first = await evaluateAllAlarms(db, {
    now,
    notify: async (target, payload) => {
      notifications.push({ target: target.id, key: payload.idempotencyKey, to: payload.alarm.state });
    },
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].from, "INSUFFICIENT_DATA");
  assert.equal(first[0].to, "ALARM");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].key, new RegExp(`^${saved.id}:`));
  const history = await db.listAlarmHistory({ alarmId: saved.id });
  assert.equal(history.length, 1);

  // Second run with the same breach: no transition, no second notification.
  const second = await evaluateAllAlarms(db, { now, notify: async () => { notifications.push({}); } });
  assert.equal(second.length, 0);
  assert.equal(notifications.length, 1);
});
