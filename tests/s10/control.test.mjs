import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDb } from "./fake-db.mjs";
import { queryMetrics } from "../../lib/control/metrics.mjs";
import { listAccessLogs, getRequestDetail, updateStageLogging } from "../../lib/control/logs.mjs";
import { createAlarm, listAlarms, deleteAlarm } from "../../lib/control/alarms.mjs";
import { createSink, testSinkDelivery } from "../../lib/control/log-sinks.mjs";
import { queryAudit, exportAuditCsv } from "../../lib/control/audit-query.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

const PROJECT = "p1";
const MEMBER = { type: "user", userId: "u-member" };
const MANAGER = { type: "user", userId: "u-manager" };
const ADMIN = { type: "user", userId: "u-admin" };

function dbWithRoles() {
  return createFakeDb({ roles: { "u-member": "member", "u-manager": "manager", "u-admin": "admin" } });
}

test("S10: member can query metrics; unknown metric/stat/period rejected", async () => {
  const db = dbWithRoles();
  db._rows.minuteRows.push({
    project_id: PROJECT, api_id: "a1", stage: "prod", dims_hash: "", dims: {},
    minute: "2026-10-09T12:00:00.000Z", metric: "Count", sum: 42, count: 42, min: 1, max: 1, hist: new Array(64).fill(0),
  });
  const result = await queryMetrics(db, MEMBER, { projectId: PROJECT, metric: "Count", period: 3600 });
  assert.equal(result.series.reduce((sum, point) => sum + (point.value ?? 0), 0), 42);
  await assert.rejects(queryMetrics(db, MEMBER, { projectId: PROJECT, metric: "Nope", period: 300 }),
    (error) => error instanceof HttpError && error.status === 422);
  await assert.rejects(queryMetrics(db, MEMBER, { projectId: PROJECT, metric: "Count", stat: "p100", period: 300 }),
    (error) => error instanceof HttpError && error.status === 422);
  await assert.rejects(queryMetrics(db, MEMBER, { projectId: PROJECT, metric: "Count", period: 61 }),
    (error) => error instanceof HttpError && error.status === 422);
});

test("S10: member can search access logs but data-trace bodies stay redacted without pods.logs.data", async () => {
  const db = dbWithRoles();
  await db.insertAccessLogs([{
    project_id: PROJECT, api_id: "a1", stage: "prod", ts: "2026-10-09T12:00:00.000Z",
    request_id: "r1", status: 200, route: "GET /pets", source_ip: "192.0.2.1", line: "line-1", fields: {},
  }]);
  const found = await listAccessLogs(db, MEMBER, { projectId: PROJECT });
  assert.equal(found.items.length, 1);
  await db.insertExecutionLogs([{
    project_id: PROJECT, api_id: "a1", stage: "prod", request_id: "r1", ts: "2026-10-09T12:00:00.000Z",
    level: "INFO",
    lines: [
      { level: "INFO", message: "Method completed with status: 200" },
      { level: "INFO", message: "Method request body before transformations: {\"secret\":1}" },
    ],
  }]);
  const memberView = await getRequestDetail(db, MEMBER, { projectId: PROJECT, requestId: "r1" });
  assert.equal(memberView.bodiesRedacted, true);
  assert.match(memberView.execution[0].lines[1].message, /redacted/);
  assert.ok(!memberView.execution[0].lines[1].message.includes("secret\":1}"), "body leaked to member");
  const managerView = await getRequestDetail(db, MANAGER, { projectId: PROJECT, requestId: "r1" });
  assert.equal(managerView.bodiesRedacted, false);
  assert.match(managerView.execution[0].lines[1].message, /secret/);
});

