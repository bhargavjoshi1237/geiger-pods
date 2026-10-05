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

/**
 * In-process token-bucket rate limiter (per project). Production runs one
 * Next instance per project shard; the same bucket math ports to KV later.
 */
export class ControlRateLimiter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.buckets = new Map();
    this.heavy = new Map();
  }

  reset() {
    this.buckets.clear();
    this.heavy.clear();
  }

  /**
   * Consumes one request from the project's bucket.
   *
   * @param {string} projectId
   * @returns {{ allowed: boolean, retryAfterMs: number }}
   */
  consume(projectId) {
    const now = this.now();
    const key = `rl:${projectId}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: CONTROL_PLANE_LIMIT.burst, updatedAt: now };
      this.buckets.set(key, bucket);
    }
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
   * create 1/30 s, import 1/3 s).
   *
   * @param {string} name - One of `deployments.create`, `domains.create`, `import`.
   * @param {string} scope - API id / project id scoping the bucket.
   * @returns {{ allowed: boolean, retryAfterMs: number }}
   */
  consumeHeavy(name, scope) {
    const limit = HEAVY_LIMITS[name];
    if (!limit) return { allowed: true, retryAfterMs: 0 };
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
