/**
 * F30 [runtime] (S15 part 2): LRU wiring in the cache phases.
 *
 * `storeInCache` (method-response, phase 19) evicts oldest-first victims
 * via `evictForStore` instead of blindly skipping when the budget is full,
 * and `cacheLookup` (phase 15) refreshes recency on hits. Proves eviction
 * end to end through the real `methodResponse` phase with a tiny budget
 * (`PODS_CACHE_MAX_BYTES`), not just the pure helper.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { run as runMethodResponse } from "../../lib/gateway/core/phases/method-response.mjs";
import { run as runCacheLookup } from "../../lib/gateway/core/phases/cache-lookup.mjs";
import {
  bytesKvKey,
  entryKvKey,
  loadLruRegistry,
} from "../../lib/gateway/core/release/cache.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";

const STAGE_ID = "f30wire:prod";

function ctxFor({ kv, cacheKey, bodyBytes }) {
  const body = new Uint8Array(bodyBytes);
  return {
    request: new Request("https://gw.test/pets", { headers: new Headers() }),
    artifact: {
      protocol: "REST",
      settings: {},
      features: {},
      stageCache: { enabled: true, size: "118", defaultTtl: 60 },
    },
    stageCache: { enabled: true, size: "118", defaultTtl: 60 },
    s06: { built: true },
    s06result: {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body,
      contentType: "application/json",
    },
    cacheKey,
    cacheStageId: STAGE_ID,
    cacheTtlSec: 60,
    cacheEncrypted: false,
    ports: { kv, clock: { now: () => 1_000 } },
  };
}

test("F30 [runtime]: methodResponse evicts the oldest entry instead of skipping", async (t) => {
  const previous = process.env.PODS_CACHE_MAX_BYTES;
  process.env.PODS_CACHE_MAX_BYTES = "150";
  t.after(() => {
    if (previous === undefined) delete process.env.PODS_CACHE_MAX_BYTES;
    else process.env.PODS_CACHE_MAX_BYTES = previous;
  });
  const kv = new MemoryKvStore({ clock: { now: () => 1_000 } });

  const first = ctxFor({ kv, cacheKey: "key-first", bodyBytes: 100 });
  const response1 = await runMethodResponse(first);
  assert.equal(response1.status, 200);
  assert.equal(first.cacheStoreSkipped ?? false, false);
  assert.ok(await kv.get(entryKvKey(STAGE_ID, "key-first")), "first entry must be stored");

  const second = ctxFor({ kv, cacheKey: "key-second", bodyBytes: 100 });
  const response2 = await runMethodResponse(second);
  assert.equal(response2.status, 200);
  // Old behavior set `cacheStoreSkipped`; LRU wiring stores instead.
  assert.equal(second.cacheStoreSkipped ?? false, false, "second store must evict, not skip");
  assert.ok(await kv.get(entryKvKey(STAGE_ID, "key-second")), "second entry must be stored");
  assert.equal(await kv.get(entryKvKey(STAGE_ID, "key-first")), null, "oldest entry must be evicted");

  const registry = await loadLruRegistry(kv, STAGE_ID);
  assert.ok(registry.some((entry) => entry.k === "key-second"), "registry must track the new store");
  const counter = Number(await kv.get(bytesKvKey(STAGE_ID)));
  assert.ok(counter <= 150, `byte counter must fit the budget, got ${counter}`);
});

test("F30 [runtime]: cacheLookup refreshes recency on hits", async (t) => {
  const previous = process.env.PODS_CACHE_MAX_BYTES;
  process.env.PODS_CACHE_MAX_BYTES = "100000";
  t.after(() => {
    if (previous === undefined) delete process.env.PODS_CACHE_MAX_BYTES;
    else process.env.PODS_CACHE_MAX_BYTES = previous;
  });
  const kv = new MemoryKvStore({ clock: { now: () => 1_000 } });
  const { cacheKeyFor, entryKvKey: entryKey, noteCacheStore: noteStore } = await import(
    "../../lib/gateway/core/release/cache.mjs"
  );
  const lookupCtx = {
    request: new Request("https://gw.test/pets", { headers: new Headers() }),
    artifact: {
      protocol: "REST",
      stage: "prod",
      apiPublicId: "f30wire",
      apiId: "f30wire",
      stageCache: { enabled: true, size: "118", defaultTtl: 60 },
      resources: [{ id: "res", path: "/pets", methods: { GET: { id: "m1", integrationId: "int-1" } } }],
      integrations: { "int-1": {} },
    },
    stageCache: { enabled: true, size: "118", defaultTtl: 60 },
    match: { methodId: "m1" },
    ports: { kv, clock: { now: () => 1_000 } },
  };
  // Seed the entry exactly where the lookup will find it.
  const keyHex = cacheKeyFor(lookupCtx, {
    method: "GET",
    resourcePath: "/pets",
    resourceId: "res",
    integration: {},
    stageId: STAGE_ID,
    epoch: "0",
  });
  // The lookup derives `stageId` from the artifact (`apiPublicId:stage`);
  // align the seed with that derivation.
  const derivedStage = "f30wire:prod";
  const derivedKey = cacheKeyFor(lookupCtx, {
    method: "GET",
    resourcePath: "/pets",
    resourceId: "res",
    integration: {},
    stageId: derivedStage,
    epoch: "0",
  });
  void keyHex;
  const body = Buffer.from(JSON.stringify({ ok: true })).toString("base64");
  await kv.set(entryKey(derivedStage, derivedKey), JSON.stringify({ status: 200, headers: {}, body, encrypted: false }));
  await noteStore(kv, { stageId: derivedStage, keyHex: derivedKey, bytes: 20, now: 1_000 });
  const before = await loadLruRegistry(kv, derivedStage);
  const beforeEntry = before.find((entry) => entry.k === derivedKey);
  assert.ok(beforeEntry, "store must register recency");

  // Simulate time passing, then hit: the lookup must refresh `t`.
  lookupCtx.ports.clock = { now: () => 9_999 };
  const hit = await runCacheLookup(lookupCtx);
  assert.ok(hit instanceof Response, "expected a cache hit");
  assert.equal(lookupCtx.cacheOutcome, "hit");
  const after = await loadLruRegistry(kv, derivedStage);
  const afterEntry = after.find((entry) => entry.k === derivedKey);
  assert.ok(afterEntry.t > beforeEntry.t, "hit must refresh recency");
});
