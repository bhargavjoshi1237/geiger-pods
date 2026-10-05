/**
 * Gateway responses control-plane service (S06 §1 + §9).
 * `pods.gateway_responses`: per-API customization rows, unique
 * `(api_id, response_type)`. Writes need `pods.gateway_response.write`
 * (API-scoped); reads need `pods.apis.view`. Templates are parse-checked at
 * write time; full selection happens in the data plane.
 *
 * @module lib/control/gateway-responses
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { GATEWAY_RESPONSES } from "../gateway/core/gateway-responses.mjs";
import { parseTemplate } from "../gateway/core/processing/templates/index.mjs";

const STATUS_PATTERN = /^[1-5]\d\d$/;
const GATEWAY_PARAM_KEY = /^gatewayresponse\.header\.[A-Za-z0-9_.\-]+$/i;

/** The 21 types with defaults and a "customized" flag for the UI tab. */
export function listResponseTypes(customized = []) {
  const names = new Set((customized ?? []).map((entry) => entry?.response_type ?? entry?.responseType));
  return Object.entries(GATEWAY_RESPONSES).map(([type, entry]) => ({
    type,
    defaultStatus: entry.status ?? (type === "DEFAULT_4XX" ? 400 : 500),
    defaultMessage: entry.message,
    customized: names.has(type),
  }));
}

function checkType(responseType) {
  if (!responseType || !GATEWAY_RESPONSES[responseType]) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.responseType: unknown gateway response type "${responseType ?? "(missing)"}"`);
  }
  return responseType;
}

function checkParameters(parameters) {
  if (parameters === undefined) return {};
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.responseParameters: expected an object");
  }
  for (const key of Object.keys(parameters)) {
    if (!GATEWAY_PARAM_KEY.test(key)) {
      throw new HttpError(422, "invalid_input", `Invalid request: responseParameters key "${key}" must be gatewayresponse.header.<name>`);
    }
    if (typeof parameters[key] !== "string") {
      throw new HttpError(422, "invalid_input", `Invalid request: responseParameters["${key}"]: expected a string expression`);
    }
  }
  return { ...parameters };
}

function checkTemplates(templates) {
  if (templates === undefined) return {};
  if (!templates || typeof templates !== "object" || Array.isArray(templates)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.responseTemplates: expected an object");
  }
  for (const [contentType, template] of Object.entries(templates)) {
    if (typeof template !== "string") {
      throw new HttpError(422, "invalid_input", `Invalid request: responseTemplates["${contentType}"]: expected a string`);
    }
    try {
      parseTemplate(template);
    } catch (error) {
      throw new HttpError(422, "invalid_input", `Invalid template for ${contentType}: ${error.message}`);
    }
  }
  return { ...templates };
}

function toView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    apiId: row.api_id,
    responseType: row.response_type,
    statusCode: row.status_code,
    responseParameters: row.response_parameters ?? {},
    responseTemplates: row.response_templates ?? {},
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scoped(projectId, apiId, row) {
  if (!row || row.project_id !== projectId || String(row.api_id) !== String(apiId)) {
    throw new HttpError(404, "not_found", "Gateway response does not exist.");
  }
  return row;
}

export async function listGatewayResponses(db, actor, { projectId, apiId }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId, apiId });
  return (await db.listGatewayResponses({ projectId, apiId })).map(toView);
}

export async function getGatewayResponse(db, actor, { projectId, apiId, responseType }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId, apiId });
  return toView(scoped(projectId, apiId, await db.getGatewayResponse({ apiId, responseType })));
}

export async function putGatewayResponse(db, actor, { projectId, apiId, responseType, input, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.gateway_response.write", { projectId, apiId });
  const type = checkType(responseType ?? input?.responseType);
  const statusCode = input?.statusCode === undefined || input?.statusCode === null
    ? null
    : STATUS_PATTERN.test(String(input.statusCode))
      ? String(input.statusCode)
      : (() => { throw new HttpError(422, "invalid_input", "Invalid request: $.statusCode: must match ^[1-5]\\d\\d$"); })();
  const responseParameters = checkParameters(input?.responseParameters);
  const responseTemplates = checkTemplates(input?.responseTemplates);
  const current = await db.getGatewayResponse({ apiId, responseType: type });
  if (current) {
    const row = scoped(projectId, apiId, current);
    if (expectedVersion !== null && expectedVersion !== row.version) {
      throw new HttpError(409, "version_conflict", `Gateway response changed (expected version ${expectedVersion}, found ${row.version}).`);
    }
    const saved = await db.updateGatewayResponse({
      id: row.id,
      status_code: statusCode,
      response_parameters: responseParameters,
      response_templates: responseTemplates,
      version: row.version + 1,
    });
    await audit(db, actor, {
      action: "gateway_response.update",
      resourceType: "gateway_response",
      resourceId: row.id,
      projectId,
      apiId: String(apiId),
      before: toView(row),
      after: toView(saved),
      requestId,
    });
    return toView(saved);
  }
  const saved = await db.insertGatewayResponse({
    project_id: projectId,
    api_id: apiId,
    response_type: type,
    status_code: statusCode,
    response_parameters: responseParameters,
    response_templates: responseTemplates,
  });
  await audit(db, actor, {
    action: "gateway_response.create",
    resourceType: "gateway_response",
    resourceId: saved.id,
    projectId,
    apiId: String(apiId),
    after: toView(saved),
    requestId,
  });
  return toView(saved);
}

/** Resets one type to the built-in default (deletes the customization). */
export async function resetGatewayResponse(db, actor, { projectId, apiId, responseType, requestId = null }) {
  await requirePermission(db, actor, "pods.gateway_response.write", { projectId, apiId });
  const current = scoped(projectId, apiId, await db.getGatewayResponse({ apiId, responseType }));
  await db.deleteGatewayResponse({ id: current.id });
  await audit(db, actor, {
    action: "gateway_response.reset",
    resourceType: "gateway_response",
    resourceId: current.id,
    projectId,
    apiId: String(apiId),
    before: toView(current),
    requestId,
  });
  return { responseType, reset: true };
}
