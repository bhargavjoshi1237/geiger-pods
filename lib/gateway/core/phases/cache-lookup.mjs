/**
 * `cacheLookup` phase (pipeline row 15).
 *
 * S09 implementation (replaces the S01 no-op stub, keeping the exported
 * `name` and `run(ctx)` contract).
 *
 * REST-only. When the stage cache is enabled and the method is cacheable:
 * - `Cache-Control: max-age=0` bypasses the lookup and refreshes the entry.
 *   When `requireAuthorizationForCacheControl` is true the caller must hold
 *   `execute-api:InvalidateCache` on the method ARN (S07 policy evaluator,
 *   SIGNED callers); otherwise the configured
 *   `unauthorizedCacheControlHeaderStrategy` applies.
 * - Hit → return the stored status/headers/body and skip the integration
 *   (`ctx.cacheOutcome = "hit"` → S10 `CacheHitCount`).
 * - Miss → `ctx.cacheOutcome = "miss"` and continue (`CacheMissCount`).
 *
 * KV failures fail open (no caching, no error). Test-invoke bypasses.
 *
 * @module lib/gateway/core/phases/cache-lookup
 */

import { GatewayError } from "../errors.mjs";
import { gatewayErrorResponse } from "../processing/runtime.mjs";
import {
  cacheKeyFor,
  decryptBody,
  dekForStage,
  entryKvKey,
  epochKvKey,
  methodCacheConfig,
  stageCacheOf,
} from "../release/cache.mjs";
import { buildMethodArn, evaluatePolicy } from "../auth/policy.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "cacheLookup";

/**
 * Finds the matched method + integration for this request.
 *
 * @param {object} ctx
 * @returns {{ method: object|null, integration: object|null, resourcePath: string, resourceId: string }}
 */
function targetFor(ctx) {
  const artifact = ctx?.artifact ?? {};
  const match = ctx?.match ?? null;
  if (!match?.methodId) return { method: null, integration: null, resourcePath: "", resourceId: "" };
  let method = null;
  let resourcePath = "";
  let resourceId = "";
  for (const resource of artifact.resources ?? []) {
    for (const [httpMethod, entry] of Object.entries(resource?.methods ?? {})) {
      if (String(entry?.id) === String(match.methodId)) {
        method = { ...entry, httpMethod };
        resourcePath = resource.path ?? "";
        resourceId = resource.id ?? "";
      }
    }
  }
  if (!method) {
    const flat = artifact.restMethods ?? [];
    const row = flat.find((entry) => String(entry?.id) === String(match.methodId));
    if (row) method = { id: row.id, httpMethod: row.httpMethod ?? ctx.request?.method ?? "GET" };
  }
  if (!method) return { method: null, integration: null, resourcePath: "", resourceId: "" };
  const integrationId = method.integrationId ?? method.integration_id ?? null;
  const integrations = artifact.integrations ?? {};
  const integration = integrationId ? (integrations[integrationId] ?? integrations[String(integrationId)] ?? null) : null;
  return { method, integration, resourcePath, resourceId };
}

/**
 * Whether the caller may invalidate the cache entry (S07 policy, SIGNED).
 *
 * @param {object} ctx
 * @param {{ method: string, resourcePath: string }} options
 * @returns {Promise<boolean>}
 */
