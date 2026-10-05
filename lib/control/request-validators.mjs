/**
 * Request validators control-plane service (S06 §1).
 * Writes need `pods.model.write` (API-scoped); reads need `pods.apis.view`.
 *
 * @module lib/control/request-validators
 */

import { v, validate } from "./validate.mjs";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";

const CREATE_SCHEMA = v.object({
  name: v.string({ min: 1, max: 128 }),
});

const PATCH_SCHEMA = v.object({});

function toBoolean(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new HttpError(422, "invalid_input", `Invalid request: $.${field}: expected a boolean`);
}

function toView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    apiId: row.api_id,
    name: row.name,
    validateRequestBody: row.validate_request_body,
    validateRequestParameters: row.validate_request_parameters,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scoped(projectId, apiId, row) {
  if (!row || row.project_id !== projectId || String(row.api_id) !== String(apiId)) {
    throw new HttpError(404, "not_found", "Request validator does not exist.");
  }
  return row;
}

export async function listRequestValidators(db, actor, { projectId, apiId }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId, apiId });
  return (await db.listRequestValidators({ projectId, apiId })).map(toView);
}

export async function getRequestValidator(db, actor, { projectId, apiId, validatorId }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId, apiId });
  return toView(scoped(projectId, apiId, await db.getRequestValidator({ id: validatorId })));
}

export async function createRequestValidator(db, actor, { projectId, apiId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.model.write", { projectId, apiId });
  const { name } = validate(CREATE_SCHEMA, { name: input?.name });
  for (const key of Object.keys(input ?? {})) {
    if (!["name", "validateRequestBody", "validateRequestParameters"].includes(key)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
    }
  }
  if (typeof input?.name !== "string" || input.name.length === 0) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name: expected a non-empty string");
  }
  if (input?.validateRequestBody !== undefined && typeof input.validateRequestBody !== "boolean") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.validateRequestBody: expected a boolean");
  }
  if (input?.validateRequestParameters !== undefined && typeof input.validateRequestParameters !== "boolean") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.validateRequestParameters: expected a boolean");
  }
  const existing = await db.listRequestValidators({ projectId, apiId });
  if (existing.some((row) => row.name === name)) {
    throw new HttpError(409, "conflict", `A request validator named "${name}" already exists.`);
  }
  const saved = await db.insertRequestValidator({
    project_id: projectId,
    api_id: apiId,
    name,
    validate_request_body: toBoolean(input.validateRequestBody, "validateRequestBody", true),
    validate_request_parameters: toBoolean(input.validateRequestParameters, "validateRequestParameters", false),
  });
  await audit(db, actor, {
    action: "request_validator.create",
    resourceType: "request_validator",
    resourceId: saved.id,
    projectId,
    apiId: String(apiId),
    after: toView(saved),
    requestId,
  });
  return toView(saved);
}

export async function updateRequestValidator(db, actor, { projectId, apiId, validatorId, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.model.write", { projectId, apiId });
  validate(PATCH_SCHEMA, {});
  const current = scoped(projectId, apiId, await db.getRequestValidator({ id: validatorId }));
  if (expectedVersion !== null && expectedVersion !== current.version) {
    throw new HttpError(409, "version_conflict", `Request validator changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const saved = await db.updateRequestValidator({
    id: current.id,
    validate_request_body: toBoolean(patch?.validateRequestBody, "validateRequestBody", current.validate_request_body),
    validate_request_parameters: toBoolean(patch?.validateRequestParameters, "validateRequestParameters", current.validate_request_parameters),
    version: current.version + 1,
  });
  await audit(db, actor, {
    action: "request_validator.update",
    resourceType: "request_validator",
    resourceId: current.id,
    projectId,
    apiId: String(apiId),
    before: toView(current),
    after: toView(saved),
    requestId,
  });
  return toView(saved);
}

export async function deleteRequestValidator(db, actor, { projectId, apiId, validatorId, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.model.write", { projectId, apiId });
  const current = scoped(projectId, apiId, await db.getRequestValidator({ id: validatorId }));
  if (expectedVersion !== null && expectedVersion !== current.version) {
    throw new HttpError(409, "version_conflict", `Request validator changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  await db.deleteRequestValidator({ id: current.id });
  await audit(db, actor, {
    action: "request_validator.delete",
    resourceType: "request_validator",
    resourceId: current.id,
    projectId,
    apiId: String(apiId),
    before: toView(current),
    requestId,
  });
  return { id: current.id, deleted: true };
}
