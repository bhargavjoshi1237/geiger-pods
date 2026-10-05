/**
 * Supabase implementations of the S07 db port (authorizers, signing
 * credentials + policies, API resource-policy column).
 *
 * Route files compose these onto the S02 control db via the `route()`
 * `deps.createControlDb` hook, so `lib/control/supabase-db.mjs` (S02-owned)
 * stays untouched:
 *
 * ```js
 * import { createControlDb } from "@/lib/control/supabase-db.mjs";
 * import { withAuthTables } from "@/lib/control/auth-db.mjs";
 * const deps = { createControlDb: (client, opts) => withAuthTables(createControlDb(client, opts), client) };
 * ```
 *
 * @module lib/control/auth-db
 */

import { HttpError } from "./errors.mjs";

function pods(client) {
  return client.schema("pods");
}

function conflict(error, message) {
  if (error && (error.code === "23505" || /duplicate|unique/i.test(error.message ?? ""))) {
    throw new HttpError(409, "conflict", message);
  }
  throw new HttpError(500, "internal_error", error?.message ?? "Database error.");
}

/**
 * Mixes S07 table helpers into a control-db object.
 *
 * @param {object} db - The S02 control db.
 * @param {object} client - The caller's Supabase client (RLS).
 * @returns {object} the same `db` with S07 methods attached.
 */
export function withAuthTables(db, client) {
  return Object.assign(db, {
    // --- authorizers ---
    async listAuthorizers({ projectId, apiId, limit = 101, cursor = null }) {
      let query = pods(client).from("authorizers").select("*")
        .eq("project_id", projectId).eq("api_id", apiId)
        .order("created_at", { ascending: true }).limit(limit);
      if (cursor) query = query.gt("id", cursor);
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getAuthorizerById(id) {
      const { data, error } = await pods(client).from("authorizers").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertAuthorizer(row) {
      const { data, error } = await pods(client).from("authorizers").insert(row).select("*").single();
      if (error) conflict(error, "An authorizer with this name already exists for this API.");
      return data;
    },

    async updateAuthorizer({ id, patch }) {
      const { data, error } = await pods(client).from("authorizers").update(patch).eq("id", id).select("*").single();
      if (error) conflict(error, "An authorizer with this name already exists for this API.");
      return data;
    },

    async deleteAuthorizer({ id }) {
      const { error } = await pods(client).from("authorizers").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    // --- signing credentials ---
    async listSigningCredentials({ projectId, limit = 101, cursor = null }) {
      let query = pods(client).from("signing_credentials").select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }).limit(limit);
      if (cursor) query = query.lt("created_at", cursor.createdAt).or(`created_at.eq.${cursor.createdAt},id.gt.${cursor.id}`);
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getSigningCredentialById(id) {
      const { data, error } = await pods(client).from("signing_credentials").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async getSigningCredentialByKey({ accessKeyId }) {
      const { data, error } = await pods(client).from("signing_credentials").select("*").eq("access_key_id", accessKeyId).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertSigningCredential(row) {
      const { data, error } = await pods(client).from("signing_credentials").insert(row).select("*").single();
      if (error) conflict(error, "A signing credential with this name already exists.");
      return data;
    },

    async updateSigningCredential({ id, patch }) {
      const { data, error } = await pods(client).from("signing_credentials").update(patch).eq("id", id).select("*").single();
      if (error) conflict(error, "A signing credential with this name already exists.");
      return data;
    },

    async deleteSigningCredential({ id }) {
      const { error } = await pods(client).from("signing_credentials").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    // --- signing policies ---
    async listSigningPolicies({ projectId, credentialId }) {
      const { data, error } = await pods(client).from("signing_policies").select("*")
        .eq("project_id", projectId).eq("credential_id", credentialId)
        .order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getSigningPolicyById(id) {
      const { data, error } = await pods(client).from("signing_policies").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async countSigningPolicies({ credentialId }) {
      const { count, error } = await pods(client).from("signing_policies")
        .select("id", { count: "exact", head: true }).eq("credential_id", credentialId);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return count ?? 0;
    },

    async insertSigningPolicy(row) {
      const { data, error } = await pods(client).from("signing_policies").insert(row).select("*").single();
      if (error) conflict(error, "A policy with this name already exists for this credential.");
      return data;
    },

    async updateSigningPolicy({ id, patch }) {
      const { data, error } = await pods(client).from("signing_policies").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteSigningPolicy({ id }) {
      const { error } = await pods(client).from("signing_policies").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },
  });
}
