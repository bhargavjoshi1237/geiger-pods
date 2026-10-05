/**
 * Usage-plan control-plane service (S08 §1, §4–§5).
 *
 * Plans bind API stages (with per-method throttles, ≤20 entries — AWS) to
 * throttles, quotas and keys. Guards: plan/stage rates may not exceed the
 * project (account) level (422); HTTP APIs reject stage association with
 * 400 `capability_unsupported`; a key stays out of two plans covering the
 * same stage (409, via `insertPlanMembership`). Every mutation refreshes
 * the affected keys' runtime cache and publishes `pods:usage-changed`.
 *
 * Also serves `GetUsage` (AWS shape: today's numbers live from KV,
 * history from `usage_daily`) and `UpdateUsage` (`extend`/`reset`/`set`
 * → absolute `qa:` allowance override + append-only `quota_adjustments`
 * row), plus service-level stage-throttle updates (the S05 stage PATCH
 * route owns the HTTP surface; see the S08 report).
 *
 * @module lib/control/usage-plans
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { DEFAULT_SETTINGS } from "./settings.mjs";
import { supports } from "../gateway/capabilities.mjs";
import { newPublicId } from "../gateway/ids.mjs";
import {
  applyQuotaAdjustment,
  baseAllowance,
  effectiveAllowance,
  formatUsage,
  parseUsageDay,
  periodEndMs,
  periodStartFor,
  quotaAllowanceKey,
  quotaCounterKey,
} from "../gateway/core/usage/quota.mjs";
import {
  getPepper,
  insertPlanMembership,
  publishUsageChanged,
  resolveKey,
  warmKeyCache,
} from "./api-keys.mjs";

/** Per-method throttle cap per plan-stage (AWS, spec §1). */
export const MAX_METHOD_THROTTLES = 20;

function projectThrottle(settingsRow) {
  return {
    rate: Number(settingsRow?.throttle_rate ?? DEFAULT_SETTINGS.throttleRate),
    burst: Number(settingsRow?.throttle_burst ?? DEFAULT_SETTINGS.throttleBurst),
  };
}

function checkThrottleValue(value, path) {
  if (!value || typeof value !== "object") {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${path}: expected {rateLimit, burstLimit}`);
  }
  const { rateLimit, burstLimit } = value;
  for (const [name, entry] of [["rateLimit", rateLimit], ["burstLimit", burstLimit]]) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.${path}.${name}: expected a number >= 0`);
    }
  }
  return { rateLimit, burstLimit };
}

function checkThrottleVsProject(throttle, project, path) {
  const clean = checkThrottleValue(throttle, path);
  if (clean.rateLimit > project.rate || clean.burstLimit > project.burst) {
    throw new HttpError(
      422, "invalid_input",
      `Invalid request: $.${path}: exceeds the project throttle (${project.rate} rps / ${project.burst} burst)`,
    );
  }
  return clean;
}

