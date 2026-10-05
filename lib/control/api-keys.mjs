/**
 * API-key control-plane service (S08 §1–§2).
 *
 * `pods.api_keys` is project-level: generated values are 40-char base62,
 * imported/custom values 20–128 chars `[A-Za-z0-9_-]`. The value is stored
 * once in the vault (`value_ref`, kind `generic`) and looked up at runtime
 * by `value_hmac` (HMAC-SHA256 with `PODS_KEY_PEPPER`). Responses carry the
 * value **once** (on create/rotate); reveal needs `pods.api_key.reveal` and
 * is audited. Mutations warm the runtime KV cache (`apikey:{hmac}`, 60 s)
 * and publish `pods:usage-changed` so keys take effect without a redeploy.
 *
 * Services are storage-agnostic (`db` port); the vault path needs
 * `deps.keys` in tests (production loads `PODS_VAULT_KEYS` from env) and the
 * cache path needs `deps.kv` (absent → skipped, like S05 stages).
 *
 * @module lib/control/api-keys
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import {
  createSecret as vaultCreate,
  deleteSecret as vaultDelete,
  formatSecretRef,
  parseSecretRef,
  resolveSecretRef,
} from "../vault/secrets.mjs";
import { newPublicId } from "../gateway/ids.mjs";
import {
  APIKEY_CACHE_TTL_MS,
  USAGE_CHANGED_CHANNEL,
  apiKeyCacheKey,
  assertImportableValue,
  generateApiKeyValue,
  hmacForValue,
  keyPrefix,
} from "../gateway/core/usage/api-key.mjs";

export { USAGE_CHANGED_CHANNEL, APIKEY_CACHE_TTL_MS };

/** A key may belong to at most 10 plans (spec §1). */
export const MAX_PLANS_PER_KEY = 10;

/**
 * Resolves the HMAC pepper: explicit `deps.pepper`, else `PODS_KEY_PEPPER`.
 *
 * @param {{ pepper?: string }} [deps={}]
 * @returns {string}
 * @throws {HttpError} 500 when unconfigured (fail closed).
 */
export function getPepper(deps = {}) {
  const pepper = deps.pepper ?? process.env.PODS_KEY_PEPPER;
  if (typeof pepper !== "string" || pepper.length === 0) {
    throw new HttpError(500, "configuration_error", "PODS_KEY_PEPPER is not configured.");
  }
  return pepper;
}

/**
 * Publishes a usage invalidation (best-effort; the 60 s TTL still applies).
 *
 * @param {object|null} kv
 * @param {object} payload
 */
export async function publishUsageChanged(kv, payload) {
  if (!kv || typeof kv.publish !== "function") return;
  try {
    await kv.publish(USAGE_CHANGED_CHANNEL, JSON.stringify(payload ?? {}));
  } catch {
    // Pub/sub is best-effort.
  }
}

function view(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    publicId: row.public_id,
    name: row.name,
    description: row.description ?? "",
    enabled: row.enabled ?? true,
    customerId: row.customer_id ?? null,
    prefix: row.value_prefix,
    lastUsedAt: row.last_used_at ?? null,
    tags: row.tags ?? {},
    generateDistinctId: row.generate_distinct_id ?? false,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function checkName(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > 128) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
  }
  return name;
}

