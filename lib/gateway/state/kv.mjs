/**
 * `KvStore` port: shared surface re-exported for consumers.
 *
 * The interface is defined in `lib/gateway/core/ports.mjs` (typedefs).
 * Use {@link kvFromEnv} to pick the implementation: `memory` when no
 * `PODS_KV_URL` is set (tests, single process), `redis` otherwise
 * (any Redis-protocol server, e.g. Upstash via the Vercel Marketplace).
 *
 * Failure semantics (ADR-4): if the KV store is down, the gateway fails
 * open for caching and fails closed for quotas. Throttling is
 * configurable per project; the default is fail-open with a local
 * in-memory token bucket. Enforcement lives in S08/S09; this module
 * only selects the store.
 *
 * @module lib/gateway/state/kv
 */

import { MemoryKvStore } from "./memory-kv.mjs";
import { RedisKvStore } from "./redis-kv.mjs";

export { MemoryKvStore, RedisKvStore };

/**
 * Creates a `KvStore` from the environment.
 * Reads `PODS_KV_URL` (connection string env from ADR-4).
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env=process.env]
 * @param {{ now(): number }} [clock] - Injected clock for the memory store.
 * @returns {Promise<import("../core/ports.mjs").KvStore>}
 */
export async function kvFromEnv(env = process.env, clock) {
  const url = env?.PODS_KV_URL;
  if (!url) return new MemoryKvStore({ clock });
  const kv = new RedisKvStore(url, { clock });
  await kv.connect();
  return kv;
}
