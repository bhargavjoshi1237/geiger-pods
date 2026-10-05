/**
 * API-key engine helpers (S08 §2–§3).
 *
 * Pure ES module: no Next.js, Supabase or Node-only APIs except through the
 * injected ports (`kv`, `clock`) and `process.env` (pepper fallback). Key
 * values never leave this module except into `$context.identity.apiKey`
 * (redacted in logs unless the stage enables data trace, S10).
 *
 * Key rules (spec §1–§2):
 * - Generated values: 40 chars base62.
 * - Imported/custom values: 20–128 chars `[A-Za-z0-9_-]` (AWS minimum 20).
 * - Lookup key: HMAC-SHA256 hex with `PODS_KEY_PEPPER` (`value_hmac`).
 * - Display prefix: first 6 chars (`value_prefix`).
 *
 * Runtime lookup contract (spec §3): the host provides key records through
 * `ctx.usage` (a compiled snapshot for tests / the S05 runtime host) and/or
 * an async `ctx.usage.lookup(hmacHex)` read-through. Successful lookups are
 * cached in KV as `apikey:{hmac}` for 60 s and invalidated through the
 * pub/sub channel `pods:usage-changed`, so key and plan changes take effect
 * without a redeploy.
 *
 * S07 contract: with `apiKeySource: "AUTHORIZER"` the candidate value is
 * `ctx.authorizer.usageIdentifierKey` (set by the S07 custom authorizer;
 * also accepted at `ctx.context.authorizer.usageIdentifierKey`). When S07
 * is absent the field is simply undefined and the phase 403s, as specified.
 *
 * @module lib/gateway/core/usage/api-key
 */

import { createHmac } from "node:crypto";

/** Generated key length (40 chars base62). */
export const API_KEY_GENERATED_LENGTH = 40;

/** Imported/custom values: 20–128 chars `[A-Za-z0-9_-]` (AWS minimum 20). */
export const IMPORT_VALUE_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

/** KV lookup-cache entry TTL: 60 s (spec §3). */
export const APIKEY_CACHE_TTL_MS = 60_000;

/** Pub/sub channel for key/plan invalidation (spec §3). */
export const USAGE_CHANGED_CHANNEL = "pods:usage-changed";

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Returns cryptographically random base62 of `length` chars (rejection
 * sampled, no modulo bias — same approach as `lib/gateway/ids.mjs`).
 *
 * @param {number} [length=40]
 * @returns {string}
 */
