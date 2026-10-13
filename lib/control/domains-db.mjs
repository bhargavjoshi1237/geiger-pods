/**
 * Supabase adapter for the S11 domain + WAF tables (production path).
 *
 * `createControlDb` (S02, shared) has no domain/WAF methods, so the
 * management routes under `domains/`, `truststores/` and `waf/` failed with
 * "db.X is not a function" in production. `withDomainTables(db, client)`
 * attaches them; `tests/s11/fake-db.mjs` is the behavioural contract.
 *
 * - Reads/writes go through RLS as the caller (`client`); every table has a
 *   `for all to authenticated` policy keyed on `pods.domain.write`,
 *   `pods.trust_store.write` or `pods.waf.write`.
 * - `findDomainByNameGlobal` uses `options.service` when given: domain names
 *   are globally unique across projects (partial unique index), but RLS hides
 *   other projects' rows, so the user client cannot see a clash. It selects
 *   identity columns only. Without a service client it falls back to the user
 *   client and the unique index still turns a clash into a 409 on insert.
 * - Only `domain_names` is soft-deleted (`deleted_at`); every other table is
 *   hard-deleted, as in the fake.
 * - `version` is not bumped by a trigger (`pods.touch_updated_at` only sets
 *   `updated_at`), so versioned updates bump it here with a compare-and-set on
 *   the current version (409 `version_conflict` on a lost race).
 * - Writes send only columns the migration defines. `certificate_key_pem`
 *   (passed by the domain service) has no column: the schema keeps the key
 *   behind `certificate_key_ref` (vault), so the PEM is never persisted here.
 * - List methods return bare arrays (the services wrap `{ items }`).
 *
 * @module lib/control/domains-db
 */

import { HttpError } from "./errors.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = {
  domain_names: [
    "project_id", "domain_name", "endpoint_type", "ip_address_type", "security_policy",
    "certificate_mode", "certificate_chain_pem", "certificate_key_ref", "certificate_expires_at",
    "verification_token", "status", "status_message", "target_hostname", "routing_mode",
    "mtls", "policy", "tags", "created_by", "deleted_at",
  ],
  api_mappings: ["domain_id", "api_id", "stage_name", "base_path"],
  routing_rules: ["domain_id", "priority", "conditions", "action"],
  trust_stores: ["project_id", "name", "pem_bundle", "cert_count", "warnings", "crl_pem", "versions", "created_by"],
  domain_access_associations: ["domain_id", "connector_id"],
  ip_sets: ["project_id", "name", "ip_version", "addresses", "created_by"],
  regex_sets: ["project_id", "name", "patterns", "created_by"],
  web_acls: ["project_id", "name", "default_action", "rules", "custom_responses", "visibility", "created_by"],
  web_acl_associations: ["project_id", "web_acl_id", "api_id", "stage_name"],
};

/** Highest routing-rule priority the migration's check constraint allows. */
const MAX_PRIORITY = 1000000;

function pods(client) {
  return client.schema("pods");
}

function fail(message, status = 500, code = "internal_error") {
  throw new HttpError(status, code, message);
}

function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Keeps only the table's real columns. A null/undefined `created_by` is
 * dropped so the column default (`auth.uid()`) applies.
 */
function pick(table, row) {
  const out = {};
  for (const column of COLUMNS[table]) {
    if (row?.[column] === undefined) continue;
    if (column === "created_by" && row[column] === null) continue;
    out[column] = row[column];
  }
  return out;
}

function mapError(error, { conflictMessage = null, notFoundMessage = null } = {}) {
  if (error.code === "PGRST116" && notFoundMessage) fail(notFoundMessage, 404, "not_found");
  if (error.code === "23505") fail(conflictMessage ?? "Duplicate value violates a uniqueness constraint.", 409, "conflict");
  // 22P02: invalid text representation (e.g. a CIDR with host bits set).
  if (error.code === "22P02") fail(`Invalid request: ${error.message}`, 422, "invalid_input");
  fail(error.message);
}

async function one(query, options = {}) {
  const { data, error } = await query;
  if (error) mapError(error, options);
  return data;
}

async function many(query) {
  const { data, error } = await query;
  if (error) fail(error.message);
  return data ?? [];
}

/**
 * Attaches the S11 domain/WAF store to a control `db` object.
 *
 * @param {object} db - The request-scoped control db (permissions, audit, vault, APIs).
 * @param {object} client - A Supabase server client for the caller (RLS applies).
 * @param {{ service?: object|null }} [options={}] - `service`: optional service-role client,
 *   used only for the cross-project domain-name lookup.
 * @returns {object} `db` plus the S11 table methods.
 */
