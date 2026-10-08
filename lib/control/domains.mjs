// Custom-domain management service (S11 Part A/B/C): domains, ownership
// verification, certificates, API mappings, routing rules, trust stores and
// private access associations. Writes need `pods.domain.write` (trust stores:
// `pods.trust_store.write`).
//
// Real ACME/DNS issuance lives behind an injected `certIssuer` port
// (`issue({ domainName }) → { chainPem, keyPem, expiresAt }`); production
// wires Let's Encrypt (`PODS_ACME_DIRECTORY`) plus a DNS provider adapter.
// Tests inject a deterministic double.
//
// @module lib/control/domains

import { randomBytes } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { registerStackHandler } from "./stacks.mjs";
import {
  normalizeDomainName,
  isWildcardDomain,
  validateBasePath,
  dnsRecordsFor,
  checkDohTxtAnswer,
  newVerificationToken,
} from "../gateway/core/edge/host-resolve.mjs";
import { validateRoutingRule } from "../gateway/core/edge/routing-rules.mjs";
import { availablePolicies } from "../gateway/core/edge/tls-policy.mjs";
import { validateImportedCert, parseTrustStore } from "../gateway/core/edge/certs.mjs";

export const DOMAIN_STATUSES = [
  "PENDING_VERIFICATION",
  "PENDING_CERTIFICATE",
  "AVAILABLE",
  "UPDATING",
  "FAILED",
];

export const ENDPOINT_TYPES = ["REGIONAL", "EDGE", "PRIVATE"];
export const IP_ADDRESS_TYPES = ["ipv4", "dualstack"];
export const ROUTING_MODES = ["API_MAPPING_ONLY", "ROUTING_RULE_THEN_API_MAPPING", "ROUTING_RULE_ONLY"];
export const MAX_MULTILEVEL_MAPPINGS = 200;
export const MAX_ROUTING_RULES = 50;

const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function checkDomainName(value) {
  if (typeof value !== "string" || value !== value.toLowerCase()) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.domainName: must be a lowercase FQDN (or wildcard *.example.com)");
  }
  const normalized = normalizeDomainName(value);
  if (normalized.length > 253 || !DOMAIN_RE.test(normalized)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.domainName: must be a lowercase FQDN (or wildcard *.example.com)");
  }
  if (normalized.startsWith("*.")) {
    const parent = normalized.slice(2);
    if (parent.split(".").length < 2) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.domainName: wildcard needs a registrable parent (e.g. *.example.com)");
    }
  }
  return normalized;
}