export function generateApiKeyValue(length = API_KEY_GENERATED_LENGTH) {
  if (!Number.isInteger(length) || length <= 0) {
    throw new TypeError("generateApiKeyValue(length) requires a positive integer");
  }
  const limit = Math.floor(256 / BASE62.length) * BASE62.length;
  let out = "";
  while (out.length < length) {
    const bytes = new Uint8Array(length - out.length);
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += BASE62[byte % BASE62.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Validates an imported/custom key value. Returns the value unchanged.
 *
 * @param {unknown} value
 * @returns {string}
 * @throws {Error} When the value is outside 20–128 chars `[A-Za-z0-9_-]`.
 */
export function assertImportableValue(value) {
  if (typeof value !== "string" || !IMPORT_VALUE_PATTERN.test(value)) {
    throw new Error("API key values must be 20–128 characters of [A-Za-z0-9_-].");
  }
  return value;
}

/**
 * Display prefix for a key value (first 6 chars, `value_prefix`).
 *
 * @param {string} value
 * @returns {string}
 */
export function keyPrefix(value) {
  return String(value ?? "").slice(0, 6);
}

/**
 * HMAC-SHA256 hex of a key value with the pepper (`value_hmac` lookup key).
 *
 * @param {string} value - Raw key value.
 * @param {string} pepper - `PODS_KEY_PEPPER`.
 * @returns {string} Lowercase hex digest.
 * @throws {Error} When the pepper is missing (fail closed, never fall back
 *   to an unkeyed hash — that would make lookups predictable).
 */
export function hmacForValue(value, pepper) {
  if (typeof pepper !== "string" || pepper.length === 0) {
    throw new Error("PODS_KEY_PEPPER is not configured.");
  }
  return createHmac("sha256", pepper).update(String(value), "utf8").digest("hex");
}

/**
 * Resolves the HMAC pepper: explicit `ctx.usage.pepper`, then
 * `ctx.ports.keyPepper` (tests), then `PODS_KEY_PEPPER` from env.
 *
 * @param {object} ctx - Pipeline context.
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {string}
 */
export function pepperFrom(ctx, env = process.env) {
  return ctx?.usage?.pepper ?? ctx?.ports?.keyPepper ?? env?.PODS_KEY_PEPPER ?? "";
}

/**
 * KV cache key for a key record.
 *
 * @param {string} hmacHex
 * @returns {string}
 */
export function apiKeyCacheKey(hmacHex) {
  return `apikey:${hmacHex}`;
}

/**
 * Extracts the candidate key value from its source.
 * `HEADER` reads `x-api-key`; `AUTHORIZER` uses the custom authorizer's
 * `usageIdentifierKey` (S07 contract, read defensively so the phase works
 * when S07 is absent).
 *
 * @param {object} ctx - Pipeline context (`request`, `artifact`, `authorizer`, `context`).
 * @returns {string|null} The candidate value, or null when missing.
 */
export function extractCandidateKey(ctx) {
  const artifact = ctx?.artifact ?? {};
  const source = artifact?.settings?.apiKeySource ?? artifact?.apiKeySource ?? "HEADER";
  if (source === "AUTHORIZER") {
    const candidate = ctx?.authorizer?.usageIdentifierKey
      ?? ctx?.context?.authorizer?.usageIdentifierKey;
    return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
  }
  const header = ctx?.request?.headers?.get?.("x-api-key");
  return typeof header === "string" && header.length > 0 ? header : null;
}

/**
 * Reports whether the matched method/route requires an API key.
 * An explicit boolean `ctx.apiKeyRequired` (set by the host, e.g. S12 for
 * WebSocket `$connect`) wins; otherwise REST methods and HTTP routes are
 * read from the artifact. HTTP APIs never require keys (capability
 * `usage.apiKeys` is REST + WebSocket only).
 *
 * @param {object} ctx - Pipeline context (`artifact`, `match`, `apiKeyRequired`).
 * @returns {boolean}
 */
export function apiKeyRequiredFor(ctx) {
  if (typeof ctx?.apiKeyRequired === "boolean") return ctx.apiKeyRequired;
  const artifact = ctx?.artifact ?? {};
  const protocol = artifact.protocol ?? "REST";
  const match = ctx?.match ?? null;
  if (!match) return false;
  if (protocol === "HTTP") {
    const routes = artifact.httpRoutes
      ?? (artifact.routes ?? []).map((route) => ({
        id: route.id,
        routeKey: route.routeKey ?? route.route_key,
        apiKeyRequired: route.apiKeyRequired ?? route.api_key_required ?? false,
      }));
    const found = routes.find((route) => route.id === match.routeId);
    return Boolean(found?.apiKeyRequired);
  }
  if (protocol === "REST") {
    for (const resource of artifact.resources ?? []) {
      for (const [httpMethod, method] of Object.entries(resource.methods ?? {})) {
        if (method?.id === match.methodId
          || (resource.id === match.resourceId && httpMethod === match.httpMethod)) {
          return Boolean(method?.apiKeyRequired);
        }
      }
    }
    for (const method of artifact.restMethods ?? []) {
      if (method?.id === match.methodId) return Boolean(method?.apiKeyRequired);
    }
  }
  return false;
}

/**
 * Finds the plan (from the key record) covering `{apiId, stage}`.
 *
 * @param {{ plans?: Array<{ planId: string, apiId: string, stage: string }> }|null} record
 * @param {string} apiId
 * @param {string} stage
 * @returns {{ planId: string, apiId: string, stage: string }|null}
 */
export function findCoveringPlan(record, apiId, stage) {
  for (const plan of record?.plans ?? []) {
    if (String(plan?.apiId) === String(apiId) && String(plan?.stage) === String(stage)) {
      return plan;
    }
  }
  return null;
}

function asRecord(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.keyId !== "string") return null;
  if (!Array.isArray(value.plans)) return null;
  return value;
}

function snapshotRecord(ctx, hmacHex) {
  const keys = ctx?.usage?.keys;
  if (!keys) return null;
  if (typeof keys.get === "function") {
    const found = keys.get(hmacHex);
    return asRecord(found);
  }
  if (typeof keys === "object") {
    const found = Object.hasOwn(keys, hmacHex) ? keys[hmacHex] : null;
    return asRecord(found);
  }
  return null;
}

/**
 * Looks up a key record by HMAC: KV cache first, then the `ctx.usage.keys`
 * snapshot or `ctx.usage.lookup(hmacHex)` read-through (populating the
 * cache for 60 s). Returns null when unknown.
 *
 * @param {object} ctx - Pipeline context (`ports.kv`, `usage`).
 * @param {string} hmacHex
 * @returns {Promise<object|null>}
 */
export async function lookupKeyRecord(ctx, hmacHex) {
  const kv = ctx?.ports?.kv;
  const cacheKey = apiKeyCacheKey(hmacHex);
  if (kv && typeof kv.get === "function") {
    try {
      const cached = await kv.get(cacheKey);
      if (cached !== null && cached !== undefined) {
        try {
          const record = asRecord(JSON.parse(String(cached)));
          if (record) return record;
        } catch {
          // Corrupt entry: fall through to the snapshot/read-through.
        }
      }
    } catch {
      // KV failure on the key path fails closed below only when the
      // snapshot also misses; a throwing cache never masks a known key.
    }
  }
  let record = snapshotRecord(ctx, hmacHex);
  if (!record && typeof ctx?.usage?.lookup === "function") {
    try {
      record = asRecord(await ctx.usage.lookup(hmacHex));
    } catch {
      record = null;
    }
  }
  if (record && kv && typeof kv.set === "function") {
    try {
      await kv.set(cacheKey, JSON.stringify(record), { ttlMs: APIKEY_CACHE_TTL_MS });
    } catch {
      // Cache population is best-effort.
    }
  }
  return record;
}

/**
 * Subscribes `kv` to `pods:usage-changed` invalidations. Messages are
 * `{hmac}` (delete one entry) or `{all:true}` / key mutations without an
 * hmac (host-level flush via `onInvalidate`). Returns the unsubscribe
 * function (no-op when the store has no pub/sub).
 *
 * @param {object} kv - `KvStore` port.
 * @param {{ onInvalidate?: (message: object) => void }} [options={}]
 * @returns {() => void}
 */
export function attachUsageInvalidation(kv, options = {}) {
  if (!kv || typeof kv.subscribe !== "function") return () => {};
  const handler = (message) => {
    let event = null;
    try {
      event = JSON.parse(String(message));
    } catch {
      return;
    }
    try {
      if (event && typeof event.hmac === "string" && event.hmac.length > 0) {
        kv.del?.(apiKeyCacheKey(event.hmac))?.catch?.(() => {});
      } else if (typeof options.onInvalidate === "function") {
        options.onInvalidate(event ?? {});
      }
    } catch {
      // Invalidation is best-effort; the 60 s TTL still bounds staleness.
    }
  };
  try {
    const maybe = kv.subscribe(USAGE_CHANGED_CHANNEL, handler);
    if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
  } catch {
    return () => {};
  }
  return () => {
    try {
      const out = kv.unsubscribe?.(USAGE_CHANGED_CHANNEL, handler);
      if (out && typeof out.catch === "function") out.catch(() => {});
    } catch {
      // Ignore.
    }
  };
}