export function withDomainTables(db, client, options = {}) {
  if (!client) return db;
  const store = pods(client);
  const service = options.service ?? null;

  async function byId(table, id) {
    if (!isUuid(id)) return null;
    return one(store.from(table).select("*").eq("id", id).maybeSingle());
  }

  function listByProject(table, projectId) {
    return many(store.from(table).select("*").eq("project_id", projectId)
      .order("created_at", { ascending: true }).order("id", { ascending: true }));
  }

  async function hardDelete(table, id, scope = {}) {
    if (!isUuid(id)) return { id, deleted: true };
    let query = store.from(table).delete().eq("id", id);
    for (const [column, value] of Object.entries(scope)) {
      if (value !== undefined && value !== null) query = query.eq(column, value);
    }
    const { error } = await query;
    if (error) fail(error.message);
    return { id, deleted: true };
  }

  /**
   * Versioned update: compare-and-set on `version`, bumping it by one.
   * Without `expectedVersion` it reads the current version and retries a
   * lost race a few times before reporting a conflict.
   */
  async function versionedUpdate(table, { id, patch, expectedVersion = null, label, conflictMessage = null }) {
    const notFound = `${label} does not exist.`;
    const clean = pick(table, patch);
    const attempts = expectedVersion === null ? 3 : 1;
    let found = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let base = expectedVersion;
      if (base === null) {
        const current = await byId(table, id);
        if (!current) fail(notFound, 404, "not_found");
        base = current.version;
      } else if (!isUuid(id)) {
        fail(notFound, 404, "not_found");
      }
      const data = await one(store.from(table).update({ ...clean, version: base + 1 })
        .eq("id", id).eq("version", base).select("*").maybeSingle(), { conflictMessage });
      if (data) return data;
      found = await byId(table, id);
      if (!found) fail(notFound, 404, "not_found");
    }
    const expected = expectedVersion ?? found.version;
    throw new HttpError(409, "version_conflict", `${label} changed (expected version ${expected}, found ${found.version}).`);
  }

  return {
    ...db,

    // --- domain_names (soft delete) ---
    async findDomainByNameGlobal({ domainName }) {
      const reader = pods(service ?? client);
      return one(reader.from("domain_names").select("id, project_id, domain_name, status, created_at")
        .eq("domain_name", domainName).is("deleted_at", null).limit(1).maybeSingle());
    },
    async insertDomain(row) {
      return one(store.from("domain_names").insert(pick("domain_names", row)).select("*").single(),
        { conflictMessage: `A domain named "${row.domain_name}" already exists.` });
    },
    async getDomainById(id) {
      // Soft-deleted rows are returned; the service checks `deleted_at`.
      return byId("domain_names", id);
    },
    async listDomains({ projectId }) {
      return many(store.from("domain_names").select("*").eq("project_id", projectId).is("deleted_at", null)
        .order("created_at", { ascending: true }).order("id", { ascending: true }));
    },
    async updateDomain({ id, patch, expectedVersion = null }) {
      return versionedUpdate("domain_names", { id, patch, expectedVersion, label: "Domain" });
    },
    async deleteDomain({ id }) {
      if (!isUuid(id)) fail("Domain does not exist.", 404, "not_found");
      const data = await one(store.from("domain_names").update({ deleted_at: new Date().toISOString() })
        .eq("id", id).select("id").maybeSingle());
      if (!data) fail("Domain does not exist.", 404, "not_found");
      return { id, deleted: true };
    },

    // --- api_mappings ---
    async listMappings({ domainId }) {
      if (!isUuid(domainId)) return [];
      return many(store.from("api_mappings").select("*").eq("domain_id", domainId)
        .order("created_at", { ascending: true }).order("id", { ascending: true }));
    },
    async insertMapping(row) {
      return one(store.from("api_mappings").insert(pick("api_mappings", row)).select("*").single(),
        { conflictMessage: `A mapping for base path "${row.base_path}" already exists.` });
    },
    async deleteMapping({ id, domainId = null }) {
      return hardDelete("api_mappings", id, { domain_id: domainId });
    },

    // --- routing_rules ---
    async listRoutingRules({ domainId }) {
      if (!isUuid(domainId)) return [];
      return many(store.from("routing_rules").select("*").eq("domain_id", domainId)
        .order("priority", { ascending: true }));
    },
    async insertRoutingRule(row) {
      return one(store.from("routing_rules").insert(pick("routing_rules", row)).select("*").single(),
        { conflictMessage: `A routing rule with priority ${row.priority} already exists.` });
    },
    /**
     * Updates a rule. `unique (domain_id, priority)` is not deferrable, but
     * the only caller (reorder) renumbers rules one at a time, so a target
     * priority can still be held by a rule that is renumbered later in the
     * same pass. On that clash the holder is parked on a free priority first
     * (the fake has no uniqueness check on update).
     */
    async updateRoutingRule({ id, patch }) {
      if (!isUuid(id)) fail("Routing rule does not exist.", 404, "not_found");
      const clean = pick("routing_rules", patch);
      const run = () => store.from("routing_rules").update(clean).eq("id", id).select("*").maybeSingle();
      let { data, error } = await run();
      if (error?.code === "23505" && clean.priority !== undefined) {
        const current = await byId("routing_rules", id);
        if (!current) fail("Routing rule does not exist.", 404, "not_found");
        const siblings = await many(store.from("routing_rules").select("id, priority").eq("domain_id", current.domain_id));
        const holder = siblings.find((rule) => rule.priority === clean.priority && rule.id !== id);
        if (holder) {
          const used = new Set(siblings.map((rule) => rule.priority));
          let free = MAX_PRIORITY;
          while (used.has(free) && free > 1) free -= 1;
          await one(store.from("routing_rules").update({ priority: free }).eq("id", holder.id).select("id").maybeSingle(),
            { conflictMessage: `A routing rule with priority ${clean.priority} already exists.` });
        }
        ({ data, error } = await run());
      }
      if (error) mapError(error, { conflictMessage: `A routing rule with priority ${clean.priority} already exists.` });
      if (!data) fail("Routing rule does not exist.", 404, "not_found");
      return data;
    },
    async deleteRoutingRule({ id, domainId = null }) {
      return hardDelete("routing_rules", id, { domain_id: domainId });
    },

    // --- trust_stores (hard delete) ---
    async insertTrustStore(row) {
      return one(store.from("trust_stores").insert(pick("trust_stores", row)).select("*").single());
    },
    async getTrustStoreById(id) {
      return byId("trust_stores", id);
    },
    async listTrustStores({ projectId }) {
      return listByProject("trust_stores", projectId);
    },
    async updateTrustStore({ id, patch }) {
      return versionedUpdate("trust_stores", { id, patch, label: "Trust store" });
    },
    async deleteTrustStore({ id, projectId = null }) {
      return hardDelete("trust_stores", id, { project_id: projectId });
    },

    // --- domain_access_associations ---
    async listAccessAssociations({ domainId }) {
      if (!isUuid(domainId)) return [];
      return many(store.from("domain_access_associations").select("*").eq("domain_id", domainId)
        .order("created_at", { ascending: true }).order("id", { ascending: true }));
    },
    async insertAccessAssociation(row) {
      return one(store.from("domain_access_associations").insert(pick("domain_access_associations", row)).select("*").single(),
        { conflictMessage: "This connector is already associated with the domain." });
    },
    async deleteAccessAssociation({ id, domainId = null }) {
      return hardDelete("domain_access_associations", id, { domain_id: domainId });
    },

    // --- ip_sets ---
    async insertIpSet(row) {
      return one(store.from("ip_sets").insert(pick("ip_sets", row)).select("*").single());
    },
    async getIpSetById(id) {
      return byId("ip_sets", id);
    },
    async listIpSets({ projectId }) {
      return listByProject("ip_sets", projectId);
    },
    async updateIpSet({ id, patch }) {
      return versionedUpdate("ip_sets", { id, patch, label: "IP set" });
    },

    // --- regex_sets ---
    async insertRegexSet(row) {
      return one(store.from("regex_sets").insert(pick("regex_sets", row)).select("*").single());
    },
    async getRegexSetById(id) {
      return byId("regex_sets", id);
    },
    async listRegexSets({ projectId }) {
      return listByProject("regex_sets", projectId);
    },

    // --- web_acls ---
    async insertWebAcl(row) {
      return one(store.from("web_acls").insert(pick("web_acls", row)).select("*").single(),
        { conflictMessage: `A web ACL named "${row.name}" already exists.` });
    },
    async getWebAclById(id) {
      return byId("web_acls", id);
    },
    async listWebAcls({ projectId }) {
      return listByProject("web_acls", projectId);
    },
    async updateWebAcl({ id, patch, expectedVersion = null }) {
      return versionedUpdate("web_acls", {
        id, patch, expectedVersion, label: "Web ACL",
        conflictMessage: "A web ACL with this name already exists.",
      });
    },

    // --- web_acl_associations ---
    async listAclAssociations({ webAclId = null, apiId = null } = {}) {
      if ((webAclId !== null && !isUuid(webAclId)) || (apiId !== null && !isUuid(apiId))) return [];
      let query = store.from("web_acl_associations").select("*");
      if (webAclId !== null) query = query.eq("web_acl_id", webAclId);
      if (apiId !== null) query = query.eq("api_id", apiId);
      return many(query.order("created_at", { ascending: true }).order("id", { ascending: true }));
    },
    async insertAclAssociation(row) {
      return one(store.from("web_acl_associations").insert(pick("web_acl_associations", row)).select("*").single(),
        { conflictMessage: `Stage "${row.stage_name}" already has a web ACL.` });
    },
    async deleteAclAssociation({ id, projectId = null }) {
      return hardDelete("web_acl_associations", id, { project_id: projectId });
    },
  };
}
