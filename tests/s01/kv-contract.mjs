/**
 * Shared `KvStore` contract suite (S01). Both the memory store and the
 * redis store (when `PODS_KV_URL` is set) run these same assertions.
 * Not a test file itself — `*.test.mjs` files call {@link defineKvContract}.
 *
 * @module tests/s01/kv-contract
 */

import assert from "node:assert/strict";
import test from "node:test";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Registers the contract tests for one store factory.
 *
 * @param {string} label - Suite label, e.g. `"memory"`.
 * @param {() => Promise<object> | object} createStore - Returns a `KvStore`.
 */
export function defineKvContract(label, createStore) {
  test(`S01: kv contract (${label}): get/set/del round-trips and misses read null`, async () => {
    const kv = await createStore();
    try {
      assert.equal(await kv.get("missing"), null);
      await kv.set("k", "v");
      assert.equal(await kv.get("k"), "v");
      await kv.del("k");
      assert.equal(await kv.get("k"), null);
    } finally {
      await kv.close?.();
    }
  });

  test(`S01: kv contract (${label}): set with ttlMs expires`, async () => {
    const kv = await createStore();
    try {
      await kv.set("ttl", "v", { ttlMs: 60 });
      assert.equal(await kv.get("ttl"), "v");
      await sleep(150);
      assert.equal(await kv.get("ttl"), null);
    } finally {
      await kv.close?.();
    }
  });

  test(`S01: kv contract (${label}): incrBy accumulates and rejects non-integers`, async () => {
    const kv = await createStore();
    try {
      assert.equal(await kv.incrBy("n", 2), 2);
      assert.equal(await kv.incrBy("n", 3), 5);
      assert.equal(await kv.get("n"), "5");
      await kv.set("bad", "nan");
      await assert.rejects(() => kv.incrBy("bad", 1));
    } finally {
      await kv.close?.();
    }
  });

  test(`S01: kv contract (${label}): tokenBucket allows burst then denies`, async () => {
    const kv = await createStore();
    try {
      for (let i = 0; i < 3; i++) {
        const out = await kv.tokenBucket("bucket", { rate: 1, burst: 3, cost: 1 });
        assert.equal(out.allowed, true);
        assert.equal(out.retryAfterMs, 0);
      }
      const denied = await kv.tokenBucket("bucket", { rate: 1, burst: 3, cost: 1 });
      assert.equal(denied.allowed, false);
      assert.ok(denied.retryAfterMs >= 0);
    } finally {
      await kv.close?.();
    }
  });

  test(`S01: kv contract (${label}): incrBy preserves TTL unless ttlMs overrides`, async () => {
    const kv = await createStore();
    try {
      await kv.set("keep", "10", { ttlMs: 100_000 });
      assert.equal(await kv.incrBy("keep", 5), 15);
      assert.equal(await kv.get("keep"), "15");
      await kv.set("swap", "0", { ttlMs: 100_000 });
      assert.equal(await kv.incrBy("swap", 1, { ttlMs: 100_000 }), 1);
      assert.equal(await kv.get("swap"), "1");
    } finally {
      await kv.close?.();
    }
  });

  test(`S01: kv contract (${label}): publish/subscribe delivers messages`, async () => {
    const kv = await createStore();
    try {
      const seen = [];
      const off = await kv.subscribe("ch", (msg) => seen.push(msg));
      await kv.publish("ch", "hello");
      await sleep(50);
      assert.deepEqual(seen, ["hello"]);
      await off?.();
      await kv.publish("ch", "again");
      await sleep(50);
      assert.deepEqual(seen, ["hello"]);
    } finally {
      await kv.close?.();
    }
  });
}
