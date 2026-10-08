/**
 * Supabase implementations of the S13 db port (documentation parts and
 * versions). Route files compose these onto the S02 control db via the
 * `route()` `deps.createControlDb` hook, so `lib/control/supabase-db.mjs`
 * (S02-owned) stays untouched — the same pattern as `processing-db.mjs`:
 *
 * ```js
 * import { createControlDb } from "@/lib/control/supabase-db.mjs";
 * import { withDistributionTables } from "@/lib/control/distribution-db.mjs";
 * const deps = { createControlDb: (client, opts) => withDistributionTables(createControlDb(client, opts), client) };
 * ```
 *
 * @module lib/control/distribution-db
 */

import { HttpError } from "./errors.mjs";

function pods(client) {
  return client.schema("pods");
}

/**
 * Mixes S13 table helpers into a control-db object.
 *
 * @param {object} db - The S02 control db.
 * @param {object} client - The caller's Supabase client (RLS).
 * @returns {object} the same `db` with S13 methods attached.
 */
export function withDistributionTables(db, client) {
  return Object.assign(db, {
    async listDocumentationParts({ apiId }) {
      const { data, error } = await pods(client).from("documentation_parts").select("*")
        .eq("api_id", apiId).order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getDocumentationPart({ id }) {
      const { data, error } = await pods(client).from("documentation_parts").select("*")
        .eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertDocumentationPart(row) {
      const { data, error } = await pods(client).from("documentation_parts").insert(row).select("*").single();
      if (error) {
        if (error.code === "23505") throw new HttpError(409, "conflict", "A documentation part already exists for this location.");
        throw new HttpError(500, "internal_error", error.message);
      }
      return data;
    },

    async updateDocumentationPart({ id, patch }) {
      const { data, error } = await pods(client).from("documentation_parts").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteDocumentationPart({ id }) {
      const { error } = await pods(client).from("documentation_parts").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async listDocumentationVersions({ apiId }) {
      const { data, error } = await pods(client).from("documentation_versions").select("*")
        .eq("api_id", apiId).order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getDocumentationVersion({ apiId, version }) {
      const { data, error } = await pods(client).from("documentation_versions").select("*")
        .eq("api_id", apiId).eq("version", version).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertDocumentationVersion(row) {
      const { data, error } = await pods(client).from("documentation_versions").insert(row).select("*").single();
      if (error) {
        if (error.code === "23505") throw new HttpError(409, "conflict", `A documentation version "${row.version}" already exists.`);
        throw new HttpError(500, "internal_error", error.message);
      }
      return data;
    },
  });
}