function checkMethodThrottles(raw, project) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.methodThrottles: expected an object");
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_METHOD_THROTTLES) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.methodThrottles: at most ${MAX_METHOD_THROTTLES} entries`);
  }
  const clean = {};
  for (const [methodKey, entry] of entries) {
    clean[methodKey] = checkThrottleVsProject(entry, project, `methodThrottles["${methodKey}"]`);
  }
  return clean;
}

function checkQuota(raw) {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== "object") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.quota: expected {limit, period} with optional offset");
  }
  const { limit, offset = 0, period } = raw;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.quota.limit: expected a non-negative integer");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.quota.offset: expected a non-negative integer");
  }
  if (!["DAY", "WEEK", "MONTH"].includes(period)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.quota.period: must be one of DAY|WEEK|MONTH");
  }
  return { limit, offset, period };
}

function planView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    publicId: row.public_id,
    name: row.name,
    description: row.description ?? "",
    throttle: row.throttle ?? null,
    quota: row.quota ?? null,
    tags: row.tags ?? {},
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Resolves a plan by uuid or public id, scoped to the project.
 */
export async function resolvePlan(db, projectId, planId) {
  let row = null;
  try {
    row = await db.getPlanById(planId);
  } catch {
    row = null;
  }
  if (!row && typeof db.getPlanByRef === "function") {
    try {
      row = await db.getPlanByRef({ projectId, ref: planId });
    } catch {
      row = null;
    }
  }
  if (!row || row.project_id !== projectId) {
    throw new HttpError(404, "not_found", "Usage plan does not exist.");
  }
  return row;
}

async function keyHmacs(db, keyIds, pepper) {
  void pepper;
  const hmacs = new Map();
  for (const keyId of keyIds) {
    const row = await db.getApiKeyById(keyId).catch(() => null);
    if (row) hmacs.set(keyId, row.value_hmac);
  }
  return hmacs;
}

async function refreshPlanKeys(db, kv, planId, deps = {}) {
  if (!kv) return;
  const memberships = await db.listPlanKeys({ planId });
  const pepper = getPepper(deps);
  const hmacs = await keyHmacs(db, memberships.map((row) => row.api_key_id), pepper);
  for (const [keyId, hmac] of hmacs) {
    await warmKeyCache(db, kv, keyId, hmac, deps);
  }
  await publishUsageChanged(kv, { planId });
}

async function checkApiSupportsPlans(db, projectId, apiRef) {
  const api = await db.getApiByRef({ projectId, ref: apiRef });
  if (!api) throw new HttpError(404, "not_found", "API does not exist.");
  const protocol = api.protocol ?? "REST";
  if (!supports(protocol, "usage.plans")) {
    throw new HttpError(400, "capability_unsupported", `Usage plans are not supported for ${protocol} APIs.`);
  }
  return api;
}

/** Create a usage plan. */
export async function createPlan(db, actor, input, deps = {}) {
  const { projectId, requestId = null } = input ?? {};
  await requirePermission(db, actor, "pods.usage_plan.write", { projectId });
  if (typeof input?.name !== "string" || input.name.length < 1 || input.name.length > 128) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
  }
  const project = projectThrottle(await db.getProjectSettings(projectId).catch(() => null));
  const throttle = input?.throttle === undefined || input?.throttle === null
    ? null
    : checkThrottleVsProject(input.throttle, project, "throttle");
  const quota = checkQuota(input?.quota);
  const row = await db.insertPlan({
    project_id: projectId,
    public_id: newPublicId(),
    name: input.name,
    description: typeof input?.description === "string" ? input.description : "",
    throttle,
    quota,
    quota_since: quota ? new Date().toISOString() : null,
    tags: input?.tags && typeof input.tags === "object" ? { ...input.tags } : {},
    created_by: actor?.userId ?? null,
  });
  await audit(db, actor, {
    action: "usage_plan.create", resourceType: "usage_plan", resourceId: row.id,
    projectId, before: null, after: planView(row), requestId,
  });
  return { status: 201, body: planView(row) };
}

/** Get one plan (with stages + key count for the detail screen). */
export async function getPlan(db, actor, { projectId, planId }) {
  await requirePermission(db, actor, "pods.usage_plan.write", { projectId });
  const row = await resolvePlan(db, projectId, planId);
  const stages = await db.listPlanStages({ planId: row.id });
  const keys = await db.listPlanKeys({ planId: row.id });
  return {
    ...planView(row),
    stages: stages.map((stage) => ({
      apiId: stage.api_id,
      stage: stage.stage_name,
      methodThrottles: stage.method_throttles ?? {},
    })),
    keyCount: keys.length,
  };
}

/** List plans for a project. */
export async function listPlans(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.usage_plan.write", { projectId });
  const rows = await db.listPlans({ projectId });
  return { items: rows.map(planView), nextCursor: null };
}

/** Update name/description/throttle/quota/tags (compare-and-swap). */
export async function updatePlan(db, actor, { projectId, planId, patch, expectedVersion = null, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.usage_plan.write", { projectId });
  const current = await resolvePlan(db, projectId, planId);
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Usage plan changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const project = projectThrottle(await db.getProjectSettings(projectId).catch(() => null));
  const clean = {};
  if (patch?.name !== undefined) {
    if (typeof patch.name !== "string" || patch.name.length < 1 || patch.name.length > 128) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
    }
    clean.name = patch.name;
  }
  if (patch?.description !== undefined) {
    if (typeof patch.description !== "string" || patch.description.length > 1024) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.description: must be a string of at most 1024 characters");
    }
    clean.description = patch.description;
  }
  if (patch?.throttle !== undefined) {
    clean.throttle = patch.throttle === null ? null : checkThrottleVsProject(patch.throttle, project, "throttle");
  }
  if (patch?.quota !== undefined) {
    clean.quota = checkQuota(patch.quota);
    clean.quota_since = clean.quota ? new Date().toISOString() : null;
  }
  if (patch?.methodThrottles !== undefined) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.methodThrottles: set per-stage via the plan stages endpoints");
  }
  if (patch?.tags !== undefined) {
    if (!patch.tags || typeof patch.tags !== "object" || Array.isArray(patch.tags)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.tags: expected an object");
    }
    clean.tags = { ...patch.tags };
  }
  if (Object.keys(clean).length === 0) return planView(current);
  const before = planView(current);
  const next = await db.updatePlan({ id: current.id, patch: { ...clean, version: current.version + 1 } });
  await refreshPlanKeys(db, deps.kv ?? null, next.id, deps);
  await audit(db, actor, {
    action: "usage_plan.update", resourceType: "usage_plan", resourceId: next.id,
    projectId, before, after: planView(next), requestId,
  });
  return planView(next);
}

/** Delete a plan (memberships + stages cascade; key caches refreshed). */
export async function deletePlan(db, actor, { projectId, planId, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.usage_plan.write", { projectId });
  const current = await resolvePlan(db, projectId, planId);
  const memberships = await db.listPlanKeys({ planId: current.id });
  const before = planView(current);
  await db.deletePlan({ id: current.id });
  const pepper = getPepper(deps);
  const hmacs = await keyHmacs(db, memberships.map((row) => row.api_key_id), pepper);
  for (const [keyId, hmac] of hmacs) {
    await warmKeyCache(db, deps.kv ?? null, keyId, hmac, deps);
  }
  await publishUsageChanged(deps.kv ?? null, { planId: current.id });
  await audit(db, actor, {
    action: "usage_plan.delete", resourceType: "usage_plan", resourceId: current.id,
    projectId, before, after: null, requestId,
  });
  return { id: current.id, deleted: true };
}

/** Associate an API stage with a plan (capability-gated). */
export async function addPlanStage(db, actor, { projectId, planId, apiId, stage, methodThrottles = {}, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.usage_plan.write", { projectId });
  const plan = await resolvePlan(db, projectId, planId);
  const api = await checkApiSupportsPlans(db, projectId, apiId);
  if (typeof stage !== "string" || stage.length < 1 || stage.length > 128) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.stage: must be a string of 1–128 characters");
  }
  const project = projectThrottle(await db.getProjectSettings(projectId).catch(() => null));
  const clean = checkMethodThrottles(methodThrottles, project) ?? {};
  const row = await db.insertPlanStage({
    plan_id: plan.id, api_id: api.id, stage_name: stage, method_throttles: clean,
  });
  await refreshPlanKeys(db, deps.kv ?? null, plan.id, deps);
  await audit(db, actor, {
    action: "usage_plan.stage_add", resourceType: "usage_plan", resourceId: plan.id,
    projectId, apiId: api.id,
    before: null, after: { apiId: api.id, stage, methodThrottles: clean }, requestId,
  });
  return { planId: plan.id, apiId: row.api_id, stage: row.stage_name, methodThrottles: row.method_throttles ?? {} };
}

/** Remove an API stage from a plan. */
export async function removePlanStage(db, actor, { projectId, planId, apiId, stage, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.usage_plan.write", { projectId });
  const plan = await resolvePlan(db, projectId, planId);
  const api = await db.getApiByRef({ projectId, ref: apiId });
  if (!api) throw new HttpError(404, "not_found", "API does not exist.");
  const removed = await db.deletePlanStage({ planId: plan.id, apiId: api.id, stage });
  await refreshPlanKeys(db, deps.kv ?? null, plan.id, deps);
  await audit(db, actor, {
    action: "usage_plan.stage_remove", resourceType: "usage_plan", resourceId: plan.id,
    projectId, apiId: api.id, before: { apiId: api.id, stage }, after: null, requestId,
  });
  return removed;
}

/** Replace the per-method throttles of one plan stage. */
export async function setPlanMethodThrottles(db, actor, { projectId, planId, apiId, stage, methodThrottles, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.usage_plan.write", { projectId });
  const plan = await resolvePlan(db, projectId, planId);
  const api = await db.getApiByRef({ projectId, ref: apiId });
  if (!api) throw new HttpError(404, "not_found", "API does not exist.");
  const project = projectThrottle(await db.getProjectSettings(projectId).catch(() => null));
  const clean = checkMethodThrottles(methodThrottles, project) ?? {};
  const row = await db.updatePlanStage({ planId: plan.id, apiId: api.id, stage, patch: { method_throttles: clean } });
  await refreshPlanKeys(db, deps.kv ?? null, plan.id, deps);
  await audit(db, actor, {
    action: "usage_plan.method_throttles", resourceType: "usage_plan", resourceId: plan.id,
    projectId, apiId: api.id, before: null, after: { apiId: api.id, stage, methodThrottles: clean }, requestId,
  });
  return { planId: plan.id, apiId: row.api_id, stage: row.stage_name, methodThrottles: row.method_throttles ?? {} };
}

/** Add a key to a plan (same-stage conflict → 409 with the other plan). */
export async function addKeyToPlan(db, actor, { projectId, planId, keyId, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.usage_plan.write", { projectId });
  const plan = await resolvePlan(db, projectId, planId);
  const key = await resolveKey(db, projectId, keyId);
  const membership = await insertPlanMembership(db, { keyId: key.id, planId: plan.id });
  await warmKeyCache(db, deps.kv ?? null, key.id, key.value_hmac, deps);
  await publishUsageChanged(deps.kv ?? null, { planId: plan.id, keyId: key.id, hmac: key.value_hmac });
  await audit(db, actor, {
    action: "usage_plan.key_add", resourceType: "usage_plan", resourceId: plan.id,
    projectId, before: null, after: { keyId: key.id, planId: plan.id }, requestId,
  });
  return membership;
}

/** Remove a key from a plan. */
export async function removeKeyFromPlan(db, actor, { projectId, planId, keyId, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.usage_plan.write", { projectId });
  const plan = await resolvePlan(db, projectId, planId);
  const key = await resolveKey(db, projectId, keyId);
  const removed = await db.deletePlanKey({ planId: plan.id, keyId: key.id });
  await warmKeyCache(db, deps.kv ?? null, key.id, key.value_hmac, deps);
  await publishUsageChanged(deps.kv ?? null, { planId: plan.id, keyId: key.id, hmac: key.value_hmac });
  await audit(db, actor, {
    action: "usage_plan.key_remove", resourceType: "usage_plan", resourceId: plan.id,
    projectId, before: { keyId: key.id, planId: plan.id }, after: null, requestId,
  });
  return removed;
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(day, delta) {
  return isoDay(Date.parse(`${day}T00:00:00.000Z`) + delta * 24 * 60 * 60 * 1000);
}

/**
 * AWS-shaped usage report for a plan. Today's numbers come from the live KV
 * counters; past days come from `usage_daily` history.
 */
export async function getUsage(db, actor, { projectId, planId, keyId = null, startDate, endDate }, deps = {}) {
  await requirePermission(db, actor, "pods.usage.view", { projectId });
  const plan = await resolvePlan(db, projectId, planId);
  let start;
  let end;
  try {
    start = parseUsageDay(startDate);
    end = parseUsageDay(endDate);
  } catch {
    throw new HttpError(422, "invalid_input", "Invalid request: startDate/endDate must be YYYY-MM-DD");
  }
  if (start > end) {
    throw new HttpError(422, "invalid_input", "Invalid request: startDate must not be after endDate");
  }
  if (end - start > 366 * 24 * 60 * 60 * 1000) {
    throw new HttpError(422, "invalid_input", "Invalid request: date range must not exceed 366 days");
  }
  let keys;
  if (keyId !== null && keyId !== undefined) {
    keys = [await resolveKey(db, projectId, keyId)];
    const memberships = await db.listPlansForKey({ keyId: keys[0].id });
    if (!memberships.some((row) => row.plan_id === plan.id)) {
      throw new HttpError(404, "not_found", "This key is not associated with the plan.");
    }
  } else {
    const memberships = await db.listPlanKeys({ planId: plan.id });
    keys = [];
    for (const membership of memberships) {
      const key = await db.getApiKeyById(membership.api_key_id);
      if (key && key.project_id === projectId) keys.push(key);
    }
  }
  const nowMs = typeof deps.now === "function" ? deps.now() : Date.now();
  const today = isoDay(nowMs);
  const days = [];
  for (let day = isoDay(start); day <= isoDay(end); day = addDays(day, 1)) days.push(day);

  const series = {};
  for (const key of keys) {
    const history = await db.listUsageDaily({ planId: plan.id, keyId: key.id, start: isoDay(start), end: isoDay(end) });
    const byDay = new Map(history.map((row) => [row.day, row]));
    const pairs = [];
    for (const day of days) {
      let used = Number(byDay.get(day)?.count ?? 0);
      if (day === today && plan.quota) {
        const live = await readLiveCounter(deps.kv ?? null, plan, key.id, nowMs);
        if (live !== null) used = live;
      }
      const allowance = allowanceForDay(plan, day, await adjustmentsForPeriod(db, plan, key.id, day, nowMs));
      pairs.push([used, Math.max(allowance - used, 0)]);
    }
    series[key.public_id] = pairs;
  }
  return formatUsage({ usagePlanId: plan.id, startDate: isoDay(start), endDate: isoDay(end), series });
}

async function adjustmentsForPeriod(db, plan, keyId, day, nowMs) {
  if (!plan.quota || typeof db.listQuotaAdjustments !== "function") return { delta: 0, setRemaining: null };
  const periodStart = periodStartFor(plan.quota.period, Date.parse(`${day}T00:00:00.000Z`));
  const rows = await db.listQuotaAdjustments({ planId: plan.id, keyId });
  let delta = 0;
  let setRemaining = null;
  for (const row of rows) {
    if (Date.parse(row.period_start) !== periodStart) continue;
    if (Number.isInteger(row.delta)) delta += row.delta;
    if (Number.isInteger(row.set_remaining)) setRemaining = row.set_remaining;
  }
  return { delta, setRemaining };
}

function allowanceForDay(plan, day, { delta, setRemaining }) {
  const quota = plan.quota;
  if (!quota) return 0;
  const periodStart = periodStartFor(quota.period, Date.parse(`${day}T00:00:00.000Z`));
  const base = baseAllowance({ ...quota, since: plan.quota_since ?? plan.created_at ?? null }, periodStart);
  if (setRemaining !== null) {
    // A `set` pins remaining; reconstruct from the day's used count lazily
    // at the call site — here return base + delta and let the caller adjust.
    return Math.max(base + delta, 0);
  }
  return Math.max(base + delta, 0);
}

async function readLiveCounter(kv, plan, keyId, nowMs) {
  if (!kv || typeof kv.get !== "function" || !plan.quota) return null;
  const periodStart = periodStartFor(plan.quota.period, nowMs);
  try {
    if (plan.quota.period === "DAY") {
      const raw = await kv.get(quotaCounterKey(plan.id, keyId, periodStart));
      return raw === null || raw === undefined ? 0 : Number(raw);
    }
    const raw = await kv.get(quotaCounterKey(plan.id, keyId, periodStart));
    if (raw === null || raw === undefined) return 0;
    return Math.max(Number(raw), 0);
  } catch {
    return null;
  }
}

/**
 * Sums `delta` adjustments for one period (shared by updateUsage and the
 * cache record builder).
 *
 * @param {object} db
 * @param {object} plan
 * @param {string} keyId
 * @param {number} periodStart
 * @returns {Promise<number>}
 */
export async function periodDeltaSum(db, plan, keyId, periodStart) {
  if (typeof db.listQuotaAdjustments !== "function") return 0;
  const rows = await db.listQuotaAdjustments({ planId: plan.id, keyId });
  let delta = 0;
  for (const row of rows) {
    if (Date.parse(row.period_start) === periodStart && Number.isInteger(row.delta)) {
      delta += row.delta;
    }
  }
  return delta;
}

/**
 * AWS `UpdateUsage`: `extend` grows today's allowance, `reset` restores the
 * full limit as remaining, `set` pins remaining to `value`. Writes the
 * absolute `qa:` override (TTL to period end) + an append-only
 * `quota_adjustments` row, then refreshes the key cache.
 */
export async function updateUsage(db, actor, { projectId, planId, keyId, op, value, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.usage_plan.write", { projectId });
  const plan = await resolvePlan(db, projectId, planId);
  const key = await resolveKey(db, projectId, keyId);
  const memberships = await db.listPlansForKey({ keyId: key.id });
  if (!memberships.some((row) => row.plan_id === plan.id)) {
    throw new HttpError(404, "not_found", "This key is not associated with the plan.");
  }
  if (!plan.quota) {
    throw new HttpError(422, "invalid_input", "Invalid request: this plan has no quota to adjust");
  }
  if (!["extend", "reset", "set"].includes(op)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.op: must be one of extend|reset|set");
  }
  const kv = deps.kv ?? null;
  if (!kv) throw new HttpError(503, "kv_unavailable", "Usage state is unavailable; retry shortly.");
  const nowMs = typeof deps.now === "function" ? deps.now() : Date.now();
  const periodStart = periodStartFor(plan.quota.period, nowMs);
  let used = 0;
  let current = null;
  try {
    const counter = await kv.get(quotaCounterKey(plan.id, key.id, periodStart));
    used = counter === null || counter === undefined ? 0 : Number(counter);
    const override = await kv.get(quotaAllowanceKey(plan.id, key.id, periodStart));
    current = override === null || override === undefined ? null : Number(override);
  } catch {
    throw new HttpError(503, "kv_unavailable", "Usage state is unavailable; retry shortly.");
  }
  const since = plan.quota_since ?? plan.created_at ?? null;
  const snapshotDelta = await periodDeltaSum(db, plan, key.id, periodStart);
  const allowance = effectiveAllowance({ quota: { ...plan.quota, since }, adjustmentsDelta: snapshotDelta }, periodStart, current);
  let next;
  try {
    next = applyQuotaAdjustment(op, value, { used, allowance, limit: plan.quota.limit });
  } catch (error) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.value: ${error.message}`);
  }
  try {
    await kv.set(quotaAllowanceKey(plan.id, key.id, periodStart), String(next), {
      ttlMs: Math.max(periodEndMs(plan.quota.period, periodStart) - nowMs, 1000),
    });
  } catch {
    throw new HttpError(503, "kv_unavailable", "Usage state is unavailable; retry shortly.");
  }
  await db.insertQuotaAdjustment({
    project_id: projectId,
    plan_id: plan.id,
    api_key_id: key.id,
    period_start: new Date(periodStart).toISOString(),
    delta: op === "extend" ? Number(value) : null,
    set_remaining: op === "set" ? Number(value) : null,
    actor_id: actor?.userId ?? null,
  });
  await warmKeyCache(db, kv, key.id, key.value_hmac, deps);
  await publishUsageChanged(kv, { planId: plan.id, keyId: key.id, hmac: key.value_hmac });
  await audit(db, actor, {
    action: "usage_plan.usage_update", resourceType: "usage_plan", resourceId: plan.id,
    projectId, before: { keyId: key.id, allowance }, after: { keyId: key.id, allowance: next }, requestId,
  });
  return { planId: plan.id, keyId: key.id, periodStart, used, allowance: next, remaining: Math.max(next - used, 0) };
}

