/**
 * In-memory fake of the S13 control db port (catalog + integrations +
 * processing + releases + distribution). Extends the S05 fake with models,
 * authorizers, gateway responses and the documentation tables, mirroring
 * the unique indexes the Postgres migrations enforce.
 */

import { randomUUID } from "node:crypto";
import { HttpError } from "../../lib/control/errors.mjs";

function encodeTime(seq) {
  return new Date(Date.UTC(2026, 9, 13, 0, 0, 0, seq % 60)).toISOString();
}

export function createFakeDb(options = {}) {
  const { roles = {} } = options;
  let bindings = options.bindings ?? null;
  let seq = 0;
  const stamp = () => {
    seq += 1;
    return encodeTime(seq);
  };
  const apis = new Map();
  const resources = new Map();
  const methods = new Map();
  const routes = new Map();
  const integrations = new Map();
  const models = new Map();
  const authorizers = new Map();
  const gatewayResponses = new Map();
  const deployments = new Map();
  const stages = new Map();
  const docParts = new Map();
  const docVersions = new Map();
  const history = [];
  const audits = [];

  return {
    audits,
    history,
    _maps: { apis, resources, methods, routes, integrations, models, deployments, stages, docParts, docVersions },
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
      const now = stamp();
      const full = {
        id: randomUUID(), version: 1, created_at: now, updated_at: now, deleted_at: null,
        api_key_source: "HEADER", binary_media_types: [], minimum_compression_size: null,
        missing_route_behavior: "aws", cors: null, resource_policy: null,
        route_selection_expression: null, api_key_selection_expression: null,
        ...row,
      };
      apis.set(full.id, full);
      return { ...full };
    },
    async updateApi({ id, patch }) {
      const row = apis.get(id);
      if (!row) throw new HttpError(404, "not_found", "API does not exist.");
      const next = { ...row, ...patch, updated_at: stamp() };
      apis.set(id, next);
      return { ...next };
    },
    // --- catalog rows ---
    async listResourcesByApi({ apiId }) {
      return [...resources.values()].filter((row) => row.api_id === apiId && !row.deleted_at).map((row) => ({ ...row }));
    },
    async listChildResources({ apiId, parentId }) {
      return [...resources.values()].filter((row) => row.api_id === apiId && row.parent_id === parentId && !row.deleted_at).map((row) => ({ ...row }));
    },
    async getResourceById({ id }) {
      const row = resources.get(id);
      return row && !row.deleted_at ? { ...row } : null;
    },
    async insertResource(row) {
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, deleted_at: null, ...row };
      resources.set(full.id, full);
      return { ...full };
    },
    async updateResource({ id, patch }) {
      const row = resources.get(id);
      if (!row) throw new HttpError(404, "not_found", "Resource does not exist.");
      const next = { ...row, ...patch, updated_at: stamp() };
      resources.set(id, next);
      return { ...next };
    },
    async deleteResources({ ids }) {
      for (const id of ids) {
        const row = resources.get(id);
        if (row) resources.set(id, { ...row, deleted_at: stamp() });
      }
      return { deleted: ids.length };
    },
    async listMethodsByApi({ apiId }) {
      return [...methods.values()].filter((row) => row.api_id === apiId && !row.deleted_at).map((row) => ({ ...row }));
    },
    async insertMethod(row) {
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, deleted_at: null, ...row };
      methods.set(full.id, full);
      return { ...full };
    },
    async getMethod({ resourceId, httpMethod }) {
      for (const row of methods.values()) {
        if (!row.deleted_at && row.resource_id === resourceId && row.http_method === httpMethod) return { ...row };
      }
      return null;
    },
    async updateMethod({ id, patch }) {
      const row = methods.get(id);
      if (!row) throw new HttpError(404, "not_found", "Method does not exist.");
      const next = { ...row, ...patch, updated_at: stamp() };
      methods.set(id, next);
      return { ...next };
    },
    async deleteMethods({ ids }) {
      for (const id of ids) {
        const row = methods.get(id);
        if (row) methods.set(id, { ...row, deleted_at: stamp() });
      }
      return { deleted: ids.length };
    },
    async listRoutesByApi({ apiId }) {
      return [...routes.values()].filter((row) => row.api_id === apiId && !row.deleted_at).map((row) => ({ ...row }));
    },
    async insertRoute(row) {
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, deleted_at: null, ...row };
      routes.set(full.id, full);
      return { ...full };
    },
    async getRouteByKey({ apiId, routeKey }) {
      for (const row of routes.values()) {
        if (!row.deleted_at && row.api_id === apiId && row.route_key === routeKey) return { ...row };
      }
      return null;
    },
    async getRouteById({ id }) {
      const row = routes.get(id);
      return row && !row.deleted_at ? { ...row } : null;
    },
    async updateRoute({ id, patch }) {
      const row = routes.get(id);
      if (!row) throw new HttpError(404, "not_found", "Route does not exist.");
      const next = { ...row, ...patch, updated_at: stamp() };
      routes.set(id, next);
      return { ...next };
    },
    async deleteRoute({ id }) {
      const row = routes.get(id);
      if (row) routes.set(id, { ...row, deleted_at: stamp() });
      return { id, deleted: true };
    },
    // --- integrations ---
    async getApiProtocol({ projectId, apiId }) {
      const api = [...apis.values()].find((row) => (row.id === apiId || row.public_id === apiId) && row.project_id === projectId && !row.deleted_at);
      return api?.protocol ?? null;
    },
    async listIntegrations({ apiId }) {
      return [...integrations.values()].filter((row) => row.api_id === apiId && !row.deleted_at).map((row) => ({ ...row }));
    },
    async insertIntegration(row) {
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, deleted_at: null, ...row };
      integrations.set(full.id, full);
      return { ...full };
    },
    async deleteIntegration(id) {
      const row = integrations.get(id);
      if (row) integrations.set(id, { ...row, deleted_at: stamp() });
      return { id, deleted: true };
    },
    // --- models / authorizers / gateway responses ---
    async listModels({ projectId, apiId }) {
      return [...models.values()].filter((row) => row.api_id === apiId).map((row) => ({ ...row }));
    },
    async getModel({ projectId, apiId, name }) {
      for (const row of models.values()) {
        if (row.project_id === projectId && String(row.api_id) === String(apiId) && row.name === name) return { ...row };
      }
      return null;
    },
    async insertModel(row) {
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, ...row };
      models.set(full.id, full);
      return { ...full };
    },
    async updateModel({ id, ...patch }) {
      const row = models.get(id);
      if (!row) throw new HttpError(404, "not_found", "Model does not exist.");
      const next = { ...row, ...patch, updated_at: stamp() };
      models.set(id, next);
      return { ...next };
    },
    async deleteModel({ id }) {
      models.delete(id);
      return { id, deleted: true };
    },
    async listAuthorizers({ apiId }) {
      return [...authorizers.values()].filter((row) => row.api_id === apiId).map((row) => ({ ...row }));
    },
    async insertAuthorizer(row) {
      const now = stamp();
      const full = { id: row.id ?? randomUUID(), created_at: now, ...row };
      authorizers.set(full.id, full);
      return { ...full };
    },
    async deleteAuthorizer({ id }) {
      authorizers.delete(id);
      return { id, deleted: true };
    },
    async listRequestValidators() {
      return [];
    },
    async listGatewayResponses({ projectId, apiId }) {
      return [...gatewayResponses.values()].filter((row) => row.api_id === apiId).map((row) => ({ ...row }));
    },
    async insertGatewayResponse(row) {
      const now = stamp();
      const full = { id: randomUUID(), created_at: now, ...row };
      gatewayResponses.set(full.id, full);
      return { ...full };
    },
    async deleteGatewayResponse({ id }) {
      gatewayResponses.delete(id);
      return { id, deleted: true };
    },
    // --- releases ---
    async insertDeployment(row) {
      const now = stamp();
      const full = { id: row.id ?? randomUUID(), created_at: now, ...row };
      deployments.set(full.id, full);
      return { ...full };
    },
    async getDeploymentById(id) {
      const row = deployments.get(id);
      return row ? { ...row } : null;
    },
    async insertStage(row) {
      for (const existing of stages.values()) {
        if (existing.api_id === row.api_id && existing.name === row.name) {
          throw new HttpError(409, "conflict", `A stage named "${row.name}" already exists.`);
        }
      }
      const now = stamp();
      const full = {
        id: randomUUID(), version: 1, created_at: now, updated_at: now,
        description: "", variables: {}, auto_deploy: false, documentation_version: null,
        tags: {}, ...row,
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
    async listStages({ apiId }) {
      return [...stages.values()].filter((row) => row.api_id === apiId).map((row) => ({ ...row }));
    },
    async updateStage({ id, patch }) {
      const row = stages.get(id);
      if (!row) throw new HttpError(404, "not_found", "Stage does not exist.");
      const next = { ...row, ...patch, updated_at: stamp() };
      stages.set(id, next);
      return { ...next };
    },
    async insertStageHistory(row) {
      const full = { id: randomUUID(), created_at: stamp(), ...row };
      history.push(full);
      return { ...full };
    },
    // --- distribution ---
    async listDocumentationParts({ apiId }) {
      return [...docParts.values()].filter((row) => row.api_id === apiId).map((row) => ({ ...row }));
    },
    async getDocumentationPart({ id }) {
      const row = docParts.get(id);
      return row ? { ...row } : null;
    },
    async insertDocumentationPart(row) {
      for (const existing of docParts.values()) {
        if (existing.api_id === row.api_id && existing.location_key === row.location_key) {
          throw new HttpError(409, "conflict", "A documentation part already exists for this location.");
        }
      }
      const now = stamp();
      const full = { version: 1, created_at: now, updated_at: now, ...row };
      docParts.set(full.id, full);
      return { ...full };
    },
    async updateDocumentationPart({ id, patch }) {
      const row = docParts.get(id);
      if (!row) throw new HttpError(404, "not_found", "Documentation part does not exist.");
      const next = { ...row, ...patch, updated_at: stamp() };
      docParts.set(id, next);
      return { ...next };
    },
    async deleteDocumentationPart({ id }) {
      docParts.delete(id);
      return { id, deleted: true };
    },
    async listDocumentationVersions({ apiId }) {
      return [...docVersions.values()].filter((row) => row.api_id === apiId).map((row) => ({ ...row }));
    },
    async getDocumentationVersion({ apiId, version }) {
      for (const row of docVersions.values()) {
        if (row.api_id === apiId && row.version === version) return { ...row };
      }
      return null;
    },
    async insertDocumentationVersion(row) {
      const now = stamp();
      const full = { created_at: now, ...row };
      docVersions.set(full.id, full);
      return { ...full };
    },
  };
}
