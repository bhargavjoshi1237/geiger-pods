/**
 * Shared-KV accessor for the S08 management routes (control plane).
 *
 * The gateway runtime and the control plane share one KV (Redis via
 * `PODS_KV_URL`, memory otherwise) so key/plan mutations are visible to the
 * data plane within the pub/sub + 60 s TTL bounds without a redeploy. The
 * client is created once per server instance (module-level cache); route
 * handlers must never create one per request.
 *
 * @module lib/control/usage-kv
 */

import { kvFromEnv } from "../gateway/state/kv.mjs";

let cached = null;

/**
 * Returns the shared KV client (cached per server instance).
 *
 * @returns {Promise<object>} `KvStore`.
 */
export async function getUsageKv() {
  if (!cached) cached = kvFromEnv();
  return cached;
}

/** Test hook: replaces the cached client. */
export function setUsageKv(kv) {
  cached = kv ?? null;
}

/** Test hook: clears the cached client. */
export function resetUsageKv() {
  cached = null;
}
