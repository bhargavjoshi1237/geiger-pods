/**
 * `methodResponse` phase (pipeline row 19 — CORS response headers,
 * compression, cache store).
 *
 * S06W implementation of the S06 half (keeping the `name` + `run(ctx)`
 * contract; S09 owns cache lookup/store and streaming and extends this
 * module). Builds the final client `Response` from `ctx.s06result` (set by
 * `integrationResponse`):
 *
 * 1. Content-Type defaults to the selected template/backend type.
 * 2. Payload compression (`minimum_compression_size`, `node:zlib`):
 *    bodies at or above the threshold with a client `Accept-Encoding` of
 *    `gzip`/`deflate` (`br` only with `features.brotliCompression`) and no
 *    backend `Content-Encoding` are compressed; `Vary: Accept-Encoding` is
 *    added. Never for 204/304.
 * 3. Managed HTTP CORS headers replace backend CORS headers.
 *
 * Returns the final `Response` (short-circuits the pipeline, as `invoke`
 * used to). Returns `undefined` when the S06 request phases did not run
 * (non-HTTP/REST protocols, unmatched requests, or the S05 invoke fallback).
 *
 * @module lib/gateway/core/phases/method-response
 */

import { withManagedCors } from "../processing/runtime.mjs";
import { applyEdgeHeaders } from "../edge/edge-headers.mjs";
import {
  compressBody,
  negotiateResponseCompression,
} from "../processing/compression.mjs";
import {
  budgetForSize,
  bytesKvKey,
  dekForStage,
  encryptBody,
  entryKvKey,
  evictForStore,
  loadLruRegistry,
  noteCacheStore,
  saveLruRegistry,
  shouldStore,
  stageCacheOf,
} from "../release/cache.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "methodResponse";

/**
 * Builds the final client response.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<Response|undefined>} Final response, or `undefined`.
 */
