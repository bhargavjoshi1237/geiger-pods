// Documentation parts & versions service (S13 part B, §B).
//
// `pods.documentation_parts` hold OpenAPI-style properties keyed by
// location `{ type, path, method, statusCode, name }`; unique per API by
// location, ≤ 2000 parts. `pods.documentation_versions` freeze a snapshot
// of all parts; `stages.documentation_version` associates one with a
// stage, and export/portals read the stage's version.
//
// Content inheritance (AWS rules) lives in `resolveDocumentation`:
// a part whose location uses `method: "*"`, `statusCode: "*"` or a
// parent `path` applies to more specific locations unless they define
// the same property. Later passes (portals) render from the resolver;
// keep its signature stable.
//
// @module lib/control/documentation

import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { registerCloneHandler, resolveApi } from "./apis.mjs";
import { parseDocument } from "../gateway/distribution/openapi.mjs";
import { MAX_DOCUMENTATION_PARTS_PER_API as MAX_PARTS_PER_API } from "../gateway/core/limits.mjs";

export { MAX_PARTS_PER_API };

export const DOC_LOCATION_TYPES = [
  "API", "AUTHORIZER", "MODEL", "RESOURCE", "METHOD",
  "PATH_PARAMETER", "QUERY_PARAMETER", "REQUEST_HEADER",
  "REQUEST_BODY", "RESPONSE", "RESPONSE_HEADER", "RESPONSE_BODY",
];

// Canonical value lives in `lib/gateway/core/limits.mjs` (S15 §1).

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a documentation location. `path` defaults to `/` (API-wide),
 * `method`/`statusCode` default to `*` (inherit-everywhere).
 */
export function cleanLocation(input) {
  if (!isObject(input)) throw new HttpError(422, "invalid_input", "Invalid request: $.location: expected an object");
  const { type, path = "/", method = "*", statusCode = "*", name = null } = input;
  if (!DOC_LOCATION_TYPES.includes(type)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.location.type: must be one of ${DOC_LOCATION_TYPES.join(", ")}`);
  }
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 1024) {
    throw new HttpError(422, "invalid_input", 'Invalid request: $.location.path: must start with "/"');
  }
  const methodName = String(method).toUpperCase();
  if (methodName !== "*" && !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"].includes(methodName)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.location.method: must be * or an HTTP method");
  }
  const status = String(statusCode);
  if (status !== "*" && !/^[1-5][0-9][0-9]$/.test(status)) {
    throw new HttpError(422, "invalid_input", 'Invalid request: $.location.statusCode: must be "*" or a 3-digit status');
  }
  if (name !== null && (typeof name !== "string" || name === "" || name.length > 256)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.location.name: must be null or a non-empty string");
  }
  return { type, path, method: methodName, statusCode: status, name };
}

/** Stable identity for the unique-by-location constraint. */
export function locationKey(location) {
  const clean = cleanLocation(location);
  return JSON.stringify([clean.type, clean.path, clean.method, clean.statusCode, clean.name ?? ""]);
}

function cleanProperties(input) {
  if (!isObject(input)) throw new HttpError(422, "invalid_input", "Invalid request: $.properties: expected an object");
  const keys = Object.keys(input);
  if (keys.length === 0) throw new HttpError(422, "invalid_input", "Invalid request: $.properties: must define at least one property");
  if (keys.length > 64) throw new HttpError(422, "invalid_input", "Invalid request: $.properties: at most 64 keys");
  const out = {};
  for (const key of keys) {
    if (typeof key !== "string" || key === "" || key.length > 128) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.properties: keys must be non-empty strings");
    }
    const value = input[key];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && !isObject(value) && !Array.isArray(value)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.properties.${key}: must be a JSON value`);
    }
    out[key] = value;
  }
  return out;
}

