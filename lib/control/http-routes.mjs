// HTTP/WS route service (S03 §4). Owns `pods.http_routes`; every operation
// requires `pods.route.write` scoped to the API. HTTP route keys follow the
// strict `<METHOD> <path>` grammar (validated by the pure matcher);
// WebSocket route keys are free strings (route semantics arrive in S12).

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { parsePaging, resolveApi, toPage } from "./apis.mjs";
import { cleanAuthFields } from "./rest-resources.mjs";
import { RoutePatternError, parseHttpRouteKey } from "../gateway/core/match/http-routes.mjs";

const ROUTE_FIELDS = new Set([
  "routeKey", "authorizationType", "authorizerId", "authorizationScopes",
  "apiKeyRequired", "operationName", "integrationId", "requestParameters",
  "requestModels", "modelSelectionExpression", "routeResponseSelectionExpression",
]);

const WS_ONLY_FIELDS = new Set([
  "requestParameters", "requestModels", "modelSelectionExpression", "routeResponseSelectionExpression",
]);

function rejectUnknown(input, allowed) {
  for (const key of Object.keys(input ?? {})) {
    if (!allowed.has(key)) throw new HttpError(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
  }
}

function checkIdOrNull(value, path) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${path}: must be a string of 1–128 characters`);
  }
  return value;
}

/**
 * Validates route fields. `routeKey` is grammar-checked against the API
 * protocol (strict for HTTP, free string for WS); WS-only columns are
 * rejected with `capability_unsupported` on HTTP routes.
 */
function cleanRouteFields(input, { partial, protocol }) {
  rejectUnknown(input, ROUTE_FIELDS);
  const clean = {};
  if (input.routeKey !== undefined) {
    if (typeof input.routeKey !== "string" || input.routeKey === "" || input.routeKey.length > 512) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.routeKey: must be a non-empty string of at most 512 characters");
    }
    if (protocol === "WEBSOCKET") {
      clean.route_key = input.routeKey;
    } else {
      try {
        parseHttpRouteKey(input.routeKey);
      } catch (error) {
        if (error instanceof RoutePatternError) {
          throw new HttpError(422, "invalid_input", `Invalid request: $.routeKey: ${error.message}`);
        }
        throw error;
      }
      clean.route_key = input.routeKey;
    }
  } else if (!partial) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.routeKey: expected a string");
  }
  Object.assign(clean, cleanAuthFields(input, { partial, apiKeyAllowed: protocol === "WEBSOCKET" }));
  if (input.apiKeyRequired === true && protocol !== "WEBSOCKET") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.apiKeyRequired: API keys are only enforced on WebSocket routes.");
  }
  if (input.integrationId !== undefined) clean.integration_id = checkIdOrNull(input.integrationId, "integrationId");
  else if (!partial) clean.integration_id = null;
  for (const field of ["requestParameters", "requestModels"]) {
    if (input[field] !== undefined) {
      const value = input[field];
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new HttpError(422, "invalid_input", `Invalid request: $.${field}: expected an object`);
      }
      if (protocol !== "WEBSOCKET" && Object.keys(value).length > 0) {
        throw new HttpError(400, "capability_unsupported", `Invalid request: $.${field}: only WebSocket routes carry ${field}.`);
      }
      clean[field === "requestParameters" ? "request_parameters" : "request_models"] = { ...value };
    } else if (!partial) {
      clean[field === "requestParameters" ? "request_parameters" : "request_models"] = {};
    }
  }
  for (const field of ["modelSelectionExpression", "routeResponseSelectionExpression"]) {
    const column = field === "modelSelectionExpression" ? "model_selection_expression" : "route_response_selection_expression";
    if (input[field] !== undefined) {
      if (protocol !== "WEBSOCKET") {
        throw new HttpError(400, "capability_unsupported", `Invalid request: $.${field}: only WebSocket routes carry ${field}.`);
      }
      clean[column] = checkIdOrNull(input[field], field);
    } else if (!partial) {
      clean[column] = null;
    }
  }
  void WS_ONLY_FIELDS;
  return clean;
}

export function toRouteView(row) {
  return {
    id: row.id, apiId: row.api_id, routeKey: row.route_key,
    authorizationType: row.authorization_type, authorizerId: row.authorizer_id ?? null,
    authorizationScopes: row.authorization_scopes ?? [], apiKeyRequired: row.api_key_required ?? false,
    integrationId: row.integration_id ?? null, operationName: row.operation_name ?? "",
    requestParameters: row.request_parameters ?? {}, requestModels: row.request_models ?? {},
    modelSelectionExpression: row.model_selection_expression ?? null,
    routeResponseSelectionExpression: row.route_response_selection_expression ?? null,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// --- Internal row helpers (no permission checks; callers already checked) ---

/** @internal */
export async function insertRouteRow(db, row) {
  return db.insertRoute(row);
}

/** @internal all non-deleted routes of an API. */
export async function listRouteRows(db, apiId) {
  return db.listRoutesByApi({ apiId });
}

async function scoped(db, actor, projectId, apiId) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId: api.id });
  if (api.protocol === "REST") {
    throw new HttpError(422, "invalid_input", "HTTP routes are only available on HTTP and WebSocket APIs.");
  }
  return api;
}

async function resolveRoute(db, api, routeId) {
  const row = await db.getRouteById({ id: routeId });
  if (!row || row.api_id !== api.id || row.project_id !== api.project_id) {
    throw new HttpError(404, "not_found", "Route does not exist.");
  }
  return row;
}

/** List draft routes. */
export async function listRoutes(db, actor, { projectId, apiId, limit = 25, cursor = null }) {
  const api = await scoped(db, actor, projectId, apiId);
  const { take, decoded } = parsePaging({ limit, cursor });
  const rows = await db.listRoutes({ apiId: api.id, limit: take + 1, cursor: decoded });
  return toPage(rows, take, toRouteView);
}

/** Create a route. Duplicate keys conflict (409); bad keys fail (422). */
export async function createRoute(db, actor, { projectId, apiId, routeKey, requestId = null, ...fields }) {
  const api = await scoped(db, actor, projectId, apiId);
  const clean = cleanRouteFields({ ...fields, routeKey }, { partial: false, protocol: api.protocol });
  if (await db.getRouteByKey({ apiId: api.id, routeKey: clean.route_key })) {
    throw new HttpError(409, "conflict", `A route with key "${clean.route_key}" already exists.`);
  }
  const row = await insertRouteRow(db, { project_id: projectId, api_id: api.id, ...clean });
  await audit(db, actor, {
    action: "route.create", resourceType: "http_route", resourceId: row.id,
    projectId, apiId: api.id, before: null, after: toRouteView(row), requestId,
  });
  return { status: 201, body: toRouteView(row) };
}

/** GET one route. */
export async function getRoute(db, actor, { projectId, apiId, routeId }) {
  const api = await scoped(db, actor, projectId, apiId);
  return toRouteView(await resolveRoute(db, api, routeId));
}

/** PATCH a route (key changes revalidate and recheck uniqueness). */
export async function updateRoute(db, actor, { projectId, apiId, routeId, patch, expectedVersion = null, requestId = null }) {
  const api = await scoped(db, actor, projectId, apiId);
  const existing = await resolveRoute(db, api, routeId);
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new HttpError(422, "invalid_input", "Provide at least one route field to update.");
  }
  if (expectedVersion !== null && existing.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Route changed (expected version ${expectedVersion}, found ${existing.version}).`);
  }
  const clean = cleanRouteFields(patch, { partial: true, protocol: api.protocol });
  if (clean.route_key !== undefined && clean.route_key !== existing.route_key) {
    if (await db.getRouteByKey({ apiId: api.id, routeKey: clean.route_key })) {
      throw new HttpError(409, "conflict", `A route with key "${clean.route_key}" already exists.`);
    }
  }
  const before = toRouteView(existing);
  const row = await db.updateRoute({ id: existing.id, patch: { ...clean, version: existing.version + 1 } });
  await audit(db, actor, {
    action: "route.update", resourceType: "http_route", resourceId: row.id,
    projectId, apiId: api.id, before, after: toRouteView(row), requestId,
  });
  return toRouteView(row);
}

/** DELETE a route. */
export async function deleteRoute(db, actor, { projectId, apiId, routeId, requestId = null }) {
  const api = await scoped(db, actor, projectId, apiId);
  const existing = await resolveRoute(db, api, routeId);
  const before = toRouteView(existing);
  await db.deleteRoute({ id: existing.id });
  await audit(db, actor, {
    action: "route.delete", resourceType: "http_route", resourceId: existing.id,
    projectId, apiId: api.id, before, after: null, requestId,
  });
  return { id: existing.id, deleted: true };
}
