/**
 * S11 test helpers: fake control db (domains + WAF tables), ports, artifacts.
 *
 * @module tests/s11/fake-db
 */

import { randomUUID } from "node:crypto";
import { HttpError } from "../../lib/control/errors.mjs";

export const PROJECT = "22222222-2222-4222-8222-222222222222";
export const ADMIN = { type: "user", userId: "u-s11-admin" };

function stampMaker() {
  let seq = 0;
  return () => {
    seq += 1;
    return new Date(Date.UTC(2026, 9, 5, 0, 0, seq % 60)).toISOString();
  };
}

/**
 * Minimal fake db for S11 services: role checks + domain/WAF tables with the
 * same uniqueness rules the Postgres migration enforces.
 */
export function createS11FakeDb(options = {}) {
  const { roles = { "u-s11-admin": "admin" } } = options;
  const stamp = stampMaker();
  const domains = new Map();
  const mappings = new Map();
  const rules = new Map();
  const truststores = new Map();
  const associations = new Map();
  const ipSets = new Map();
  const regexSets = new Map();
  const webAcls = new Map();
  const aclAssocs = new Map();
  const audits = [];
  const apis = new Map();

  async function getInheritedRole({ userId }) {
    return roles[userId] ?? null;
  }

  return {
    audits,
    _maps: { domains, mappings, rules, truststores, ipSets, regexSets, webAcls },
    async getInheritedRole({ userId }) {
      return getInheritedRole({ userId });
    },
    async listRoleBindings() {
      return { roles: [], grants: [] };
    },
    async insertAudit(entry) {
      audits.push(entry);
    },
    // --- domains ---
    async findDomainByNameGlobal({ domainName }) {
      for (const row of domains.values()) {
        if (!row.deleted_at && row.domain_name === domainName) return { ...row };
      }
      return null;
    },
    async insertDomain(row) {
      for (const existing of domains.values()) {
        if (!existing.deleted_at && existing.domain_name === row.domain_name) {
          throw new HttpError(409, "conflict", `A domain named "${row.domain_name}" already exists.`);
        }
      }
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, deleted_at: null, status_message: null, tags: {}, ...row };
      domains.set(full.id, full);
      return { ...full };
    },
    async getDomainById(id) {
      const row = domains.get(id);
      return row ? { ...row } : null;
    },
    async listDomains({ projectId }) {
      return [...domains.values()].filter((row) => row.project_id === projectId && !row.deleted_at).map((row) => ({ ...row }));
    },
    async updateDomain({ id, patch, expectedVersion = null }) {
      const row = domains.get(id);
      if (!row) throw new HttpError(404, "not_found", "Domain does not exist.");
      if (expectedVersion !== null && row.version !== expectedVersion) {
        throw new HttpError(409, "version_conflict", `Domain changed (expected version ${expectedVersion}, found ${row.version}).`);
      }
      const next = { ...row, ...patch, version: row.version + 1, updated_at: stamp() };
      domains.set(id, next);
      return { ...next };
    },
    async deleteDomain({ id }) {
      const row = domains.get(id);
      if (!row) throw new HttpError(404, "not_found", "Domain does not exist.");
      domains.set(id, { ...row, deleted_at: stamp() });
      return { id, deleted: true };
    },
    // --- mappings ---
    async listMappings({ domainId }) {
      return [...mappings.values()].filter((row) => row.domain_id === domainId).map((row) => ({ ...row }));
    },
    async insertMapping(row) {
      for (const existing of mappings.values()) {
        if (existing.domain_id === row.domain_id && existing.base_path === row.base_path) {
          throw new HttpError(409, "conflict", `A mapping for base path "${row.base_path}" already exists.`);
        }
      }
      const full = { id: randomUUID(), created_at: stamp(), ...row };
      mappings.set(full.id, full);
      return { ...full };
    },
    async deleteMapping({ id }) {
      mappings.delete(id);
      return { id, deleted: true };
    },
    // --- routing rules ---
    async listRoutingRules({ domainId }) {
      return [...rules.values()].filter((row) => row.domain_id === domainId).map((row) => ({ ...row }));
    },
    async insertRoutingRule(row) {
      for (const existing of rules.values()) {
        if (existing.domain_id === row.domain_id && existing.priority === row.priority) {
          throw new HttpError(409, "conflict", `A routing rule with priority ${row.priority} already exists.`);
        }
      }
      const full = { id: randomUUID(), created_at: stamp(), ...row };
      rules.set(full.id, full);
      return { ...full };
    },
    async updateRoutingRule({ id, patch }) {
      const row = rules.get(id);
      if (!row) throw new HttpError(404, "not_found", "Routing rule does not exist.");
      const next = { ...row, ...patch };
      rules.set(id, next);
      return { ...next };
    },
    async deleteRoutingRule({ id }) {
      rules.delete(id);
      return { id, deleted: true };
    },
    // --- trust stores ---
    async insertTrustStore(row) {
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, ...row };
      truststores.set(full.id, full);
      return { ...full };
    },
    async getTrustStoreById(id) {
      const row = truststores.get(id);
      return row ? { ...row } : null;
    },
    async listTrustStores({ projectId }) {
      return [...truststores.values()].filter((row) => row.project_id === projectId).map((row) => ({ ...row }));
    },
    async updateTrustStore({ id, patch }) {
      const row = truststores.get(id);
      if (!row) throw new HttpError(404, "not_found", "Trust store does not exist.");
      const next = { ...row, ...patch, version: row.version + 1, updated_at: stamp() };
      truststores.set(id, next);
      return { ...next };
    },
    async deleteTrustStore({ id }) {
      truststores.delete(id);
      return { id, deleted: true };
    },
    // --- access associations ---
    async listAccessAssociations({ domainId }) {
      return [...associations.values()].filter((row) => row.domain_id === domainId).map((row) => ({ ...row }));
    },
    async insertAccessAssociation(row) {
      const full = { id: randomUUID(), created_at: stamp(), ...row };
      associations.set(full.id, full);
      return { ...full };
    },
    async deleteAccessAssociation({ id }) {
      associations.delete(id);
      return { id, deleted: true };
    },
    // --- WAF ---
    async insertIpSet(row) {
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, ...row };
      ipSets.set(full.id, full);
      return { ...full };
    },
    async getIpSetById(id) {
      const row = ipSets.get(id);
      return row ? { ...row } : null;
    },
    async listIpSets({ projectId }) {
      return [...ipSets.values()].filter((row) => row.project_id === projectId).map((row) => ({ ...row }));
    },
    async updateIpSet({ id, patch }) {
      const row = ipSets.get(id);
      if (!row) throw new HttpError(404, "not_found", "IP set does not exist.");
      const next = { ...row, ...patch, version: row.version + 1, updated_at: stamp() };
      ipSets.set(id, next);
      return { ...next };
    },
    async insertRegexSet(row) {
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, ...row };
      regexSets.set(full.id, full);
      return { ...full };
    },
    async getRegexSetById(id) {
      const row = regexSets.get(id);
      return row ? { ...row } : null;
    },
    async listRegexSets({ projectId }) {
      return [...regexSets.values()].filter((row) => row.project_id === projectId).map((row) => ({ ...row }));
    },
    async insertWebAcl(row) {
      const now = stamp();
      const full = { id: randomUUID(), version: 1, created_at: now, updated_at: now, ...row };
      webAcls.set(full.id, full);
      return { ...full };
    },
    async getWebAclById(id) {
      const row = webAcls.get(id);
      return row ? { ...row } : null;
    },
    async listWebAcls({ projectId }) {
      return [...webAcls.values()].filter((row) => row.project_id === projectId).map((row) => ({ ...row }));
    },
    async updateWebAcl({ id, patch, expectedVersion = null }) {
      const row = webAcls.get(id);
      if (!row) throw new HttpError(404, "not_found", "Web ACL does not exist.");
      if (expectedVersion !== null && row.version !== expectedVersion) {
        throw new HttpError(409, "version_conflict", `Web ACL changed (expected version ${expectedVersion}, found ${row.version}).`);
      }
      const next = { ...row, ...patch, version: row.version + 1, updated_at: stamp() };
      webAcls.set(id, next);
      return { ...next };
    },
    async listAclAssociations({ webAclId = null, apiId = null } = {}) {
      return [...aclAssocs.values()]
        .filter((row) => (webAclId === null || row.web_acl_id === webAclId) && (apiId === null || row.api_id === apiId))
        .map((row) => ({ ...row }));
    },
    async insertAclAssociation(row) {
      for (const existing of aclAssocs.values()) {
        if (existing.api_id === row.api_id && existing.stage_name === row.stage_name) {
          throw new HttpError(409, "conflict", `Stage "${row.stage_name}" already has a web ACL.`);
        }
      }
      const full = { id: randomUUID(), created_at: stamp(), ...row };
      aclAssocs.set(full.id, full);
      return { ...full };
    },
    async deleteAclAssociation({ id }) {
      aclAssocs.delete(id);
      return { id, deleted: true };
    },
    // --- generic API lookup (wired by tests when needed) ---
    async getApiByRef({ projectId, ref }) {
      for (const row of apis.values()) {
        if (projectId && row.project_id !== projectId) continue;
        if (row.id === ref || row.public_id === ref) return { ...row };
      }
      return null;
    },
    /** Test seam: seed an API row the mapping ownership check resolves. */
    async seedApi(row) {
      const full = { id: randomUUID(), project_id: PROJECT, public_id: null, endpoint_type: "REGIONAL", ...row };
      apis.set(full.id, full);
      return { ...full };
    },
    // --- stacks (S14 registry reads; S11 kinds plan from desired state) ---
    async listStackResources() {
      return { apis: [], domains: [], waf: [] };
    },
  };
}
