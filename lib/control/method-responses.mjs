/**
 * Method responses control-plane service (S06 §1).
 * `pods.method_responses`: per-method `status_code` rows with
 * `response_parameters` (`{"method.response.header.X": true}` = required)
 * and `response_models` (content type → model name). Writes need
 * `pods.route.write`; reads need `pods.apis.view`.
 *
 * @module lib/control/method-responses
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";

const STATUS_PATTERN = /^[1-5]\d\d$/;
const PARAM_KEY = /^method\.response\.header\.[A-Za-z0-9_.\-]+$/;

function checkStatusCode(statusCode) {
  if (!STATUS_PATTERN.test(String(statusCode ?? ""))) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.statusCode: must match ^[1-5]\\d\\d$");
  }
  return String(statusCode);
}

function checkParameters(parameters) {
  if (parameters === undefined) return {};
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.responseParameters: expected an object");
  }
  for (const [key, value] of Object.entries(parameters)) {
    if (!PARAM_KEY.test(key)) {
      throw new HttpError(422, "invalid_input", `Invalid request: responseParameters key "${key}" must be method.response.header.<name>`);
    }
    if (typeof value !== "boolean") {
      throw new HttpError(422, "invalid_input", `Invalid request: responseParameters["${key}"]: expected a boolean (true = required)`);
    }
  }
  return { ...parameters };
}

function checkModels(models) {
  if (models === undefined) return {};
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.responseModels: expected an object");
  }
  for (const [contentType, name] of Object.entries(models)) {
    if (typeof name !== "string" || name.length === 0) {
      throw new HttpError(422, "invalid_input", `Invalid request: responseModels["${contentType}"]: expected a model name`);
    }
  }
  return { ...models };
}

function toView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    apiId: row.api_id,
    methodId: row.method_id,
    statusCode: row.status_code,
    responseParameters: row.response_parameters ?? {},
    responseModels: row.response_models ?? {},
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scoped(projectId, methodId, row) {
  if (!row || row.project_id !== projectId || String(row.method_id) !== String(methodId)) {
    throw new HttpError(404, "not_found", "Method response does not exist.");
  }
  return row;
}

async function checkResponseModels(db, { projectId, apiId }, models) {
  const names = Object.values(models ?? {});
  if (names.length === 0) return;
  const known = new Set((await db.listModels({ projectId, apiId })).map((row) => row.name));
  for (const name of names) {
    if (!known.has(name) && !["Empty", "Error"].includes(name)) {
      throw new HttpError(422, "invalid_input", `Unknown model "${name}".`);
    }
  }
}

export async function listMethodResponses(db, actor, { projectId, apiId, methodId }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId, apiId });
  return (await db.listMethodResponses({ methodId })).map(toView);
}

export async function getMethodResponse(db, actor, { projectId, apiId, methodId, statusCode }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId, apiId });
  return toView(scoped(projectId, methodId, await db.getMethodResponse({ methodId, statusCode: String(statusCode) })));
}

export async function createMethodResponse(db, actor, { projectId, apiId, methodId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId });
  const statusCode = checkStatusCode(input?.statusCode);
  const responseParameters = checkParameters(input?.responseParameters);
  const responseModels = checkModels(input?.responseModels);
  for (const key of Object.keys(input ?? {})) {
    if (!["statusCode", "responseParameters", "responseModels"].includes(key)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
    }
  }
  if (await db.getMethodResponse({ methodId, statusCode })) {
    throw new HttpError(409, "conflict", `A ${statusCode} response already exists for this method.`);
  }
  await checkResponseModels(db, { projectId, apiId }, responseModels);
  const saved = await db.insertMethodResponse({
    project_id: projectId,
    api_id: apiId,
    method_id: methodId,
    status_code: statusCode,
    response_parameters: responseParameters,
    response_models: responseModels,
  });
  await audit(db, actor, {
    action: "method_response.create",
    resourceType: "method_response",
    resourceId: saved.id,
    projectId,
    apiId: String(apiId),
    after: toView(saved),
    requestId,
  });
  return toView(saved);
}

export async function updateMethodResponse(db, actor, { projectId, apiId, methodId, statusCode, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId });
  const current = scoped(projectId, methodId, await db.getMethodResponse({ methodId, statusCode: String(statusCode) }));
  if (expectedVersion !== null && expectedVersion !== current.version) {
    throw new HttpError(409, "version_conflict", `Method response changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const responseParameters = patch && Object.hasOwn(patch, "responseParameters") ? checkParameters(patch.responseParameters) : current.response_parameters;
  const responseModels = patch && Object.hasOwn(patch, "responseModels") ? checkModels(patch.responseModels) : current.response_models;
  await checkResponseModels(db, { projectId, apiId }, responseModels);
  const saved = await db.updateMethodResponse({
    id: current.id,
    response_parameters: responseParameters,
    response_models: responseModels,
    version: current.version + 1,
  });
  await audit(db, actor, {
    action: "method_response.update",
    resourceType: "method_response",
    resourceId: current.id,
    projectId,
    apiId: String(apiId),
    before: toView(current),
    after: toView(saved),
    requestId,
  });
  return toView(saved);
}

export async function deleteMethodResponse(db, actor, { projectId, apiId, methodId, statusCode, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId });
  const current = scoped(projectId, methodId, await db.getMethodResponse({ methodId, statusCode: String(statusCode) }));
  if (expectedVersion !== null && expectedVersion !== current.version) {
    throw new HttpError(409, "version_conflict", `Method response changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  await db.deleteMethodResponse({ id: current.id });
  await audit(db, actor, {
    action: "method_response.delete",
    resourceType: "method_response",
    resourceId: current.id,
    projectId,
    apiId: String(apiId),
    before: toView(current),
    requestId,
  });
  return { id: current.id, deleted: true };
}
