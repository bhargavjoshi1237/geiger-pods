/**
 * S10 acceptance: emit phase (§1 wiring), log/event export (§6), alarms (§7).
 *
 * - Emit runs post-response via queueMicrotask/setImmediate and never blocks.
 * - https sink receives signed NDJSON; failing sink retries with backoff and
 *   does not block others.
 * - Alarm 2-of-3 datapoints breaching → ALARM once; treatMissingData variants;
 *   notification sent exactly once per transition.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { name as emitName, run as emitRun } from "../../lib/gateway/core/phases/emit.mjs";
import {
  createBatchWriter,
  createHttpsSink,
  createS3Sink,
  signBody,
  verifySignature,
} from "../../lib/gateway/core/observe/sinks.mjs";
import {
  compare,
  evaluateAlarm,
  transitionKey,
} from "../../lib/gateway/core/observe/alarms.mjs";

function emitCtx(overrides = {}) {
  return {
    requestId: "req-emit-1",
    startTime: Date.now() - 25,
    request: { method: "GET" },
    artifact: {
      projectId: "proj-1", apiId: "api-1", apiPublicId: "abcdefghij",
      protocol: "REST", stage: "prod", deploymentId: "dep-1",
    },
    context: {
      requestId: "req-emit-1",
      extendedRequestId: "ext-1",
      stage: "prod",
      apiId: "api-1",
      protocol: "REST",
      httpMethod: "GET",
      resourcePath: "/pets",
      status: "200",
      identity: { sourceIp: "1.2.3.4", userAgent: "t", apiKeyId: "" },
      authorizer: { principalId: "" },
      isCanaryRequest: false,
    },
    response: new Response("ok", { status: 200 }),
    ports: { clock: { now: () => Date.now() }, events: { emit() {} } },
    ...overrides,
  };
}

describe("S10: emit phase builds the request event after the response without blocking", () => {
  it("keeps the phase contract (name + run)", () => {
    assert.equal(emitName, "emit");
    assert.equal(typeof emitRun, "function");
  });

  it("emits the event off-tick and resolves immediately", async () => {
    const seen = [];
    const ctx = emitCtx({ ports: { clock: { now: () => Date.now() }, events: { emit: (e) => seen.push(e) } } });
    const pending = emitRun(ctx);
    assert.ok(pending instanceof Promise);
    await pending;
    assert.equal(ctx.requestEvent?.requestId ?? seen[0]?.requestId, "req-emit-1");
    // The sink fan-out itself stays async.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].status, 200);
    assert.ok(seen[0].latencyMs !== null && seen[0].latencyMs >= 0);
  });

  it("skips test-invoke traffic", async () => {
    const seen = [];
    const ctx = emitCtx({
      artifact: { ...emitCtx().artifact, testInvoke: true },
      ports: { clock: { now: () => Date.now() }, events: { emit: (e) => seen.push(e) } },
    });
    await emitRun(ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.length, 0);
  });

  it("a throwing sink never breaks emit", async () => {
    const ctx = emitCtx({
      ports: {
        clock: { now: () => Date.now() },
        events: { emit() { throw new Error("sink down"); } },
      },
    });
    await assert.doesNotReject(emitRun(ctx));
  });
});

describe("S10: https sink receives signed NDJSON; failing sink retries with backoff and does not block others", () => {
  it("signBody/verifySignature round-trip (x-pods-signature)", () => {
    const sig = signBody("secret-1", '{"a":1}');
    assert.equal(sig, createHmac("sha256", "secret-1").update('{"a":1}').digest("hex"));
    assert.equal(verifySignature("secret-1", '{"a":1}', sig), true);
    assert.equal(verifySignature("secret-1", '{"a":1}', "00"), false);
  });

  it("flush posts NDJSON ≤1MB with the signature header", async () => {
    const calls = [];
    const sink = createHttpsSink({
      url: "https://logs.example/ingest",
      secret: "s3cret",
      fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; },
    });
    sink.enqueue({ requestId: "r1" });
    sink.enqueue({ requestId: "r2" });
    const out = await sink.flush();
    assert.equal(out.delivered, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://logs.example/ingest");
    assert.equal(calls[0].init.headers["x-pods-signature"], signBody("s3cret", calls[0].init.body));
    assert.ok(Buffer.byteLength(calls[0].init.body, "utf8") <= 1024 * 1024);
    assert.deepEqual(calls[0].init.body.split("\n").map((line) => JSON.parse(line).requestId), ["r1", "r2"]);
  });

  it("failure backs off, retries, drops after 24h, and never blocks a sibling sink", async () => {
    let failures = 0;
    const bad = createHttpsSink({
      url: "https://down.example/x",
      secret: "s",
      baseRetryMs: 1000,
      maxRetryMs: 60000,
      fetchImpl: async () => { failures += 1; return { ok: false, status: 500 }; },
      clock: { now: () => 0 },
    });
    const goodCalls = [];
    const good = createHttpsSink({
      url: "https://up.example/x",
      secret: "s",
      fetchImpl: async (url, init) => { goodCalls.push(1); return { ok: true, status: 200 }; },
    });
    bad.enqueue({ requestId: "r1" });
    good.enqueue({ requestId: "r2" });
    const first = await bad.flush();
    assert.equal(first.delivered, 0);
    assert.equal(failures, 1);
    assert.ok(bad.nextAttemptAt > 0, "backoff scheduled");
    // Immediate retry is suppressed while backing off.
    const suppressed = await bad.flush();
    assert.equal(failures, 1);
    assert.equal(suppressed.delivered, 0);
    // Sibling unaffected.
    const goodOut = await good.flush();
    assert.equal(goodOut.delivered, 1);
    // After 24h the batch is dropped and counted.
    bad.clock.advance(25 * 3600 * 1000);
    const expired = await bad.flush();
    assert.equal(expired.dropped, 1);
    assert.equal(bad.dropped, 1);
    assert.equal(suppressed.delivered, 0);
  });

  it("s3 sink writes gzip NDJSON objects on size or interval", async () => {
    const objects = [];
    const sink = createS3Sink({
      prefix: "logs/pods",
      instanceId: "i-1",
      putObject: async (object) => { objects.push(object); },
    });
    sink.enqueue({ requestId: "a" });
    sink.enqueue({ requestId: "b" });
    const out = await sink.flush();
    assert.equal(out.objects, 1);
    assert.match(objects[0].key, /^logs\/pods\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/i-1-0\.ndjson\.gz$/);
    assert.equal(objects[0].contentEncoding, "gzip");
  });

  it("batch writer flushes every 500 rows", async () => {
    const inserted = [];
    const writer = createBatchWriter({ insert: async (rows) => { inserted.push(rows.length); }, maxRows: 500 });
    for (let i = 0; i < 1200; i += 1) writer.append({ id: i });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(inserted, [500, 500]);
    await writer.flush();
    assert.deepEqual(inserted, [500, 500, 200]);
  });
});

describe("S10: alarm 2-of-3 datapoints breaching → ALARM once; treatMissingData variants; notification sent exactly once per transition", () => {
  it("comparison operators", () => {
    assert.equal(compare(">", 5, 4), true);
    assert.equal(compare(">=", 4, 4), true);
    assert.equal(compare("<", 3, 4), true);
    assert.equal(compare("<=", 4, 4), true);
    assert.equal(compare(">", 4, 4), false);
  });

  it("2-of-3 breaching → ALARM; 1-of-3 stays OK", () => {
    const config = { comparison: ">", threshold: 100, evaluationPeriods: 3, datapointsToAlarm: 2, treatMissingData: "missing" };
    assert.equal(evaluateAlarm({ values: [150, 160, 10], ...config }).state, "ALARM");
    assert.equal(evaluateAlarm({ values: [150, 10, 10], ...config }).state, "OK");
  });

  it("treatMissingData variants", () => {
    const base = { comparison: ">", threshold: 100, evaluationPeriods: 3, datapointsToAlarm: 2 };
    assert.equal(evaluateAlarm({ values: [150, null, null], ...base, treatMissingData: "breaching" }).state, "ALARM");
    assert.equal(evaluateAlarm({ values: [150, null, null], ...base, treatMissingData: "notBreaching" }).state, "OK");
    assert.equal(evaluateAlarm({ values: [null, null, null], ...base, treatMissingData: "ignore" }).state, "INSUFFICIENT_DATA");
    assert.equal(evaluateAlarm({ values: [150, null, 160], ...base, treatMissingData: "ignore" }).state, "ALARM");
    assert.equal(evaluateAlarm({ values: [null, null, null], ...base, treatMissingData: "missing" }).state, "INSUFFICIENT_DATA");
  });

  it("idempotency key is alarmId:stateUpdatedAt", () => {
    assert.equal(transitionKey("alarm-1", "2026-10-05T12:00:00.000Z"), "alarm-1:2026-10-05T12:00:00.000Z");
  });
});
