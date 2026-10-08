// WAF management service (S11 §D1): IP sets, regex sets, web ACLs and
// stage associations. All writes need `pods.waf.write`.
//
// @module lib/control/waf

import { isIP } from "node:net";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { registerStackHandler } from "./stacks.mjs";
import { validateStatement, validateRegexPattern, getSampledRequests } from "../gateway/core/edge/waf-engine.mjs";

export const MAX_IP_ADDRESSES = 10000;

function checkName(value, path = "$.name") {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new HttpError(422, "invalid_input", `Invalid request: ${path}: must be a string of 1–128 characters`);
  }
  return value;
}

/**
 * Validates one CIDR against the set's IP version.
 *
 * @param {string} cidr
 * @param {"IPV4"|"IPV6"} ipVersion
 */
export function checkCidr(cidr, ipVersion) {
  if (typeof cidr !== "string") {
    throw new HttpError(422, "invalid_input", `Invalid CIDR "${cidr}": must be a string`);
  }
  const index = cidr.lastIndexOf("/");
  if (index === -1) throw new HttpError(422, "invalid_input", `Invalid CIDR "${cidr}": missing prefix length`);
  const base = cidr.slice(0, index);
  const prefix = Number(cidr.slice(index + 1));
  const version = isIP(base);
  if (version === 0) throw new HttpError(422, "invalid_input", `Invalid CIDR "${cidr}": not an IP address`);
  if (ipVersion === "IPV4" && version !== 4) {
    throw new HttpError(422, "invalid_input", `Invalid CIDR "${cidr}": not an IPv4 address`);
  }
  if (ipVersion === "IPV6" && version !== 6) {
    throw new HttpError(422, "invalid_input", `Invalid CIDR "${cidr}": not an IPv6 address`);
  }
  const max = version === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    throw new HttpError(422, "invalid_input", `Invalid CIDR "${cidr}": prefix must be 0–${max}`);
  }
}

function geoAvailable() {
  return Boolean(process.env.PODS_GEOIP_DB);
}