function checkTags(tags) {
  if (tags === undefined) return undefined;
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.tags: expected an object");
  }
  const entries = Object.entries(tags);
  if (entries.length > 50) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.tags: at most 50 entries");
  }
  for (const [key, value] of entries) {
    if (typeof value !== "string" || value.length > 256) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.tags.${key}: expected a string of at most 256 characters`);
    }
  }
  return { ...tags };
}

/**
 * Resolves a key by uuid or public id, scoped to the project.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} keyId
 */
export async function resolveKey(db, projectId, keyId) {
  let row = null;
  try {
    row = await db.getApiKeyById(keyId);
  } catch {
    row = null;
  }
  if (!row && typeof db.listApiKeys === "function") {
    const all = await db.listApiKeys({ projectId });
    row = all.find((entry) => entry.public_id === keyId) ?? null;
  }
  if (!row || row.project_id !== projectId) {
    throw new HttpError(404, "not_found", "API key does not exist.");
  }
  return row;
}

/**
 * Builds the runtime snapshot record for a key (KV cache payload).
 *
 * @param {object} db
 * @param {string} keyId
 * @param {{ now?: () => number }} [deps={}]
 */
export async function buildKeyRecord(db, keyId, deps = {}) {
  const { periodStartFor } = await import("../gateway/core/usage/quota.mjs");
  const row = await db.getApiKeyById(keyId);
  if (!row) throw new HttpError(404, "not_found", "API key does not exist.");
  const nowMs = typeof deps.now === "function" ? deps.now() : Date.now();
  const memberships = await db.listPlansForKey({ keyId: row.id });
  const plans = [];
  for (const membership of memberships) {
    const plan = await db.getPlanById(membership.plan_id);
    if (!plan) continue;
    const stages = await db.listPlanStages({ planId: plan.id });
    let adjustmentsDelta = 0;
    if (plan.quota && typeof db.listQuotaAdjustments === "function") {
      const periodStart = periodStartFor(plan.quota.period, nowMs);
      const adjustments = await db.listQuotaAdjustments({ planId: plan.id, keyId: row.id });
      for (const entry of adjustments) {
        if (Date.parse(entry.period_start) === periodStart && Number.isInteger(entry.delta)) {
          adjustmentsDelta += entry.delta;
        }
      }
    }
    for (const stage of stages) {
      plans.push({
        planId: plan.id,
        apiId: stage.api_id,
        stage: stage.stage_name,
        throttle: plan.throttle ?? null,
        quota: plan.quota
          ? { ...plan.quota, since: plan.quota_since ?? plan.created_at ?? null }
          : null,
        methodThrottles: stage.method_throttles ?? {},
        adjustmentsDelta,
      });
    }
  }
  return { keyId: row.id, publicId: row.public_id, enabled: row.enabled, plans };
}

/**
 * Warms the runtime KV cache for a key (best-effort without `kv`).
 *
 * @param {object} db
 * @param {object|null} kv
 * @param {string} keyId
 * @param {string} hmacHex
 * @param {{ now?: () => number }} [deps={}]
 */
export async function warmKeyCache(db, kv, keyId, hmacHex, deps = {}) {
  if (!kv || typeof kv.set !== "function") return;
  try {
    const record = await buildKeyRecord(db, keyId, deps);
    await kv.set(apiKeyCacheKey(hmacHex), JSON.stringify(record), { ttlMs: APIKEY_CACHE_TTL_MS });
  } catch {
    // Cache warming is best-effort.
  }
}

/**
 * Low-level plan membership insert with the spec §1 guards: a key may join
 * at most 10 plans and must not join two plans covering the same API stage.
 * No permission or audit here — `addKeyToPlan` (usage-plans) and the CSV
 * importer wrap it after checking once.
 *
 * @param {object} db
 * @param {{ keyId: string, planId: string }} input
 * @returns {Promise<object>} The `usage_plan_keys` row.
 * @throws {HttpError} 409 with the conflicting plan when guards fail.
 */
export async function insertPlanMembership(db, { keyId, planId }) {
  const existing = await db.listPlansForKey({ keyId });
  if (existing.some((row) => row.plan_id === planId)) {
    throw new HttpError(409, "conflict", "This key is already associated with the plan.");
  }
  if (existing.length >= MAX_PLANS_PER_KEY) {
    throw new HttpError(409, "conflict", `A key may belong to at most ${MAX_PLANS_PER_KEY} plans.`);
  }
  const incoming = await db.listPlanStages({ planId });
  const covered = new Set(incoming.map((stage) => `${stage.api_id}|${stage.stage_name}`));
  for (const membership of existing) {
    const stages = await db.listPlanStages({ planId: membership.plan_id });
    for (const stage of stages) {
      if (covered.has(`${stage.api_id}|${stage.stage_name}`)) {
        throw new HttpError(
          409,
          "conflict",
          `This key is already in plan "${membership.plan_id}", which covers the same API stage.`,
          { conflictingPlanId: membership.plan_id, apiId: stage.api_id, stage: stage.stage_name },
        );
      }
    }
  }
  return db.insertPlanKey({ plan_id: planId, api_key_id: keyId });
}

/** Create a key: generate or accept a value, vault it, return it **once**. */
export async function createApiKey(db, actor, input, deps = {}) {
  const { projectId, requestId = null } = input ?? {};
  await requirePermission(db, actor, "pods.api_key.write", { projectId });
  const name = checkName(input?.name);
  const description = typeof input?.description === "string" ? input.description : "";
  if (description.length > 1024) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.description: must be at most 1024 characters");
  }
  const customerId = input?.customerId === null || input?.customerId === undefined
    ? null
    : String(input.customerId);
  if (customerId !== null && customerId.length > 256) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.customerId: must be at most 256 characters");
  }
  if (input?.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.enabled: expected a boolean");
  }
  const tags = checkTags(input?.tags) ?? {};
  let value;
  if (input?.value !== undefined && input?.value !== null) {
    try {
      value = assertImportableValue(input.value);
    } catch {
      throw new HttpError(422, "invalid_input", "Invalid request: $.value: must be 20–128 characters of [A-Za-z0-9_-]");
    }
  } else {
    value = generateApiKeyValue();
  }
  const pepper = getPepper(deps);
  const hmac = hmacForValue(value, pepper);
  if (await db.getApiKeyByHmac(hmac)) {
    throw new HttpError(409, "conflict", "This key value is already registered.");
  }
  const publicId = newPublicId();
  let secret;
  try {
    secret = await vaultCreate(db, actor, {
      projectId,
      name: `apikey-${publicId}`,
      kind: "generic",
      value: { value },
      description: `API key "${name}"`,
    }, deps.keys ? { keys: deps.keys } : {});
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, "internal_error", error?.message ?? "Could not store the key value.");
  }
  const row = await db.insertApiKey({
    project_id: projectId,
    public_id: publicId,
    name,
    description,
    enabled: input?.enabled ?? true,
    customer_id: customerId,
    value_ref: formatSecretRef(secret.id),
    value_hmac: hmac,
    value_prefix: keyPrefix(value),
    tags,
    generate_distinct_id: input?.generateDistinctId ?? false,
    created_by: actor?.userId ?? null,
  });
  await warmKeyCache(db, deps.kv ?? null, row.id, hmac, deps);
  await publishUsageChanged(deps.kv ?? null, { keyId: row.id, hmac });
  await audit(db, actor, {
    action: "api_key.create", resourceType: "api_key", resourceId: row.id,
    projectId, before: null, after: view(row), requestId,
  });
  return { status: 201, body: { ...view(row), value } };
}

/** Get key metadata (never the value), with plan memberships. */
export async function getApiKey(db, actor, { projectId, keyId }) {
  await requirePermission(db, actor, "pods.api_key.write", { projectId });
  const row = await resolveKey(db, projectId, keyId);
  const memberships = await db.listPlansForKey({ keyId: row.id });
  const plans = [];
  for (const membership of memberships) {
    const plan = await db.getPlanById(membership.plan_id).catch(() => null);
    if (plan && plan.project_id === projectId) {
      plans.push({ id: plan.id, publicId: plan.public_id, name: plan.name });
    }
  }
  return { ...view(row), plans };
}

/** List key metadata for a project. */
export async function listApiKeys(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.api_key.write", { projectId });
  const rows = await db.listApiKeys({ projectId });
  return { items: rows.map(view), nextCursor: null };
}

/**
 * Reveal a key value (AWS `GetApiKey includeValue`). Requires
 * `pods.api_key.reveal` and is audited (the audit entry never holds value).
 */
export async function revealApiKey(db, actor, { projectId, keyId, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.api_key.reveal", { projectId });
  const row = await resolveKey(db, projectId, keyId);
  let resolved;
  try {
    resolved = await resolveSecretRef(db, row.value_ref, {
      projectId,
      ...(deps.keys ? { keys: deps.keys } : {}),
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, "internal_error", "Could not reveal the key value.");
  }
  await audit(db, actor, {
    action: "api_key.reveal", resourceType: "api_key", resourceId: row.id,
    projectId, before: null, after: view(row), requestId,
  });
  return { ...view(row), value: resolved?.value?.value };
}

/** Update metadata / enable / disable (compare-and-swap on `version`). */
export async function updateApiKey(db, actor, { projectId, keyId, patch, expectedVersion = null, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.api_key.write", { projectId });
  const current = await resolveKey(db, projectId, keyId);
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `API key changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const clean = {};
  if (patch?.name !== undefined) clean.name = checkName(patch.name);
  if (patch?.description !== undefined) {
    if (typeof patch.description !== "string" || patch.description.length > 1024) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.description: must be a string of at most 1024 characters");
    }
    clean.description = patch.description;
  }
  if (patch?.customerId !== undefined) {
    if (patch.customerId !== null && (typeof patch.customerId !== "string" || patch.customerId.length > 256)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.customerId: must be a string of at most 256 characters or null");
    }
    clean.customer_id = patch.customerId;
  }
  if (patch?.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.enabled: expected a boolean");
    }
    clean.enabled = patch.enabled;
  }
  if (patch?.tags !== undefined) clean.tags = checkTags(patch.tags) ?? {};
  if (Object.keys(clean).length === 0) return view(current);
  const before = view(current);
  const next = await db.updateApiKey({ id: current.id, patch: { ...clean, version: current.version + 1 } });
  await warmKeyCache(db, deps.kv ?? null, next.id, next.value_hmac, deps);
  await publishUsageChanged(deps.kv ?? null, { keyId: next.id, hmac: next.value_hmac });
  await audit(db, actor, {
    action: "api_key.update", resourceType: "api_key", resourceId: next.id,
    projectId, before, after: view(next), requestId,
  });
  return view(next);
}