export async function run(ctx) {
  const staged = ctx?.s06result ?? null;
  if (!ctx?.s06?.built || !staged) return undefined;
  const artifact = ctx?.artifact ?? {};
  const settings = artifact.settings ?? {};
  const features = artifact.features ?? {};

  let status = staged.status ?? 200;
  if (!Number.isInteger(status) || status < 100 || status > 599) status = 500;
  let body = staged.body instanceof Uint8Array ? staged.body : null;
  if (status === 204 || status === 304) body = null;
  const headers = new Headers(staged.headers ?? {});
  if (!headers.has("content-type")) {
    if (staged.contentType) {
      try {
        headers.set("content-type", staged.contentType);
      } catch {
        // Leave the header unset when illegal.
      }
    } else if (body && body.byteLength > 0) {
      // S05 parity: a body without a type is JSON (upstream echoes, MOCK
      // payloads and function outputs are JSON by default).
      try {
        headers.set("content-type", "application/json");
      } catch {
        // Leave the header unset when illegal.
      }
    }
  }

  // Payload compression (spec §8).
  const threshold = settings.minimumCompressionSize ?? null;
  if (threshold !== null && threshold !== undefined && body && body.byteLength > 0) {
    let acceptEncoding = null;
    try {
      acceptEncoding = ctx.request.headers.get("accept-encoding");
    } catch {
      acceptEncoding = null;
    }
    const encoding = negotiateResponseCompression({
      statusCode: status,
      bodyLength: body.byteLength,
      threshold,
      acceptEncoding,
      backendContentEncoding: headers.get("content-encoding"),
      streaming: false,
      brotliEnabled: features.brotliCompression ?? false,
    });
    if (encoding) {
      body = compressBody(body, encoding);
      try {
        headers.set("content-encoding", encoding);
      } catch {
        // Leave the header unset when illegal.
      }
      appendVary(headers, "Accept-Encoding");
      try {
        headers.delete("content-length");
      } catch {
        // Keep a stale content-length rather than failing the request.
      }
    }
  }

  let response;
  try {
    response = new Response(body && body.byteLength > 0 ? body : null, { status, headers });
  } catch {
    response = new Response("Internal server error", {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  await storeInCache(ctx, { status, headers, body });
  // S09 §2: unauthorized client invalidation with SUCCEED_WITH_RESPONSE_HEADER.
  if (ctx?.cacheInvalidationUnauthorized === true) {
    try {
      response.headers.set("x-pods-cache-invalidation", "unauthorized");
    } catch {
      // Best-effort.
    }
  }
  return applyEdgeHeaders(ctx, withManagedCors(ctx, response));
}

/**
 * Stores a cacheable response (S09 §2, phase 19). No-op unless the
 * `cacheLookup` phase ran and missed. KV failures fail open.
 *
 * @param {object} ctx - Pipeline context.
 * @param {{ status: number, headers: Headers, body: Uint8Array|null }} result
 */
async function storeInCache(ctx, { status, headers, body }) {
  try {
    if (!ctx || ctx.cacheHit === true || !ctx.cacheKey || !ctx.cacheStageId) return;
    if (ctx.cacheInvalidationUnauthorized) return;
    if (ctx.isCanary && ctx.canaryNoCache) return;
    if (ctx.streaming === true) return;
    const bytes = body && body.byteLength > 0 ? body : new Uint8Array(0);
    if (!shouldStore({ status, headers, bodyLength: bytes.byteLength, streamed: false })) return;
    const kv = ctx?.ports?.kv ?? null;
    if (!kv || typeof kv.set !== "function") return;
    const stageCache = stageCacheOf(ctx);
    const budget = budgetForSize(stageCache.size);
    // F30: approximate LRU eviction instead of pure skip-on-exceed. When the
    // store would overflow, evict oldest-first victims from the recency
    // registry so it fits; only oversized items (or an unreadable registry
    // that still overflows) keep the skip behavior.
    try {
      const raw = await kv.get(bytesKvKey(ctx.cacheStageId));
      const current = raw === null || raw === undefined ? 0 : Number(raw);
      if (Number.isFinite(current) && current + bytes.byteLength > budget) {
        const registry = await loadLruRegistry(kv, ctx.cacheStageId);
        const { evicted, fits } = evictForStore(registry, { budget, neededBytes: bytes.byteLength });
        if (!fits) {
          ctx.cacheStoreSkipped = true;
          return;
        }
        let freed = 0;
        for (const keyHex of evicted) {
          try {
            await kv.del(entryKvKey(ctx.cacheStageId, keyHex));
          } catch {
            // Best-effort per key.
          }
          const victim = registry.find((entry) => entry.k === keyHex);
          if (victim) freed += victim.b;
        }
        // Drop victims from the recency registry so later evictions do not
        // re-evict them, and reconcile the byte counter.
        try {
          const remaining = registry.filter((entry) => !evicted.includes(entry.k));
          await saveLruRegistry(kv, ctx.cacheStageId, remaining).catch(() => null);
        } catch {
          // Registry pruning is best-effort.
        }
        try {
          if (freed > 0) {
            await kv.incrBy(bytesKvKey(ctx.cacheStageId), -freed).catch(() => null);
          }
        } catch {
          // Counter reconciliation is best-effort.
        }
      }
    } catch {
      // Budget check is best-effort; continue to store.
    }
    const encrypted = Boolean(ctx.cacheEncrypted ?? stageCache.encrypted ?? false);
    let payload;
    if (encrypted) {
      const key = await dekForStage(ctx, ctx.cacheStageId);
      payload = encryptBody(bytes, key);
    } else {
      payload = Buffer.from(bytes).toString("base64");
    }
    const storedHeaders = {};
    try {
      for (const [name, value] of headers.entries()) {
        if (name.toLowerCase() === "x-pods-cache") continue;
        storedHeaders[name] = value;
      }
    } catch {
      // Store without headers rather than failing.
    }
    const entry = JSON.stringify({
      status,
      headers: storedHeaders,
      body: payload,
      encrypted,
      storedAt: ctx?.ports?.clock?.now?.() ?? Date.now(),
    });
    const ttlMs = Math.max(0, Number(ctx.cacheTtlSec ?? 300)) * 1000;
    await kv.set(entryKvKey(ctx.cacheStageId, ctx.cacheKey), entry, ttlMs > 0 ? { ttlMs } : {});
    try {
      await kv.incrBy(bytesKvKey(ctx.cacheStageId), bytes.byteLength, { ttlMs: ttlMs > 0 ? ttlMs : undefined });
    } catch {
      // Byte accounting is best-effort.
    }
    // F30: record the store in the recency registry (newest wins, bounded).
    try {
      const now = ctx?.ports?.clock?.now?.() ?? Date.now();
      await noteCacheStore(kv, {
        stageId: ctx.cacheStageId,
        keyHex: ctx.cacheKey,
        bytes: bytes.byteLength,
        now,
        ttlMs: ttlMs > 0 ? ttlMs : undefined,
      });
    } catch {
      // Recency is best-effort; the cache works without it.
    }
  } catch {
    // Cache store never breaks responses.
  }
}

/**
 * Appends a value to `Vary` unless already present.
 *
 * @param {Headers} headers
 * @param {string} value
 */
function appendVary(headers, value) {
  const current = headers.get("vary");
  if (!current) {
    try {
      headers.set("vary", value);
    } catch {
      // Leave Vary unset when illegal.
    }
    return;
  }
  const parts = current.split(",").map((part) => part.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) {
    try {
      headers.set("vary", `${current}, ${value}`);
    } catch {
      // Keep the existing Vary rather than failing the request.
    }
  }
}
