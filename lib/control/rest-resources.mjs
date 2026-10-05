// REST resource + method service (S03 §4). Owns `pods.rest_resources` and
// `pods.rest_methods`; every operation requires `pods.route.write` scoped to
// the API. Draft invariants (single variable sibling, greedy-is-leaf,
// literal uniqueness) are enforced here; the migration backs them with
// unique indexes and a path-maintenance trigger.

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi, parsePaging, toPage } from "./apis.mjs";
import { parsePathPart } from "../gateway/core/match/path-parts.mjs";

export const REST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"];
export const AUTHORIZATION_TYPES = ["NONE", "SIGNED", "JWT", "CUSTOM"];

/** Resolve a resource row, scoped to the API (404 otherwise). */
export async function resolveResource(db, api, resourceId) {
  const row = await db.getResourceById({ id: resourceId });
  if (!row || row.api_id !== api.id || row.project_id !== api.project_id) {
    throw new HttpError(404, "not_found", "Resource does not exist.");
  }
  return row;
}

function segmentKind(pathPart) {
  try {
    return parsePathPart(pathPart).kind;
  } catch {
    return "literal";
  }
}

/** Validate one path part, mapping grammar errors to 422. */
function cleanPathPart(pathPart) {
  if (typeof pathPart !== "string" || pathPart === "" || pathPart.includes("/")) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.pathPart: must be a single non-empty path segment.");
  }
  try {
    return parsePathPart(pathPart);
  } catch (error) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.pathPart: ${error.message}`);
  }
}

function rejectUnknown(input, allowed, what) {
  for (const key of Object.keys(input ?? {})) {
    if (!allowed.has(key)) throw new HttpError(422, "invalid_input", `Invalid request: $${what}.${key}: unknown field`);
  }
}

function checkString(value, path, { min = 1, max = 1024 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new HttpError(422, "invalid_input", `Invalid request: $${path}: must be a string of ${min}–${max} characters`);
  }
  return value;
}

function checkIdOrNull(value, path) {
  if (value === null || value === undefined) return null;
  return checkString(value, path, { min: 1, max: 128 });
}

function checkStringMap(value, path, valueKind) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $${path}: expected an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    const ok = valueKind === "boolean" ? typeof entry === "boolean" : typeof entry === "string";
    if (!ok) {
      throw new HttpError(422, "invalid_input", `Invalid request: $${path}.${key}: expected ${valueKind === "boolean" ? "a boolean" : "a string"}`);
    }
  }
  return { ...value };
}

const AUTH_FIELDS = new Set(["authorizationType", "authorizerId", "authorizationScopes", "apiKeyRequired", "operationName"]);

/**
 * Shared authorization-field validation for methods and routes.
 * @param {object} input raw input.
 * @param {{ partial: boolean, apiKeyAllowed: boolean }} options
 */
export function cleanAuthFields(input, { partial, apiKeyAllowed }) {
  const clean = {};
  if (input.authorizationType !== undefined) {
    if (!AUTHORIZATION_TYPES.includes(input.authorizationType)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.authorizationType: must be one of ${AUTHORIZATION_TYPES.join(", ")}`);
    }
    clean.authorization_type = input.authorizationType;
  } else if (!partial) {
    clean.authorization_type = "NONE";
  }
  if (input.authorizerId !== undefined) clean.authorizer_id = checkIdOrNull(input.authorizerId, "authorizerId");
  if (input.authorizationScopes !== undefined) {
    if (!Array.isArray(input.authorizationScopes)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.authorizationScopes: expected an array");
    }
    clean.authorization_scopes = input.authorizationScopes.map((scope) => checkString(scope, "authorizationScopes[]", { min: 1, max: 256 }));
  } else if (!partial) {
    clean.authorization_scopes = [];
  }
  if (input.apiKeyRequired !== undefined) {
    if (typeof input.apiKeyRequired !== "boolean") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.apiKeyRequired: expected a boolean");
    }
    if (input.apiKeyRequired && !apiKeyAllowed) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.apiKeyRequired: API keys are only enforced on WebSocket routes and REST methods.");
    }
    clean.api_key_required = input.apiKeyRequired;
  } else if (!partial) {
    clean.api_key_required = false;
  }
  if (input.operationName !== undefined) {
    clean.operation_name = checkString(input.operationName, "operationName", { min: 1, max: 256 });
  } else if (!partial) {
    clean.operation_name = "";
  }
  return clean;
}