export async function isAuthorizedForCacheInvalidation(ctx, { method, resourcePath } = {}) {
  // Explicit test hook / control-plane pre-authorization.
  if (ctx?.invalidateCacheAuthorized === true) return true;
  const accessKey = ctx?.context?.identity?.accessKey ?? ctx?.context?.identity?.caller ?? "";
  if (!accessKey) return false;
  try {
    const store = ctx?.ports?.signingPolicies ?? null;
    if (!store || typeof store.list !== "function") return false;
    const documents = (await store.list(accessKey)) ?? [];
    const artifact = ctx?.artifact ?? {};
    const resource = buildMethodArn({
      region: artifact.region ?? "auto",
      projectId: artifact.projectId ?? "",
      apiPublicId: artifact.apiPublicId ?? artifact.apiId ?? "",
      stage: artifact.stage ?? ctx?.stage ?? "",
      method,
      resourcePath,
    });
    for (const document of documents) {
      const verdict = evaluatePolicy({ document, action: "execute-api:InvalidateCache", resource });
      if (verdict.decision === "Deny") return false;
    }
    for (const document of documents) {
      const verdict = evaluatePolicy({ document, action: "execute-api:InvalidateCache", resource });
      if (verdict.decision === "Allow") return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Whether the request asks for client-driven invalidation.
 *
 * @param {Request} request
 * @returns {boolean}
 */
function wantsInvalidation(request) {
  let value = null;
  try {
    value = request.headers.get("cache-control");
  } catch {
    return false;
  }
  if (!value) return false;
  return String(value).split(",").some((part) => part.trim().toLowerCase() === "max-age=0");
}

/**
 * Runs the cache lookup.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<Response|undefined>}
 */
export async function run(ctx) {
  if (ctx?.testInvoke === true || ctx?.artifact?.testInvoke === true) return undefined;
  const artifact = ctx?.artifact ?? {};
  if ((artifact.protocol ?? "REST") !== "REST") return undefined;
  if (ctx?.isCanary && ctx?.canaryNoCache) return undefined;
  const stageCache = stageCacheOf(ctx);
  if (!stageCache.enabled) return undefined;
  const { method, integration, resourcePath, resourceId } = targetFor(ctx);
  if (!method) return undefined;
  const httpMethod = String(method.httpMethod ?? ctx.request?.method ?? "GET").toUpperCase();
  const config = methodCacheConfig(stageCache, { resourcePath, method: httpMethod });
  if (!config.cachingEnabled) return undefined;
  if (config.ttl <= 0) return undefined;
  // STREAM responses are never cached (compile also rejects the combo).
  const transferMode = String(integration?.responseTransferMode ?? integration?.response_transfer_mode ?? "BUFFERED").toUpperCase();
  if (transferMode === "STREAM") return undefined;

  const stageId = `${artifact.apiPublicId ?? artifact.apiId ?? ""}:${artifact.stage ?? ctx?.stage ?? ""}`;
  const kv = ctx?.ports?.kv ?? null;
  if (!kv || typeof kv.get !== "function") return undefined;
  let epoch = "0";
  try {
    epoch = (await kv.get(epochKvKey(stageId))) ?? "0";
  } catch {
    return undefined;
  }
  const keyHex = cacheKeyFor(ctx, {
    method: httpMethod,
    resourcePath,
    resourceId,
    integration: integration ?? {},
    stageId,
    epoch,
  });
  ctx.cacheKey = keyHex;
  ctx.cacheStageId = stageId;
  ctx.cacheTtlSec = config.ttl;
  ctx.cacheEncrypted = config.encrypted;

  if (wantsInvalidation(ctx.request)) {
    const authorized = config.requireAuth ? await isAuthorizedForCacheInvalidation(ctx, { method: httpMethod, resourcePath }) : true;
    if (!authorized) {
      const strategy = String(config.strategy ?? "SUCCEED_WITH_RESPONSE_HEADER");
      if (strategy === "FAIL_WITH_403") {
        throw new GatewayError("ACCESS_DENIED", "Forbidden");
      }
      if (strategy === "SUCCEED_WITH_RESPONSE_HEADER") {
        ctx.cacheInvalidationUnauthorized = true;
        return undefined;
      }
      ctx.cacheInvalidationUnauthorized = "silent";
      return undefined;
    }
    // Authorized: bypass lookup, refresh after the integration runs.
    ctx.cacheRefresh = true;
    ctx.cacheOutcome = "miss";
    if (ctx?.context) ctx.context.cacheHit = "";
    return undefined;
  }

  let raw = null;
  try {
    raw = await kv.get(entryKvKey(stageId, keyHex));
  } catch {
    return undefined;
  }
  if (!raw) {
    ctx.cacheOutcome = "miss";
    if (ctx?.context) ctx.context.cacheHit = "";
    return undefined;
  }
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    ctx.cacheOutcome = "miss";
    return undefined;
  }
  let body = null;
  try {
    if (entry.encrypted) {
      const key = await dekForStage(ctx, stageId);
      body = decryptBody(entry.body, key);
    } else {
      body = new Uint8Array(Buffer.from(String(entry.body ?? ""), "base64"));
    }
  } catch {
    ctx.cacheOutcome = "miss";
    return undefined;
  }
  ctx.cacheOutcome = "hit";
  ctx.cacheHit = true;
  if (ctx?.context) ctx.context.cacheHit = "true";
  const headers = new Headers(entry.headers ?? {});
  try {
    headers.set("x-pods-cache", "Hit");
  } catch {
    // Leave headers as stored.
  }
  if (ctx.cacheInvalidationUnauthorized === true) {
    try {
      headers.set("x-pods-cache-invalidation", "unauthorized");
    } catch {
      // Best-effort.
    }
  }
  const response = new Response(body && body.byteLength > 0 ? body : null, {
    status: entry.status ?? 200,
    headers,
  });
  return response;
}

/** Test hook: expose the invalidation check. */
export const __test = { wantsInvalidation, targetFor };
