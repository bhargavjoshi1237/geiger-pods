import assert from "node:assert/strict";
import test from "node:test";

import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { defineKvContract } from "./kv-contract.mjs";

defineKvContract("memory", () => new MemoryKvStore());

test("S01: memory tokenBucket allows burst then refills at rate using injected clock", async () => {
  let now = 1_000_000;
  const kv = new MemoryKvStore({ clock: { now: () => now } });
  for (let i = 0; i < 5; i++) {
    const out = await kv.tokenBucket("api", { rate: 1, burst: 5, cost: 1 });
    assert.deepEqual(out, { allowed: true, remaining: 4 - i, retryAfterMs: 0 });
  }
  const denied = await kv.tokenBucket("api", { rate: 1, burst: 5, cost: 1 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterMs > 900 && denied.retryAfterMs <= 1000);

  now += 3000;
  const refilled = await kv.tokenBucket("api", { rate: 1, burst: 5, cost: 1 });
  assert.deepEqual(refilled, { allowed: true, remaining: 2, retryAfterMs: 0 });
});
