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
  features: {},
};

const SETTINGS_SCHEMA = v.object({
  throttleRate: v.optional(v.int({ min: 1, max: 1000000 })),
  throttleBurst: v.optional(v.int({ min: 1, max: 1000000 })),
  throttleKvFailure: v.optional(v.enum(["open", "closed"])),
  logRetentionDays: v.optional(v.int({ min: 1, max: 3650 })),
  dataTraceRetentionDays: v.optional(v.int({ min: 1, max: 30 })),
  defaultRegion: v.optional(v.string({ min: 1, max: 64 })),
});

function toView(projectId, row, version) {
  return {
    projectId,
    throttleRate: row.throttle_rate,
    throttleBurst: row.throttle_burst,
    throttleKvFailure: row.throttle_kv_failure,
    logRetentionDays: row.log_retention_days,
    dataTraceRetentionDays: row.data_trace_retention_days,
    defaultRegion: row.default_region,
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
  const clean = validate(SETTINGS_SCHEMA, patch ?? {});
  let features;
  if (patch && Object.hasOwn(patch, "features")) {
    if (typeof patch.features !== "object" || patch.features === null || Array.isArray(patch.features)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.features: expected an object");
    }
    features = patch.features;
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