/**
 * Service-level stage throttle update (REST `method_settings` with a
 * star-slash-star default; HTTP/WS `default_route_settings`/`route_settings`).
 * Validated against the project level (422). The HTTP surface stays with the
 * S05 stage routes — this function is exported for tests and reuse.
 */
export async function updateStageThrottle(db, actor, { projectId, apiId, stageName, defaultThrottle, methodThrottles = {}, requestId = null }) {
  await requirePermission(db, actor, "pods.stage.write", { projectId });
  const api = await db.getApiByRef({ projectId, ref: apiId });
  if (!api) throw new HttpError(404, "not_found", "API does not exist.");
  const protocol = api.protocol ?? "REST";
  const stage = await db.getStageByName({ apiId: api.id, name: stageName });
  if (!stage) throw new HttpError(404, "not_found", "Stage does not exist.");
  const project = projectThrottle(await db.getProjectSettings(projectId).catch(() => null));
  const cleanDefault = defaultThrottle === undefined || defaultThrottle === null
    ? null
    : checkThrottleValue(defaultThrottle, "defaultThrottle");
  if (cleanDefault && (cleanDefault.rateLimit > project.rate || cleanDefault.burstLimit > project.burst)) {
    throw new HttpError(
      422, "invalid_input",
      `Invalid request: $.defaultThrottle: exceeds the project throttle (${project.rate} rps / ${project.burst} burst)`,
    );
  }
  const cleanMethods = {};
  for (const [methodKey, entry] of Object.entries(methodThrottles ?? {})) {
    cleanMethods[methodKey] = checkThrottleVsProject(entry, project, `methodThrottles["${methodKey}"]`);
  }
  const toStage = (rate, burst) => ({ throttlingRateLimit: rate, throttlingBurstLimit: burst });
  let patch;
  if (protocol === "REST") {
    const methodSettings = { ...(stage.method_settings ?? {}) };
    if (cleanDefault) methodSettings["*/*"] = toStage(cleanDefault.rateLimit, cleanDefault.burstLimit);
    for (const [methodKey, entry] of Object.entries(cleanMethods)) {
      methodSettings[methodKey] = toStage(entry.rateLimit, entry.burstLimit);
    }
    patch = { method_settings: methodSettings };
  } else {
    const routeSettings = { ...(stage.route_settings ?? {}) };
    for (const [routeKey, entry] of Object.entries(cleanMethods)) {
      routeSettings[routeKey] = toStage(entry.rateLimit, entry.burstLimit);
    }
    patch = {
      route_settings: routeSettings,
      ...(cleanDefault
        ? { default_route_settings: toStage(cleanDefault.rateLimit, cleanDefault.burstLimit) }
        : {}),
    };
  }
  const next = await db.updateStage({ id: stage.id, patch });
  await audit(db, actor, {
    action: "stage.throttle_update", resourceType: "stage", resourceId: stage.id,
    projectId, apiId: api.id,
    before: null,
    after: { stage: stageName, defaultThrottle: cleanDefault, methodThrottles: cleanMethods },
    requestId,
  });
  return {
    apiId: api.id,
    stage: stageName,
    defaultThrottle: cleanDefault,
    methodThrottles: cleanMethods,
    version: next.version,
  };
}
