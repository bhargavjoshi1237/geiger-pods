/**
 * F50 (S15 part 2): stage observability settings reach the gateway runtime.
 *
 * The S10 control plane writes `stages.access_log`, `stages.method_settings`,
 * `stages.route_settings` and `stages.tracing_enabled`, but nothing ever
 * carried those settings to the gateway: the emit phase reads
 * `ctx.stageSettings` (populated by the runtime loader) with an
 * `artifact.stageSettings[stage]` fallback, and neither was populated on the
 * host path — so access logs, execution logs and traces silently never
 * emitted. The loader now maps the stage row (`stageObservabilityFromRow`)
 * and the host copies it to `ctx.stageSettings`.
 *
 * - Mapping unit: snake_case rows and camelCase fixtures map; nulls fall
 *   back to the emit-phase defaults (log off, OFF, tracing off).
 * - Migration contract: the F50 migration adds `default_logging_level` +
 *   `default_data_trace` (columns the control plane already writes).
 * - Host runtime: a real gateway serves requests with observability enabled;
 *   access-log rows, execution-log rows and trace spans arrive at the
 *   writers through `createGatewaySink` (no test header).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { createGatewayServer, createGatewaySink } from "../../gateway/server.mjs";
import { createMemoryLoader, stageObservabilityFromRow } from "../../gateway/loader.mjs";
import { PRESETS } from "../../lib/gateway/core/observe/access-log.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("F50: stageObservabilityFromRow maps stage rows and fixtures, defaults otherwise", () => {
  const row = {
    access_log: { enabled: true, format: PRESETS.CLF, destinations: ["pods"] },
    default_logging_level: "INFO",
    default_data_trace: true,
    tracing_enabled: true,
    method_settings: { "GET /pets": { loggingLevel: "ERROR" } },
    route_settings: {},
  };
  assert.deepEqual(stageObservabilityFromRow(row), {
    accessLog: row.access_log,
    loggingLevel: "INFO",
    dataTraceEnabled: true,
    tracingEnabled: true,
    methodSettings: { "GET /pets": { loggingLevel: "ERROR" } },
    routeSettings: {},
  });
  // camelCase fixtures pass through; missing values take emit defaults.
  assert.deepEqual(stageObservabilityFromRow({ accessLog: { enabled: false } }), {
    accessLog: { enabled: false },
    loggingLevel: "OFF",
    dataTraceEnabled: false,
    tracingEnabled: false,
    methodSettings: {},
    routeSettings: {},
  });
  assert.deepEqual(stageObservabilityFromRow({}), {
    accessLog: null,
    loggingLevel: "OFF",
    dataTraceEnabled: false,
    tracingEnabled: false,
    methodSettings: {},
    routeSettings: {},
  });
  assert.equal(stageObservabilityFromRow(null), null);
});

test("F50: migration adds default_logging_level + default_data_trace with @up/@down", () => {
  const sql = readFileSync(
    join(ROOT, "supabase", "migrations", "observability", "20261019000001_stage_observability_defaults.sql"),
    "utf8",
  );
  assert.match(sql, /@up/);
  assert.match(sql, /@down/);
  assert.match(sql, /default_logging_level/);
  assert.match(sql, /default_data_trace/);
});

function restArtifact(upstreamUrl) {
  const draft = {
    projectId: "proj-f50",
    apiId: "api-f50",
    apiPublicId: "f50obs00001",
    protocol: "REST",
    resources: [
      { id: "res-root", path: "/" },
      { id: "res-ok", path: "/ok" },
    ],
    methods: [
      { id: "m-ok", resourceId: "res-ok", httpMethod: "GET", authorizationType: "NONE", integrationId: "int-ok" },
    ],
    integrations: [
      { id: "int-ok", type: "HTTP_PROXY", uri: `${upstreamUrl}/status/200`, timeoutMs: 5000 },
    ],
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0, `fixture must compile: ${errors[0]?.message}`);
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

test("F50 [runtime]: access rows, execution rows and spans flow through a real gateway", async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const artifact = restArtifact(upstream.url);
  const accessRows = [];
  const executionRows = [];
  const spanBatches = [];
  const sink = createGatewaySink({
    logsWriter: {
      async insertAccessLogs(rows) { accessRows.push(...rows); },
      async insertExecutionLogs(rows) { executionRows.push(...rows); },
    },
    traceWriter: {
      async insertSpans(rows) { spanBatches.push(rows); },
    },
  });
  t.after(() => sink.close());
  const loader = createMemoryLoader({
    pathRouting: true,
    stages: new Map([[`${artifact.apiPublicId}:prod`, {
      artifact,
      stageObservability: {
        accessLog: { enabled: true, format: PRESETS.CLF, destinations: ["pods"] },
        loggingLevel: "INFO",
        dataTraceEnabled: false,
        tracingEnabled: true,
        methodSettings: {},
        routeSettings: {},
      },
    }]]),
  });
  const gateway = createGatewayServer({
    loader,
    ports: { events: sink, kv: new MemoryKvStore() },
  });
  const port = await gateway.start(0);
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${port}/${artifact.apiPublicId}/prod`;

  for (let i = 0; i < 2; i += 1) {
    const response = await fetch(`${base}/ok`);
    assert.equal(response.status, 200);
    await response.text();
  }

  await waitFor(() => sink.queue.length >= 2);
  await sink.flush();
  const events = [...sink.queue];
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.ok(event.accessLog, "access payload must be attached by the emit phase");
    assert.match(event.accessLog.line, /GET \/ok/);
    assert.match(event.accessLog.line, / 200 /);
    assert.ok(event.accessLog.row, "access row must be derived");
    assert.equal(event.accessLog.row.status, 200);
    assert.equal(event.accessLog.row.route, "GET /ok");
    assert.ok(event.executionLog, "execution payload must be attached at INFO level");
    assert.ok(Array.isArray(event.trace?.spans) && event.trace.spans.length > 0, "spans must be sampled");
    assert.equal(event.trace.spans[0].name, "gateway");
  }

  await sink.flushLogs();
  assert.ok(accessRows.length >= 2, `expected access rows at the writer, got ${accessRows.length}`);
  assert.ok(executionRows.length >= 2, `expected execution rows at the writer, got ${executionRows.length}`);
  const spans = spanBatches.flat();
  assert.ok(spans.length >= 2, `expected spans at the writer, got ${spans.length}`);
  for (const span of spans) {
    assert.equal(span.projectId, "proj-f50");
  }
});

test("F50 [runtime]: observability stays off by default (no rows, no spans)", async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const artifact = restArtifact(upstream.url);
  const accessRows = [];
  const spanBatches = [];
  const sink = createGatewaySink({
    logsWriter: {
      async insertAccessLogs(rows) { accessRows.push(...rows); },
      async insertExecutionLogs() {},
    },
    traceWriter: {
      async insertSpans(rows) { spanBatches.push(rows); },
    },
  });
  t.after(() => sink.close());
  const loader = createMemoryLoader({
    pathRouting: true,
    stages: new Map([[`${artifact.apiPublicId}:prod`, { artifact }]]),
  });
  const gateway = createGatewayServer({
    loader,
    ports: { events: sink, kv: new MemoryKvStore() },
  });
  const port = await gateway.start(0);
  t.after(() => gateway.close());

  const response = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/ok`);
  assert.equal(response.status, 200);
  await response.text();

  await waitFor(() => sink.queue.length >= 1);
  await sink.flush();
  const [event] = sink.queue;
  assert.equal(event.accessLog, null);
  assert.equal(event.executionLog, null);
  assert.deepEqual(event.trace?.spans ?? [], []);
  await sink.flushLogs();
  assert.equal(accessRows.length, 0);
  assert.equal(spanBatches.flat().length, 0);
});
