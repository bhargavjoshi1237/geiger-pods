// Idempotency-Key handling for POSTs (S14 §1) and the control-plane rate
// limiter (10 rps sustained, burst 40 per project, plus named heavy-operation
// buckets). Both are pure/injected-clock so tests are deterministic.

import { createHash } from "node:crypto";
import { HttpError } from "./errors.mjs";

export const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

/**
 * Stable hash of a request body for idempotency comparison.
 *
 * @param {unknown} body
 * @returns {string}
 */
export function hashBody(body) {
  return createHash("sha256").update(JSON.stringify(body ?? null), "utf8").digest("hex");
}

/**
 * Checks the idempotency store before running a POST handler.
 *
 * @param {object} db - Needs `getIdempotency`, `insertIdempotency`.
 * @param {{ projectId: string, actorKey: string, key: string|null, body: unknown }} input
 * @returns {Promise<{ replayed: true, status: number, body: unknown }|{ replayed: false }>}
 * @throws {HttpError} 422 when the same key arrives with a different body.
 */
export async function checkIdempotency(db, { projectId, actorKey, key, body }) {
  if (!key) return { replayed: false };
  const existing = await db.getIdempotency({ projectId, actorKey, key });
  if (!existing) return { replayed: false };
  if (existing.expires_at && new Date(existing.expires_at).getTime() <= Date.now()) {
    return { replayed: false };
  }
  if (existing.request_hash !== hashBody(body)) {
    throw new HttpError(422, "idempotency_conflict", "Idempotency-Key was already used with a different request body.");
  }
  return { replayed: true, status: existing.response_status, body: existing.response_body };
}

/**
 * Records a successful POST response for later replays.
 */
export async function recordIdempotency(db, { projectId, actorKey, key, body, status, responseBody }) {
  if (!key) return;
  try {
    await db.insertIdempotency({
      project_id: projectId, actor_key: actorKey, idempotency_key: key,
      request_hash: hashBody(body), response_status: status, response_body: responseBody ?? null,
    });
  } catch {
    // A lost idempotency record only loses replay protection, never the write.
  }
}

export const CONTROL_PLANE_LIMIT = { ratePerSecond: 10, burst: 40 };

const HEAVY_LIMITS = {
  "deployments.create": { windowMs: 2000, max: 1 },
  "domains.create": { windowMs: 30_000, max: 1 },
  import: { windowMs: 3000, max: 1 },
};

// --- KV backing (F28: multi-instance control planes share state) ------------
// The `KvStore` port (`lib/gateway/state/`) backs both the rate limiter and
// idempotency when available (`PODS_KV_URL` set → Redis; otherwise the
// in-memory default for dev/tests). A dead KV fails over to the local
// bucket, so the control plane stays up (still rate-limited per instance).

/** Max idempotency response kept in KV (larger responses skip KV storage). */
export const IDEMPOTENCY_KV_MAX_BYTES = 256 * 1024;

function escapeKvPart(value, max = 128) {
  const text = String(value ?? "").slice(0, Math.max(1, max));
  return text.replace(/%/g, "%25").replace(/:/g, "%3A");
}

/**
 * KV key for an idempotency record (namespaced per project+actor+key).
 *
 * @param {{ projectId: string, actorKey: string, key: string }} input
 * @returns {string}
 */
export function idempotencyKvKey({ projectId, actorKey, key }) {
  return `ctrl:idem:${escapeKvPart(projectId)}:${escapeKvPart(actorKey)}:${escapeKvPart(key, 256)}`;
}

/**
 * KV-backed idempotency check (see `checkIdempotency` for the db version).
 *
 * @param {object} kv - `KvStore` (needs `get`).
 * @param {{ projectId: string, actorKey: string, key: string|null, body: unknown }} input
 * @returns {Promise<{ replayed: true, status: number, body: unknown }|{ replayed: false }>}
 * @throws {HttpError} 422 when the same key arrives with a different body.
 */
export async function checkIdempotencyKv(kv, { projectId, actorKey, key, body }) {
  if (!key) return { replayed: false };
  let raw = null;
  try {
    raw = await kv.get(idempotencyKvKey({ projectId, actorKey, key }));
  } catch {
    return { replayed: false };
  }
  if (!raw) return { replayed: false };
  let record = null;
  try {
    record = JSON.parse(String(raw));
  } catch {
    return { replayed: false };
  }
  if (!record || typeof record !== "object" || typeof record.h !== "string") return { replayed: false };
  if (record.h !== hashBody(body)) {
    throw new HttpError(422, "idempotency_conflict", "Idempotency-Key was already used with a different request body.");
  }
  return { replayed: true, status: record.s ?? 200, body: record.b ?? null };
}

/**
 * KV-backed idempotency record (24 h TTL). Responses over
 * `IDEMPOTENCY_KV_MAX_BYTES` are skipped (`{ stored: false }`) so one giant
 * replay cannot exhaust shared KV memory. Never throws: a lost record only
 * loses replay protection, never the write.
 *
 * @param {object} kv - `KvStore` (needs `set`).
 * @param {{ projectId: string, actorKey: string, key: string|null, body: unknown, status: number, responseBody: unknown }} input
 * @returns {Promise<{ stored: boolean }>}
 */
