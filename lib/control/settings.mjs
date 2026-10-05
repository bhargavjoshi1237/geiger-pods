// Project settings service (S02 §4, AWS "account settings" equivalent).
// Reads need pods.settings.view; writes need pods.settings.write, validate
// against a strict schema, use optimistic concurrency, and append audit rows.

import { v, validate } from "./validate.mjs";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";

export const DEFAULT_SETTINGS = {
  throttleRate: 10000,
  throttleBurst: 5000,
  throttleKvFailure: "open",
  logRetentionDays: 30,
  dataTraceRetentionDays: 3,
  defaultRegion: "auto",
  maxIntegrationTimeoutMs: 29000,
  features: {},
};

const SETTINGS_SCHEMA = v.object({
  throttleRate: v.optional(v.int({ min: 1, max: 1000000 })),
  throttleBurst: v.optional(v.int({ min: 1, max: 1000000 })),
  throttleKvFailure: v.optional(v.enum(["open", "closed"])),
  logRetentionDays: v.optional(v.int({ min: 1, max: 3650 })),
  dataTraceRetentionDays: v.optional(v.int({ min: 1, max: 30 })),
  defaultRegion: v.optional(v.string({ min: 1, max: 64 })),
  maxIntegrationTimeoutMs: v.optional(v.int({ min: 50, max: 300000 })),
});

// Engine feature flags writable through $.features (S02 §4, S06/S07/S08/S10).
// Unknown keys are 422 so misspelled flags cannot vanish silently.
const FEATURE_SPECS = {
  corsWildcardSubdomains: { kind: "boolean" },
  brotliCompression: { kind: "boolean" },
  rateLimitHeaders: { kind: "boolean" },
  quotaFailOpen: { kind: "boolean" },
  signedAnyRegion: { kind: "boolean" },
  sigv4a: { kind: "boolean" },
  echoTraceparent: { kind: "boolean" },
  cacheSharedAcrossPrincipals: { kind: "boolean" },
  trustedProxyHeader: { kind: "string", max: 256 },
  otlpEndpoint: { kind: "string", max: 2048 },
  streamBandwidthCapBytesPerSec: { kind: "int", min: 1, max: 104857600 },
  instanceCount: { kind: "int", min: 1, max: 1000 },
};

/** Validate $.features: known keys only, typed values. */
export function checkFeatures(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.features: expected an object");
  }
  const clean = {};
  for (const [key, entry] of Object.entries(value)) {
    const spec = FEATURE_SPECS[key];
    if (!spec) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.features.${key}: unknown feature flag`);
    }
    if (spec.kind === "boolean") {
      if (typeof entry !== "boolean") {
        throw new HttpError(422, "invalid_input", `Invalid request: $.features.${key}: expected a boolean`);
      }
      clean[key] = entry;
    } else if (spec.kind === "string") {
      if (typeof entry !== "string" || entry.length < 1 || entry.length > spec.max) {
        throw new HttpError(422, "invalid_input", `Invalid request: $.features.${key}: must be a string of 1-${spec.max} characters`);
      }
      clean[key] = entry;
    } else if (spec.kind === "int") {
      if (!Number.isInteger(entry) || entry < spec.min || entry > spec.max) {
        throw new HttpError(422, "invalid_input", `Invalid request: $.features.${key}: must be an integer ${spec.min}-${spec.max}`);
      }
      clean[key] = entry;
    }
  }
  return clean;
}

function toView(projectId, row, version) {
  return {
    projectId,
    throttleRate: row.throttle_rate,
    throttleBurst: row.throttle_burst,
    throttleKvFailure: row.throttle_kv_failure,
    logRetentionDays: row.log_retention_days,
    dataTraceRetentionDays: row.data_trace_retention_days,
    defaultRegion: row.default_region,
    maxIntegrationTimeoutMs: row.max_integration_timeout_ms ?? DEFAULT_SETTINGS.maxIntegrationTimeoutMs,
    features: row.features ?? {},
    version,
  };
}

/** Read settings; projects without a row see the defaults. */
export async function getSettings(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.settings.view", { projectId });
  const row = await db.getProjectSettings(projectId);
  if (!row) {
    return {
      projectId,
      ...DEFAULT_SETTINGS,
      features: { ...DEFAULT_SETTINGS.features },
      version: 0,
    };
  }
  return toView(projectId, row, row.version);
}

/** Patch settings. `expectedVersion` (from If-Match) guards lost updates. */
export async function updateSettings(db, actor, { projectId, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.settings.write", { projectId });
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new HttpError(422, "invalid_input", "Provide at least one settings field to update.");
  }
  const { features: rawFeatures, ...rest } = patch ?? {};
  const clean = validate(SETTINGS_SCHEMA, rest ?? {});
  let features;
  if (patch && Object.hasOwn(patch, "features")) {
    features = checkFeatures(rawFeatures);
  }
  const before = await db.getProjectSettings(projectId);
  const currentVersion = before?.version ?? 0;
  if (expectedVersion !== null && expectedVersion !== currentVersion) {
    throw new HttpError(409, "version_conflict", `Settings changed (expected version ${expectedVersion}, found ${currentVersion}).`);
  }
  const next = {
    project_id: projectId,
    throttle_rate: clean.throttleRate ?? before?.throttle_rate ?? DEFAULT_SETTINGS.throttleRate,
    throttle_burst: clean.throttleBurst ?? before?.throttle_burst ?? DEFAULT_SETTINGS.throttleBurst,
    throttle_kv_failure: clean.throttleKvFailure ?? before?.throttle_kv_failure ?? DEFAULT_SETTINGS.throttleKvFailure,
    log_retention_days: clean.logRetentionDays ?? before?.log_retention_days ?? DEFAULT_SETTINGS.logRetentionDays,
    data_trace_retention_days: clean.dataTraceRetentionDays ?? before?.data_trace_retention_days ?? DEFAULT_SETTINGS.dataTraceRetentionDays,
    default_region: clean.defaultRegion ?? before?.default_region ?? DEFAULT_SETTINGS.defaultRegion,
    max_integration_timeout_ms: clean.maxIntegrationTimeoutMs ?? before?.max_integration_timeout_ms ?? DEFAULT_SETTINGS.maxIntegrationTimeoutMs,
    features: features ?? before?.features ?? {},
    version: currentVersion + 1,
  };
  const saved = await db.upsertProjectSettings(next);
  await audit(db, actor, {
    action: "settings.update",
    resourceType: "project_settings",
    resourceId: projectId,
    projectId,
    before: before ? toView(projectId, before, before.version) : null,
    after: toView(projectId, saved, saved.version),
    requestId,
  });
  return toView(projectId, saved, saved.version);
}
