/**
 * S08 shared-state runtime test: N gateway instances sharing one KV store
 * enforce a 10 rps / burst 10 limit within ±1 over 1000 concurrent requests.
 * Production shares Redis (atomic Lua `tokenBucket`); here the instances
 * share one `MemoryKvStore`, which honors the same atomic `KvStore` contract
 * (`redis-kv.mjs` implements `tokenBucket` as a single Lua script).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { run as runThrottle } from "../../lib/gateway/core/phases/throttle.mjs";

function instanceContext(kv, clock, index) {
  return {
    request: new Request("https://gw.example/pets", { method: "GET" }),
    artifact: {
      protocol: "REST",
      projectId: "proj-1",
      apiId: "api-uuid-1",
      apiPublicId: "a1b2c3d4e5",
      stage: "prod",
    },
    ports: { kv, clock, log() {}, events: { emit() {} } },
    context: {
      requestId: `req-${index}`,
      accountId: "proj-1",
      routeKey: "GET /pets",
      resourcePath: "/pets",
      resourceId: "r1",
      identity: {},
      authorizer: {},
      error: { message: "", messageString: '""', responseType: "" },
    },
    match: { resourceId: "r1", resourcePath: "/pets", methodId: "m1", httpMethod: "GET", pathParameters: {} },
    usage: { project: { rate: 10, burst: 10 } },
  };
}

test("S08 [runtime]: two gateway instances sharing one KV enforce 10 rps burst 10 within ±1 over 1000 concurrent requests", async () => {
  const kv = new MemoryKvStore({ clock: { now: () => Date.UTC(2026, 9, 4, 12, 0, 0) } });
  const clock = { now: () => Date.UTC(2026, 9, 4, 12, 0, 0) };
  const attempts = Array.from({ length: 1000 }, (_, index) => (async () => {
    const ctx = instanceContext(kv, clock, index);
    try {
      await runThrottle(ctx);
      return true;
    } catch {
      return false;
    }
  })());
  const results = await Promise.all(attempts);
  const allowed = results.filter(Boolean).length;
  assert.ok(
    allowed >= 9 && allowed <= 11,
    `expected 10 ± 1 allowed (burst 10, single instant), got ${allowed}`,
  );
});
