/**
 * Supabase adapter for the S08 usage tables (production path).
 *
 * `createControlDb` (S02, shared) has no usage methods and is owned by
 * another spec, so S08 attaches its store here instead of editing the
 * shared file: route handlers build one extra server client and call
 * `withUsageDb(db, client)`. Reads/writes go through RLS as the caller
 * (the migration grants exactly the `pods.api_key.write` /
 * `pods.usage_plan.write` / `pods.usage.view` keys the services check).
 *
 * `value_hmac` is `bytea`: PostgREST parses `\x…` hex literals, so the
 * adapter converts hex ↔ `\x` hex format on write/read.
 *
 * @module lib/control/usage-db
 */

import { HttpError } from "./errors.mjs";

function pods(client) {
  return client.schema("pods");
}

function fail(message, status = 500, code = "internal_error") {
  throw new HttpError(status, code, message);
}

/**
 * Converts an HMAC hex digest to Postgres `bytea` hex-literal format.
 *
 * @param {string} hex
 * @returns {string}
 */
export function hmacToDb(hex) {
  return `\\x${String(hex).toLowerCase()}`;
}

/**
 * Converts a `bytea` value read from Postgres back to lowercase hex.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function hmacFromDb(value) {
  if (typeof value !== "string") return null;
  const text = value.startsWith("\\x") ? value.slice(2) : value;
  return /^[0-9a-fA-F]+$/.test(text) ? text.toLowerCase() : null;
}

function keyRow(row) {
  if (row && typeof row.value_hmac === "string") {
    return { ...row, value_hmac: hmacFromDb(row.value_hmac) ?? row.value_hmac };
  }
  return row;
}

async function one(query, { notFoundMessage = null } = {}) {
  const { data, error } = await query;
  if (error) {
    if (error.code === "PGRST116" && notFoundMessage) fail(notFoundMessage, 404, "not_found");
    if (error.code === "23505") fail("Duplicate value violates a uniqueness constraint.", 409, "conflict");
    fail(error.message);
  }
  return data;
}

async function many(query) {
  const { data, error } = await query;
  if (error) fail(error.message);
  return data ?? [];
}

/**
 * Attaches the S08 usage store to any control `db` object.
 *
 * @param {object} db - The request-scoped control db (permissions, audit, vault).
 * @param {object} client - A Supabase server client for the caller (RLS applies).
 * @returns {object} `db` plus the S08 table methods.
 */
export function withUsageDb(db, client) {
  if (!client) return db;
  const store = pods(client);
  return {
    ...db,
    // --- api_keys ---
    async insertApiKey(row) {
      try {
        const data = await one(store.from("api_keys").insert({
          ...row,
          value_hmac: hmacToDb(row.value_hmac),
        }).select("*").single());
        return keyRow(data);
      } catch (error) {
        if (error instanceof HttpError && error.code === "conflict") {
          throw new HttpError(409, "conflict", "This key value is already registered.");
        }
        throw error;
      }
    },
    async getApiKeyById(id) {
      return keyRow(await one(store.from("api_keys").select("*").eq("id", id).maybeSingle()));
    },
    async getApiKeyByHmac(hmacHex) {
      return keyRow(await one(store.from("api_keys").select("*").eq("value_hmac", hmacToDb(hmacHex)).maybeSingle()));
    },
    async listApiKeys({ projectId }) {
      const rows = await many(store.from("api_keys").select("*").eq("project_id", projectId)
        .order("created_at", { ascending: false }));
      return rows.map(keyRow);
    },
    async updateApiKey({ id, patch }) {
      const data = await one(store.from("api_keys").update(patch).eq("id", id).select("*").single(),
        { notFoundMessage: "API key does not exist." });
      return keyRow(data);
    },
    async deleteApiKey({ id }) {
      const { error } = await store.from("api_keys").delete().eq("id", id);
      if (error) fail(error.message);
      return { id, deleted: true };
    },
    // --- usage_plans ---
    async insertPlan(row) {
      return one(store.from("usage_plans").insert(row).select("*").single());
    },
    async getPlanById(id) {
      return one(store.from("usage_plans").select("*").eq("id", id).maybeSingle());
    },
    async getPlanByRef({ projectId, ref }) {
      const { data, error } = await store.from("usage_plans").select("*").eq("project_id", projectId)
        .or(`id.eq.${ref},public_id.eq.${ref}`).maybeSingle();
      if (error) fail(error.message);
      return data;
    },
    async listPlans({ projectId }) {
      return many(store.from("usage_plans").select("*").eq("project_id", projectId)
        .order("created_at", { ascending: false }));
    },
    async updatePlan({ id, patch }) {
      return one(store.from("usage_plans").update(patch).eq("id", id).select("*").single(),
        { notFoundMessage: "Usage plan does not exist." });
    },
    async deletePlan({ id }) {
      const { error } = await store.from("usage_plans").delete().eq("id", id);
      if (error) fail(error.message);
      return { id, deleted: true };
    },
    // --- plan stages ---
    async insertPlanStage(row) {
      return one(store.from("usage_plan_stages").insert(row).select("*").single());
    },
    async listPlanStages({ planId }) {
      return many(store.from("usage_plan_stages").select("*").eq("plan_id", planId));
    },
    async updatePlanStage({ planId, apiId, stage, patch }) {
      return one(store.from("usage_plan_stages").update(patch)
        .eq("plan_id", planId).eq("api_id", apiId).eq("stage_name", stage).select("*").single(),
      { notFoundMessage: "This API stage is not associated with the plan." });
    },
    async deletePlanStage({ planId, apiId, stage }) {
      const { error } = await store.from("usage_plan_stages").delete()
        .eq("plan_id", planId).eq("api_id", apiId).eq("stage_name", stage);
      if (error) fail(error.message);
      return { planId, apiId, stage, deleted: true };
    },
    // --- plan keys ---
    async insertPlanKey(row) {
      return one(store.from("usage_plan_keys").insert(row).select("*").single());
    },
    async listPlanKeys({ planId }) {
      return many(store.from("usage_plan_keys").select("*").eq("plan_id", planId));
    },
    async listPlansForKey({ keyId }) {
      return many(store.from("usage_plan_keys").select("*").eq("api_key_id", keyId));
    },
    async deletePlanKey({ planId, keyId }) {
      const { error } = await store.from("usage_plan_keys").delete()
        .eq("plan_id", planId).eq("api_key_id", keyId);
      if (error) fail(error.message);
      return { planId, keyId, deleted: true };
    },
    // --- quota adjustments + usage history ---
    async insertQuotaAdjustment(row) {
      return one(store.from("quota_adjustments").insert(row).select("*").single());
    },
    async listQuotaAdjustments({ planId, keyId }) {
      return many(store.from("quota_adjustments").select("*")
        .eq("plan_id", planId).eq("api_key_id", keyId).order("created_at", { ascending: true }));
    },
    async listUsageDaily({ planId, keyId = null, start = null, end = null }) {
      let query = store.from("usage_daily").select("*").eq("plan_id", planId);
      if (keyId !== null) query = query.eq("api_key_id", keyId);
      if (start !== null) query = query.gte("day", start);
      if (end !== null) query = query.lte("day", end);
      return many(query.order("day", { ascending: true }));
    },
  };
}
