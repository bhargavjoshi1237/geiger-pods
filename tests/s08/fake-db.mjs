/**
 * In-memory fake of the S08 control db port (usage tables + the secret,
 * catalog, settings and stage rows the services touch). Mirrors the unique
 * indexes the Postgres migration enforces, so service prechecks behave the
 * same. No network, no Supabase.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { loadVaultKeys } from "../../lib/vault/keys.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

/** Vault KEK set for tests (mirrors tests/s02/vault.test.mjs). */
export function makeTestKeys() {
  const kek = randomBytes(32);
  return loadVaultKeys({
    PODS_VAULT_KEYS: JSON.stringify({ k1: kek.toString("base64") }),
    PODS_VAULT_ACTIVE_KID: "k1",
  });
}

function stamp(seq) {
  return new Date(Date.UTC(2026, 9, 8, 0, 0, 0, seq % 60)).toISOString();
}

export function createFakeDb(options = {}) {
  const { roles = {} } = options;
  let bindings = options.bindings ?? null;
  let seq = 0;
  const nextStamp = () => {
    seq += 1;
    return stamp(seq);
  };

  const apis = new Map();
  const stages = new Map();
  const secrets = new Map();
  const secretVersions = new Map();
  const apiKeys = new Map();
  const plans = new Map();
  const planStages = new Map(); // `${planId}|${apiId}|${stage}` → row
  const planKeys = new Map(); // `${planId}|${keyId}` → row
  const quotaAdjustments = [];
  const usageDaily = [];
  const audits = [];
  let settings = options.settings ?? null;

  return {
    audits,
    _maps: { apis, stages, secrets, apiKeys, plans, planStages, planKeys, usageDaily, quotaAdjustments },
    setBindings(next) {
      bindings = next;
    },
    async getInheritedRole({ userId }) {
      return roles[userId] ?? null;
    },
    async listRoleBindings() {
      return bindings ?? { roles: [], grants: [] };
    },
    async insertAudit(entry) {
      audits.push(entry);
    },
    // --- secrets (vault path; mirrors tests/s02/vault.test.mjs) ---
    async insertSecret(row) {
      const secret = {
        id: randomUUID(), created_at: nextStamp(), updated_at: nextStamp(),
        last_rotated_at: nextStamp(), deleted_at: null, expires_at: null,
        description: null, current_version: 1, version: 1, ...row,
      };
      secrets.set(secret.id, secret);
      return { ...secret };
    },
    async getSecretById(id) {
      return secrets.get(id) ? { ...secrets.get(id) } : null;
    },
    async updateSecret(id, patch) {
      const secret = secrets.get(id);
      if (!secret) return null;
      Object.assign(secret, patch, { updated_at: nextStamp() });
      return { ...secret };
    },
    async insertSecretVersion(row) {
      const record = { created_at: nextStamp(), disabled_at: null, ...row };
      secretVersions.set(`${row.secret_id}@${row.version}`, record);
      return { ...record };
    },
    async getSecretVersion(secretId, version) {
      const row = secretVersions.get(`${secretId}@${version}`);
      return row ? { ...row } : null;
    },
    async getSecretVersionEnvelope(secretId, version) {
      const row = secretVersions.get(`${secretId}@${version}`);
      return row ? { ...row } : null;
    },
    async listSecretVersions(secretId) {
      return [...secretVersions.values()]
        .filter((row) => row.secret_id === secretId)
        .sort((a, b) => b.version - a.version)
        .map((row) => ({ ...row }));
    },
    async updateSecretVersion(secretId, version, patch) {
      const record = secretVersions.get(`${secretId}@${version}`);
      if (!record) return null;
      Object.assign(record, patch);
      return { ...record };
    },
    async countSecretReferences() {
      return 0;
    },
    // --- catalog (minimal: apis + protocol) ---
    async insertApi(row) {
      const full = {
        id: randomUUID(), version: 1, created_at: nextStamp(), updated_at: nextStamp(),
        deleted_at: null, api_key_source: "HEADER", ...row,
      };
      apis.set(full.id, full);
      return { ...full };
    },
    async getApiByRef({ projectId, ref }) {
      for (const row of apis.values()) {
        if (row.deleted_at || row.project_id !== projectId) continue;
        if (row.id === ref || row.public_id === ref) return { ...row };
      }
      return null;
    },
    async getApiProtocol({ projectId, apiId }) {
      const api = [...apis.values()].find((row) => (row.id === apiId || row.public_id === apiId)
        && row.project_id === projectId && !row.deleted_at);
      return api?.protocol ?? null;
    },
    // --- project settings ---
    async getProjectSettings() {
      return settings ? { ...settings } : null;
    },
    async upsertProjectSettings(row) {
      settings = { version: 1, ...row };
      return { ...settings };
    },
    // --- stages (minimal inspector for updateStageThrottle) ---
    async insertStage(row) {
      const full = {
        id: randomUUID(), version: 1, created_at: nextStamp(), updated_at: nextStamp(),
        description: "", variables: {}, default_route_settings: {}, route_settings: {},
        method_settings: {}, ...row,
      };
      stages.set(full.id, full);
      return { ...full };
    },
    async getStageByName({ apiId, name }) {
      for (const row of stages.values()) {
        if (row.api_id === apiId && row.name === name) return { ...row };
      }
      return null;
    },
    async updateStage({ id, patch }) {
      const row = stages.get(id);
      if (!row) throw new HttpError(404, "not_found", "Stage does not exist.");
      const next = { ...row, ...patch, updated_at: nextStamp() };
      stages.set(id, next);
      return { ...next };
    },
    // --- api_keys ---
    async insertApiKey(row) {
      for (const existing of apiKeys.values()) {
        if (existing.value_hmac === row.value_hmac) {
          throw new HttpError(409, "conflict", "This key value is already registered.");
        }
      }
      const now = nextStamp();
      const full = {
        id: randomUUID(), version: 1, created_at: now, updated_at: now,
        enabled: true, description: "", customer_id: null, last_used_at: null,
        tags: {}, generate_distinct_id: false, ...row,
      };
      apiKeys.set(full.id, full);
      return { ...full };
    },
    async getApiKeyById(id) {
      const row = apiKeys.get(id);
      return row ? { ...row } : null;
    },
    async getApiKeyByHmac(hmacHex) {
      for (const row of apiKeys.values()) {
        if (row.value_hmac === hmacHex) return { ...row };
      }
      return null;
    },
    async listApiKeys({ projectId }) {
      return [...apiKeys.values()]
        .filter((row) => row.project_id === projectId)
        .map((row) => ({ ...row }));
    },
    async updateApiKey({ id, patch }) {
      const row = apiKeys.get(id);
      if (!row) throw new HttpError(404, "not_found", "API key does not exist.");
      const next = { ...row, ...patch, updated_at: nextStamp() };
      apiKeys.set(id, next);
      return { ...next };
    },
    async deleteApiKey({ id }) {
      const row = apiKeys.get(id);
      if (!row) throw new HttpError(404, "not_found", "API key does not exist.");
      apiKeys.delete(id);
      for (const key of [...planKeys.keys()]) {
        if (key.endsWith(`|${id}`)) planKeys.delete(key);
      }
      return { id, deleted: true };
    },
    // --- usage_plans ---
    async insertPlan(row) {
      for (const existing of plans.values()) {
        if (existing.project_id === row.project_id && existing.public_id === row.public_id) {
          throw new HttpError(409, "conflict", `A usage plan "${row.public_id}" already exists.`);
        }
      }
      const now = nextStamp();
      const full = {
        id: randomUUID(), version: 1, created_at: now, updated_at: now,
        description: "", throttle: null, quota: null, quota_since: null, tags: {}, ...row,
      };
      plans.set(full.id, full);
      return { ...full };
    },
    async getPlanById(id) {
      const row = plans.get(id);
      return row ? { ...row } : null;
    },
    async getPlanByRef({ projectId, ref }) {
      for (const row of plans.values()) {
        if (row.project_id !== projectId) continue;
        if (row.id === ref || row.public_id === ref) return { ...row };
      }
      return null;
    },
    async listPlans({ projectId }) {
      return [...plans.values()]
        .filter((row) => row.project_id === projectId)
        .map((row) => ({ ...row }));
    },
    async updatePlan({ id, patch }) {
      const row = plans.get(id);
      if (!row) throw new HttpError(404, "not_found", "Usage plan does not exist.");
      const next = { ...row, ...patch, updated_at: nextStamp() };
      plans.set(id, next);
      return { ...next };
    },
    async deletePlan({ id }) {
      const row = plans.get(id);
      if (!row) throw new HttpError(404, "not_found", "Usage plan does not exist.");
      plans.delete(id);
      for (const key of [...planStages.keys()]) {
        if (key.startsWith(`${id}|`)) planStages.delete(key);
      }
      for (const key of [...planKeys.keys()]) {
        if (key.startsWith(`${id}|`)) planKeys.delete(key);
      }
      return { id, deleted: true };
    },
    // --- plan stages ---
    async insertPlanStage(row) {
      const key = `${row.plan_id}|${row.api_id}|${row.stage_name}`;
      if (planStages.has(key)) {
        throw new HttpError(409, "conflict", "This API stage is already associated with the plan.");
      }
      const full = { method_throttles: {}, ...row };
      planStages.set(key, full);
      return { ...full };
    },
    async listPlanStages({ planId }) {
      return [...planStages.values()]
        .filter((row) => row.plan_id === planId)
        .map((row) => ({ ...row }));
    },
    async updatePlanStage({ planId, apiId, stage, patch }) {
      const key = `${planId}|${apiId}|${stage}`;
      const row = planStages.get(key);
      if (!row) throw new HttpError(404, "not_found", "This API stage is not associated with the plan.");
      const next = { ...row, ...patch };
      planStages.set(key, next);
      return { ...next };
    },
    async deletePlanStage({ planId, apiId, stage }) {
      const key = `${planId}|${apiId}|${stage}`;
      if (!planStages.has(key)) throw new HttpError(404, "not_found", "This API stage is not associated with the plan.");
      planStages.delete(key);
      return { planId, apiId, stage, deleted: true };
    },
    // --- plan keys ---
    async insertPlanKey(row) {
      const key = `${row.plan_id}|${row.api_key_id}`;
      if (planKeys.has(key)) {
        throw new HttpError(409, "conflict", "This key is already associated with the plan.");
      }
      const full = { created_at: nextStamp(), ...row };
      planKeys.set(key, full);
      return { ...full };
    },
    async listPlanKeys({ planId }) {
      return [...planKeys.values()]
        .filter((row) => row.plan_id === planId)
        .map((row) => ({ ...row }));
    },
    async listPlansForKey({ keyId }) {
      return [...planKeys.values()]
        .filter((row) => row.api_key_id === keyId)
        .map((row) => ({ ...row }));
    },
    async deletePlanKey({ planId, keyId }) {
      const key = `${planId}|${keyId}`;
      if (!planKeys.has(key)) throw new HttpError(404, "not_found", "This key is not associated with the plan.");
      planKeys.delete(key);
      return { planId, keyId, deleted: true };
    },
    // --- quota adjustments + usage history ---
    async insertQuotaAdjustment(row) {
      const full = { id: randomUUID(), created_at: nextStamp(), ...row };
      quotaAdjustments.push(full);
      return { ...full };
    },
    async listQuotaAdjustments({ planId, keyId }) {
      return quotaAdjustments
        .filter((row) => row.plan_id === planId && row.api_key_id === keyId)
        .map((row) => ({ ...row }));
    },
    async insertUsageDaily(row) {
      usageDaily.push({ ...row });
      return { ...row };
    },
    async listUsageDaily({ planId, keyId = null, start = null, end = null }) {
      return usageDaily
        .filter((row) => row.plan_id === planId
          && (keyId === null || row.api_key_id === keyId)
          && (start === null || row.day >= start)
          && (end === null || row.day <= end))
        .map((row) => ({ ...row }));
    },
  };
}
