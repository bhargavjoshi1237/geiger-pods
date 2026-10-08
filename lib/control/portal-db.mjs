/**
 * Supabase implementations of the S13 portals db port (part D).
 *
 * Route files compose this onto the S02 control db via the `route()`
 * `deps.createControlDb` hook, so `lib/control/supabase-db.mjs` (S02-owned)
 * stays untouched — the same pattern as `distribution-db.mjs`:
 *
 * ```js
 * import { createControlDb } from "@/lib/control/supabase-db.mjs";
 * import { withPortalTables } from "@/lib/control/portal-db.mjs";
 * const deps = { createControlDb: (client, opts) => withPortalTables(createControlDb(client, opts), client) };
 * ```
 *
 * @module lib/control/portal-db
 */

import { HttpError } from "./errors.mjs";

function pods(client) {
  return client.schema("pods");
}

/**
 * Mixes S13 portal table helpers into a control-db object.
 *
 * @param {object} db - The S02 control db.
 * @param {object} client - The caller's Supabase client (RLS).
 * @returns {object} the same `db` with S13 portal methods attached.
 */
export function withPortalTables(db, client) {
  return Object.assign(db, {
    async insertPortal(row) {
      const { data, error } = await pods(client).from("portals").insert(row).select("*").single();
      if (error) {
        if (error.code === "23505") throw new HttpError(409, "conflict", "A portal with this slug already exists.");
        throw new HttpError(500, "internal_error", error.message);
      }
      return data;
    },
    async getPortalById({ id }) {
      const { data, error } = await pods(client).from("portals").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },
    async getPortalBySlug({ slug }) {
      const { data, error } = await pods(client).from("portals").select("*").eq("slug", slug).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },
    async listPortals({ projectId }) {
      const { data, error } = await pods(client).from("portals").select("*").eq("project_id", projectId).order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },
    async updatePortal({ id, patch }) {
      const { data, error } = await pods(client).from("portals").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },
    async deletePortal({ id }) {
      const { error } = await pods(client).from("portals").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return { id, deleted: true };
    },
    async insertPortalProduct(row) {
      const { data, error } = await pods(client).from("portal_products").insert(row).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },
    async getPortalProduct({ id }) {
      const { data, error } = await pods(client).from("portal_products").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },
    async listPortalProducts({ projectId }) {
      const { data, error } = await pods(client).from("portal_products").select("*").eq("project_id", projectId).order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },
    async listAllPortalProducts() {
      const { data, error } = await pods(client).from("portal_products").select("*").order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },
    async updatePortalProduct({ id, patch }) {
      const { data, error } = await pods(client).from("portal_products").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },
    async deletePortalProduct({ id }) {
      const { error } = await pods(client).from("portal_products").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return { id, deleted: true };
    },
    async linkProduct({ portalId, productId, order = 0 }) {
      const { data, error } = await pods(client).from("portal_product_links")
        .upsert({ portal_id: portalId, product_id: productId, order }, { onConflict: "portal_id,product_id" })
        .select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },
    async unlinkProduct({ portalId, productId }) {
      const { error } = await pods(client).from("portal_product_links").delete().eq("portal_id", portalId).eq("product_id", productId);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return { deleted: true };
    },
    async listPortalLinks({ portalId }) {
      const { data, error } = await pods(client).from("portal_product_links").select("*").eq("portal_id", portalId);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },
    async insertProductPage(row) {
      const { data, error } = await pods(client).from("product_pages").insert(row).select("*").single();
      if (error) {
        if (error.code === "23505") throw new HttpError(409, "conflict", "A page with this slug already exists on the product.");
        throw new HttpError(500, "internal_error", error.message);
      }
      return data;
    },
    async listProductPages({ productId }) {
      const { data, error } = await pods(client).from("product_pages").select("*").eq("product_id", productId).order("order", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },
    async insertProductEndpoint(row) {
      const { data, error } = await pods(client).from("product_endpoint_pages").insert(row).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },
    async listProductEndpoints({ productId }) {
      const { data, error } = await pods(client).from("product_endpoint_pages").select("*").eq("product_id", productId).order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },
    async insertPortalEvent(row) {
      const { data, error } = await pods(client).from("portal_events").insert(row).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },
  });
}
