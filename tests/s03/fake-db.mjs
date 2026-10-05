/**
 * In-memory fake of the S03 catalog db port (plus audit capture), for
 * service unit tests. Mirrors the unique indexes and soft-delete scoping
 * the Postgres migration enforces, so service prechecks behave the same.
 */

import { randomUUID } from "node:crypto";
import { HttpError } from "../../lib/control/errors.mjs";

function conflict(message) {
  return new HttpError(409, "conflict", message);
}

function encodeTime(seq) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, seq)).toISOString();
}

function paginate(rows, { limit = 25, cursor = null }) {
  const sorted = [...rows].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1,
  );
  const after = cursor
    ? sorted.filter((row) => row.created_at > cursor.createdAt || (row.created_at === cursor.createdAt && row.id > cursor.id))
    : sorted;
  return after.slice(0, limit);
}

/**
 * @param {{ roles?: Record<string,string>, bindings?: { roles: Array, grants: Array } }} [options]
 */
export function createFakeDb(options = {}) {
  const { roles = {} } = options;
  let bindings = options.bindings ?? null;
  let seq = 0;
  const stamp = () => {
    seq += 1;
    return encodeTime(seq);
  };
  /** @type {Map<string, object>} */
  const apis = new Map();
  const resources = new Map();
  const methods = new Map();
  const routes = new Map();
  const audits = [];

  function uniqueApiName(projectId, name, exceptId = null) {
    for (const row of apis.values()) {
      if (row.deleted_at || row.project_id !== projectId || row.id === exceptId) continue;
      if (row.name === name) throw conflict(`An API named "${name}" already exists.`);
    }
  }

  function uniqueResourcePath(apiId, path, exceptId = null) {
    for (const row of resources.values()) {
      if (row.deleted_at || row.api_id !== apiId || row.id === exceptId) continue;
      if (row.path === path) throw conflict(`A resource with path "${path}" already exists.`);
    }
  }

  function uniqueMethod(resourceId, httpMethod, exceptId = null) {
    for (const row of methods.values()) {
      if (row.deleted_at || row.resource_id !== resourceId || row.id === exceptId) continue;
      if (row.http_method === httpMethod) throw conflict(`Method ${httpMethod} already exists on this resource.`);
    }
  }

  function uniqueRouteKey(apiId, routeKey, exceptId = null) {
    for (const row of routes.values()) {
      if (row.deleted_at || row.api_id !== apiId || row.id === exceptId) continue;
      if (row.route_key === routeKey) throw conflict(`A route with key "${routeKey}" already exists.`);
    }
  }

  return {
    audits,
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

    // --- apis ---
    async listApis({ projectId, limit = 25, cursor = null }) {
      return paginate(
        [...apis.values()].filter((row) => row.project_id === projectId && !row.deleted_at),
        { limit, cursor },
      );
    },
    async getApiByRef({ projectId, ref }) {
      for (const row of apis.values()) {
        if (row.deleted_at || row.project_id !== projectId) continue;
        if (row.id === ref || row.public_id === ref) return { ...row };
      }
      return null;
    },
    async getApiByName({ projectId, name }) {
      for (const row of apis.values()) {
        if (row.deleted_at || row.project_id !== projectId) continue;
        if (row.name === name) return { ...row };
      }
      return null;
    },
    async insertApi(row) {
      uniqueApiName(row.project_id, row.name);
      for (const existing of apis.values()) {
        if (existing.public_id === row.public_id) throw conflict("Public id collision; retry.");
      }
      const now = stamp();
      const full = {
        id: randomUUID(), version: 1, metadata: {}, created_by: null,
        created_at: now, updated_at: now, deleted_at: null, ...row,
      };
      apis.set(full.id, full);
      return { ...full };
    },
    async updateApi({ id, patch }) {
      const row = apis.get(id);
      if (!row || row.deleted_at) return null;
      if (patch.name !== undefined) uniqueApiName(row.project_id, patch.name, id);
      const next = { ...row, ...patch, updated_at: stamp() };
      apis.set(id, next);
      return { ...next };
    },
    async softDeleteApi({ id, version }) {
      const row = apis.get(id);
      if (!row || row.deleted_at) return null;
      const next = { ...row, deleted_at: stamp(), version, updated_at: stamp() };
      apis.set(id, next);
      return { ...next };
    },

    // --- rest_resources ---
    async listResources({ apiId, limit = 25, cursor = null }) {
      return paginate([...resources.values()].filter((row) => row.api_id === apiId && !row.deleted_at), { limit, cursor });
    },
    async listResourcesByApi({ apiId }) {
      return [...resources.values()].filter((row) => row.api_id === apiId && !row.deleted_at);
    },
    async getResourceById({ id }) {
      const row = resources.get(id);
      return row && !row.deleted_at ? { ...row } : null;
    },
    async getResourceByPath({ apiId, path }) {
      for (const row of resources.values()) {
        if (row.deleted_at || row.api_id !== apiId) continue;
        if (row.path === path) return { ...row };
      }
      return null;
    },
    async listChildResources({ apiId, parentId }) {
      return [...resources.values()].filter(
        (row) => !row.deleted_at && row.api_id === apiId && (row.parent_id ?? null) === (parentId ?? null),
      );
    },
    async insertResource(row) {
      uniqueResourcePath(row.api_id, row.path);
      const now = stamp();
      const full = { id: randomUUID(), version: 1, metadata: {}, created_by: null, created_at: now, updated_at: now, deleted_at: null, ...row };
      resources.set(full.id, full);
      return { ...full };
    },
    async updateResource({ id, patch }) {
      const row = resources.get(id);
      if (!row || row.deleted_at) return null;
      if (patch.path !== undefined) uniqueResourcePath(row.api_id, patch.path, id);
      const next = { ...row, ...patch, updated_at: stamp() };
      resources.set(id, next);
      return { ...next };
    },
    async deleteResources({ ids }) {
      let count = 0;
      for (const id of ids) {
        const row = resources.get(id);
        if (row && !row.deleted_at) {
          resources.set(id, { ...row, deleted_at: stamp() });
          count += 1;
        }
      }
      return count;
    },

    // --- rest_methods ---
    async listMethodsByApi({ apiId }) {
      return [...methods.values()].filter((row) => row.api_id === apiId && !row.deleted_at);
    },
    async getMethod({ resourceId, httpMethod }) {
      for (const row of methods.values()) {
        if (row.deleted_at || row.resource_id !== resourceId) continue;
        if (row.http_method === httpMethod) return { ...row };
      }
      return null;
    },
    async insertMethod(row) {
      uniqueMethod(row.resource_id, row.http_method);
      const now = stamp();
      const full = { id: randomUUID(), version: 1, metadata: {}, created_by: null, created_at: now, updated_at: now, deleted_at: null, ...row };
      methods.set(full.id, full);
      return { ...full };
    },
    async updateMethod({ id, patch }) {
      const row = methods.get(id);
      if (!row || row.deleted_at) return null;
      if (patch.http_method !== undefined) uniqueMethod(row.resource_id, patch.http_method, id);
      const next = { ...row, ...patch, updated_at: stamp() };
      methods.set(id, next);
      return { ...next };
    },
    async deleteMethods({ ids }) {
      let count = 0;
      for (const id of ids) {
        const row = methods.get(id);
        if (row && !row.deleted_at) {
          methods.set(id, { ...row, deleted_at: stamp() });
          count += 1;
        }
      }
      return count;
    },

    // --- http_routes ---
    async listRoutes({ apiId, limit = 25, cursor = null }) {
      return paginate([...routes.values()].filter((row) => row.api_id === apiId && !row.deleted_at), { limit, cursor });
    },
    async listRoutesByApi({ apiId }) {
      return [...routes.values()].filter((row) => row.api_id === apiId && !row.deleted_at);
    },
    async getRouteById({ id }) {
      const row = routes.get(id);
      return row && !row.deleted_at ? { ...row } : null;
    },
    async getRouteByKey({ apiId, routeKey }) {
      for (const row of routes.values()) {
        if (row.deleted_at || row.api_id !== apiId) continue;
        if (row.route_key === routeKey) return { ...row };
      }
      return null;
    },
    async insertRoute(row) {
      uniqueRouteKey(row.api_id, row.route_key);
      const now = stamp();
      const full = { id: randomUUID(), version: 1, metadata: {}, created_by: null, created_at: now, updated_at: now, deleted_at: null, ...row };
      routes.set(full.id, full);
      return { ...full };
    },
    async updateRoute({ id, patch }) {
      const row = routes.get(id);
      if (!row || row.deleted_at) return null;
      if (patch.route_key !== undefined) uniqueRouteKey(row.api_id, patch.route_key, id);
      const next = { ...row, ...patch, updated_at: stamp() };
      routes.set(id, next);
      return { ...next };
    },
    async deleteRoute({ id }) {
      const row = routes.get(id);
      if (!row || row.deleted_at) return null;
      routes.set(id, { ...row, deleted_at: stamp() });
      return { ...row, deleted_at: "deleted" };
    },
  };
}
