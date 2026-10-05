// Supabase implementation of the lib/control db port (S02 §4 + §8). Route
// handlers build it per request; services stay storage-agnostic for tests.
//
// `user` acts for the caller through RLS; `service` (optional) performs the
// vault writes the schema reserves for the server path (secret_versions
// inserts, ciphertext reads) after the service already required permission.

import { inheritedRole } from "../workspace/access.mjs";
import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { VaultError } from "../vault/secrets.mjs";

function pods(client) {
  return client.schema("pods");
}

function toRole(row) {
  return { id: row.id, key: row.key, name: row.name, permissions: row.permissions ?? [] };
}

function toGrant(row) {
  return {
    id: row.id,
    roleId: row.role_id,
    userId: row.user_id,
    projectId: row.project_id,
    scope: row.scope ?? {},
    status: row.status ?? "active",
  };
}

export function createControlDb(user, options = {}) {
  const service = options.service ?? null;

  async function requireService(feature) {
    if (!service) throw new HttpError(500, "internal_error", `The vault ${feature} path needs a service-role client.`);
    return service;
  }

  return {
    async getInheritedRole({ projectId, userId }) {
      const shared = user.schema("public");
      const [{ data: project, error: projectError }, { data: memberships, error: membershipError }] = await Promise.all([
        shared.from("projects").select("id, organization_id, created_by").eq("id", projectId).maybeSingle(),
        shared.from("organization_users").select("organization, user, role").eq("user", userId),
      ]);
      if (projectError) throw new HttpError(500, "internal_error", projectError.message);
      if (membershipError) throw new HttpError(500, "internal_error", membershipError.message);
      if (!project) return null;
      return inheritedRole(
        { organizationId: project.organization_id ?? null, createdBy: project.created_by ?? null },
        (memberships ?? []).map((row) => ({ organizationId: row.organization, userId: row.user, role: row.role })),
        userId,
      );
    },

    async listRoleBindings({ projectId, userId }) {
      const { data: grants, error: grantsError } = await pods(user)
        .from("role_grants")
        .select("id, role_id, user_id, project_id, scope, status")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .eq("status", "active");
      if (grantsError) throw new HttpError(500, "internal_error", grantsError.message);
      const roleIds = [...new Set((grants ?? []).map((grant) => grant.role_id))];
      let roles = [];
      if (roleIds.length > 0) {
        const { data, error } = await user.schema("public")
          .from("roles")
          .select("id, key, name, permissions")
          .in("id", roleIds)
          .is("deleted_at", null);
        if (error) throw new HttpError(500, "internal_error", error.message);
        roles = (data ?? []).map(toRole);
      }
      return { roles, grants: (grants ?? []).map(toGrant) };
    },

    async getProjectSettings(projectId) {
      const { data, error } = await pods(user).from("project_settings").select("*").eq("project_id", projectId).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async upsertProjectSettings(row) {
      const { data, error } = await pods(user).from("project_settings").upsert(row, { onConflict: "project_id" }).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertAudit(entry) {
      const { error } = await pods(user).rpc("audit", {
        p_project: entry.project_id,
        p_actor: entry.actor_id,
        p_actor_type: entry.actor_type,
        p_action: entry.action,
        p_resource_type: entry.resource_type,
        p_resource_id: entry.resource_id,
        p_api: entry.api_id,
        p_before: entry.before,
        p_after: entry.after,
        p_request_id: entry.request_id,
      });
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async listAudit({ projectId, filters = {}, limit = 25, cursor = null }) {
      let query = pods(user)
        .from("audit_events")
        .select("id, project_id, actor_id, actor_type, action, resource_type, resource_id, api_id, before, after, request_id, created_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1);
      if (filters.resourceType) query = query.eq("resource_type", filters.resourceType);
      if (filters.resourceId) query = query.eq("resource_id", filters.resourceId);
      if (filters.actor) query = query.eq("actor_id", filters.actor);
      if (filters.from) query = query.gte("created_at", filters.from);
      if (filters.to) query = query.lte("created_at", filters.to);
      if (cursor) {
        query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
      }
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      const items = (data ?? []).slice(0, limit);
      const nextCursor = (data ?? []).length > limit
        ? Buffer.from(JSON.stringify({ createdAt: items[items.length - 1].created_at, id: items[items.length - 1].id }), "utf8").toString("base64url")
        : null;
      return { items, nextCursor };
    },

    async insertSecret(row) {
      const { data, error } = await pods(user).from("secrets").insert(row).select("*").single();
      if (error) {
        if (error.code === "23505") throw new VaultError("CONFLICT", `A secret named "${row.name}" already exists.`);
        throw new HttpError(500, "internal_error", error.message);
      }
      return data;
    },

    async getSecretById(id) {
      const { data, error } = await pods(user).from("secrets").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async updateSecret(id, patch) {
      const { data, error } = await pods(user).from("secrets").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async listSecrets({ projectId, limit = 25, cursor = null }) {
      let query = pods(user)
        .from("secrets")
        .select("id, project_id, name, description, kind, current_version, last_rotated_at, expires_at, fingerprint, version, created_at")
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      if (cursor) {
        query = query.or(`created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`);
      }
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    // Server vault path (service role): version writes and envelope reads.
    async insertSecretVersion(row) {
      const client = await requireService("write");
      const payload = {
        ...row,
        ciphertext: toHex(row.ciphertext),
        iv: toHex(row.iv),
        auth_tag: toHex(row.auth_tag),
        wrapped_dek: toHex(row.wrapped_dek),
      };
      const { data, error } = await pods(client).from("secret_versions").insert(payload).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return fromHexRow(data);
    },

    async getSecretVersion(secretId, version) {
      const { data, error } = await pods(user)
        .from("secret_versions")
        .select("secret_id, version, kek_id, created_at, disabled_at")
        .eq("secret_id", secretId)
        .eq("version", version)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async getSecretVersionEnvelope(secretId, version) {
      const client = await requireService("read");
      const { data, error } = await pods(client)
        .from("secret_versions")
        .select("*")
        .eq("secret_id", secretId)
        .eq("version", version)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return fromHexRow(data);
    },

    async listSecretVersions(secretId) {
      const { data, error } = await pods(user)
        .from("secret_versions")
        .select("secret_id, version, kek_id, created_at, disabled_at")
        .eq("secret_id", secretId)
        .order("version", { ascending: false });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async updateSecretVersion(secretId, version, patch) {
      const client = await requireService("write");
      const { data, error } = await pods(client)
        .from("secret_versions")
        .update(patch)
        .eq("secret_id", secretId)
        .eq("version", version)
        .select("secret_id, version, kek_id, created_at, disabled_at")
        .single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    // S04 extension: vault secret refs held by integration backend_auth /
    // function / aws configs and client-certificate rows. Only missing-table
    // errors (migrations not yet applied) read as zero refs; any other
    // failure is rethrown so deletes fail closed instead of reading "unused".
    async countSecretReferences(secretId) {
      try {
        let count = 0;
        const needle = `secret:${secretId}`;
        const { data: integrations, error: integrationsError } = await pods(user)
          .from("integrations")
          .select("backend_auth, function, aws")
          .is("deleted_at", null);
        if (integrationsError) throw integrationsError;
        for (const row of integrations ?? []) {
          const refs = [
            row.backend_auth?.secretRef,
            row.function?.secretRef,
            row.function?.credentialsRef,
            row.aws?.roleSecretRef,
          ].filter(Boolean);
          if (refs.some((ref) => String(ref).split("@")[0] === needle)) count += 1;
        }
        const { data: certs, error: certsError } = await pods(user)
          .from("client_certificates")
          .select("private_key_ref")
          .is("deleted_at", null);
        if (certsError) throw certsError;
        for (const row of certs ?? []) {
          if (String(row.private_key_ref ?? "").split("@")[0] === needle) count += 1;
        }
        return count;
      } catch (error) {
        const code = error?.code;
        if (code === "42P01" || code === "PGRST205") return 0;
        throw error;
      }
    },

    async listRoleGrants({ projectId }) {
      const { data: grants, error } = await pods(user)
        .from("role_grants")
        .select("id, project_id, user_id, role_id, scope, status, created_at")
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      const roleIds = [...new Set((grants ?? []).map((grant) => grant.role_id))];
      const rolesById = new Map();
      if (roleIds.length > 0) {
        const { data: roles, error: rolesError } = await user.schema("public")
          .from("roles")
          .select("id, key, name")
          .in("id", roleIds);
        if (rolesError) throw new HttpError(500, "internal_error", rolesError.message);
        for (const role of roles ?? []) rolesById.set(role.id, role);
      }
      return (grants ?? []).map((grant) => ({
        ...toGrant(grant),
        roleKey: rolesById.get(grant.role_id)?.key ?? null,
        roleName: rolesById.get(grant.role_id)?.name ?? null,
        createdAt: grant.created_at,
      }));
    },

    async getRoleByKey({ projectId, roleKey }) {
      const { data, error } = await user.schema("public")
        .from("roles")
        .select("id, key, name, permissions")
        .eq("project_id", projectId)
        .eq("key", roleKey)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ? toRole(data) : null;
    },

    async getRoleGrantById({ grantId }) {
      const { data, error } = await pods(user)
        .from("role_grants")
        .select("id, project_id, user_id, role_id, scope, status")
        .eq("id", grantId)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ? toGrant(data) : null;
    },

    async grantRole({ projectId, userId, roleKey, scope }) {
      const { data, error } = await pods(user).rpc("grant_role", {
        p_project: projectId,
        p_user: userId,
        p_role_key: roleKey,
        p_scope: scope ?? {},
      });
      if (error) throw new HttpError(403, "forbidden", error.message);
      return { id: data, projectId, userId, roleKey, scope: scope ?? {} };
    },

    async revokeGrant({ grantId }) {
      const { error } = await pods(user).rpc("revoke_grant", { p_grant_id: grantId });
      if (error) throw new HttpError(404, "not_found", error.message);
      return { id: grantId, revoked: true };
    },

    // --- S03 catalog: APIs, REST resources/methods, HTTP/WS routes ---
    // Services enforce permissions and draft invariants; the unique
    // partial indexes in supabase/migrations/catalog back them. Unique
    // violations surface as 409 conflict, like the service prechecks.
    async listApis({ projectId, limit = 25, cursor = null }) {
      let query = pods(user)
        .from("apis")
        .select("*")
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      if (cursor) {
        query = query.or(`created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`);
      }
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getApiByRef({ projectId, ref }) {
      if (typeof ref !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(ref)) return null;
      const { data, error } = await pods(user)
        .from("apis")
        .select("*")
        .eq("project_id", projectId)
        .or(`id.eq.${ref},public_id.eq.${ref}`)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async getApiByName({ projectId, name }) {
      const { data, error } = await pods(user)
        .from("apis")
        .select("*")
        .eq("project_id", projectId)
        .eq("name", name)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertApi(row) {
      try {
        const { data, error } = await pods(user).from("apis").insert(row).select("*").single();
        if (error) throw error;
        return data;
      } catch (error) {
        throw mapUnique(error, "An API with this name already exists.");
      }
    },

    async updateApi({ id, patch }) {
      try {
        const { data, error } = await pods(user).from("apis").update(patch).eq("id", id).select("*").single();
        if (error) throw error;
        return data;
      } catch (error) {
        throw mapUnique(error, "An API with this name already exists.");
      }
    },

    async softDeleteApi({ id, version }) {
      const { data, error } = await pods(user)
        .from("apis")
        .update({ deleted_at: new Date().toISOString(), version })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async listResources({ apiId, limit = 25, cursor = null }) {
      let query = pods(user)
        .from("rest_resources")
        .select("*")
        .eq("api_id", apiId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      if (cursor) {
        query = query.or(`created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`);
      }
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async listResourcesByApi({ apiId }) {
      const { data, error } = await pods(user)
        .from("rest_resources")
        .select("*")
        .eq("api_id", apiId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getResourceById({ id }) {
      const { data, error } = await pods(user)
        .from("rest_resources")
        .select("*")
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async getResourceByPath({ apiId, path }) {
      const { data, error } = await pods(user)
        .from("rest_resources")
        .select("*")
        .eq("api_id", apiId)
        .eq("path", path)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async listChildResources({ apiId, parentId }) {
      let query = pods(user)
        .from("rest_resources")
        .select("*")
        .eq("api_id", apiId)
        .is("deleted_at", null);
      query = parentId === null || parentId === undefined
        ? query.is("parent_id", null)
        : query.eq("parent_id", parentId);
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async insertResource(row) {
      try {
        const { data, error } = await pods(user).from("rest_resources").insert(row).select("*").single();
        if (error) throw error;
        return data;
      } catch (error) {
        throw mapUnique(error, "A resource with this path already exists.");
      }
    },

    async updateResource({ id, patch }) {
      try {
        const { data, error } = await pods(user).from("rest_resources").update(patch).eq("id", id).select("*").single();
        if (error) throw error;
        return data;
      } catch (error) {
        throw mapUnique(error, "A resource with this path already exists.");
      }
    },

    async deleteResources({ ids }) {
      if (!ids || ids.length === 0) return 0;
      const { error, count } = await pods(user)
        .from("rest_resources")
        .update({ deleted_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return count ?? ids.length;
    },

    async listMethodsByApi({ apiId }) {
      const { data, error } = await pods(user)
        .from("rest_methods")
        .select("*")
        .eq("api_id", apiId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getMethod({ resourceId, httpMethod }) {
      const { data, error } = await pods(user)
        .from("rest_methods")
        .select("*")
        .eq("resource_id", resourceId)
        .eq("http_method", httpMethod)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertMethod(row) {
      try {
        const { data, error } = await pods(user).from("rest_methods").insert(row).select("*").single();
        if (error) throw error;
        return data;
      } catch (error) {
        throw mapUnique(error, "This method already exists on the resource.");
      }
    },

    async updateMethod({ id, patch }) {
      try {
        const { data, error } = await pods(user).from("rest_methods").update(patch).eq("id", id).select("*").single();
        if (error) throw error;
        return data;
      } catch (error) {
        throw mapUnique(error, "This method already exists on the resource.");
      }
    },

    async deleteMethods({ ids }) {
      if (!ids || ids.length === 0) return 0;
      const { error, count } = await pods(user)
        .from("rest_methods")
        .update({ deleted_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return count ?? ids.length;
    },

    async listRoutes({ apiId, limit = 25, cursor = null }) {
      let query = pods(user)
        .from("http_routes")
        .select("*")
        .eq("api_id", apiId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      if (cursor) {
        query = query.or(`created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`);
      }
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async listRoutesByApi({ apiId }) {
      const { data, error } = await pods(user)
        .from("http_routes")
        .select("*")
        .eq("api_id", apiId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getRouteById({ id }) {
      const { data, error } = await pods(user)
        .from("http_routes")
        .select("*")
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async getRouteByKey({ apiId, routeKey }) {
      const { data, error } = await pods(user)
        .from("http_routes")
        .select("*")
        .eq("api_id", apiId)
        .eq("route_key", routeKey)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertRoute(row) {
      try {
        const { data, error } = await pods(user).from("http_routes").insert(row).select("*").single();
        if (error) throw error;
        return data;
      } catch (error) {
        throw mapUnique(error, "A route with this key already exists.");
      }
    },

    async updateRoute({ id, patch }) {
      try {
        const { data, error } = await pods(user).from("http_routes").update(patch).eq("id", id).select("*").single();
        if (error) throw error;
        return data;
      } catch (error) {
        throw mapUnique(error, "A route with this key already exists.");
      }
    },

    async deleteRoute({ id }) {
      const { error } = await pods(user)
        .from("http_routes")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return { id, deleted: true };
    },

    // --- S04 integrations: configs, responses, connectors, client certificates ---
    // pods.apis is S03-owned (uuid PK plus public_id); api refs resolve either way.

    async getApiProtocol({ projectId, apiId }) {
      if (typeof apiId !== "string" || apiId.length === 0) return null;
      const safe = /^[A-Za-z0-9-]{1,64}$/.test(apiId) ? apiId : null;
      if (!safe) return null;
      const { data, error } = await pods(user)
        .from("apis")
        .select("id, project_id, protocol")
        .eq("project_id", projectId)
        .or(`id.eq.${safe},public_id.eq.${safe}`)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) {
        if (error.code === "42P01") return null;
        throw new HttpError(500, "internal_error", error.message);
      }
      return data?.protocol ?? null;
    },

    async listIntegrations({ apiId, limit = 25, cursor = null }) {
      let query = pods(user)
        .from("integrations")
        .select("*")
        .eq("api_id", apiId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      if (cursor) {
        query = query.or(`created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`);
      }
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getIntegrationById(id) {
      const { data, error } = await pods(user).from("integrations").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertIntegration(row) {
      const { data, error } = await pods(user).from("integrations").insert(row).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async updateIntegration(id, patch) {
      const { data, error } = await pods(user).from("integrations").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteIntegration(id) {
      const { error } = await pods(user).from("integrations").update({ deleted_at: new Date().toISOString() }).eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return { id, deleted: true };
    },

    async listIntegrationResponses({ integrationId }) {
      const { data, error } = await pods(user)
        .from("integration_responses")
        .select("*")
        .eq("integration_id", integrationId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getIntegrationResponseById(id) {
      const { data, error } = await pods(user).from("integration_responses").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertIntegrationResponse(row) {
      const { data, error } = await pods(user).from("integration_responses").insert(row).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteIntegrationResponse(id) {
      const { error } = await pods(user).from("integration_responses").update({ deleted_at: new Date().toISOString() }).eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return { id, deleted: true };
    },

    async listConnectors({ projectId, limit = 25, cursor = null }) {
      let query = pods(user)
        .from("connectors")
        .select("*")
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      if (cursor) {
        query = query.or(`created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`);
      }
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getConnectorById(id) {
      const { data, error } = await pods(user).from("connectors").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertConnector(row) {
      try {
        const { data, error } = await pods(user).from("connectors").insert(row).select("*").single();
        if (error) throw error;
        return data;
      } catch (error) {
        throw mapUnique(error, "A connector with this name already exists.");
      }
    },

    async updateConnector(id, patch) {
      try {
        const { data, error } = await pods(user).from("connectors").update(patch).eq("id", id).select("*").single();
        if (error) throw error;
        return data;
      } catch (error) {
        throw mapUnique(error, "A connector with this name already exists.");
      }
    },

    async deleteConnector(id) {
      const { error } = await pods(user).from("connectors").update({ deleted_at: new Date().toISOString() }).eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return { id, deleted: true };
    },

    async listConnectorTokens(connectorId) {
      const { data, error } = await pods(user)
        .from("connector_tokens")
        .select("id, connector_id, prefix, created_by, created_at, revoked_at")
        .eq("connector_id", connectorId)
        .order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getConnectorTokenById(id) {
      const { data, error } = await pods(user)
        .from("connector_tokens")
        .select("id, connector_id, prefix, created_by, created_at, revoked_at")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async getConnectorTokenByHash(tokenHash) {
      const client = service ?? user;
      const { data, error } = await pods(client)
        .from("connector_tokens")
        .select("id, connector_id, prefix, created_at, revoked_at")
        .eq("token_hash", tokenHash)
        .is("revoked_at", null)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertConnectorToken(row) {
      const client = service ?? user;
      const { data, error } = await pods(client)
        .from("connector_tokens")
        .insert(row)
        .select("id, connector_id, prefix, created_by, created_at, revoked_at")
        .single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async updateConnectorToken(id, patch) {
      const client = service ?? user;
      const { data, error } = await pods(client)
        .from("connector_tokens")
        .update(patch)
        .eq("id", id)
        .select("id, connector_id, prefix, created_by, created_at, revoked_at")
        .single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async listClientCertificates({ projectId }) {
      const { data, error } = await pods(user)
        .from("client_certificates")
        .select("*")
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getClientCertificateById(id) {
      const { data, error } = await pods(user).from("client_certificates").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertClientCertificate(row) {
      const { data, error } = await pods(user).from("client_certificates").insert(row).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteClientCertificate(id) {
      const { error } = await pods(user).from("client_certificates").update({ deleted_at: new Date().toISOString() }).eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return { id, deleted: true };
    },

    // S05 stages reference client certificates; until then nothing does.
    async countClientCertReferences() {
      return 0;
    },

    // Cross-instance deploy lock (F21): a lease row claimed through
    // `pods.acquire_deploy_lock`. Returns `false` when another holder owns an
    // unexpired lease, or `{ release }` when acquired. A missing function
    // (migration not applied) returns undefined so callers fall back to the
    // in-process lock.
    async advisoryLock({ apiId, ttlSeconds = 60 }) {
      const holder = randomUUID();
      const { data, error } = await pods(user).rpc("acquire_deploy_lock", { p_api: apiId, p_holder: holder, p_ttl_seconds: ttlSeconds });
      if (error) {
        if (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202") return undefined;
        throw new HttpError(500, "internal_error", error.message);
      }
      if (data !== true) return false;
      return {
        async release() {
          await pods(user).rpc("release_deploy_lock", { p_api: apiId, p_holder: holder });
        },
      };
    },
  };
}

function toHex(bytes) {
  return `\\x${Buffer.from(bytes).toString("hex")}`;
}

/** Maps Postgres unique violations to 409 conflict; anything else is a 500. */
function mapUnique(error, message) {
  if (error instanceof HttpError) {
    if (error.status === 409) return error;
    return error;
  }
  if (error && error.code === "23505") {
    return new HttpError(409, "conflict", message);
  }
  if (error && error.code === "PGRST116") {
    return new HttpError(404, "not_found", "The row no longer exists.");
  }
  return new HttpError(500, "internal_error", error?.message ?? "Database request failed.");
}

function fromHexRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const key of ["ciphertext", "iv", "auth_tag", "wrapped_dek"]) {
    if (typeof out[key] === "string" && out[key].startsWith("\\x")) {
      out[key] = Buffer.from(out[key].slice(2), "hex");
    }
  }
  return out;
}
