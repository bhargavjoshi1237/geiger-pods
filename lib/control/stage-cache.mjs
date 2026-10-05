/**
 * Stage cache control-plane service (S09 §2).
 *
 * Stage settings: `cache_cluster_enabled`, `cache_cluster_size` (AWS sizes),
 * `method_settings` per-method overrides (resource path plus method, or a
 * wildcard entry). Flush: `DELETE …/stages/{name}/cache` (`pods.cache.flush`)
 * increments `cache:epoch:{stageId}` in KV (O(1) invalidation).
 *
 * @module lib/control/stage-cache
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi } from "./apis.mjs";
import { CACHE_SIZES_GB, MAX_TTL_S, epochKvKey } from "../gateway/core/release/cache.mjs";

const STRATEGIES = ["FAIL_WITH_403", "SUCCEED_WITH_RESPONSE_HEADER", "SUCCEED_WITHOUT_RESPONSE_HEADER"];

function toCacheView(stage) {
  return {
    enabled: Boolean(stage.cache_cluster_enabled ?? false),
    size: stage.cache_cluster_size ?? null,
    defaultTtl: Number(stage.cache_default_ttl ?? 300),
    encrypted: Boolean(stage.cache_data_encrypted ?? false),
    requireAuthorizationForCacheControl: (stage.require_authorization_for_cache_control ?? true) !== false,
    unauthorizedStrategy: String(stage.unauthorized_cache_control_header_strategy ?? "SUCCEED_WITH_RESPONSE_HEADER"),
    methodSettings: { ...(stage.method_settings ?? {}) },
  };
}

async function scopedStage(db, api, stageName) {
  const row = await db.getStageByName({ apiId: api.id, name: stageName });
  if (!row) throw new HttpError(404, "not_found", "Stage does not exist.");
  return row;
}

/**
 * Validates cache settings input.
 *
 * @param {unknown} input
 * @returns {object} Snake_case patch for `updateStage`.
 */