export async function recordIdempotencyKv(kv, { projectId, actorKey, key, body, status, responseBody }) {
  if (!key) return { stored: false };
  const payload = JSON.stringify({ h: hashBody(body), s: status ?? 200, b: responseBody ?? null });
  if (Buffer.byteLength(payload, "utf8") > IDEMPOTENCY_KV_MAX_BYTES) return { stored: false };
  try {
    await kv.set(idempotencyKvKey({ projectId, actorKey, key }), payload, { ttlMs: IDEMPOTENCY_TTL_MS });
    return { stored: true };
  } catch {
    return { stored: false };
  }
}

/** Process-wide control-plane KV (singleton; memory when `PODS_KV_URL` is unset). */
let controlKvSingleton = undefined;

/**
 * Returns the shared control-plane KV, or null when unavailable. Override
 * in tests with {@link setControlKv}.
 *
 * @returns {Promise<object|null>}
 */
export async function getControlKv() {
  if (controlKvSingleton !== undefined) return controlKvSingleton;
  try {
    const { kvFromEnv } = await import("../gateway/state/kv.mjs");
    controlKvSingleton = await kvFromEnv();
  } catch {
    controlKvSingleton = null;
  }
  return controlKvSingleton;
}

/** Test hook: replaces the process-wide control-plane KV (`undefined` resets). */
export function setControlKv(next) {
  controlKvSingleton = next;
}

/**
 * Control-plane rate limiter (per project). Uses the shared KV token bucket
 * when a KV store is available (multi-instance safe) and the in-process
 * bucket otherwise (dev/tests, or KV outage). Async: KV calls are awaited.
 */
export class ControlRateLimiter {
  constructor({ now = () => Date.now(), kv = null } = {}) {
    this.now = now;
    this.kv = kv;
    this.buckets = new Map();
    this.heavy = new Map();
  }

  reset() {
    this.buckets.clear();
    this.heavy.clear();
  }

  bucketFor(key, initial) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = initial;
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Consumes one request from the project's bucket.
   *
   * @param {string} projectId
   * @param {{ kv?: object|null }} [options={}] - Overrides the instance KV.
   * @returns {Promise<{ allowed: boolean, retryAfterMs: number }>}
   */
  async consume(projectId, { kv = undefined } = {}) {
    const store = kv === undefined ? this.kv : kv;
    if (store && typeof store.tokenBucket === "function") {
      try {
        const out = await store.tokenBucket(`ctrl:rl:${projectId}`, {
          rate: CONTROL_PLANE_LIMIT.ratePerSecond,
          burst: CONTROL_PLANE_LIMIT.burst,
          cost: 1,
        });
        if (out && typeof out.allowed === "boolean") {
          return { allowed: out.allowed, retryAfterMs: Math.max(0, Number(out.retryAfterMs) || 0) };
        }
      } catch {
        // Fall through to the local bucket (fail-open, still limited).
      }
    }
    const now = this.now();
    const key = `rl:${projectId}`;
    const bucket = this.bucketFor(key, { tokens: CONTROL_PLANE_LIMIT.burst, updatedAt: now });
    const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(CONTROL_PLANE_LIMIT.burst, bucket.tokens + elapsedSec * CONTROL_PLANE_LIMIT.ratePerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    const retryAfterMs = Math.ceil(((1 - bucket.tokens) / CONTROL_PLANE_LIMIT.ratePerSecond) * 1000);
    return { allowed: false, retryAfterMs };
  }

  /**
   * Named heavy-operation buckets (deployments 1/2 s per API, domain
   * create 1/30 s, import 1/3 s). KV-backed via an atomic increment with
   * TTL (first writer in the window wins); local map otherwise.
   *
   * @param {string} name - One of `deployments.create`, `domains.create`, `import`.
   * @param {string} scope - API id / project id scoping the bucket.
   * @param {{ kv?: object|null }} [options={}]
   * @returns {Promise<{ allowed: boolean, retryAfterMs: number }>}
   */
  async consumeHeavy(name, scope, { kv = undefined } = {}) {
    const limit = HEAVY_LIMITS[name];
    if (!limit) return { allowed: true, retryAfterMs: 0 };
    const store = kv === undefined ? this.kv : kv;
    if (store && typeof store.incrBy === "function") {
      try {
        const count = await store.incrBy(`ctrl:heavy:${name}:${scope}`, 1, { ttlMs: limit.windowMs });
        if (count === 1) return { allowed: true, retryAfterMs: 0 };
        return { allowed: false, retryAfterMs: limit.windowMs };
      } catch {
        // Fall through to the local bucket.
      }
    }
    const now = this.now();
    const key = `heavy:${name}:${scope}`;
    const last = this.heavy.get(key) ?? -Infinity;
    if (now - last >= limit.windowMs) {
      this.heavy.set(key, now);
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: limit.windowMs - (now - last) };
  }
}

let shared = null;

/** Process-wide limiter used by the route wrapper. */
export function sharedLimiter() {
  if (!shared) shared = new ControlRateLimiter();
  return shared;
}

/** Test hook: replaces the process-wide limiter. */
export function setSharedLimiter(next) {
  shared = next;
}
