/**
 * F29 (S15): approximate LRU eviction for stage-cache budgets (S09 §2).
 *
 * The engine tracks per-entry recency in KV (`cache:lru:<stageId>`,
 * bounded → approximate) and `evictForStore` picks oldest-first victims so
 * a store fits the budget instead of blindly skipping. Items larger than
 * the whole budget never fit (`fits: false` → keep the skip behavior).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  evictForStore,
  loadLruRegistry,
  lruKvKey,
  noteCacheHit,
  noteCacheStore,
} from "../../lib/gateway/core/release/cache.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";

const STAGE = "api123:prod";
const kv = () => new MemoryKvStore({ clock: { now: () => 1_000 } });

test("F30: evictForStore picks oldest-first victims until the store fits", () => {
  const entries = [
    { k: "a", b: 40, t: 3 },
    { k: "b", b: 40, t: 1 },
    { k: "c", b: 40, t: 2 },
  ];
  // Budget 100, used 120 → need 20 more for a 40-byte store... total would
  // be 160; evict oldest (b, then c) until 40 + remaining ≤ 100.
  const out = evictForStore(entries, { budget: 100, neededBytes: 40 });
  assert.deepEqual(out.evicted, ["b", "c"]);
  assert.equal(out.fits, true);
  assert.equal(out.remainingBytes, 40);
});

test("F30: evictForStore is a no-op when the store already fits", () => {
  const out = evictForStore([{ k: "a", b: 10, t: 1 }], { budget: 100, neededBytes: 10 });
  assert.deepEqual(out.evicted, []);
  assert.equal(out.fits, true);
});

test("F30: items larger than the budget never fit (skip, do not empty)", () => {
  const out = evictForStore([{ k: "a", b: 10, t: 1 }], { budget: 100, neededBytes: 200 });
  assert.equal(out.fits, false);
  assert.deepEqual(out.evicted, []);
});

test("F30: KV-backed recency — hits refresh, stores evict least-recently-used", async () => {
  const store = kv();
  await noteCacheStore(store, { stageId: STAGE, keyHex: "a", bytes: 40, now: 1 });
  await noteCacheStore(store, { stageId: STAGE, keyHex: "b", bytes: 40, now: 2 });
  await noteCacheStore(store, { stageId: STAGE, keyHex: "c", bytes: 40, now: 3 });
  await noteCacheHit(store, { stageId: STAGE, keyHex: "a", now: 4 });
  const registry = await loadLruRegistry(store, STAGE);
  assert.equal(registry.length, 3);
  // `a` was refreshed most recently; `b` is now the oldest.
  const out = evictForStore(registry, { budget: 100, neededBytes: 40 });
  assert.deepEqual(out.evicted, ["b", "c"]);
  assert.ok(lruKvKey(STAGE).startsWith("cache:lru:"));
});

test("F30: the recency registry stays bounded (approximate LRU)", async () => {
  const store = kv();
  for (let index = 0; index < 600; index += 1) {
    await noteCacheStore(store, { stageId: STAGE, keyHex: `k${index}`, bytes: 1, now: index });
  }
  const registry = await loadLruRegistry(store, STAGE);
  assert.ok(registry.length <= 512, `registry must stay bounded, got ${registry.length}`);
  // The newest entries survive bounding.
  assert.ok(registry.some((entry) => entry.k === "k599"));
});
