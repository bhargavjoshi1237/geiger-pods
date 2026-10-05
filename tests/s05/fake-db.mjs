/**
 * In-memory fake of the S05 control db port (catalog + integrations + releases).
 * Mirrors the unique indexes and soft-delete scoping the Postgres migrations
 * enforce, so service prechecks behave the same.
 */

import { randomUUID } from "node:crypto";
import { HttpError } from "../../lib/control/errors.mjs";

function encodeTime(seq) {
  return new Date(Date.UTC(2026, 9, 8, 0, 0, 0, seq % 60)).toISOString();
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
  const authorizers = new Map();
  const deployments = new Map();
  const stages = new Map();
  const history = [];
  const audits = [];

  return {
    audits,
    history,
    _maps: { apis, resources, methods, routes, integrations, deployments, stages },
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
    async insertApi(row) {
      const now = stamp();
      const full = {
        id: randomUUID(), version: 1, created_at: now, updated_at: now, deleted_at: null,
        api_key_source: "HEADER", binary_media_types: [], minimum_compression_size: null,
        missing_route_behavior: "aws", cors: null, resource_policy: null,
        route_selection_expression: null, ...row,
      };
      apis.set(full.id, full);
      return { ...full };
    },
    // --- catalog rows ---
    async listResourcesByApi({ apiId }) {
      return [...resources.values()].filter((row) => row.api_id === apiId && !row.deleted_at).map((row) => ({ ...row }));
    },
    async listMethodsByApi({ apiId }) {
      return [...methods.values()].filter((row) => row.api_id === apiId && !row.deleted_at).map((row) => ({ ...row }));
    },
    async listRoutesByApi({ apiId }) {
      return [...routes.values()].filter((row) => row.api_id === apiId && !row.deleted_at).map((row) => ({ ...row }));
    },
    async insertResource(row) {
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, deleted_at: null, ...row };
      resources.set(full.id, full);
      return { ...full };
    },
    async insertMethod(row) {
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, deleted_at: null, ...row };
      methods.set(full.id, full);
      return { ...full };
    },
    async insertRoute(row) {
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, deleted_at: null, ...row };
      routes.set(full.id, full);
      return { ...full };
    },
    async deleteRoute({ id }) {
      const row = routes.get(id);
      if (row) routes.set(id, { ...row, deleted_at: stamp() });
      return { id, deleted: true };
    },
    // --- integrations (S04 shape) ---
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
    async listAuthorizers({ apiId }) {
      return [...authorizers.values()].filter((row) => row.api_id === apiId).map((row) => ({ ...row }));
    },
    async insertAuthorizer(row) {
      const now = stamp();
      const full = { id: row.id ?? randomUUID(), created_at: now, ...row };
      authorizers.set(full.id, full);
      return { ...full };
    },
    // --- S06 tables (empty unless tests add) ---
    async listModels() {
      return [];
    },
    async listRequestValidators() {
      return [];
    },
    async listGatewayResponses() {
      return [];
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
    async listDeployments({ apiId, limit = 25 }) {
      return [...deployments.values()]
        .filter((row) => row.api_id === apiId)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
    async deleteDeployment({ id }) {
      deployments.delete(id);
      return { id, deleted: true };
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
        description: "", variables: {}, auto_deploy: false, client_certificate_id: null,
        default_route_settings: {}, route_settings: {}, method_settings: {},
        access_log: null, tracing_enabled: false, cache_cluster_enabled: false,
        cache_cluster_size: null, canary: null, last_deployment_status_message: null,
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
    async deleteStage({ id }) {
      const row = stages.get(id);
      if (!row) throw new HttpError(404, "not_found", "Stage does not exist.");
      stages.delete(id);
      return { id, deleted: true };
    },
    async insertStageHistory(row) {
      const full = { id: randomUUID(), created_at: stamp(), ...row };
      history.push(full);
      return { ...full };
    },
    async listStageHistory({ stageId }) {
      return history.filter((row) => row.stage_id === stageId).map((row) => ({ ...row }));
    },
  };
}
