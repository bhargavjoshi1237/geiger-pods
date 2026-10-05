/**
 * Supabase implementations of the S06 db port (models, request validators,
 * method responses, gateway responses, API CORS).
 *
 * Route files compose these onto the S02 control db via the `route()`
 * `deps.createControlDb` hook, so `lib/control/supabase-db.mjs` (S02-owned)
 * stays untouched:
 *
 * ```js
 * import { createControlDb } from "@/lib/control/supabase-db.mjs";
 * import { withProcessingTables } from "@/lib/control/processing-db.mjs";
 * const deps = { createControlDb: (client, opts) => withProcessingTables(createControlDb(client, opts), client) };
 * ```
 *
 * `apis.cors` helpers target the S03 `apis` table; they throw a 501 until
 * that table lands (recorded in the S06 report).
 *
 * @module lib/control/processing-db
 */

import { HttpError } from "./errors.mjs";

function pods(client) {
  return client.schema("pods");
}

async function requireApisTable(client) {
  try {
    await pods(client).from("apis").select("id").limit(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mixes S06 table helpers into a control-db object.
 *
 * @param {object} db - The S02 control db.
 * @param {object} client - The caller's Supabase client (RLS).
 * @returns {object} the same `db` with S06 methods attached.
 */
export function withProcessingTables(db, client) {
  return Object.assign(db, {
    async listModels({ projectId, apiId, limit = 101, cursor = null }) {
      let query = pods(client).from("models").select("*").eq("project_id", projectId).eq("api_id", apiId)
        .order("created_at", { ascending: true }).limit(limit);
      if (cursor) query = query.gt("id", cursor);
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getModel({ projectId, apiId, name, id }) {
      let query = pods(client).from("models").select("*").eq("project_id", projectId).eq("api_id", apiId);
      query = id ? query.eq("id", id) : query.eq("name", name);
      const { data, error } = await query.maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertModel(row) {
      const { data, error } = await pods(client).from("models").insert(row).select("*").single();
      if (error) {
        if (error.code === "23505") throw new HttpError(409, "conflict", `A model named "${row.name}" already exists.`);
        throw new HttpError(500, "internal_error", error.message);
      }
      return data;
    },

    async updateModel({ id, ...patch }) {
      const { data, error } = await pods(client).from("models").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteModel({ id }) {
      const { error } = await pods(client).from("models").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async listRequestValidators({ projectId, apiId }) {
      const { data, error } = await pods(client).from("request_validators").select("*")
        .eq("project_id", projectId).eq("api_id", apiId).order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getRequestValidator({ id }) {
      const { data, error } = await pods(client).from("request_validators").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertRequestValidator(row) {
      const { data, error } = await pods(client).from("request_validators").insert(row).select("*").single();
      if (error) {
        if (error.code === "23505") throw new HttpError(409, "conflict", "A request validator with this name already exists.");
        throw new HttpError(500, "internal_error", error.message);
      }
      return data;
    },

    async updateRequestValidator({ id, ...patch }) {
      const { data, error } = await pods(client).from("request_validators").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteRequestValidator({ id }) {
      const { error } = await pods(client).from("request_validators").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async listMethodResponses({ methodId }) {
      const { data, error } = await pods(client).from("method_responses").select("*")
        .eq("method_id", methodId).order("status_code", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getMethodResponse({ methodId, statusCode }) {
      const { data, error } = await pods(client).from("method_responses").select("*")
        .eq("method_id", methodId).eq("status_code", statusCode).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertMethodResponse(row) {
      const { data, error } = await pods(client).from("method_responses").insert(row).select("*").single();
      if (error) {
        if (error.code === "23505") throw new HttpError(409, "conflict", "This method response already exists.");
        throw new HttpError(500, "internal_error", error.message);
      }
      return data;
    },

    async updateMethodResponse({ id, ...patch }) {
      const { data, error } = await pods(client).from("method_responses").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteMethodResponse({ id }) {
      const { error } = await pods(client).from("method_responses").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async listGatewayResponses({ projectId, apiId }) {
      const { data, error } = await pods(client).from("gateway_responses").select("*")
        .eq("project_id", projectId).eq("api_id", apiId).order("response_type", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getGatewayResponse({ apiId, responseType }) {
      const { data, error } = await pods(client).from("gateway_responses").select("*")
        .eq("api_id", apiId).eq("response_type", responseType).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertGatewayResponse(row) {
      const { data, error } = await pods(client).from("gateway_responses").insert(row).select("*").single();
      if (error) {
        if (error.code === "23505") throw new HttpError(409, "conflict", "This gateway response is already customized.");
        throw new HttpError(500, "internal_error", error.message);
      }
      return data;
    },

    async updateGatewayResponse({ id, ...patch }) {
      const { data, error } = await pods(client).from("gateway_responses").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteGatewayResponse({ id }) {
      const { error } = await pods(client).from("gateway_responses").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async getApiCors({ projectId, apiId }) {
      if (!(await requireApisTable(client))) {
        throw new HttpError(501, "not_implemented", "API CORS storage needs the S03 apis table.");
      }
      const { data, error } = await pods(client).from("apis").select("id, project_id, cors, version")
        .eq("id", apiId).eq("project_id", projectId).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async updateApiCors({ projectId, apiId, cors, version }) {
      if (!(await requireApisTable(client))) {
        throw new HttpError(501, "not_implemented", "API CORS storage needs the S03 apis table.");
      }
      const { data, error } = await pods(client).from("apis").update({ cors, version })
        .eq("id", apiId).eq("project_id", projectId).select("id, project_id, cors, version").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },
  });
}