const METHOD_FIELDS = new Set([...AUTH_FIELDS, "requestValidatorId", "requestParameters", "requestModels", "integrationId", "settings"]);

function cleanMethodFields(input, { partial }) {
  rejectUnknown(input, METHOD_FIELDS, "");
  const clean = cleanAuthFields(input, { partial, apiKeyAllowed: true });
  if (input.requestValidatorId !== undefined) clean.request_validator_id = checkIdOrNull(input.requestValidatorId, "requestValidatorId");
  else if (!partial) clean.request_validator_id = null;
  if (input.requestParameters !== undefined) clean.request_parameters = checkStringMap(input.requestParameters, "requestParameters", "boolean");
  else if (!partial) clean.request_parameters = {};
  if (input.requestModels !== undefined) clean.request_models = checkStringMap(input.requestModels, "requestModels", "string");
  else if (!partial) clean.request_models = {};
  if (input.integrationId !== undefined) clean.integration_id = checkIdOrNull(input.integrationId, "integrationId");
  else if (!partial) clean.integration_id = null;
  if (input.settings !== undefined) {
    if (typeof input.settings !== "object" || input.settings === null || Array.isArray(input.settings)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.settings: expected an object");
    }
    clean.settings = { ...input.settings };
  } else if (!partial) {
    clean.settings = {};
  }
  return clean;
}

