// Playground fake for the v1 API: the API catalog (`/apis`, `/apis/:apiId`),
// after app/api/v1/projects/[projectId]/apis/** and lib/control/apis.mjs.

import {
  PROJECT_ID, ACTOR_ID, audit, bodyOf, checkVersion, created, fail, live, newId, newPublicId, nowIso, page, resolveApi, routes, table, update,
} from "./http.js";

// Copy of lib/control/apis.mjs toApiView().
export function toApiView(row) {
  return {
    id: row.id, publicId: row.public_id, projectId: row.project_id,
    name: row.name, description: row.description ?? "",
    protocol: row.protocol, apiVersion: row.api_version ?? null,
    endpointType: row.endpoint_type ?? "REGIONAL", ipAddressType: row.ip_address_type ?? "ipv4",
    disableDefaultEndpoint: row.disable_default_endpoint ?? false,
    apiKeySource: row.api_key_source ?? "HEADER",
    apiKeySelectionExpression: row.api_key_selection_expression ?? null,
    binaryMediaTypes: row.binary_media_types ?? [],
    minimumCompressionSize: row.minimum_compression_size ?? null,
    routeSelectionExpression: row.route_selection_expression ?? null,
    cors: row.cors ?? null, resourcePolicy: row.resource_policy ?? null,
    missingRouteBehavior: row.missing_route_behavior ?? "aws",
    tags: row.tags ?? {}, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const PROTOCOLS = ["REST", "HTTP", "WEBSOCKET"];

// camelCase input field -> snake_case column (lib/control/apis.mjs cleanApiInput).
const FIELDS = {
  name: "name", description: "description", apiVersion: "api_version", endpointType: "endpoint_type",
  ipAddressType: "ip_address_type", disableDefaultEndpoint: "disable_default_endpoint", apiKeySource: "api_key_source",
  apiKeySelectionExpression: "api_key_selection_expression", binaryMediaTypes: "binary_media_types",
  minimumCompressionSize: "minimum_compression_size", routeSelectionExpression: "route_selection_expression",
  cors: "cors", resourcePolicy: "resource_policy", missingRouteBehavior: "missing_route_behavior", tags: "tags",
};

function cleanInput(input) {
  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "protocol" || key === "quickCreate") continue;
    const column = FIELDS[key];
    if (!column) fail(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
    clean[column] = value;
  }
  if ("name" in clean && (typeof clean.name !== "string" || clean.name.trim().length < 1 || clean.name.length > 128)) {
    fail(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
  }
  return clean;
}

function checkUniqueName(name, exceptId = null) {
  if (live("apis", (api) => api.project_id === PROJECT_ID && api.name === name && api.id !== exceptId).length > 0) {
    fail(409, "conflict", `An API named "${name}" already exists.`);
  }
}

function apiRow(input) {
  const now = nowIso();
  return {
    id: newId(), project_id: PROJECT_ID, public_id: newPublicId(), name: "", description: "", protocol: "REST",
    api_version: null, endpoint_type: "REGIONAL", ip_address_type: "ipv4", disable_default_endpoint: false,
    api_key_source: "HEADER", api_key_selection_expression: null, binary_media_types: [], minimum_compression_size: null,
    route_selection_expression: null, cors: null, resource_policy: null, missing_route_behavior: "aws", tags: {},
    metadata: {}, created_by: ACTOR_ID, created_at: now, updated_at: now, deleted_at: null, version: 1,
    ...input,
  };
}

function rootResource(api) {
  const now = nowIso();
  table("rest_resources").push({
    id: newId(), project_id: PROJECT_ID, api_id: api.id, parent_id: null, path_part: "", path: "/",
    metadata: {}, created_by: ACTOR_ID, created_at: now, updated_at: now, deleted_at: null, version: 1,
  });
}

function createApi(ctx) {
  const input = bodyOf(ctx);
  if (!PROTOCOLS.includes(input.protocol)) fail(422, "invalid_input", `Invalid request: $.protocol: must be one of ${PROTOCOLS.join(", ")}`);
  const clean = cleanInput({ ...input, name: input.name });
  checkUniqueName(clean.name);
  const row = apiRow({
    ...clean,
    protocol: input.protocol,
    api_key_selection_expression: input.protocol === "WEBSOCKET" ? clean.api_key_selection_expression ?? "$request.header.x-api-key" : clean.api_key_selection_expression ?? null,
  });
  table("apis").push(row);
  if (row.protocol === "REST") rootResource(row);
  let quickCreatePending = null;
  if (input.quickCreate) {
    if (row.protocol !== "HTTP") fail(422, "invalid_input", "quickCreate is only available for HTTP APIs.");
    const now = nowIso();
    table("http_routes").push({
      id: newId(), project_id: PROJECT_ID, api_id: row.id, route_key: "$default", authorization_type: "NONE",
      authorizer_id: null, authorization_scopes: [], api_key_required: false, integration_id: null, operation_name: "",
      request_parameters: {}, request_models: {}, model_selection_expression: null, route_response_selection_expression: null,
      metadata: {}, created_by: ACTOR_ID, created_at: now, updated_at: now, deleted_at: null, version: 1,
    });
    quickCreatePending = "The playground doesn't provision backends; the $default route was created without an integration.";
  }
  const after = toApiView(row);
  audit({ action: "api.create", resourceType: "api", resourceId: row.id, apiId: row.id, after });
  return created(quickCreatePending ? { ...after, quickCreatePending } : after);
}

function updateApi(ctx) {
  const existing = resolveApi(ctx.params.apiId);
  const patch = bodyOf(ctx);
  if (Object.keys(patch).length === 0) fail(422, "invalid_input", "Provide at least one API field to update.");
  if (patch.protocol !== undefined && patch.protocol !== existing.protocol) {
    fail(422, "invalid_input", "The API protocol is immutable; create a new API instead.");
  }
  checkVersion(existing, ctx.request);
  const clean = cleanInput(patch);
  if (clean.name !== undefined && clean.name !== existing.name) checkUniqueName(clean.name, existing.id);
  const before = toApiView(existing);
  update(existing, clean);
  const after = toApiView(existing);
  audit({ action: "api.update", resourceType: "api", resourceId: existing.id, apiId: existing.id, before, after });
  return after;
}

function deleteApi(ctx) {
  const existing = resolveApi(ctx.params.apiId);
  const before = toApiView(existing);
  existing.deleted_at = nowIso();
  existing.version += 1;
  audit({ action: "api.delete", resourceType: "api", resourceId: existing.id, apiId: existing.id, before });
  return { id: existing.id, deleted: true };
}

function uniqueCloneName(base) {
  let name = `${base} (copy)`;
  for (let attempt = 1; live("apis", (api) => api.name === name).length > 0; attempt += 1) name = `${base} (copy ${attempt + 1})`;
  return name;
}

// Clone copies the draft (resources, methods, routes) like cloneApi().
function cloneApi(ctx) {
  const source = resolveApi(ctx.params.apiId);
  const input = bodyOf(ctx);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : uniqueCloneName(source.name);
  checkUniqueName(name);
  const now = nowIso();
  const target = apiRow({ ...source, id: newId(), public_id: newPublicId(), name, created_by: ACTOR_ID, created_at: now, updated_at: now, deleted_at: null, version: 1 });
  table("apis").push(target);
  const resourceIds = new Map();
  const resources = live("rest_resources", (row) => row.api_id === source.id).sort((a, b) => a.path.length - b.path.length);
  for (const row of resources) {
    const id = newId();
    resourceIds.set(row.id, id);
    table("rest_resources").push({ ...row, id, api_id: target.id, parent_id: row.parent_id ? resourceIds.get(row.parent_id) ?? null : null, created_at: now, updated_at: now, version: 1 });
  }
  for (const row of live("rest_methods", (method) => method.api_id === source.id)) {
    table("rest_methods").push({ ...row, id: newId(), api_id: target.id, resource_id: resourceIds.get(row.resource_id), integration_id: null, created_at: now, updated_at: now, version: 1 });
  }
  for (const row of live("http_routes", (route) => route.api_id === source.id)) {
    table("http_routes").push({ ...row, id: newId(), api_id: target.id, integration_id: null, created_at: now, updated_at: now, version: 1 });
  }
  const after = toApiView(target);
  audit({ action: "api.clone", resourceType: "api", resourceId: target.id, apiId: target.id, after });
  return created(after);
}

export const catalogRoutes = routes([
  ["GET", "/apis", ({ query }) => listApis(query)],
  ["POST", "/apis", createApi],
  ["GET", "/apis/:apiId", ({ params }) => toApiView(resolveApi(params.apiId))],
  ["PATCH", "/apis/:apiId", updateApi],
  ["DELETE", "/apis/:apiId", deleteApi],
  ["POST", "/apis/:apiId/clone", cloneApi],
]);

// Newest first by created_at, like db.listApis().
function listApis(query) {
  const rows = live("apis", (api) => api.project_id === PROJECT_ID)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const result = page(rows, query);
  return { items: result.items.map(toApiView), nextCursor: result.nextCursor };
}
