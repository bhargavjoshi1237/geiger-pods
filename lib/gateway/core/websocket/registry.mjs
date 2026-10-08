/**
 * WebSocket connection registry + instance liveness over the KV port (S12 §4).
 *
 * Keys: `ws:conn:{id}` → JSON record with TTL max-duration + 60 s;
 * `ws:instance:{id}` heartbeat every 10 s with a 30 s TTL. Entries pointing
 * at a dead instance are treated as gone (410) and cleaned up lazily.
 *
 * @module lib/gateway/core/websocket/registry
 */

import { randomBytes } from "node:crypto";
import { CONN_TTL_MS, INSTANCE_TTL_MS, connKey, instanceKey } from "./constants.mjs";

/**
 * Creates a 16-char base64url connection id via `crypto.randomBytes(12)`.
 *
 * @param {() => Uint8Array} [rand=randomBytes] - Injectable for tests.
 * @returns {string}
 */
export function newConnectionId(rand = (n) => randomBytes(n)) {
  const bytes = rand(12);
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Reads a connection record, treating entries on dead instances as gone.
 *
 * @param {object} kv - KvStore.
 * @param {string} connectionId
 * @returns {Promise<object|null>}
 */
export async function getConnection(kv, connectionId) {
  if (!kv || typeof connectionId !== "string" || !connectionId) return null;
  if (connectionId.length > 128) return null;
  const raw = await kv.get(connKey(connectionId)).catch(() => null);
  if (!raw) return null;
  let record = null;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record || typeof record !== "object") return null;
  // Liveness: a registry entry pointing at a dead instance is gone.
  if (record.instanceId) {
    const heartbeat = await kv.get(instanceKey(record.instanceId)).catch(() => null);
    if (!heartbeat) {
      await kv.del(connKey(connectionId)).catch(() => {});
      return null;
    }
  }
  return record;
}

/**
 * Registers a connection with TTL.
 *
 * @param {object} kv
 * @param {string} connectionId
 * @param {object} record
 * @param {{ ttlMs?: number }} [options={}]
 */
export async function registerConnection(kv, connectionId, record, { ttlMs = CONN_TTL_MS } = {}) {
  await kv.set(connKey(connectionId), JSON.stringify(record), { ttlMs });
}

/**
 * Deletes a connection registration (best-effort $disconnect cleanup).
 *
 * @param {object} kv
 * @param {string} connectionId
 */
export async function deleteConnection(kv, connectionId) {
  if (!kv || !connectionId) return;
  await kv.del(connKey(connectionId)).catch(() => {});
}

/**
 * Touches the connection's `lastActiveAt` (fire-and-forget safe).
 *
 * @param {object} kv
 * @param {string} connectionId
 * @param {number} now
 */
export async function touchConnection(kv, connectionId, now) {
  if (!kv || !connectionId) return;
  const record = await getConnection(kv, connectionId).catch(() => null);
  if (!record) return;
  record.lastActiveAt = now;
  await kv.set(connKey(connectionId), JSON.stringify(record), { ttlMs: CONN_TTL_MS }).catch(() => {});
}

/**
 * Heartbeats this instance (every 10 s, 30 s TTL).
 *
 * @param {object} kv
 * @param {string} instanceId
 * @param {number} now
 */
export async function heartbeatInstance(kv, instanceId, now) {
  if (!kv || !instanceId) return;
  await kv.set(instanceKey(instanceId), JSON.stringify({ instanceId, at: now }), { ttlMs: INSTANCE_TTL_MS }).catch(() => {});
}