function toPartView(row) {
  return {
    id: row.id, apiId: row.api_id, location: row.location, properties: row.properties,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toVersionView(row) {
  return {
    id: row.id, apiId: row.api_id, version: row.version,
    description: row.description ?? "", parts: (row.snapshot ?? []).length,
    createdAt: row.created_at,
  };
}

/**
 * Resolves the effective documentation for a location under the AWS
 * inheritance rules: parts with `method: "*"`, `statusCode: "*"` or a
 * parent `path` apply to more specific locations unless the more
 * specific location defines the same property.
 *
 * Specificity (low → high, later wins per property): API type parts,
 * parent paths, `method: "*"` / `statusCode: "*"` wildcards, then the
 * exact location.
 *
 * @param {Array<{ location: object, properties: object }>} parts
 * @param {{ type: string, path?: string, method?: string, statusCode?: string, name?: string|null }} location
 * @returns {object} Merged properties (possibly empty).
 */
export function resolveDocumentation(parts, location) {
  const target = {
    type: location.type,
    path: location.path ?? "/",
    method: String(location.method ?? "*").toUpperCase(),
    statusCode: String(location.statusCode ?? "*"),
    name: location.name ?? null,
  };
  const scored = [];
  for (const part of parts) {
    const candidate = part?.location ?? {};
    const properties = part?.properties ?? {};
    if (candidate.type !== target.type) continue;
    // Name pins the part to one named entity (authorizers, models…).
    if (candidate.name !== undefined && candidate.name !== null && candidate.name !== target.name) continue;
    if (target.name !== null && (candidate.name ?? null) !== target.name && candidate.type !== "API") continue;
    if (!pathCovers(candidate.path ?? "/", target.path)) continue;
    const methodOk = (candidate.method ?? "*") === "*" || String(candidate.method).toUpperCase() === target.method || target.method === "*";
    if (!methodOk) continue;
    const statusOk = String(candidate.statusCode ?? "*") === "*" || String(candidate.statusCode) === target.statusCode || target.statusCode === "*";
    if (!statusOk) continue;
    scored.push({ specificity: specificityOf(candidate, target), properties });
  }
  scored.sort((left, right) => left.specificity - right.specificity);
  const merged = {};
  for (const entry of scored) Object.assign(merged, entry.properties);
  return merged;
}

/** True when `candidate` path equals or is an ancestor of `target`. */
function pathCovers(candidate, target) {
  const parent = candidate ?? "/";
  const child = target ?? "/";
  if (parent === "/") return true;
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function specificityOf(candidate, target) {
  let score = 0;
  const candidatePath = candidate.path ?? "/";
  if (candidatePath !== "/") score += 100 + candidatePath.length;
  if ((candidate.method ?? "*") !== "*") score += 10;
  else if (target.method !== "*") score += 0;
  if (String(candidate.statusCode ?? "*") !== "*") score += 5;
  if (candidate.type === "API") score -= 50;
  if (candidate.name !== undefined && candidate.name !== null) score += 20;
  return score;
}

// --- Parts CRUD ---------------------------------------------------------------

/** List documentation parts for an API. */
export async function listDocumentationParts(db, actor, { projectId, apiId }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const rows = typeof db.listDocumentationParts === "function"
    ? await db.listDocumentationParts({ apiId: api.id })
    : [];
  return { items: rows.map(toPartView) };
}

/** Create one documentation part (409 on duplicate location). */
export async function createDocumentationPart(db, actor, { projectId, apiId, location, properties, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Documentation parts are only available on REST APIs.");
  }
  await requirePermission(db, actor, "pods.documentation.write", { projectId, apiId: api.id });
  const clean = cleanLocation(location);
  const props = cleanProperties(properties);
  const key = locationKey(clean);
  const existing = typeof db.listDocumentationParts === "function"
    ? await db.listDocumentationParts({ apiId: api.id })
    : [];
  if (existing.length >= MAX_PARTS_PER_API) {
    throw new HttpError(422, "invalid_input", `Documentation parts exceed ${MAX_PARTS_PER_API} for this API.`);
  }
  if (existing.some((row) => locationKey(row.location) === key)) {
    throw new HttpError(409, "conflict", "A documentation part already exists for this location.");
  }
  const row = await db.insertDocumentationPart({
    id: randomUUID(), project_id: projectId, api_id: api.id,
    location: clean, location_key: key, properties: props,
    created_by: actor?.userId ?? null,
  });
  await audit(db, actor, {
    action: "documentation_part.create", resourceType: "documentation_part", resourceId: row.id,
    projectId, apiId: api.id, before: null, after: toPartView(row), requestId,
  });
  return { status: 201, body: toPartView(row) };
}

/** Replace a part's properties (If-Match guarded). */
export async function updateDocumentationPart(db, actor, { projectId, apiId, partId, properties, expectedVersion = null, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.documentation.write", { projectId, apiId: api.id });
  const current = await db.getDocumentationPart({ id: partId }).catch(() => null);
  if (!current || current.api_id !== api.id) throw new HttpError(404, "not_found", "Documentation part does not exist.");
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Documentation part changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const before = toPartView(current);
  const row = await db.updateDocumentationPart({ id: current.id, patch: { properties: cleanProperties(properties), version: current.version + 1 } });
  await audit(db, actor, {
    action: "documentation_part.update", resourceType: "documentation_part", resourceId: current.id,
    projectId, apiId: api.id, before, after: toPartView(row), requestId,
  });
  return toPartView(row);
}

/** Delete one documentation part. */
export async function deleteDocumentationPart(db, actor, { projectId, apiId, partId, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.documentation.write", { projectId, apiId: api.id });
  const current = await db.getDocumentationPart({ id: partId }).catch(() => null);
  if (!current || current.api_id !== api.id) throw new HttpError(404, "not_found", "Documentation part does not exist.");
  const before = toPartView(current);
  await db.deleteDocumentationPart({ id: current.id });
  await audit(db, actor, {
    action: "documentation_part.delete", resourceType: "documentation_part", resourceId: current.id,
    projectId, apiId: api.id, before, after: null, requestId,
  });
  return { id: current.id, deleted: true };
}

// --- Versions ------------------------------------------------------------------

/**
 * Freezes the current parts into an immutable documentation version.
 * Later part edits never touch the snapshot (it is write-once).
 */
export async function createDocumentationVersion(db, actor, { projectId, apiId, version, description = "", requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Documentation versions are only available on REST APIs.");
  }
  await requirePermission(db, actor, "pods.documentation.write", { projectId, apiId: api.id });
  if (typeof version !== "string" || version.length < 1 || version.length > 64 || !/^[A-Za-z0-9._-]+$/.test(version)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.version: must match ^[A-Za-z0-9._-]{1,64}$");
  }
  if (typeof description !== "string" || description.length > 1024) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.description: must be a string of at most 1024 characters");
  }
  const existing = typeof db.getDocumentationVersion === "function"
    ? await db.getDocumentationVersion({ apiId: api.id, version }).catch(() => null)
    : null;
  if (existing) throw new HttpError(409, "conflict", `A documentation version "${version}" already exists.`);
  const parts = typeof db.listDocumentationParts === "function"
    ? await db.listDocumentationParts({ apiId: api.id })
    : [];
  const snapshot = parts.map((row) => ({ location: row.location, properties: row.properties }));
  const row = await db.insertDocumentationVersion({
    id: randomUUID(), project_id: projectId, api_id: api.id,
    version, description, snapshot, created_by: actor?.userId ?? null,
  });
  await audit(db, actor, {
    action: "documentation_version.create", resourceType: "documentation_version", resourceId: row.id,
    projectId, apiId: api.id, before: null, after: toVersionView(row), requestId,
  });
  return { status: 201, body: toVersionView(row) };
}

/** List documentation versions (newest last). */
export async function listDocumentationVersions(db, actor, { projectId, apiId }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const rows = typeof db.listDocumentationVersions === "function"
    ? await db.listDocumentationVersions({ apiId: api.id })
    : [];
  return { items: rows.map(toVersionView) };
}

/** Get one version with its immutable snapshot. */
export async function getDocumentationVersion(db, actor, { projectId, apiId, version }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const row = typeof db.getDocumentationVersion === "function"
    ? await db.getDocumentationVersion({ apiId: api.id, version }).catch(() => null)
    : null;
  if (!row) throw new HttpError(404, "not_found", "Documentation version does not exist.");
  return { ...toVersionView(row), description: row.description ?? "", snapshot: row.snapshot ?? [] };
}

/** Associates a documentation version with a stage (export uses it). */
export async function setStageDocumentationVersion(db, actor, { projectId, apiId, stageName, version, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.stage.write", { projectId, apiId: api.id });
  const stage = await db.getStageByName({ apiId: api.id, name: stageName }).catch(() => null);
  if (!stage) throw new HttpError(404, "not_found", "Stage does not exist.");
  if (version !== null) {
    const record = typeof db.getDocumentationVersion === "function"
      ? await db.getDocumentationVersion({ apiId: api.id, version }).catch(() => null)
      : null;
    if (!record) throw new HttpError(404, "not_found", "Documentation version does not exist.");
  }
  const before = { documentationVersion: stage.documentation_version ?? null };
  const next = await db.updateStage({ id: stage.id, patch: { documentation_version: version, version: (stage.version ?? 1) + 1 } });
  await audit(db, actor, {
    action: "stage.documentation_version", resourceType: "stage", resourceId: stage.id,
    projectId, apiId: api.id, before, after: { documentationVersion: next.documentation_version ?? null }, requestId,
  });
  return { stage: stage.name, documentationVersion: next.documentation_version ?? null };
}

// --- Clone support (S03 extension point) ----------------------------------------
// API clone copies documentation parts so the copy keeps its docs; versions
// are point-in-time snapshots and intentionally do not clone.
registerCloneHandler(async (db, { projectId, sourceApiId, targetApiId }) => {
  if (typeof db.listDocumentationParts !== "function" || typeof db.insertDocumentationPart !== "function") return;
  const parts = await db.listDocumentationParts({ apiId: sourceApiId }).catch(() => []);
  for (const part of parts) {
    await db.insertDocumentationPart({
      id: randomUUID(),
      project_id: projectId,
      api_id: targetApiId,
      location: part.location,
      location_key: part.location_key ?? locationKey(part.location),
      properties: part.properties,
      created_by: part.created_by ?? null,
    }).catch(() => null);
  }
}, {
  // F16 compensation: remove the parts copied to the target API.
  rollback: async (db, { targetApiId }) => {
    if (typeof db.listDocumentationParts !== "function" || typeof db.deleteDocumentationPart !== "function") return;
    const parts = await db.listDocumentationParts({ apiId: targetApiId }).catch(() => []);
    for (const part of parts) {
      await db.deleteDocumentationPart({ id: part.id }).catch(() => null);
    }
  },
});

/**
 * Imports documentation alone from an OpenAPI file carrying
 * `x-amazon-apigateway-documentation` (`mode=overwrite|merge`).
 */
export async function importDocumentation(db, actor, { projectId, apiId, body, options = {}, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Documentation import is only available on REST APIs.");
  }
  await requirePermission(db, actor, "pods.documentation.write", { projectId, apiId: api.id });
  const mode = options.mode ?? "merge";
  if (mode !== "overwrite" && mode !== "merge") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.mode: must be one of overwrite, merge");
  }
  const raw = body && typeof body === "object" && ("document" in body) ? body.document : body;
  let doc;
  try {
    ({ doc } = parseDocument(raw));
  } catch (error) {
    throw new HttpError(422, "invalid_input", error.message);
  }
  const ext = doc["x-amazon-apigateway-documentation"] ?? doc["x-pods-documentation"] ?? null;
  if (!ext || !Array.isArray(ext.documentationParts)) {
    throw new HttpError(422, "invalid_input", "Document has no x-amazon-apigateway-documentation.documentationParts array.");
  }
  if (options.failOnWarnings) {
    // Documentation-only import has no warnings of its own.
  }
  if (options.dryRun) {
    return { dryRun: true, parts: ext.documentationParts.length, mode };
  }
  let added = 0;
  let updated = 0;
  if (mode === "overwrite") {
    const existing = await db.listDocumentationParts({ apiId: api.id }).catch(() => []);
    for (const row of existing) await db.deleteDocumentationPart({ id: row.id });
  }
  const known = mode === "merge" ? await db.listDocumentationParts({ apiId: api.id }).catch(() => []) : [];
  const byKey = new Map(known.map((row) => [locationKey(row.location), row]));
  for (const entry of ext.documentationParts.slice(0, MAX_PARTS_PER_API)) {
    if (!entry || typeof entry !== "object") continue;
    let clean;
    try {
      clean = cleanLocation(entry.location);
    } catch {
      continue;
    }
    const props = entry.properties && typeof entry.properties === "object" ? entry.properties : {};
    const key = locationKey(clean);
    const current = byKey.get(key);
    if (current) {
      await db.updateDocumentationPart({ id: current.id, patch: { properties: props, version: (current.version ?? 1) + 1 } });
      updated += 1;
    } else {
      const row = await db.insertDocumentationPart({
        id: randomUUID(), project_id: projectId, api_id: api.id,
        location: clean, location_key: key, properties: props,
        created_by: actor?.userId ?? null,
      });
      byKey.set(key, row);
      added += 1;
    }
  }
  await audit(db, actor, {
    action: "documentation.import", resourceType: "api", resourceId: api.id,
    projectId, apiId: api.id, before: null, after: { mode, added, updated }, requestId,
  });
  return { mode, added, updated };
}

/** Exports the stage's documentation version (or current parts). */
export async function exportDocumentation(db, actor, { projectId, apiId, stageName = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.api.export", { projectId });
  let snapshot = null;
  let version = null;
  if (stageName && typeof db.getDocumentationVersion === "function") {
    const stage = await db.getStageByName({ apiId: api.id, name: stageName }).catch(() => null);
    if (!stage) throw new HttpError(404, "not_found", "Stage does not exist.");
    if (stage.documentation_version) {
      const record = await db.getDocumentationVersion({ apiId: api.id, version: stage.documentation_version }).catch(() => null);
      if (record) {
        snapshot = record.snapshot ?? [];
        version = record.version;
      }
    }
  }
  if (!snapshot) {
    const parts = typeof db.listDocumentationParts === "function"
      ? await db.listDocumentationParts({ apiId: api.id })
      : [];
    snapshot = parts.map((row) => ({ location: row.location, properties: row.properties }));
  }
  return {
    "x-amazon-apigateway-documentation": {
      version: version ?? "working",
      documentationParts: snapshot,
    },
  };
}