/** Delete a key (vault cleanup is best-effort; cache invalidated). */
export async function deleteApiKey(db, actor, { projectId, keyId, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.api_key.write", { projectId });
  const current = await resolveKey(db, projectId, keyId);
  const before = view(current);
  await db.deleteApiKey({ id: current.id });
  try {
    const { secretId } = parseSecretRef(current.value_ref);
    await vaultDelete(db, actor, { secretId }, deps.keys ? { keys: deps.keys } : {});
  } catch {
    // Vault cleanup is best-effort; the row (and its ref) is already gone.
  }
  try {
    await deps.kv?.del?.(apiKeyCacheKey(current.value_hmac));
  } catch {
    // Ignore.
  }
  await publishUsageChanged(deps.kv ?? null, { keyId: current.id, hmac: current.value_hmac });
  await audit(db, actor, {
    action: "api_key.delete", resourceType: "api_key", resourceId: current.id,
    projectId, before, after: null, requestId,
  });
  return { id: current.id, deleted: true };
}

/**
 * Rotate (Pods extension of the AWS create-new/delete-old flow): a new key
 * copying name (+ ` (rotated)`), plans, tags and customer; the old key stays
 * enabled until explicitly disabled. Returns the new value **once**.
 */
export async function rotateApiKey(db, actor, { projectId, keyId, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.api_key.write", { projectId });
  const current = await resolveKey(db, projectId, keyId);
  const created = await createApiKey(db, actor, {
    projectId,
    name: `${current.name} (rotated)`.slice(0, 128),
    description: current.description ?? "",
    customerId: current.customer_id,
    enabled: true,
    tags: { ...(current.tags ?? {}) },
    generateDistinctId: current.generate_distinct_id ?? false,
    requestId,
  }, deps);
  const memberships = await db.listPlansForKey({ keyId: current.id });
  for (const membership of memberships) {
    await db.insertPlanKey({ plan_id: membership.plan_id, api_key_id: created.body.id });
  }
  await warmKeyCache(db, deps.kv ?? null, created.body.id, hmacForValue(created.body.value, getPepper(deps)), deps);
  await publishUsageChanged(deps.kv ?? null, { keyId: created.body.id });
  await audit(db, actor, {
    action: "api_key.rotate", resourceType: "api_key", resourceId: created.body.id,
    projectId, before: view(current), after: { ...view({ ...current, id: created.body.id }), rotatedFrom: current.id }, requestId,
  });
  return created;
}

function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells.map((entry) => entry.trim());
}

function parseEnabled(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (text === "" || text === "true" || text === "1" || text === "yes") return { enabled: true, warning: null };
  if (text === "false" || text === "0" || text === "no") return { enabled: false, warning: null };
  return { enabled: true, warning: `Enabled "${raw}" is not a boolean; defaulted to true.` };
}

/**
 * Import keys from AWS-format CSV (`Name,Key,Description,Enabled,UsagePlanIds`).
 * Invalid rows become warnings and are skipped; `failOnWarnings` makes any
 * warning a 400 with **nothing** created (atomic: all rows validate first).
 */
export async function importApiKeys(db, actor, { projectId, csv, failOnWarnings = false, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.api_key.write", { projectId });
  if (typeof csv !== "string" || csv.trim().length === 0) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.csv: expected the AWS key file contents");
  }
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.csv: expected a header plus at least one row");
  }
  const header = splitCsvLine(lines[0]).map((cell) => cell.toLowerCase());
  const expected = ["name", "key", "description", "enabled", "usageplanids"];
  if (header.length !== expected.length || !expected.every((cell, index) => header[index] === cell)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.csv: expected header Name,Key,Description,Enabled,UsagePlanIds");
  }
  const rows = [];
  const warnings = [];
  const seenValues = new Set();
  for (let index = 1; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index]);
    while (cells.length < 5) cells.push("");
    const [name, key, description, enabledRaw, planIdsRaw] = cells;
    const label = name || `row ${index + 1}`;
    if (!name) {
      warnings.push(`Row ${index + 1}: missing Name; skipped.`);
      continue;
    }
    let value = null;
    if (key) {
      try {
        value = assertImportableValue(key);
      } catch {
        warnings.push(`Row "${label}": invalid Key (20–128 chars of [A-Za-z0-9_-]); skipped.`);
        continue;
      }
      if (seenValues.has(value)) {
        warnings.push(`Row "${label}": duplicate Key in file; skipped.`);
        continue;
      }
      seenValues.add(value);
    }
    const { enabled, warning } = parseEnabled(enabledRaw);
    if (warning) warnings.push(`Row "${label}": ${warning}`);
    const planRefs = String(planIdsRaw ?? "").split(/[\s;]+/).map((entry) => entry.trim()).filter(Boolean);
    rows.push({ name, value, description, enabled, planRefs, label });
  }
  if (failOnWarnings && warnings.length > 0) {
    throw new HttpError(400, "import_warnings", "Import has warnings and failOnWarnings is set; nothing was created.", { warnings });
  }
  const ids = [];
  for (const row of rows) {
    const created = await createApiKey(db, actor, {
      projectId,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      ...(row.value ? { value: row.value } : {}),
      requestId,
    }, deps);
    ids.push(created.body.id);
    for (const ref of row.planRefs) {
      let plan = null;
      try {
        plan = await db.getPlanByRef({ projectId, ref });
      } catch {
        plan = null;
      }
      if (!plan) {
        warnings.push(`Row "${row.label}": unknown usage plan "${ref}"; key created without it.`);
        continue;
      }
      try {
        await insertPlanMembership(db, { keyId: created.body.id, planId: plan.id });
        await warmKeyCache(
          db, deps.kv ?? null, created.body.id,
          hmacForValue(created.body.value, getPepper(deps)), deps,
        );
      } catch (error) {
        warnings.push(`Row "${row.label}": ${error?.message ?? "could not join plan"}; key created without it.`);
      }
    }
  }
  if (failOnWarnings && warnings.length > 0) {
    throw new HttpError(400, "import_warnings", "Import has warnings and failOnWarnings is set; nothing was created.", { warnings });
  }
  return { status: 200, body: { ids, warnings } };
}
