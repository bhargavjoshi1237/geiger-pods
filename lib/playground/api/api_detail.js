// Playground fake for the v1 API: Everything under /apis/:apiId/… : resources, methods, routes, integrations, authorizers, models, CORS, gateway responses, deployments, stages, docs, SDKs, agent tools, import/export.
// Served so far: HTTP/WS routes, integrations (+ responses), authorizers,
// managed CORS, deployments and stages — after lib/control/http-routes.mjs,
// integrations.mjs, authorizers.mjs, cors.mjs, deployments.mjs and stages.mjs.

import {
  PROJECT_ID, ACTOR_ID, audit, bodyOf, byNewest, byOldest, checkVersion, created, fail, live, newPublicId, insert, nowIso, page,
  resolveApi, routes, table, update,
} from "./http.js";

// --- Routes (HTTP / WebSocket) ---------------------------------------------

// Copy of lib/control/http-routes.mjs toRouteView().
function toRouteView(row) {
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

const ROUTE_FIELDS = {
  routeKey: "route_key", authorizationType: "authorization_type", authorizerId: "authorizer_id",
  authorizationScopes: "authorization_scopes", apiKeyRequired: "api_key_required", operationName: "operation_name",
  integrationId: "integration_id", requestParameters: "request_parameters", requestModels: "request_models",
  modelSelectionExpression: "model_selection_expression", routeResponseSelectionExpression: "route_response_selection_expression",
};

const HTTP_ROUTE_KEY = /^(\$default|(ANY|GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \/\S*)$/;

function routeApi(ref) {
  const api = resolveApi(ref);
  if (api.protocol === "REST") fail(422, "invalid_input", "HTTP routes are only available on HTTP and WebSocket APIs.");
  return api;
}

function findRoute(api, routeId) {
  const row = live("http_routes", (route) => route.api_id === api.id && route.id === routeId)[0];
  if (!row) fail(404, "not_found", "Route does not exist.");
  return row;
}

function cleanRouteInput(input, api) {
  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    const column = ROUTE_FIELDS[key];
    if (!column) fail(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
    clean[column] = value;
  }
  if ("route_key" in clean) {
    const key = clean.route_key;
    if (typeof key !== "string" || key === "" || key.length > 512) {
      fail(422, "invalid_input", "Invalid request: $.routeKey: must be a non-empty string of at most 512 characters");
    }
    if (api.protocol === "HTTP" && !HTTP_ROUTE_KEY.test(key)) {
      fail(422, "invalid_input", 'Invalid request: $.routeKey: expected "$default" or "<METHOD> /path"');
    }
  }
  if (clean.api_key_required === true && api.protocol !== "WEBSOCKET") {
    fail(422, "invalid_input", "Invalid request: $.apiKeyRequired: API keys are only enforced on WebSocket routes.");
  }
  return clean;
}

function checkUniqueRouteKey(api, routeKey, exceptId = null) {
  if (live("http_routes", (route) => route.api_id === api.id && route.route_key === routeKey && route.id !== exceptId).length > 0) {
    fail(409, "conflict", `A route with key "${routeKey}" already exists.`);
  }
}

function listRoutes({ params, query }) {
  const api = routeApi(params.apiId);
  const result = page(live("http_routes", (route) => route.api_id === api.id).sort(byOldest), query);
  return { items: result.items.map(toRouteView), nextCursor: result.nextCursor };
}

function createRoute(ctx) {
  const api = routeApi(ctx.params.apiId);
  const clean = cleanRouteInput(bodyOf(ctx), api);
  if (clean.route_key === undefined) fail(422, "invalid_input", "Invalid request: $.routeKey: expected a string");
  checkUniqueRouteKey(api, clean.route_key);
  const now = nowIso();
  const row = insert("http_routes", {
    project_id: PROJECT_ID, api_id: api.id, route_key: clean.route_key, authorization_type: "NONE", authorizer_id: null,
    authorization_scopes: [], api_key_required: false, integration_id: null, operation_name: "", request_parameters: {},
    request_models: {}, model_selection_expression: null, route_response_selection_expression: null, metadata: {},
    ...clean, created_by: ACTOR_ID, updated_at: now, deleted_at: null, version: 1,
  });
  audit({ action: "route.create", resourceType: "http_route", resourceId: row.id, apiId: api.id, after: toRouteView(row) });
  return created(toRouteView(row));
}

function updateRoute(ctx) {
  const api = routeApi(ctx.params.apiId);
  const existing = findRoute(api, ctx.params.routeId);
  const patch = bodyOf(ctx);
  if (Object.keys(patch).length === 0) fail(422, "invalid_input", "Provide at least one route field to update.");
  checkVersion(existing, ctx.request);
  const clean = cleanRouteInput(patch, api);
  if (clean.route_key !== undefined && clean.route_key !== existing.route_key) checkUniqueRouteKey(api, clean.route_key, existing.id);
  const before = toRouteView(existing);
  update(existing, clean);
  audit({ action: "route.update", resourceType: "http_route", resourceId: existing.id, apiId: api.id, before, after: toRouteView(existing) });
  return toRouteView(existing);
}

function deleteRoute(ctx) {
  const api = routeApi(ctx.params.apiId);
  const existing = findRoute(api, ctx.params.routeId);
  const before = toRouteView(existing);
  existing.deleted_at = nowIso();
  audit({ action: "route.delete", resourceType: "http_route", resourceId: existing.id, apiId: api.id, before });
  return { id: existing.id, deleted: true };
}

// --- Integrations ------------------------------------------------------------

// Copy of lib/control/integrations.mjs toView().
function toIntegrationView(row) {
  return {
    id: row.id, apiId: row.api_id, publicId: row.public_id, type: row.type,
    integrationMethod: row.integration_method, uri: row.uri, function: row.function ?? null, aws: row.aws ?? null,
    connectionType: row.connection_type, connectorId: row.connector_id, timeoutMs: row.timeout_ms,
    payloadFormatVersion: row.payload_format_version, passthroughBehavior: row.passthrough_behavior,
    contentHandling: row.content_handling ?? null, requestParameters: row.request_parameters ?? {},
    requestTemplates: row.request_templates ?? {}, responseParameters: row.response_parameters ?? {},
    templateSelectionExpression: row.template_selection_expression ?? null,
    cacheKeyParameters: row.cache_key_parameters ?? [], cacheNamespace: row.cache_namespace ?? null,
    responseTransferMode: row.response_transfer_mode ?? "BUFFERED",
    tls: row.tls ?? { insecureSkipVerification: false, serverNameToVerify: null },
    backendAuth: row.backend_auth ?? null, description: row.description ?? null,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// Copy of lib/control/integrations.mjs responseView().
function toIntegrationResponseView(row) {
  return {
    id: row.id, integrationId: row.integration_id, statusCode: row.status_code, selectionPattern: row.selection_pattern,
    responseParameters: row.response_parameters ?? {}, responseTemplates: row.response_templates ?? {},
    contentHandling: row.content_handling ?? null, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function findIntegration(api, integrationId) {
  const row = live("integrations", (integration) => integration.api_id === api.id && integration.id === integrationId)[0];
  if (!row) fail(404, "not_found", "Integration does not exist.");
  return row;
}

function listIntegrations({ params, query }) {
  const api = resolveApi(params.apiId);
  const result = page(live("integrations", (integration) => integration.api_id === api.id).sort(byOldest), query);
  return { items: result.items.map(toIntegrationView), nextCursor: result.nextCursor };
}

function listIntegrationResponses({ params }) {
  const integration = findIntegration(resolveApi(params.apiId), params.integrationId);
  const rows = live("integration_responses", (response) => response.integration_id === integration.id)
    .sort((a, b) => a.status_code - b.status_code);
  return { items: rows.map(toIntegrationResponseView) };
}

// --- Authorizers ---------------------------------------------------------------

// Copy of lib/control/authorizers.mjs toView().
function toAuthorizerView(row) {
  return {
    id: row.id, projectId: row.project_id, apiId: row.api_id, publicId: row.public_id, name: row.name, type: row.type,
    identitySource: row.identity_source ?? [], identityValidationExpression: row.identity_validation_expression ?? null,
    jwt: row.jwt ?? null, function: row.function ?? null, payloadFormatVersion: row.payload_format_version ?? null,
    enableSimpleResponses: row.enable_simple_responses ?? false, resultTtlSeconds: row.result_ttl_seconds ?? 300,
    timeoutMs: row.timeout_ms ?? 10000, credentialsRef: row.credentials_ref ?? null,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const AUTHORIZER_FIELDS = {
  name: "name", type: "type", identitySource: "identity_source", identityValidationExpression: "identity_validation_expression",
  jwt: "jwt", function: "function", payloadFormatVersion: "payload_format_version",
  enableSimpleResponses: "enable_simple_responses", resultTtlSeconds: "result_ttl_seconds", timeoutMs: "timeout_ms",
  credentialsRef: "credentials_ref",
};

function findAuthorizer(api, authorizerId) {
  const row = table("authorizers").find((authorizer) => authorizer.api_id === api.id && authorizer.id === authorizerId);
  if (!row) fail(404, "not_found", "Authorizer does not exist.");
  return row;
}

// The light end of lib/control/authorizers.mjs checkAuthorizerInput().
function cleanAuthorizerInput(input, api, existing = null) {
  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    const column = AUTHORIZER_FIELDS[key];
    if (!column) fail(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
    clean[column] = value;
  }
  const merged = { ...existing, ...clean };
  if (typeof merged.name !== "string" || merged.name.length < 1 || merged.name.length > 128) {
    fail(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
  }
  if (!["JWT", "TOKEN", "REQUEST"].includes(merged.type)) {
    fail(422, "invalid_input", `Invalid authorizer: authorizer.type: Unknown authorizer type "${merged.type}". Expected one of JWT, TOKEN, REQUEST.`);
  }
  if (merged.type === "JWT" && api.protocol === "WEBSOCKET") {
    fail(400, "capability_unsupported", "Invalid authorizer: authorizer: JWT authorizers are not supported for this protocol.");
  }
  if (!Array.isArray(merged.identity_source) || merged.identity_source.length === 0) {
    fail(422, "invalid_input", "Invalid authorizer: authorizer.identitySource: identitySource must be a non-empty array.");
  }
  if (merged.type === "JWT" && !merged.jwt?.issuer) {
    fail(422, "invalid_input", "Invalid authorizer: authorizer.jwt.issuer: JWT authorizers require an issuer.");
  }
  if (merged.type !== "JWT" && !merged.function?.provider) {
    fail(422, "invalid_input", "Invalid request: $.function: custom authorizers require a function target");
  }
  if (merged.type === "JWT") clean.function = null;
  else clean.jwt = null;
  return clean;
}

function checkUniqueAuthorizerName(api, name, exceptId = null) {
  if (table("authorizers").some((row) => row.api_id === api.id && row.name === name && row.id !== exceptId)) {
    fail(409, "conflict", `An authorizer named "${name}" already exists.`);
  }
}

function listAuthorizers({ params, query }) {
  const api = resolveApi(params.apiId);
  const result = page(table("authorizers").filter((row) => row.api_id === api.id).sort(byOldest), query);
  return { items: result.items.map(toAuthorizerView), nextCursor: result.nextCursor };
}

function createAuthorizer(ctx) {
  const api = resolveApi(ctx.params.apiId);
  const clean = cleanAuthorizerInput(bodyOf(ctx), api);
  checkUniqueAuthorizerName(api, clean.name);
  const row = insert("authorizers", {
    project_id: PROJECT_ID, api_id: api.id, public_id: newPublicId(8), identity_validation_expression: null, jwt: null,
    function: null, payload_format_version: null, enable_simple_responses: false, result_ttl_seconds: 300, timeout_ms: 10000,
    credentials_ref: null, ...clean, created_by: ACTOR_ID, updated_at: nowIso(), version: 1,
  });
  const after = toAuthorizerView(row);
  audit({ action: "authorizer.create", resourceType: "authorizer", resourceId: row.id, apiId: api.id, after });
  return created(after);
}

function updateAuthorizer(ctx) {
  const api = resolveApi(ctx.params.apiId);
  const existing = findAuthorizer(api, ctx.params.authorizerId);
  const patch = bodyOf(ctx);
  if (Object.keys(patch).length === 0) fail(422, "invalid_input", "Provide at least one authorizer field to update.");
  checkVersion(existing, ctx.request);
  const clean = cleanAuthorizerInput(patch, api, existing);
  if (clean.name !== undefined && clean.name !== existing.name) checkUniqueAuthorizerName(api, clean.name, existing.id);
  const before = toAuthorizerView(existing);
  update(existing, clean);
  const after = toAuthorizerView(existing);
  audit({ action: "authorizer.update", resourceType: "authorizer", resourceId: existing.id, apiId: api.id, before, after });
  return after;
}

function deleteAuthorizer(ctx) {
  const api = resolveApi(ctx.params.apiId);
  const existing = findAuthorizer(api, ctx.params.authorizerId);
  const before = toAuthorizerView(existing);
  const rows = table("authorizers");
  rows.splice(rows.indexOf(existing), 1);
  audit({ action: "authorizer.delete", resourceType: "authorizer", resourceId: existing.id, apiId: api.id, before });
  return { id: existing.id, deleted: true };
}

// --- CORS (HTTP APIs' managed config on the API row) ---------------------------

const CORS_KEYS = ["allowOrigins", "allowMethods", "allowHeaders", "exposeHeaders", "maxAge", "allowCredentials"];

function corsView(api) {
  return { apiId: api.id, cors: api.cors ?? null, version: api.version ?? 0 };
}

function cleanCors(input) {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail(422, "invalid_input", "Invalid request: CORS config must be an object or null");
  }
  for (const key of Object.keys(input)) {
    if (!CORS_KEYS.includes(key)) fail(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
  }
  const config = {
    allowOrigins: input.allowOrigins ?? [], allowMethods: input.allowMethods ?? [], allowHeaders: input.allowHeaders ?? [],
    exposeHeaders: input.exposeHeaders ?? [], maxAge: input.maxAge ?? null, allowCredentials: input.allowCredentials ?? false,
  };
  if (config.allowCredentials && config.allowOrigins.includes("*")) {
    fail(422, "invalid_input", "allowCredentials cannot be combined with a wildcard allowOrigins.");
  }
  return config;
}

function putCors(ctx, input) {
  const api = resolveApi(ctx.params.apiId);
  const cors = cleanCors(input);
  checkVersion(api, ctx.request);
  const before = { cors: api.cors ?? null };
  update(api, { cors });
  audit({ action: "cors.update", resourceType: "api_cors", resourceId: api.id, apiId: api.id, before, after: { cors } });
  return corsView(api);
}

// --- Deployments and stages ------------------------------------------------------

// Copy of lib/control/deployments.mjs toView().
function toDeploymentView(row) {
  return {
    id: row.id, projectId: row.project_id, apiId: row.api_id, publicId: row.public_id, description: row.description ?? "",
    digest: row.digest, schemaVersion: row.schema_version ?? 1, warnings: row.warnings ?? [],
    createdBy: row.created_by ?? null, createdAt: row.created_at,
  };
}

// Copy of lib/control/stages.mjs toView().
function toStageView(row) {
  return {
    id: row.id, projectId: row.project_id, apiId: row.api_id, name: row.name, deploymentId: row.deployment_id ?? null,
    description: row.description ?? "", variables: row.variables ?? {}, autoDeploy: row.auto_deploy ?? false,
    clientCertificateId: row.client_certificate_id ?? null, defaultRouteSettings: row.default_route_settings ?? {},
    routeSettings: row.route_settings ?? {}, methodSettings: row.method_settings ?? {}, accessLog: row.access_log ?? null,
    tracingEnabled: row.tracing_enabled ?? false, cacheClusterEnabled: row.cache_cluster_enabled ?? false,
    cacheClusterSize: row.cache_cluster_size ?? null, canary: row.canary ?? null,
    lastDeploymentStatusMessage: row.last_deployment_status_message ?? null, tags: row.tags ?? {},
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// lib/control/stages.mjs buildInvokeUrl() on the default gateway domain.
const GATEWAY_DOMAIN = "gw.geigerpods.app";

function invokeUrl(api, stage) {
  const host = `${api.public_id}.${GATEWAY_DOMAIN}`;
  return stage === "$default" ? `https://${host}/` : `https://${host}/${stage}`;
}

function listDeployments({ params, query }) {
  const api = resolveApi(params.apiId);
  const result = page(table("deployments").filter((row) => row.api_id === api.id).sort(byNewest), query);
  return { items: result.items.map(toDeploymentView), nextCursor: result.nextCursor };
}

function listStages({ params }) {
  const api = resolveApi(params.apiId);
  const rows = table("stages").filter((row) => row.api_id === api.id).sort(byOldest);
  return { items: rows.map((row) => ({ ...toStageView(row), invokeUrl: invokeUrl(api, row.name) })), nextCursor: null };
}

export const apiDetailRoutes = routes([
  ["GET", "/apis/:apiId/routes", listRoutes],
  ["POST", "/apis/:apiId/routes", createRoute],
  ["GET", "/apis/:apiId/routes/:routeId", ({ params }) => toRouteView(findRoute(routeApi(params.apiId), params.routeId))],
  ["PATCH", "/apis/:apiId/routes/:routeId", updateRoute],
  ["DELETE", "/apis/:apiId/routes/:routeId", deleteRoute],
  ["GET", "/apis/:apiId/integrations", listIntegrations],
  ["GET", "/apis/:apiId/integrations/:integrationId", ({ params }) => toIntegrationView(findIntegration(resolveApi(params.apiId), params.integrationId))],
  ["GET", "/apis/:apiId/integrations/:integrationId/responses", listIntegrationResponses],
  ["GET", "/apis/:apiId/authorizers", listAuthorizers],
  ["POST", "/apis/:apiId/authorizers", createAuthorizer],
  ["GET", "/apis/:apiId/authorizers/:authorizerId", ({ params }) => toAuthorizerView(findAuthorizer(resolveApi(params.apiId), params.authorizerId))],
  ["PATCH", "/apis/:apiId/authorizers/:authorizerId", updateAuthorizer],
  ["DELETE", "/apis/:apiId/authorizers/:authorizerId", deleteAuthorizer],
  ["GET", "/apis/:apiId/cors", ({ params }) => corsView(resolveApi(params.apiId))],
  ["PUT", "/apis/:apiId/cors", (ctx) => putCors(ctx, ctx.body === undefined ? null : ctx.body)],
  ["DELETE", "/apis/:apiId/cors", (ctx) => putCors(ctx, null)],
  ["GET", "/apis/:apiId/deployments", listDeployments],
  ["GET", "/apis/:apiId/stages", listStages],
]);