export function normalizeHttpMethod(value) {
  const method = String(value ?? "").toUpperCase();
  if (!REST_METHODS.includes(method)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.httpMethod: must be one of ${REST_METHODS.join(", ")}`);
  }
  return method;
}

export function toResourceView(row) {
  return {
    id: row.id, apiId: row.api_id, parentId: row.parent_id ?? null,
    pathPart: row.path_part, path: row.path, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function toMethodView(row) {
  return {
    id: row.id, apiId: row.api_id, resourceId: row.resource_id, httpMethod: row.http_method,
    authorizationType: row.authorization_type, authorizerId: row.authorizer_id ?? null,
    authorizationScopes: row.authorization_scopes ?? [], apiKeyRequired: row.api_key_required ?? false,
    operationName: row.operation_name ?? "", requestValidatorId: row.request_validator_id ?? null,
    requestParameters: row.request_parameters ?? {}, requestModels: row.request_models ?? {},
    integrationId: row.integration_id ?? null, settings: row.settings ?? {},
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// --- Internal row helpers (no permission checks; callers already checked) ---

/** @internal */
export async function insertResourceRow(db, row) {
  return db.insertResource(row);
}

/** @internal all non-deleted resources of an API. */
export async function listResourceRows(db, apiId) {
  return db.listResourcesByApi({ apiId });
}

/** @internal all non-deleted methods of an API. */
export async function listMethodRows(db, apiId) {
  return db.listMethodsByApi({ apiId });
}

/** @internal */
export async function insertMethodRow(db, row) {
  return db.insertMethod(row);
}

// --- Resources ---

/** List draft resources (flat; the UI builds the tree client-side). */
export async function listResources(db, actor, { projectId, apiId, limit = 25, cursor = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId: api.id });
  const { take, decoded } = parsePaging({ limit, cursor });
  const rows = await db.listResources({ apiId: api.id, limit: take + 1, cursor: decoded });
  return toPage(rows, take, toResourceView);
}

/**
 * Create a child resource. Enforces the AWS sibling rules: literal
 * duplicates conflict (409), and a level holds at most one variable part.
 */
export async function createResource(db, actor, { projectId, apiId, parentId, pathPart, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId: api.id });
  if (api.protocol !== "REST") {
    throw new HttpError(422, "invalid_input", "REST resources can only be created on REST APIs.");
  }
  if (parentId === null || parentId === undefined) {
    throw new HttpError(422, "invalid_input", "The root resource \"/\" is created with the API and cannot be recreated.");
  }
  const segment = cleanPathPart(pathPart);
  const parent = await resolveResource(db, api, parentId);
  if (segmentKind(parent.path.split("/").pop() ?? "") === "greedy" && parent.path !== "/") {
    throw new HttpError(422, "invalid_input", "A greedy {proxy+} resource cannot have children.");
  }
  const siblings = await db.listChildResources({ apiId: api.id, parentId: parent.id });
  if (siblings.some((sibling) => sibling.path_part === pathPart)) {
    throw new HttpError(409, "conflict", `A resource "${pathPart}" already exists under this parent.`);
  }
  if (segment.kind !== "literal" && siblings.some((sibling) => segmentKind(sibling.path_part) !== "literal")) {
    throw new HttpError(409, "conflict", "A level may hold at most one variable part (AWS rule).");
  }
  const path = parent.path === "/" ? `/${pathPart}` : `${parent.path}/${pathPart}`;
  const row = await insertResourceRow(db, {
    project_id: projectId, api_id: api.id, parent_id: parent.id, path_part: pathPart, path,
  });
  await audit(db, actor, {
    action: "resource.create", resourceType: "rest_resource", resourceId: row.id,
    projectId, apiId: api.id, before: null, after: toResourceView(row), requestId,
  });
  return { status: 201, body: toResourceView(row) };
}

/** Rename a resource (PATCH), rewriting descendant paths with it. */
export async function renameResource(db, actor, { projectId, apiId, resourceId, pathPart, expectedVersion = null, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId: api.id });
  const row = await resolveResource(db, api, resourceId);
  if (row.path === "/") {
    throw new HttpError(422, "invalid_input", "The root resource \"/\" cannot be renamed.");
  }
  if (expectedVersion !== null && row.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Resource changed (expected version ${expectedVersion}, found ${row.version}).`);
  }
  if (pathPart === undefined || pathPart === row.path_part) return toResourceView(row);
  const segment = cleanPathPart(pathPart);
  const siblings = (await db.listChildResources({ apiId: api.id, parentId: row.parent_id }))
    .filter((sibling) => sibling.id !== row.id);
  if (siblings.some((sibling) => sibling.path_part === pathPart)) {
    throw new HttpError(409, "conflict", `A resource "${pathPart}" already exists under this parent.`);
  }
  if (segment.kind !== "literal" && siblings.some((sibling) => segmentKind(sibling.path_part) !== "literal")) {
    throw new HttpError(409, "conflict", "A level may hold at most one variable part (AWS rule).");
  }
  const all = await db.listResourcesByApi({ apiId: api.id });
  const hasChildren = all.some((entry) => entry.id !== row.id && entry.path.startsWith(`${row.path}/`));
  if (hasChildren && segment.kind === "greedy") {
    throw new HttpError(422, "invalid_input", "A greedy {proxy+} resource cannot have children.");
  }
  const before = toResourceView(row);
  const base = row.path.slice(0, Math.max(0, row.path.length - row.path_part.length));
  const nextPath = `${base.endsWith("/") ? base.slice(0, -1) : base}/${pathPart}`;
  const updated = await db.updateResource({ id: row.id, patch: { path_part: pathPart, path: nextPath, version: row.version + 1 } });
  const descendants = all
    .filter((entry) => entry.id !== row.id && entry.path.startsWith(`${row.path}/`))
    .sort((a, b) => a.path.length - b.path.length);
  for (const child of descendants) {
    await db.updateResource({ id: child.id, patch: { path: `${nextPath}${child.path.slice(row.path.length)}` } });
  }
  const after = toResourceView(updated);
  await audit(db, actor, {
    action: "resource.update", resourceType: "rest_resource", resourceId: row.id,
    projectId, apiId: api.id, before, after, requestId,
  });
  return after;
}

/** Delete a resource; children require `recursive: true`. */
export async function deleteResource(db, actor, { projectId, apiId, resourceId, recursive = false, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId: api.id });
  const row = await resolveResource(db, api, resourceId);
  if (row.path === "/") {
    throw new HttpError(422, "invalid_input", "The root resource \"/\" cannot be deleted.");
  }
  const all = await db.listResourcesByApi({ apiId: api.id });
  const doomed = all.filter((entry) => entry.id === row.id || entry.path === row.path || entry.path.startsWith(`${row.path}/`));
  if (doomed.length > 1 && !recursive) {
    throw new HttpError(409, "conflict", `Resource has ${doomed.length - 1} descendant(s); pass recursive=true to delete the branch.`);
  }
  const before = toResourceView(row);
  const methodIds = (await db.listMethodsByApi({ apiId: api.id }))
    .filter((method) => doomed.some((entry) => entry.id === method.resource_id))
    .map((method) => method.id);
  if (methodIds.length > 0) await db.deleteMethods({ ids: methodIds });
  await db.deleteResources({ ids: doomed.map((entry) => entry.id) });
  await audit(db, actor, {
    action: "resource.delete", resourceType: "rest_resource", resourceId: row.id,
    projectId, apiId: api.id, before, after: null, requestId,
  });
  return { id: row.id, deleted: true, deletedResources: doomed.length };
}