export function validateCacheSettings(input) {
  const value = input ?? {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.cache: expected an object");
  }
  const patch = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.cache.enabled: expected a boolean");
    }
    patch.cache_cluster_enabled = value.enabled;
  }
  if (value.size !== undefined) {
    if (value.size !== null && !CACHE_SIZES_GB.map(String).includes(String(value.size))) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.cache.size: must be one of ${CACHE_SIZES_GB.join(", ")}`);
    }
    patch.cache_cluster_size = value.size === null ? null : String(value.size);
  }
  if (value.defaultTtl !== undefined) {
    const ttl = Number(value.defaultTtl);
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL_S) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.cache.defaultTtl: must be an integer 0–${MAX_TTL_S}`);
    }
    patch.cache_default_ttl = ttl;
  }
  if (value.encrypted !== undefined) {
    if (typeof value.encrypted !== "boolean") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.cache.encrypted: expected a boolean");
    }
    patch.cache_data_encrypted = value.encrypted;
  }
  if (value.requireAuthorizationForCacheControl !== undefined) {
    if (typeof value.requireAuthorizationForCacheControl !== "boolean") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.cache.requireAuthorizationForCacheControl: expected a boolean");
    }
    patch.require_authorization_for_cache_control = value.requireAuthorizationForCacheControl;
  }
  if (value.unauthorizedStrategy !== undefined) {
    if (!STRATEGIES.includes(value.unauthorizedStrategy)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.cache.unauthorizedStrategy: must be one of ${STRATEGIES.join(", ")}`);
    }
    patch.unauthorized_cache_control_header_strategy = value.unauthorizedStrategy;
  }
  if (value.methodSettings !== undefined) {
    if (typeof value.methodSettings !== "object" || value.methodSettings === null || Array.isArray(value.methodSettings)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.cache.methodSettings: expected an object");
    }
    const clean = {};
    for (const [key, entry] of Object.entries(value.methodSettings)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new HttpError(422, "invalid_input", `Invalid request: $.cache.methodSettings["${key}"]: expected an object`);
      }
      const row = {};
      if (entry.cachingEnabled !== undefined) {
        if (typeof entry.cachingEnabled !== "boolean") {
          throw new HttpError(422, "invalid_input", `Invalid request: $.cache.methodSettings["${key}"].cachingEnabled: expected a boolean`);
        }
        row.cachingEnabled = entry.cachingEnabled;
      }
      if (entry.cacheTtlInSeconds !== undefined) {
        const ttl = Number(entry.cacheTtlInSeconds);
        if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL_S) {
          throw new HttpError(422, "invalid_input", `Invalid request: $.cache.methodSettings["${key}"].cacheTtlInSeconds: must be an integer 0–${MAX_TTL_S}`);
        }
        row.cacheTtlInSeconds = ttl;
      }
      if (entry.cacheDataEncrypted !== undefined) {
        if (typeof entry.cacheDataEncrypted !== "boolean") {
          throw new HttpError(422, "invalid_input", `Invalid request: $.cache.methodSettings["${key}"].cacheDataEncrypted: expected a boolean`);
        }
        row.cacheDataEncrypted = entry.cacheDataEncrypted;
      }
      if (entry.requireAuthorizationForCacheControl !== undefined) {
        if (typeof entry.requireAuthorizationForCacheControl !== "boolean") {
          throw new HttpError(422, "invalid_input", `Invalid request: $.cache.methodSettings["${key}"].requireAuthorizationForCacheControl: expected a boolean`);
        }
        row.requireAuthorizationForCacheControl = entry.requireAuthorizationForCacheControl;
      }
      if (entry.unauthorizedCacheControlHeaderStrategy !== undefined) {
        if (!STRATEGIES.includes(entry.unauthorizedCacheControlHeaderStrategy)) {
          throw new HttpError(422, "invalid_input", `Invalid request: $.cache.methodSettings["${key}"].unauthorizedCacheControlHeaderStrategy: must be one of ${STRATEGIES.join(", ")}`);
        }
        row.unauthorizedCacheControlHeaderStrategy = entry.unauthorizedCacheControlHeaderStrategy;
      }
      clean[key] = row;
    }
    patch.method_settings = clean;
  }
  return patch;
}

/** Get the cache config for a stage. */
export async function getStageCache(db, actor, { projectId, apiId, stageName }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Stage caching is only supported on REST APIs.");
  }
  const stage = await scopedStage(db, api, stageName);
  return toCacheView(stage);
}

/** Update the cache config for a stage (`pods.stage.write`). */
export async function putStageCache(db, actor, { projectId, apiId, stageName, input, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.stage.write", { projectId, apiId: api.id });
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Stage caching is only supported on REST APIs.");
  }
  const stage = await scopedStage(db, api, stageName);
  const patch = validateCacheSettings(input ?? {});
  if (patch.cache_cluster_enabled === true && !patch.cache_cluster_size && !stage.cache_cluster_size) {
    throw new HttpError(422, "invalid_input", "Enabling the cache requires a size (one of 0.5, 1.6, 6.1, 13.5, 28.4, 58.2, 118, 237).");
  }
  const before = toCacheView(stage);
  const next = await db.updateStage({ id: stage.id, patch: { ...patch, version: stage.version + 1 } });
  await audit(db, actor, {
    action: "stage.cache_update", resourceType: "stage", resourceId: stage.id,
    projectId, apiId: api.id, before, after: toCacheView(next), requestId,
  });
  return toCacheView(next);
}

/**
 * Flush the stage cache (`pods.cache.flush`): increments the epoch in KV so
 * old entries expire by TTL (O(1) invalidation).
 */
export async function flushStageCache(db, actor, { projectId, apiId, stageName, kv = null, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.cache.flush", { projectId, apiId: api.id });
  const stage = await scopedStage(db, api, stageName);
  // S09: epoch key matches the engine's stage id (`apiPublicId:stage`).
  const stageId = `${api.public_id ?? api.publicId ?? api.id}:${stage.name ?? stageName}`;
  let epoch = null;
  if (kv && typeof kv.incrBy === "function") {
    try {
      epoch = await kv.incrBy(epochKvKey(stageId), 1);
    } catch {
      epoch = null;
    }
  }
  await audit(db, actor, {
    action: "stage.cache_flush", resourceType: "stage", resourceId: stage.id,
    projectId, apiId: api.id, before: null, after: { epoch }, requestId,
  });
  return { flushed: true, epoch };
}