test("S10: alarm CRUD is write-gated; wizard validation rejects bad periods", async () => {
  const db = dbWithRoles();
  await assert.rejects(createAlarm(db, MEMBER, { projectId: PROJECT, input: { name: "x", metric: "Count" } }),
    (error) => error instanceof HttpError && error.status === 403);
  await assert.rejects(createAlarm(db, ADMIN, { projectId: PROJECT, input: { name: "x", metric: "Count", periodSec: 61 } }),
    (error) => error instanceof HttpError && error.status === 422);
  await assert.rejects(createAlarm(db, ADMIN, { projectId: PROJECT, input: { name: "x", metric: "Count", evaluationPeriods: 2, datapointsToAlarm: 3 } }),
    (error) => error instanceof HttpError && error.status === 422);
  const created = await createAlarm(db, ADMIN, {
    projectId: PROJECT,
    input: { name: "high-5xx", metric: "5XXError", comparison: ">", threshold: 10, periodSec: 300, evaluationPeriods: 3, datapointsToAlarm: 2 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.state, "INSUFFICIENT_DATA");
  const listed = await listAlarms(db, MEMBER, { projectId: PROJECT });
  assert.equal(listed.items.length, 1);
  await assert.rejects(deleteAlarm(db, MEMBER, { projectId: PROJECT, alarmId: created.body.id }),
    (error) => error instanceof HttpError && error.status === 403);
});

test("S10: sink CRUD is export-gated; test delivery signs NDJSON and records errors", async () => {
  const db = dbWithRoles();
  await assert.rejects(createSink(db, MEMBER, { projectId: PROJECT, input: { name: "s", type: "https", config: { url: "https://x" } } }),
    (error) => error instanceof HttpError && error.status === 403);
  const created = await createSink(db, ADMIN, {
    projectId: PROJECT,
    input: { name: "primary", type: "https", config: { url: "https://logs.local/ingest", secretRef: "secret:1@v1" } },
  });
  db.seedSecret("secret:1@v1", "hmac-secret");
  const calls = [];
  const delivered = await testSinkDelivery(db, ADMIN, {
    projectId: PROJECT,
    sinkId: created.body.id,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 202 };
    },
  });
  assert.equal(delivered.ok, true);
  assert.equal(calls[0].options.headers["x-pods-signature"].length, 64);
  await assert.rejects(
    testSinkDelivery(db, ADMIN, {
      projectId: PROJECT,
      sinkId: created.body.id,
      fetchImpl: async () => { throw new Error("connection refused"); },
    }),
    (error) => error instanceof HttpError && error.status === 502,
  );
  const failed = await db.getLogSink({ projectId: PROJECT, id: created.body.id });
  assert.equal(failed.status, "error");
  assert.match(failed.last_error, /connection refused/);
});

test("S10: stage logging settings validate formats and gate writes", async () => {
  const db = dbWithRoles();
  const api = await db.insertApi({ project_id: PROJECT, public_id: "a1b2c3d4e5", name: "api", protocol: "REST" });
  await db.insertStage({ project_id: PROJECT, api_id: api.id, name: "prod", deployment_id: null });
  await assert.rejects(
    updateStageLogging(db, MEMBER, { projectId: PROJECT, apiId: api.id, stageName: "prod", input: { tracingEnabled: true } }),
    (error) => error instanceof HttpError && error.status === 403);
  await assert.rejects(
    updateStageLogging(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod", input: { accessLog: { enabled: true, format: "$context.status" } } }),
    (error) => error instanceof HttpError && error.status === 422);
  await assert.rejects(
    updateStageLogging(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod", input: { accessLog: { enabled: true, format: "$context.requestId", destinations: ["missing-sink"] } } }),
    (error) => error instanceof HttpError && error.status === 422);
  const next = await updateStageLogging(db, ADMIN, {
    projectId: PROJECT, apiId: api.id, stageName: "prod",
    input: { accessLog: { enabled: true, format: "$context.requestId $context.status", destinations: ["pods"] }, tracingEnabled: true },
  });
  assert.equal(next.access_log.enabled, true);
  assert.equal(next.tracing_enabled, true);
});

test("S10: audit trail filters by action/api and exports redacted CSV", async () => {
  const db = dbWithRoles();
  await db.insertAudit({
    project_id: PROJECT, actor_id: "u-admin", actor_type: "user", action: "alarm.create",
    resource_type: "alarm", resource_id: "a1", api_id: "api-1", before: null,
    after: { token: "abc" }, request_id: "r1",
  });
  const filtered = await queryAudit(db, ADMIN, { projectId: PROJECT, action: "alarm.create", apiId: "api-1" });
  assert.equal(filtered.items.length, 1);
  const empty = await queryAudit(db, ADMIN, { projectId: PROJECT, action: "stage.promote" });
  assert.equal(empty.items.length, 0);
  const { csv, count } = await exportAuditCsv(db, ADMIN, { projectId: PROJECT });
  assert.equal(count, 1);
  assert.ok(csv.startsWith("id,created_at,actor_id,actor_type,action,resource_type,resource_id,api_id,request_id\n"));
  assert.match(csv, /alarm\.create/);
});