function checkEnum(value, allowed, path) {
  if (!allowed.includes(value)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${path}: must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function targetHostname() {
  const domain = process.env.PODS_GATEWAY_DOMAIN ?? "gw.geigerpods.app";
  return `d-${randomBytes(4).toString("hex")}.${domain}`;
}

function toDomainView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    domainName: row.domain_name,
    endpointType: row.endpoint_type,
    ipAddressType: row.ip_address_type,
    securityPolicy: row.security_policy,
    certificateMode: row.certificate_mode,
    certificateExpiresAt: row.certificate_expires_at ?? null,
    verificationToken: row.verification_token,
    status: row.status,
    statusMessage: row.status_message ?? null,
    targetHostname: row.target_hostname,
    routingMode: row.routing_mode,
    mtls: row.mtls ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMappingView(row) {
  return {
    id: row.id,
    domainId: row.domain_id,
    apiId: row.api_id,
    stage: row.stage_name,
    basePath: row.base_path,
    createdAt: row.created_at,
  };
}

function toRuleView(row) {
  return {
    id: row.id,
    domainId: row.domain_id,
    priority: row.priority,
    conditions: row.conditions,
    action: row.action,
    createdAt: row.created_at,
  };
}

async function scopedDomain(db, projectId, domainId) {
  const row = await db.getDomainById(domainId);
  if (!row || row.project_id !== projectId || row.deleted_at) {
    throw new HttpError(404, "not_found", "Domain does not exist.");
  }
  return row;
}

/** List domains in a project. */
export async function listDomains(db, actor, { projectId, limit = 25 }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const rows = await db.listDomains({ projectId });
  return { items: rows.slice(0, take).map(toDomainView), nextCursor: null };
}

/** Get one domain plus its DNS records. */
export async function getDomain(db, actor, { projectId, domainId }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  const row = await scopedDomain(db, projectId, domainId);
  return {
    ...toDomainView(row),
    dnsRecords: dnsRecordsFor({ domainName: row.domain_name, verificationToken: row.verification_token, targetHostname: row.target_hostname }),
  };
}

/**
 * Create a domain: validates the name/type/policy, generates the
 * verification token + target hostname, and returns the DNS records to add.
 */
export async function createDomain(db, actor, { projectId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  const body = input ?? {};
  const domainName = checkDomainName(body.domainName);
  const endpointType = body.endpointType !== undefined ? checkEnum(body.endpointType, ENDPOINT_TYPES, "endpointType") : "REGIONAL";
  const ipAddressType = body.ipAddressType !== undefined ? checkEnum(body.ipAddressType, IP_ADDRESS_TYPES, "ipAddressType") : "ipv4";
  const securityPolicy = body.securityPolicy !== undefined ? checkEnum(body.securityPolicy, availablePolicies(), "securityPolicy") : "TLS_1_2";
  const routingMode = body.routingMode !== undefined ? checkEnum(body.routingMode, ROUTING_MODES, "routingMode") : "API_MAPPING_ONLY";
  const certificateMode = body.certificateMode !== undefined ? checkEnum(body.certificateMode, ["managed", "imported"], "certificateMode") : "managed";
  if (await db.findDomainByNameGlobal({ domainName })) {
    throw new HttpError(409, "conflict", `A domain named "${domainName}" already exists.`);
  }
  const verificationToken = newVerificationToken();
  const row = await db.insertDomain({
    project_id: projectId,
    domain_name: domainName,
    endpoint_type: endpointType,
    ip_address_type: ipAddressType,
    security_policy: securityPolicy,
    certificate_mode: certificateMode,
    certificate_chain_pem: null,
    certificate_key_pem: null,
    certificate_expires_at: null,
    verification_token: verificationToken,
    status: "PENDING_VERIFICATION",
    target_hostname: targetHostname(),
    routing_mode: routingMode,
    mtls: null,
    policy: null,
    created_by: actor?.userId ?? null,
  });
  const view = toDomainView(row);
  const dnsRecords = dnsRecordsFor({ domainName, verificationToken, targetHostname: row.target_hostname });
  await audit(db, actor, {
    action: "domain.create", resourceType: "domain", resourceId: row.id,
    projectId, before: null, after: view, requestId,
  });
  return { status: 201, body: view, dnsRecords };
}

/** Update domain settings (optimistic concurrency). */
export async function updateDomain(db, actor, { projectId, domainId, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  const current = await scopedDomain(db, projectId, domainId);
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new HttpError(422, "invalid_input", "Provide at least one domain field to update.");
  }
  const clean = {};
  if (patch.endpointType !== undefined) clean.endpoint_type = checkEnum(patch.endpointType, ENDPOINT_TYPES, "endpointType");
  if (patch.ipAddressType !== undefined) clean.ip_address_type = checkEnum(patch.ipAddressType, IP_ADDRESS_TYPES, "ipAddressType");
  if (patch.securityPolicy !== undefined) clean.security_policy = checkEnum(patch.securityPolicy, availablePolicies(), "securityPolicy");
  if (patch.routingMode !== undefined) clean.routing_mode = checkEnum(patch.routingMode, ROUTING_MODES, "routingMode");
  if (patch.mtls !== undefined) {
    if (patch.mtls !== null && (typeof patch.mtls !== "object" || Array.isArray(patch.mtls))) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.mtls: expected an object or null");
    }
    clean.mtls = patch.mtls;
  }
  if (patch.policy !== undefined) {
    if (patch.policy !== null && (typeof patch.policy !== "object" || Array.isArray(patch.policy))) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.policy: expected an object or null");
    }
    // F34: private-domain policies use the same resource-policy grammar
    // (S07 §7) so the runtime can evaluate them at ingress.
    if (patch.policy !== null) {
      const { validateResourcePolicy } = await import("../gateway/core/auth/resource-policy.mjs");
      const { errors } = validateResourcePolicy(patch.policy);
      if (errors.length > 0) {
        throw new HttpError(422, "invalid_input", `Invalid request: $.policy: ${errors[0].path}: ${errors[0].message}`);
      }
    }
    clean.policy = patch.policy;
  }
  const before = toDomainView(current);
  const row = await db.updateDomain({ id: current.id, patch: clean, expectedVersion });
  const after = toDomainView(row);
  await audit(db, actor, {
    action: "domain.update", resourceType: "domain", resourceId: row.id,
    projectId, before, after, requestId,
  });
  return after;
}

/** Delete a domain (soft delete; the name stays reserved while set). */
export async function deleteDomain(db, actor, { projectId, domainId, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  const current = await scopedDomain(db, projectId, domainId);
  const before = toDomainView(current);
  await db.deleteDomain({ id: current.id });
  await audit(db, actor, {
    action: "domain.delete", resourceType: "domain", resourceId: current.id,
    projectId, before, after: null, requestId,
  });
  return { id: current.id, deleted: true };
}

/**
 * Verifies domain ownership over DNS-over-HTTPS (fixed resolver, not the
 * system one). A matching TXT moves the domain to `PENDING_CERTIFICATE`.
 *
 * @param {object} db
 * @param {object} actor
 * @param {{ projectId: string, domainId: string, dohFetch?: Function, requestId?: string }} options
 */
export async function verifyDomain(db, actor, { projectId, domainId, dohFetch = null, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  const current = await scopedDomain(db, projectId, domainId);
  const parent = current.domain_name.startsWith("*.") ? current.domain_name.slice(2) : current.domain_name;
  const resolver = process.env.PODS_DOH_RESOLVER ?? "https://cloudflare-dns.com/dns-query";
  const fetchFn = dohFetch ?? globalThis.fetch;
  let answer = null;
  try {
    const response = await fetchFn(`${resolver}?name=_pods-challenge.${parent}&type=TXT`, {
      headers: { accept: "application/dns-json" },
    });
    answer = response?.ok === false ? null : await response.json();
  } catch {
    answer = null;
  }
  if (!answer || !checkDohTxtAnswer(answer, current.verification_token)) {
    throw new HttpError(422, "verification_failed", "The ownership TXT record was not found yet. Add the DNS record and retry.");
  }
  const row = await db.updateDomain({
    id: current.id,
    patch: { status: "PENDING_CERTIFICATE", status_message: null },
    expectedVersion: null,
  });
  await audit(db, actor, {
    action: "domain.verify", resourceType: "domain", resourceId: row.id,
    projectId, before: toDomainView(current), after: toDomainView(row), requestId,
  });
  return toDomainView(row);
}

/**
 * Imports a PEM chain + key (validated: key match, SAN coverage, expiry,
 * chain linkage). Verified domains become `AVAILABLE`.
 */
export async function importCertificate(db, actor, { projectId, domainId, chainPem, keyPem, domainName = null, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  const current = await scopedDomain(db, projectId, domainId);
  const wanted = domainName ?? current.domain_name;
  const { errors } = validateImportedCert({ certificateChainPem: chainPem, privateKeyPem: keyPem, domainName: wanted });
  if (errors.length > 0) {
    throw new HttpError(422, "invalid_input", `Invalid certificate: ${errors[0]}`, { errors });
  }
  let expiresAt = null;
  try {
    const { X509Certificate } = await import("node:crypto");
    const leaf = new X509Certificate(chainPem.match(/-----BEGIN CERTIFICATE-----[^-]*-----END CERTIFICATE-----/)[0]);
    expiresAt = new Date(Date.parse(leaf.validTo)).toISOString();
  } catch {
    expiresAt = null;
  }
  const verified = current.status !== "PENDING_VERIFICATION";
  const row = await db.updateDomain({
    id: current.id,
    patch: {
      certificate_mode: "imported",
      certificate_chain_pem: chainPem,
      certificate_key_pem: keyPem,
      certificate_expires_at: expiresAt,
      status: verified ? "AVAILABLE" : current.status,
      status_message: null,
    },
    expectedVersion: null,
  });
  await audit(db, actor, {
    action: "domain.certificate", resourceType: "domain", resourceId: row.id,
    projectId, before: toDomainView(current), after: toDomainView(row), requestId,
  });
  return toDomainView(row);
}

/**
 * Issues a managed certificate via the injected issuer (ACME in production).
 */
export async function issueManagedCertificate(db, actor, { projectId, domainId, certIssuer = null, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  const current = await scopedDomain(db, projectId, domainId);
  if (current.status === "PENDING_VERIFICATION") {
    throw new HttpError(422, "invalid_input", "Verify domain ownership before issuing a certificate.");
  }
  const issuer = certIssuer ?? null;
  if (!issuer || typeof issuer.issue !== "function") {
    throw new HttpError(501, "not_implemented", "Managed issuance needs PODS_ACME_DIRECTORY and a DNS provider adapter (see the S11 report).");
  }
  const issued = await issuer.issue({ domainName: current.domain_name });
  const { errors } = validateImportedCert({
    certificateChainPem: issued.chainPem,
    privateKeyPem: issued.keyPem,
    domainName: current.domain_name,
  });
  if (errors.length > 0) {
    throw new HttpError(502, "upstream_error", `The issuer returned an unusable certificate: ${errors[0]}`);
  }
  const row = await db.updateDomain({
    id: current.id,
    patch: {
      certificate_mode: "managed",
      certificate_chain_pem: issued.chainPem,
      certificate_key_pem: issued.keyPem,
      certificate_expires_at: issued.expiresAt ?? null,
      status: "AVAILABLE",
      status_message: null,
    },
    expectedVersion: null,
  });
  await audit(db, actor, {
    action: "domain.certificate", resourceType: "domain", resourceId: row.id,
    projectId, before: toDomainView(current), after: toDomainView(row), requestId,
  });
  return toDomainView(row);
}

/** List API mappings for a domain. */
export async function listMappings(db, actor, { projectId, domainId }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  await scopedDomain(db, projectId, domainId);
  return { items: (await db.listMappings({ domainId })).map(toMappingView) };
}

/** Create an API mapping (unique base path, ≤ 200 multi-level per domain). */
export async function createMapping(db, actor, { projectId, domainId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  const domain = await scopedDomain(db, projectId, domainId);
  const body = input ?? {};
  if (typeof body.apiId !== "string" || !body.apiId) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.apiId: must be a non-empty string");
  }
  if (typeof body.stage !== "string" || !body.stage) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.stage: must be a non-empty string");
  }
  const basePath = body.basePath ?? "";
  const baseError = validateBasePath(basePath);
  if (baseError) throw new HttpError(422, "invalid_input", `Invalid request: $.basePath: ${baseError}`);
  const existing = await db.listMappings({ domainId });
  if (existing.some((row) => row.base_path === basePath)) {
    throw new HttpError(409, "conflict", `A mapping for base path "${basePath}" already exists.`);
  }
  if (existing.filter((row) => row.base_path.includes("/")).length >= MAX_MULTILEVEL_MAPPINGS && basePath.includes("/")) {
    throw new HttpError(422, "invalid_input", `At most ${MAX_MULTILEVEL_MAPPINGS} multi-level mappings per domain.`);
  }
  // Private custom domains may target only private APIs (AWS restriction).
  if (domain.endpoint_type === "PRIVATE" && typeof db.getApiByRef === "function") {
    const api = await db.getApiByRef({ projectId, ref: body.apiId }).catch(() => null);
    if (api && api.endpoint_type !== "PRIVATE") {
      throw new HttpError(422, "invalid_input", "Private custom domains may target only private APIs.");
    }
  }
  // S15 tenant isolation: a domain may only map APIs in its own project.
  // `getApiByRef` is project-scoped, so a foreign apiId resolves to null.
  if (typeof db.getApiByRef === "function") {
    const api = await db.getApiByRef({ projectId, ref: body.apiId }).catch(() => null);
    if (!api) {
      throw new HttpError(404, "not_found", "API does not exist.");
    }
  }
  const row = await db.insertMapping({ domain_id: domainId, api_id: body.apiId, stage_name: body.stage, base_path: basePath });
  const view = toMappingView(row);
  await audit(db, actor, {
    action: "domain_mapping.create", resourceType: "domain_mapping", resourceId: row.id,
    projectId, before: null, after: view, requestId,
  });
  return { status: 201, body: view };
}

/** Delete an API mapping. */
export async function deleteMapping(db, actor, { projectId, domainId, mappingId, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  await scopedDomain(db, projectId, domainId);
  await db.deleteMapping({ id: mappingId });
  await audit(db, actor, {
    action: "domain_mapping.delete", resourceType: "domain_mapping", resourceId: mappingId,
    projectId, before: null, after: null, requestId,
  });
  return { id: mappingId, deleted: true };
}

/** Create a routing rule (priority unique, condition caps, header vetting). */
export async function createRoutingRule(db, actor, { projectId, domainId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  await scopedDomain(db, projectId, domainId);
  const problems = validateRoutingRule(input ?? {});
  if (problems.length > 0) {
    throw new HttpError(422, "invalid_input", `Invalid routing rule: ${problems[0]}`, { errors: problems });
  }
  const existing = await db.listRoutingRules({ domainId });
  if (existing.length >= MAX_ROUTING_RULES) {
    throw new HttpError(422, "invalid_input", `At most ${MAX_ROUTING_RULES} routing rules per domain.`);
  }
  if (existing.some((row) => row.priority === input.priority)) {
    throw new HttpError(409, "conflict", `A routing rule with priority ${input.priority} already exists.`);
  }
  const row = await db.insertRoutingRule({
    domain_id: domainId,
    priority: input.priority,
    conditions: input.conditions,
    action: input.action,
  });
  const view = toRuleView(row);
  await audit(db, actor, {
    action: "routing_rule.create", resourceType: "routing_rule", resourceId: row.id,
    projectId, before: null, after: view, requestId,
  });
  return { status: 201, body: view };
}

/** List routing rules by ascending priority. */
export async function listRoutingRules(db, actor, { projectId, domainId }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  await scopedDomain(db, projectId, domainId);
  const rows = (await db.listRoutingRules({ domainId })).sort((a, b) => a.priority - b.priority);
  return { items: rows.map(toRuleView) };
}

/**
 * Reorders rules (drag-reorder in the UI): renumbers with gaps (10, 20, …).
 */
export async function reorderRoutingRules(db, actor, { projectId, domainId, ruleIds, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  await scopedDomain(db, projectId, domainId);
  const existing = await db.listRoutingRules({ domainId });
  const ids = new Set(existing.map((row) => row.id));
  if (!Array.isArray(ruleIds) || ruleIds.length !== existing.length || !ruleIds.every((id) => ids.has(id))) {
    throw new HttpError(422, "invalid_input", "ruleIds must list every routing rule exactly once.");
  }
  const out = [];
  let priority = 10;
  for (const id of ruleIds) {
    out.push(toRuleView(await db.updateRoutingRule({ id, patch: { priority } })));
    priority += 10;
  }
  await audit(db, actor, {
    action: "routing_rule.reorder", resourceType: "domain", resourceId: domainId,
    projectId, before: null, after: { order: ruleIds }, requestId,
  });
  return out;
}

/** Delete a routing rule. */
export async function deleteRoutingRule(db, actor, { projectId, domainId, ruleId, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  await scopedDomain(db, projectId, domainId);
  await db.deleteRoutingRule({ id: ruleId });
  await audit(db, actor, {
    action: "routing_rule.delete", resourceType: "routing_rule", resourceId: ruleId,
    projectId, before: null, after: null, requestId,
  });
  return { id: ruleId, deleted: true };
}

/** Upload a truststore PEM bundle (parsed + warned at save). */
export async function createTrustStore(db, actor, { projectId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.trust_store.write", { projectId });
  const body = input ?? {};
  if (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 128) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
  }
  let parsed;
  try {
    parsed = parseTrustStore(body.pemBundle ?? "");
  } catch (error) {
    throw new HttpError(422, "invalid_input", `Invalid truststore: ${error.message}`);
  }
  const row = await db.insertTrustStore({
    project_id: projectId,
    name: body.name,
    pem_bundle: body.pemBundle,
    cert_count: parsed.certs.length,
    warnings: parsed.warnings,
    crl_pem: body.crlPem ?? null,
    versions: [{ version: 1, certCount: parsed.certs.length, warnings: parsed.warnings }],
    created_by: actor?.userId ?? null,
  });
  const view = {
    id: row.id, projectId: row.project_id, name: row.name,
    certCount: row.cert_count, warnings: row.warnings, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  await audit(db, actor, {
    action: "trust_store.create", resourceType: "trust_store", resourceId: row.id,
    projectId, before: null, after: view, requestId,
  });
  return { status: 201, body: view };
}

/** Replace a truststore bundle (version++ with history). */
export async function updateTrustStore(db, actor, { projectId, truststoreId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.trust_store.write", { projectId });
  const current = await db.getTrustStoreById(truststoreId);
  if (!current || current.project_id !== projectId) {
    throw new HttpError(404, "not_found", "Trust store does not exist.");
  }
  let parsed;
  try {
    parsed = parseTrustStore(input?.pemBundle ?? "");
  } catch (error) {
    throw new HttpError(422, "invalid_input", `Invalid truststore: ${error.message}`);
  }
  const version = (current.version ?? 1) + 1;
  const row = await db.updateTrustStore({
    id: current.id,
    patch: {
      pem_bundle: input.pemBundle,
      cert_count: parsed.certs.length,
      warnings: parsed.warnings,
      ...(input?.crlPem !== undefined ? { crl_pem: input.crlPem } : {}),
      versions: [...(current.versions ?? []), { version, certCount: parsed.certs.length, warnings: parsed.warnings }],
    },
  });
  const view = {
    id: row.id, projectId: row.project_id, name: row.name,
    certCount: row.cert_count, warnings: row.warnings, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  await audit(db, actor, {
    action: "trust_store.update", resourceType: "trust_store", resourceId: row.id,
    projectId, before: null, after: view, requestId,
  });
  return view;
}

/** List trust stores in a project. */
export async function listTrustStores(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.trust_store.write", { projectId });
  const rows = await db.listTrustStores({ projectId });
  return {
    items: rows.map((row) => ({
      id: row.id, projectId: row.project_id, name: row.name,
      certCount: row.cert_count, warnings: row.warnings ?? [], version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })),
  };
}

/** Get one trust store (bundle included for re-download). */
export async function getTrustStore(db, actor, { projectId, truststoreId }) {
  await requirePermission(db, actor, "pods.trust_store.write", { projectId });
  const row = await db.getTrustStoreById(truststoreId);
  if (!row || row.project_id !== projectId) {
    throw new HttpError(404, "not_found", "Trust store does not exist.");
  }
  return {
    id: row.id, projectId: row.project_id, name: row.name,
    certCount: row.cert_count, warnings: row.warnings ?? [], version: row.version,
    versions: row.versions ?? [],
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Associate a connector with a private domain. */
export async function associateConnector(db, actor, { projectId, domainId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  await scopedDomain(db, projectId, domainId);
  if (typeof input?.connectorId !== "string" || !input.connectorId) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.connectorId: must be a non-empty string");
  }
  // S15 tenant isolation: only associate connectors owned by this project.
  if (typeof db.getConnectorById === "function") {
    const connector = await db.getConnectorById(input.connectorId).catch(() => null);
    if (!connector || connector.project_id !== projectId) {
      throw new HttpError(404, "not_found", "Connector does not exist.");
    }
  }
  const row = await db.insertAccessAssociation({ domain_id: domainId, connector_id: input.connectorId });
  const view = { id: row.id, domainId, connectorId: row.connector_id, createdAt: row.created_at };
  await audit(db, actor, {
    action: "domain_access.associate", resourceType: "domain", resourceId: domainId,
    projectId, before: null, after: view, requestId,
  });
  return view;
}

/** Remove a connector association. */
export async function disassociateConnector(db, actor, { projectId, domainId, associationId, requestId = null }) {
  await requirePermission(db, actor, "pods.domain.write", { projectId });
  await scopedDomain(db, projectId, domainId);
  await db.deleteAccessAssociation({ id: associationId });
  await audit(db, actor, {
    action: "domain_access.remove", resourceType: "domain", resourceId: domainId,
    projectId, before: null, after: null, requestId,
  });
  return { id: associationId, deleted: true };
}

// --- Declarative stacks (F25): the `domains` kind ----------------------------

registerStackHandler("domains", {
  async plan(db, { projectId, desired, live }) {
    const ops = [];
    const liveByName = new Map((live ?? []).map((row) => [row.domain_name ?? row.name, row]));
    const wanted = new Set();
    for (const entry of desired ?? []) {
      if (!entry || typeof entry.name !== "string" || entry.name === "") {
        throw new HttpError(422, "invalid_input", "Each domains[] entry requires a name.");
      }
      wanted.add(entry.name);
      const current = liveByName.get(entry.name);
      if (!current) {
        ops.push({ name: entry.name, op: "create", identity: { name: entry.name }, diff: { after: entry } });
      } else {
        const diff = {};
        for (const field of ["endpointType", "securityPolicy", "routingMode"]) {
          const left = current[field === "endpointType" ? "endpoint_type" : field === "securityPolicy" ? "security_policy" : "routing_mode"] ?? null;
          if (JSON.stringify(left) !== JSON.stringify(entry[field] ?? null)) {
            diff[field] = { before: left, after: entry[field] ?? null };
          }
        }
        ops.push({ name: entry.name, op: Object.keys(diff).length === 0 ? "noop" : "update", identity: { name: entry.name, id: current.id }, diff });
      }
    }
    for (const row of live ?? []) {
      const name = row.domain_name ?? row.name;
      if (!wanted.has(name)) {
        ops.push({ name, op: "delete", identity: { name, id: row.id }, diff: { before: row }, skipped: "needs_prune" });
      }
    }
    return ops;
  },
  async apply(db, actor, { projectId, change }) {
    if (change.op === "create") {
      const after = change.diff?.after ?? {};
      await createDomain(db, actor, {
        projectId,
        input: {
          domainName: change.name,
          endpointType: after.endpointType ?? "REGIONAL",
          securityPolicy: after.securityPolicy ?? "TLS_1_2",
          routingMode: after.routingMode ?? "API_MAPPING_ONLY",
        },
      });
      return { applied: true };
    }
    if (change.op === "update") {
      const after = change.diff?.after ?? change.diff ?? {};
      const patch = {};
      if (after.endpointType) patch.endpointType = after.endpointType;
      if (after.securityPolicy) patch.securityPolicy = after.securityPolicy;
      if (after.routingMode) patch.routingMode = after.routingMode;
      const domains = await db.listDomains({ projectId }).catch(() => []);
      const row = domains.find((entry) => entry.domain_name === change.name)
        ?? await db.findDomainByNameGlobal({ domainName: change.name }).catch(() => null);
      if (row) await updateDomain(db, actor, { projectId, domainId: row.id, patch });
      return { applied: true };
    }
    if (change.op === "delete") {
      const domains = await db.listDomains({ projectId }).catch(() => []);
      const row = domains.find((entry) => entry.domain_name === change.name);
      if (row) await deleteDomain(db, actor, { projectId, domainId: row.id });
      return { applied: true };
    }
    return { applied: false };
  },
});

void isWildcardDomain;