// --- Methods ---

function resolveMethodRow(db, api, resource, httpMethod) {
  return db.getMethod({ resourceId: resource.id, httpMethod });
}

/** PUT a method (create or full replace). */
export async function putMethod(db, actor, { projectId, apiId, resourceId, httpMethod, fields = {}, expectedVersion = null, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId: api.id });
  if (api.protocol !== "REST") {
    throw new HttpError(422, "invalid_input", "Methods can only be defined on REST APIs.");
  }
  const resource = await resolveResource(db, api, resourceId);
  const method = normalizeHttpMethod(httpMethod);
  const clean = cleanMethodFields(fields ?? {}, { partial: false });
  const existing = await resolveMethodRow(db, api, resource, method);
  if (!existing) {
    const row = await insertMethodRow(db, { project_id: projectId, api_id: api.id, resource_id: resource.id, http_method: method, ...clean });
    await audit(db, actor, {
      action: "method.put", resourceType: "rest_method", resourceId: row.id,
      projectId, apiId: api.id, before: null, after: toMethodView(row), requestId,
    });
    return { status: 201, body: toMethodView(row) };
  }
  if (expectedVersion !== null && existing.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Method changed (expected version ${expectedVersion}, found ${existing.version}).`);
  }
  const before = toMethodView(existing);
  const row = await db.updateMethod({ id: existing.id, patch: { ...clean, version: existing.version + 1 } });
  await audit(db, actor, {
    action: "method.update", resourceType: "rest_method", resourceId: row.id,
    projectId, apiId: api.id, before, after: toMethodView(row), requestId,
  });
  return { status: 200, body: toMethodView(row) };
}

/** GET one method (404 when the resource matches but has no such method). */
export async function getMethod(db, actor, { projectId, apiId, resourceId, httpMethod }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId: api.id });
  const resource = await resolveResource(db, api, resourceId);
  const row = await resolveMethodRow(db, api, resource, normalizeHttpMethod(httpMethod));
  if (!row) throw new HttpError(404, "not_found", "Method does not exist.");
  return toMethodView(row);
}

/** PATCH a method. */
export async function patchMethod(db, actor, { projectId, apiId, resourceId, httpMethod, patch, expectedVersion = null, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId: api.id });
  const resource = await resolveResource(db, api, resourceId);
  const existing = await resolveMethodRow(db, api, resource, normalizeHttpMethod(httpMethod));
  if (!existing) throw new HttpError(404, "not_found", "Method does not exist.");
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new HttpError(422, "invalid_input", "Provide at least one method field to update.");
  }
  if (expectedVersion !== null && existing.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Method changed (expected version ${expectedVersion}, found ${existing.version}).`);
  }
  const clean = cleanMethodFields(patch, { partial: true });
  const before = toMethodView(existing);
  const row = await db.updateMethod({ id: existing.id, patch: { ...clean, version: existing.version + 1 } });
  await audit(db, actor, {
    action: "method.update", resourceType: "rest_method", resourceId: row.id,
    projectId, apiId: api.id, before, after: toMethodView(row), requestId,
  });
  return toMethodView(row);
}

/** DELETE a method. */
export async function deleteMethod(db, actor, { projectId, apiId, resourceId, httpMethod, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId: api.id });
  const resource = await resolveResource(db, api, resourceId);
  const existing = await resolveMethodRow(db, api, resource, normalizeHttpMethod(httpMethod));
  if (!existing) throw new HttpError(404, "not_found", "Method does not exist.");
  const before = toMethodView(existing);
  await db.deleteMethods({ ids: [existing.id] });
  await audit(db, actor, {
    action: "method.delete", resourceType: "rest_method", resourceId: existing.id,
    projectId, apiId: api.id, before, after: null, requestId,
  });
  return { id: existing.id, deleted: true };
}
