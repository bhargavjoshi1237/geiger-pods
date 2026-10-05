import assert from "node:assert/strict";
import test from "node:test";
import { buildRequestEvent, createEventSink } from "../../lib/gateway/core/observe/event.mjs";
import { buildContext } from "../../lib/gateway/core/context.mjs";
import { run } from "../../lib/gateway/core/phases/emit.mjs";

function makeCtx(overrides = {}) {
  const request = new Request("https://example.local/pets", { method: "GET" });
  const artifact = { projectId: "p1", apiId: "a1", apiPublicId: "a1b2c3d4e5", protocol: "REST", stage: "prod", ...overrides.artifact };
  const ctx = buildContext(request, artifact, { events: { emit() {} }, clock: { now: () => 1000 } });
  ctx.response = new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "content-length": "11" } });
  Object.assign(ctx, overrides.ctx ?? {});
  return ctx;
}

test("S10: emitting is off the response path — a slow sink does not increase request latency (bounded queue drops and counts)", async () => {
  const seen = [];
  const sink = createEventSink({
    capacity: 4,
    consumers: [async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      seen.push(event);
    }],
  });
  const ctx = makeCtx();
  ctx.ports = { ...ctx.ports, events: sink };
  const started = Date.now();
  await run(ctx);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 50, `emit blocked the response path for ${elapsed} ms`);
  // Overflow the bounded queue: oldest dropped, counter incremented.
  for (let index = 0; index < 10; index += 1) sink.emit({ index });
  assert.ok(sink.queue.length <= 4, `queue exceeded capacity: ${sink.queue.length}`);
  assert.ok(sink.droppedEvents > 0, "expected dropped events to be counted");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(seen.length > 0, "consumer still received events off-path");
});

test("S10: ctx.trace always exists and emit collects its lines without blocking", async () => {
  const request = new Request("https://example.local/pets");
  const ctx = buildContext(request, { protocol: "REST" }, {});
  assert.equal(typeof ctx.trace, "function");
  ctx.trace("INFO", "Method request path: {}");
  ctx.trace("ERROR", "Backend failed");
  assert.equal(ctx.traceLines.length, 2);
  const emitted = [];
  ctx.ports = { events: { emit: (payload) => emitted.push(payload) }, clock: { now: () => 2000 } };
  ctx.response = new Response("nope", { status: 500 });
  await run(ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].status, 500);
});

test("S10: request event carries the §1 shape and canary/error flags", () => {
  const ctx = makeCtx({ ctx: { throttled: true, cacheOutcome: "hit" } });
  ctx.context.routeKey = "GET /pets";
  const event = buildRequestEvent(ctx, ctx.response, { latencyMs: 12, integrationLatencyMs: 8 });
  for (const key of ["ts", "requestId", "extendedRequestId", "projectId", "apiId", "protocol", "stage", "routeKey", "httpMethod", "status", "latencyMs", "integrationLatencyMs", "sourceIp", "traceId"]) {
    assert.ok(key in event, `missing event field ${key}`);
  }
  assert.equal(event.status, 200);
  assert.equal(event.throttled, true);
  assert.equal(event.cache, "hit");
});
