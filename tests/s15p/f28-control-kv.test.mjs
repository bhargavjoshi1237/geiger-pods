/**
 * F28 (S15): KV-backed idempotency + control-plane rate limiting.
 *
 * The KV port (`lib/gateway/state/`) backs both so multi-instance control
 * planes share state; the in-memory default stays for dev/tests, and a dead
 * KV fails over to the local bucket (control plane stays up, still
 * rate-limited per instance).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_PLANE_LIMIT,
  ControlRateLimiter,
  IDEMPOTENCY_TTL_MS,
  checkIdempotencyKv,
  idempotencyKvKey,
  recordIdempotencyKv,
} from "../../lib/control/rate-limit.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";

function clock() {
  let now = 0;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test("F28: KV-backed limiter shares state across instances", async () => {
  const time = clock();
  const kv = new MemoryKvStore({ clock: time });
  const first = new ControlRateLimiter({ now: time.now, kv });
  const second = new ControlRateLimiter({ now: time.now, kv });
  for (let index = 0; index < CONTROL_PLANE_LIMIT.burst; index += 1) {
    assert.equal((await first.consume("proj")).allowed, true);
  }
  // The burst is shared: the second instance sees the same empty bucket.
  const blocked = await second.consume("proj");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  // A different project is unaffected.
  assert.equal((await second.consume("other")).allowed, true);
  // Refill after 1 s (10 tokens) is visible to both instances.
  time.advance(1000);
  for (let index = 0; index < 10; index += 1) assert.equal((await second.consume("proj")).allowed, true);
  assert.equal((await first.consume("proj")).allowed, false);
});

test("F28: KV failure falls back to the local bucket (fail-open, still limited)", async () => {
  const broken = {
    async tokenBucket() { throw new Error("kv down"); },
    async incrBy() { throw new Error("kv down"); },
    async get() { throw new Error("kv down"); },
    async set() { throw new Error("kv down"); },
  };
  const time = clock();
  const limiter = new ControlRateLimiter({ now: time.now, kv: broken });
  for (let index = 0; index < CONTROL_PLANE_LIMIT.burst; index += 1) {
    assert.equal((await limiter.consume("proj")).allowed, true);
  }
  assert.equal((await limiter.consume("proj")).allowed, false);
});

test("F28: heavy buckets share via KV", async () => {
  const time = clock();
  const kv = new MemoryKvStore({ clock: time });
  const first = new ControlRateLimiter({ now: time.now, kv });
  const second = new ControlRateLimiter({ now: time.now, kv });
  assert.equal((await first.consumeHeavy("deployments.create", "api-1")).allowed, true);
  assert.equal((await second.consumeHeavy("deployments.create", "api-1")).allowed, false);
  time.advance(2000);
  assert.equal((await second.consumeHeavy("deployments.create", "api-1")).allowed, true);
});

test("F28: KV idempotency replays across instances; body change → 422", async () => {
  const time = clock();
  const kv = new MemoryKvStore({ clock: time });
  const input = { projectId: "p", actorKey: "u", key: "k-1", body: { name: "a" } };
  assert.deepEqual(await checkIdempotencyKv(kv, input), { replayed: false });
  await recordIdempotencyKv(kv, { ...input, status: 201, responseBody: { id: "api-1" } });
  const replayed = await checkIdempotencyKv(kv, input);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.status, 201);
  assert.deepEqual(replayed.body, { id: "api-1" });
  await assert.rejects(
    checkIdempotencyKv(kv, { ...input, body: { name: "b" } }),
    (error) => error.status === 422 && error.code === "idempotency_conflict",
  );
  // Expiry (24 h TTL) turns the key into a miss again.
  time.advance(IDEMPOTENCY_TTL_MS + 1);
  assert.deepEqual(await checkIdempotencyKv(kv, input), { replayed: false });
});

test("F28: oversized idempotent responses skip KV (bounded memory)", async () => {
  const kv = new MemoryKvStore({ clock: clock() });
  const big = { blob: "x".repeat(300 * 1024) };
  const stored = await recordIdempotencyKv(kv, {
    projectId: "p", actorKey: "u", key: "k-big", body: {}, status: 201, responseBody: big,
  });
  assert.equal(stored.stored, false);
  assert.deepEqual(await checkIdempotencyKv(kv, { projectId: "p", actorKey: "u", key: "k-big", body: {} }), { replayed: false });
});

test("F28: idempotency KV keys are namespaced per project+actor+key", () => {
  assert.equal(idempotencyKvKey({ projectId: "p", actorKey: "u", key: "k" }), "ctrl:idem:p:u:k");
});
