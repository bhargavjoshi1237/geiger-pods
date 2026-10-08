/**
 * Route responses service (S12 §1). Owns `pods.route_responses`: one
 * `$default` response per WebSocket route carrying `response_models` +
 * `model_selection_expression` for two-way integrations.
 *
 * @module lib/control/route-responses
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi } from "./apis.mjs";

function checkKey(value) {
  if (typeof value !== "string" || !value || value.length > 128) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.routeResponseKey: must be a non-empty string of at most 128 characters");
  }
  if (value !== "$default") {
    throw new HttpError(422, "invalid_input", 'Invalid request: $.routeResponseKey: must be "$default".');
  }
  return value;
}

function checkModels(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.responseModels: expected an object");
  }
  return { ...value };
}

function checkExpression(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value || value.length > 512) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.modelSelectionExpression: must be a string of 1–512 characters");
  }
  return value;
}

export function toRouteResponseView(row) {
  return {
    id: row.id,
    routeId: row.route_id,
    apiId: row.api_id,
    routeResponseKey: row.route_response_key,
    responseModels: row.response_models ?? {},
    modelSelectionExpression: row.model_selection_expression ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function scopedRoute(db, actor, projectId, apiId, routeId) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId: api.id });
  if (api.protocol !== "WEBSOCKET") {
    throw new HttpError(400, "capability_unsupported", "Route responses are only available on WebSocket APIs.");
  }
  const route = await db.getRouteById?.({ id: routeId }) ?? null;
  if (!route || route.api_id !== api.id) {
    throw new HttpError(404, "not_found", "Route does not exist.");
  }
  return { api, route };
}

/** List route responses for one route. */
export async function listRouteResponses(db, actor, { projectId, apiId, routeId }) {
  await scopedRoute(db, actor, projectId, apiId, routeId);
  const rows = await db.listRouteResponses?.({ routeId }) ?? [];
  return { items: rows.map(toRouteResponseView), nextCursor: null };
}

/** Create the `$default` route response (one per route, 409 on dup). */
export async function createRouteResponse(db, actor, { projectId, apiId, routeId, routeResponseKey = "$default", responseModels, modelSelectionExpression, requestId = null }) {
  const { api } = await scopedRoute(db, actor, projectId, apiId, routeId);
  const key = checkKey(routeResponseKey);
  const existing = await db.getRouteResponseByKey?.({ routeId, key }) ?? null;
  if (existing) throw new HttpError(409, "conflict", `A route response with key "${key}" already exists.`);
  const row = await db.insertRouteResponse({
    project_id: projectId,
    api_id: api.id,
    route_id: routeId,
    route_response_key: key,
    response_models: checkModels(responseModels),
    model_selection_expression: checkExpression(modelSelectionExpression),
  });
  await audit(db, actor, {
    action: "route-response.create", resourceType: "route_response", resourceId: row.id,
    projectId, apiId: api.id, before: null, after: toRouteResponseView(row), requestId,
  });
  return { status: 201, body: toRouteResponseView(row) };
}

/** Delete a route response. */
export async function deleteRouteResponse(db, actor, { projectId, apiId, routeId, responseId, requestId = null }) {
  const { api } = await scopedRoute(db, actor, projectId, apiId, routeId);
  const row = await db.getRouteResponseById?.({ id: responseId }) ?? null;
  if (!row || row.route_id !== routeId) throw new HttpError(404, "not_found", "Route response does not exist.");
  await db.deleteRouteResponse({ id: row.id });
  await audit(db, actor, {
    action: "route-response.delete", resourceType: "route_response", resourceId: row.id,
    projectId, apiId: api.id, before: toRouteResponseView(row), after: null, requestId,
  });
  return { id: row.id, deleted: true };
}