function toIpSetView(row) {
  return {
    id: row.id, projectId: row.project_id, name: row.name,
    ipVersion: row.ip_version, addresses: row.addresses ?? [],
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toRegexSetView(row) {
  return {
    id: row.id, projectId: row.project_id, name: row.name,
    patterns: row.patterns ?? [],
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toWebAclView(row) {
  return {
    id: row.id, projectId: row.project_id, name: row.name,
    defaultAction: row.default_action, rules: row.rules ?? [],
    customResponses: row.custom_responses ?? {},
    visibility: row.visibility ?? { sampledRequests: true, metrics: true },
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Create an IP set (≤ 10 000 CIDRs). */
export async function createIpSet(db, actor, { projectId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const body = input ?? {};
  const name = checkName(body.name);
  if (!["IPV4", "IPV6"].includes(body.ipVersion)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.ipVersion: must be one of IPV4, IPV6");
  }
  if (!Array.isArray(body.addresses)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.addresses: expected an array");
  }
  if (body.addresses.length > MAX_IP_ADDRESSES) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.addresses: at most ${MAX_IP_ADDRESSES} entries`);
  }
  for (const cidr of body.addresses) checkCidr(cidr, body.ipVersion);
  const row = await db.insertIpSet({
    project_id: projectId, name, ip_version: body.ipVersion,
    addresses: [...body.addresses], created_by: actor?.userId ?? null,
  });
  const view = toIpSetView(row);
  await audit(db, actor, {
    action: "waf_ip_set.create", resourceType: "ip_set", resourceId: row.id,
    projectId, before: null, after: view, requestId,
  });
  return { status: 201, body: view };
}

/** Replace an IP set's addresses (optimistic concurrency). */
export async function updateIpSet(db, actor, { projectId, setId, input, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const current = await db.getIpSetById(setId);
  if (!current || current.project_id !== projectId) {
    throw new HttpError(404, "not_found", "IP set does not exist.");
  }
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `IP set changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const addresses = input?.addresses ?? current.addresses;
  if (!Array.isArray(addresses) || addresses.length > MAX_IP_ADDRESSES) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.addresses: at most ${MAX_IP_ADDRESSES} entries`);
  }
  for (const cidr of addresses) checkCidr(cidr, current.ip_version);
  const row = await db.updateIpSet({ id: setId, patch: { addresses: [...addresses] } });
  const view = toIpSetView(row);
  await audit(db, actor, {
    action: "waf_ip_set.update", resourceType: "ip_set", resourceId: row.id,
    projectId, before: toIpSetView(current), after: view, requestId,
  });
  return view;
}

/** Create a regex set (RE2-safe patterns only). */
export async function createRegexSet(db, actor, { projectId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const body = input ?? {};
  const name = checkName(body.name);
  if (!Array.isArray(body.patterns)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.patterns: expected an array");
  }
  for (const pattern of body.patterns) {
    const error = validateRegexPattern(pattern);
    if (error) throw new HttpError(422, "invalid_input", `Invalid request: $.patterns: ${error}`);
  }
  const row = await db.insertRegexSet({
    project_id: projectId, name, patterns: [...body.patterns], created_by: actor?.userId ?? null,
  });
  const view = toRegexSetView(row);
  await audit(db, actor, {
    action: "waf_regex_set.create", resourceType: "regex_set", resourceId: row.id,
    projectId, before: null, after: view, requestId,
  });
  return { status: 201, body: view };
}

/**
 * Validates web ACL rules (ordered, unique priorities, known statements).
 *
 * @param {Array<object>} rules
 * @param {{ allowGeo?: boolean }} [options={}]
 */
export function checkWebAclRules(rules, { allowGeo = geoAvailable() } = {}) {
  if (!Array.isArray(rules)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.rules: expected an array");
  }
  const seen = new Set();
  rules.forEach((rule, index) => {
    const prefix = `$.rules[${index}]`;
    if (typeof rule?.name !== "string" || rule.name.length < 1 || rule.name.length > 128) {
      throw new HttpError(422, "invalid_input", `Invalid request: ${prefix}.name: must be a string of 1–128 characters`);
    }
    if (!Number.isInteger(rule.priority)) {
      throw new HttpError(422, "invalid_input", `Invalid request: ${prefix}.priority: must be an integer`);
    }
    if (seen.has(rule.priority)) {
      throw new HttpError(422, "invalid_input", `Invalid request: ${prefix}.priority: duplicate priority ${rule.priority}`);
    }
    seen.add(rule.priority);
    if (!["ALLOW", "BLOCK", "COUNT"].includes(rule.action)) {
      throw new HttpError(422, "invalid_input", `Invalid request: ${prefix}.action: must be one of ALLOW, BLOCK, COUNT`);
    }
    if (rule.overrideAction !== undefined && rule.overrideAction !== null && !["NONE", "COUNT"].includes(rule.overrideAction)) {
      throw new HttpError(422, "invalid_input", `Invalid request: ${prefix}.overrideAction: must be one of NONE, COUNT`);
    }
    const problems = validateStatement(rule.statement, { allowGeo });
    if (problems.length > 0) {
      throw new HttpError(422, "invalid_input", `Invalid request: ${prefix}.statement: ${problems[0]}`, { errors: problems });
    }
  });
  return rules;
}

function checkCustomResponses(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.customResponses: expected an object");
  }
  for (const [key, entry] of Object.entries(value)) {
    const status = Number(entry?.statusCode);
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.customResponses.${key}.statusCode: must be an integer 200–599`);
    }
  }
  return value;
}

/** Create a web ACL. */
export async function createWebAcl(db, actor, { projectId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const body = input ?? {};
  const name = checkName(body.name);
  if (!["ALLOW", "BLOCK"].includes(body.defaultAction)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.defaultAction: must be one of ALLOW, BLOCK");
  }
  checkWebAclRules(body.rules ?? []);
  const customResponses = checkCustomResponses(body.customResponses);
  const row = await db.insertWebAcl({
    project_id: projectId, name, default_action: body.defaultAction,
    rules: body.rules ?? [], custom_responses: customResponses,
    visibility: body.visibility ?? { sampledRequests: true, metrics: true },
    created_by: actor?.userId ?? null,
  });
  const view = toWebAclView(row);
  await audit(db, actor, {
    action: "waf_acl.create", resourceType: "web_acl", resourceId: row.id,
    projectId, before: null, after: view, requestId,
  });
  return { status: 201, body: view };
}

/** Update a web ACL (rules, default action, custom responses). */
export async function updateWebAcl(db, actor, { projectId, aclId, input, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const current = await db.getWebAclById(aclId);
  if (!current || current.project_id !== projectId) {
    throw new HttpError(404, "not_found", "Web ACL does not exist.");
  }
  const patch = {};
  if (input?.defaultAction !== undefined) {
    if (!["ALLOW", "BLOCK"].includes(input.defaultAction)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.defaultAction: must be one of ALLOW, BLOCK");
    }
    patch.default_action = input.defaultAction;
  }
  if (input?.rules !== undefined) {
    checkWebAclRules(input.rules);
    patch.rules = input.rules;
  }
  if (input?.customResponses !== undefined) patch.custom_responses = checkCustomResponses(input.customResponses);
  if (input?.visibility !== undefined) patch.visibility = input.visibility;
  const row = await db.updateWebAcl({ id: aclId, patch, expectedVersion });
  const view = toWebAclView(row);
  await audit(db, actor, {
    action: "waf_acl.update", resourceType: "web_acl", resourceId: row.id,
    projectId, before: toWebAclView(current), after: view, requestId,
  });
  return view;
}

/** Associate a web ACL with an API stage (one ACL per stage). */
export async function associateWebAcl(db, actor, { projectId, webAclId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const acl = await db.getWebAclById(webAclId);
  if (!acl || acl.project_id !== projectId) {
    throw new HttpError(404, "not_found", "Web ACL does not exist.");
  }
  if (typeof input?.apiId !== "string" || !input.apiId) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.apiId: must be a non-empty string");
  }
  if (typeof input?.stageName !== "string" || !input.stageName) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.stageName: must be a non-empty string");
  }
  const clashes = await db.listAclAssociations({ apiId: input.apiId });
  if (clashes.some((row) => row.stage_name === input.stageName)) {
    throw new HttpError(409, "conflict", `Stage "${input.stageName}" already has a web ACL.`);
  }
  const row = await db.insertAclAssociation({
    project_id: projectId, web_acl_id: webAclId, api_id: input.apiId, stage_name: input.stageName,
  });
  const view = {
    id: row.id, projectId, webAclId, apiId: row.api_id,
    stageName: row.stage_name, createdAt: row.created_at,
  };
  await audit(db, actor, {
    action: "waf_acl.associate", resourceType: "web_acl", resourceId: webAclId,
    projectId, before: null, after: view, requestId,
  });
  return { status: 201, body: view };
}

/** List IP sets. */
export async function listIpSets(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const rows = await db.listIpSets({ projectId });
  return { items: rows.map((row) => toIpSetView(row)) };
}

/** Get one IP set. */
export async function getIpSet(db, actor, { projectId, setId }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const row = await db.getIpSetById(setId);
  if (!row || row.project_id !== projectId) {
    throw new HttpError(404, "not_found", "IP set does not exist.");
  }
  return toIpSetView(row);
}

/** List regex sets. */
export async function listRegexSets(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const rows = await db.listRegexSets({ projectId });
  return { items: rows.map((row) => toRegexSetView(row)) };
}

/** Get one regex set. */
export async function getRegexSet(db, actor, { projectId, setId }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const row = await db.getRegexSetById(setId);
  if (!row || row.project_id !== projectId) {
    throw new HttpError(404, "not_found", "Regex set does not exist.");
  }
  return toRegexSetView(row);
}

/** List web ACLs. */
export async function listWebAcls(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const rows = await db.listWebAcls({ projectId });
  return { items: rows.map((row) => toWebAclView(row)) };
}

/** Get one web ACL with its associations. */
export async function getWebAcl(db, actor, { projectId, aclId }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const row = await db.getWebAclById(aclId);
  if (!row || row.project_id !== projectId) {
    throw new HttpError(404, "not_found", "Web ACL does not exist.");
  }
  const associations = await db.listAclAssociations({ webAclId: aclId }).catch(() => []);
  return {
    ...toWebAclView(row),
    associations: associations.map((entry) => ({
      id: entry.id, apiId: entry.api_id, stageName: entry.stage_name, createdAt: entry.created_at,
    })),
  };
}

/** Remove a stage association. */
export async function disassociateWebAcl(db, actor, { projectId, associationId, requestId = null }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  await db.deleteAclAssociation({ id: associationId });
  await audit(db, actor, {
    action: "waf_acl.disassociate", resourceType: "web_acl", resourceId: associationId,
    projectId, before: null, after: null, requestId,
  });
  return { id: associationId, deleted: true };
}

// --- Sampled requests (F35) ---------------------------------------------------
// The gateway records samples in KV under `waf:samples:<aclName>:<stage>:<rule>`
// (engine-tested; last 3 h, ≤ 100 per rule per stage). This read API serves
// them to the WAF screen, scoped to one ACL of this project.

/** Max sampled rows per response (bounded input). */
export const MAX_SAMPLED_LIMIT = 100;

function checkSampleFilter(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 128) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${label}: must be a string of 1–128 characters`);
  }
  return value;
}

/**
 * Lists sampled requests for a web ACL (newest first).
 *
 * @param {object} db - Needs `getWebAclById`, `listAclAssociations`.
 * @param {object} actor
 * @param {{ projectId: string, aclId: string, stage?: string|null, rule?: string|null, limit?: number, kv?: object|null, now?: number }} options
 */
export async function listSampledRequests(db, actor, { projectId, aclId, stage = null, rule = null, limit = 25, kv = null, now = Date.now() }) {
  await requirePermission(db, actor, "pods.waf.write", { projectId });
  const acl = await db.getWebAclById(aclId);
  if (!acl || acl.project_id !== projectId) {
    throw new HttpError(404, "not_found", "Web ACL does not exist.");
  }
  const ruleNames = (acl.rules ?? []).map((entry) => entry?.name).filter((name) => typeof name === "string" && name !== "");
  const wantedRule = checkSampleFilter(rule, "rule");
  if (wantedRule !== null && !ruleNames.includes(wantedRule)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.rule: unknown rule "${wantedRule}" for this web ACL`);
  }
  const wantedStage = checkSampleFilter(stage, "stage");
  const count = limit === undefined || limit === null ? 25 : Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > MAX_SAMPLED_LIMIT) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.limit: must be an integer 1–${MAX_SAMPLED_LIMIT}`);
  }
  let stages = [];
  if (wantedStage !== null) {
    stages = [wantedStage];
  } else {
    const associations = await db.listAclAssociations({ webAclId: aclId }).catch(() => []);
    stages = [...new Set((associations ?? []).map((entry) => entry.stage_name).filter((name) => typeof name === "string" && name !== ""))];
  }
  const rules = wantedRule !== null ? [wantedRule] : ruleNames;
  // The engine keys samples by ACL *name* (see phases/waf.mjs).
  const aclName = acl.name;
  const items = [];
  if (kv && typeof kv.get === "function") {
    for (const stageName of stages) {
      for (const ruleName of rules) {
        const rows = await getSampledRequests(kv, { aclId: aclName, stage: stageName, ruleName, now });
        for (const row of rows) items.push({ ...row, stage: stageName, rule: ruleName });
      }
    }
  }
  items.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  return {
    aclId, stage: wantedStage, rule: wantedRule,
    stages, rules: ruleNames,
    kvAvailable: Boolean(kv && typeof kv.get === "function"),
    items: items.slice(0, count),
  };
}

// --- Declarative stacks (F25): the `waf` kind -------------------------------

registerStackHandler("waf", {
  async plan(db, { projectId, desired }) {
    const ops = [];
    const live = await db.listWebAcls({ projectId }).catch(() => []);
    const liveByName = new Map(live.map((row) => [row.name, row]));
    const wanted = new Set();
    for (const entry of desired ?? []) {
      if (!entry || typeof entry.name !== "string" || entry.name === "") {
        throw new HttpError(422, "invalid_input", "Each waf[] entry requires a name.");
      }
      wanted.add(entry.name);
      const current = liveByName.get(entry.name);
      if (!current) {
        ops.push({ name: entry.name, op: "create", identity: { name: entry.name }, diff: { after: entry } });
      } else {
        const diff = {};
        if (JSON.stringify(current.default_action) !== JSON.stringify(entry.defaultAction ?? current.default_action)) {
          diff.defaultAction = { before: current.default_action, after: entry.defaultAction };
        }
        if (JSON.stringify(current.rules ?? []) !== JSON.stringify(entry.rules ?? current.rules ?? [])) {
          diff.rules = { before: current.rules ?? [], after: entry.rules ?? [] };
        }
        ops.push({ name: entry.name, op: Object.keys(diff).length === 0 ? "noop" : "update", identity: { name: entry.name, id: current.id }, diff });
      }
    }
    for (const row of live) {
      if (!wanted.has(row.name)) {
        ops.push({ name: row.name, op: "delete", identity: { name: row.name, id: row.id }, diff: { before: row }, skipped: "needs_prune" });
      }
    }
    return ops;
  },
  async apply(db, actor, { projectId, change }) {
    if (change.op === "create") {
      const after = change.diff?.after ?? {};
      await createWebAcl(db, actor, {
        projectId,
        input: { name: change.name, defaultAction: after.defaultAction ?? "ALLOW", rules: after.rules ?? [] },
      });
      return { applied: true };
    }
    if (change.op === "update") {
      const after = change.diff?.after ?? {};
      const acls = await db.listWebAcls({ projectId }).catch(() => []);
      const row = acls.find((entry) => entry.name === change.name);
      if (row) {
        await updateWebAcl(db, actor, {
          projectId, aclId: row.id,
          input: { ...(after.defaultAction ? { defaultAction: after.defaultAction } : {}), ...(after.rules ? { rules: after.rules } : {}) },
        });
      }
      return { applied: true };
    }
    return { applied: false };
  },
});

/** Stack-plan helper used by tests (plan path without the registry). */
export async function planDomainsStack() {
  return { kind: "domains" };
}

/** Stack-plan helper used by tests (plan path without the registry). */
export async function planWafStack() {
  return { kind: "waf" };
}
