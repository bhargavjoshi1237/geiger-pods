// API catalog service (S03 §4). Owns `pods.apis`: create/read/update/
// soft-delete/clone plus the draft `match` debug helper. Reads need
// `pods.apis.view`; writes need `pods.api.create` / `pods.api.update` /
// `pods.api.delete`. Route/resource writes keep their own `pods.route.write`
// checks inside their services.
//
// Clone copies only the tables that exist now. Later specs register their
// tables here instead of editing this file's clone flow:
//   import { registerCloneHandler } from "./apis.mjs";
//   registerCloneHandler(async (db, { projectId, sourceApiId, targetApiId, idMaps }) => { … });

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { newPublicId } from "../gateway/ids.mjs";
import { compileHttpRoutes, matchHttpRoute } from "../gateway/core/match/http-routes.mjs";
import { compileRestResources, matchRestResource } from "../gateway/core/match/rest-resources.mjs";
import {
  insertMethodRow,
  insertResourceRow,
  listMethodRows,
  listResourceRows,
} from "./rest-resources.mjs";
import { insertRouteRow, listRouteRows } from "./http-routes.mjs";

export const PROTOCOLS = ["REST", "HTTP", "WEBSOCKET"];

/**
 * Clone handlers registered by later specs (S04 integrations, S05 stages,
 * S06 models/validators/gateway-responses, S07 authorizers, S13 docs…).
 * Each receives `(db, { projectId, sourceApiId, targetApiId, idMaps })`
 * where `idMaps` holds `{ resources, methods, routes }` (old→new uuid).
 * @type {Array<Function>}
 */
export const CLONE_HANDLERS = [];

/** Later specs call this at module load to copy their tables during clone. */
export function registerCloneHandler(handler) {
  if (typeof handler !== "function") throw new TypeError("registerCloneHandler(handler) requires a function");
  CLONE_HANDLERS.push(handler);
}

/** Resolve an API by uuid or public id, scoped to the project (404 otherwise). */
export async function resolveApi(db, projectId, apiId) {
  const row = await db.getApiByRef({ projectId, ref: apiId });
  if (!row || row.project_id !== projectId) {
    throw new HttpError(404, "not_found", "API does not exist.");
  }
  return row;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (typeof parsed.createdAt === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$/.test(parsed.createdAt) && typeof parsed.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.id)) return parsed;
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_input", "Invalid pagination cursor.");
}

/** @internal shared cursor pagination parsing. */
export function parsePaging({ limit, cursor }) {
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return { take, decoded: cursor ? decodeCursor(cursor) : null };
}

/** @internal slice a limit+1 row window into `{ items, nextCursor }`. */
export function toPage(rows, take, map) {
  const items = rows.slice(0, take).map(map);
  const nextCursor = rows.length > take ? encodeCursor(rows[take - 1]) : null;
  return { items, nextCursor };
}

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

const CREATE_FIELDS = new Set([
  "name", "description", "protocol", "apiVersion", "endpointType", "ipAddressType",
  "disableDefaultEndpoint", "apiKeySource", "apiKeySelectionExpression",
  "binaryMediaTypes", "minimumCompressionSize", "routeSelectionExpression",
  "cors", "resourcePolicy", "missingRouteBehavior", "tags", "quickCreate",
]);

const UPDATE_FIELDS = new Set([...CREATE_FIELDS].filter((field) => field !== "protocol" && field !== "quickCreate"));

function checkName(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > 128) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
  }
  return name;
}

function checkOptionalString(value, path, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${path}: must be a string of 1–${max} characters`);
  }
  return value;
}

function checkBoolean(value, path) {
  if (typeof value !== "boolean") {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${path}: expected a boolean`);
  }
  return value;
}

function checkJsonObjectOrNull(value, path) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${path}: expected an object`);
  }
  return value;
}

/** Capability gates (S01 §7): AWS REST-only / HTTP-only / WS-only settings. */
function gateCapabilities(protocol, clean) {
  const unsupported = (field, want) =>
    new HttpError(400, "capability_unsupported", `Invalid request: $.${field}: only ${want} APIs carry ${field}.`);
  if (clean.endpoint_type !== "REGIONAL" && protocol !== "REST") throw unsupported("endpointType", "REST");
  if (clean.api_key_source !== "HEADER" && protocol !== "REST") throw unsupported("apiKeySource", "REST");
  if (clean.binary_media_types.length > 0 && protocol !== "REST") throw unsupported("binaryMediaTypes", "REST");
  if (clean.minimum_compression_size !== null && protocol !== "REST") throw unsupported("minimumCompressionSize", "REST");
  if (clean.resource_policy !== null && protocol !== "REST") throw unsupported("resourcePolicy", "REST");
  if (clean.cors !== null && protocol !== "HTTP") throw unsupported("cors", "HTTP");
  if (clean.route_selection_expression !== null && protocol !== "WEBSOCKET") throw unsupported("routeSelectionExpression", "WebSocket");
  if (clean.api_key_selection_expression !== null && protocol !== "WEBSOCKET") throw unsupported("apiKeySelectionExpression", "WebSocket");
  if (clean.missing_route_behavior !== "aws" && protocol !== "REST") throw unsupported("missingRouteBehavior", "REST");
}

/** Validates create/update input into a storage row patch. */
function cleanApiInput(input, { isUpdate }) {
  const allowed = isUpdate ? UPDATE_FIELDS : CREATE_FIELDS;
  for (const key of Object.keys(input ?? {})) {
    if (!allowed.has(key)) throw new HttpError(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
  }
  const clean = {};
  if (input.name !== undefined || !isUpdate) clean.name = checkName(input.name);
  if (input.description !== undefined) {
    if (typeof input.description !== "string" || input.description.length > 1024) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.description: must be a string of at most 1024 characters");
    }
    clean.description = input.description;
  } else if (!isUpdate) {
    clean.description = "";
  }
  if (!isUpdate) {
    if (!PROTOCOLS.includes(input.protocol)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.protocol: must be one of ${PROTOCOLS.join(", ")}`);
    }
    clean.protocol = input.protocol;
  }
  if (input.apiVersion !== undefined) clean.api_version = checkOptionalString(input.apiVersion, "apiVersion", 64);
  else if (!isUpdate) clean.api_version = null;
  if (input.endpointType !== undefined) {
    if (!["REGIONAL", "EDGE", "PRIVATE"].includes(input.endpointType)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.endpointType: must be one of REGIONAL, EDGE, PRIVATE");
    }
    clean.endpoint_type = input.endpointType;
  } else if (!isUpdate) {
    clean.endpoint_type = "REGIONAL";
  }
  if (input.ipAddressType !== undefined) {
    if (!["ipv4", "dualstack"].includes(input.ipAddressType)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.ipAddressType: must be one of ipv4, dualstack");
    }
    clean.ip_address_type = input.ipAddressType;
  } else if (!isUpdate) {
    clean.ip_address_type = "ipv4";
  }
  if (input.disableDefaultEndpoint !== undefined) clean.disable_default_endpoint = checkBoolean(input.disableDefaultEndpoint, "disableDefaultEndpoint");
  else if (!isUpdate) clean.disable_default_endpoint = false;
  if (input.apiKeySource !== undefined) {
    if (!["HEADER", "AUTHORIZER"].includes(input.apiKeySource)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.apiKeySource: must be one of HEADER, AUTHORIZER");
    }
    clean.api_key_source = input.apiKeySource;
  } else if (!isUpdate) {
    clean.api_key_source = "HEADER";
  }
  if (input.apiKeySelectionExpression !== undefined) {
    clean.api_key_selection_expression = checkOptionalString(input.apiKeySelectionExpression, "apiKeySelectionExpression", 256);
  } else if (!isUpdate) {
    clean.api_key_selection_expression = null;
  }
  if (input.binaryMediaTypes !== undefined) {
    if (!Array.isArray(input.binaryMediaTypes)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.binaryMediaTypes: expected an array");
    }
    clean.binary_media_types = input.binaryMediaTypes.map((entry) => {
      if (typeof entry !== "string" || entry === "" || entry.length > 256) {
        throw new HttpError(422, "invalid_input", "Invalid request: $.binaryMediaTypes[]: must be a non-empty string");
      }
      return entry;
    });
  } else if (!isUpdate) {
    clean.binary_media_types = [];
  }
  if (input.minimumCompressionSize !== undefined) {
    if (input.minimumCompressionSize !== null && (!Number.isInteger(input.minimumCompressionSize) || input.minimumCompressionSize < 0 || input.minimumCompressionSize > 10485760)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.minimumCompressionSize: must be null or an integer 0–10485760");
    }
    clean.minimum_compression_size = input.minimumCompressionSize;
  } else if (!isUpdate) {
    clean.minimum_compression_size = null;
  }
  if (input.routeSelectionExpression !== undefined) {
    clean.route_selection_expression = checkOptionalString(input.routeSelectionExpression, "routeSelectionExpression", 256);
  } else if (!isUpdate) {
    clean.route_selection_expression = null;
  }
  if (input.cors !== undefined) clean.cors = checkJsonObjectOrNull(input.cors, "cors");
  else if (!isUpdate) clean.cors = null;
  if (input.resourcePolicy !== undefined) clean.resource_policy = checkJsonObjectOrNull(input.resourcePolicy, "resourcePolicy");
  else if (!isUpdate) clean.resource_policy = null;
  if (input.missingRouteBehavior !== undefined) {
    if (!["aws", "not_found"].includes(input.missingRouteBehavior)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.missingRouteBehavior: must be one of aws, not_found");
    }
    clean.missing_route_behavior = input.missingRouteBehavior;
  } else if (!isUpdate) {
    clean.missing_route_behavior = "aws";
  }
  if (input.tags !== undefined) {
    if (typeof input.tags !== "object" || input.tags === null || Array.isArray(input.tags)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.tags: expected an object");
    }
    clean.tags = { ...input.tags };
  } else if (!isUpdate) {
    clean.tags = {};
  }
  return clean;
}

/**
 * HTTP quick-create provisioning (S03 §4 + S04 + S05).
 * Creates an `HTTP_PROXY` integration for `target`, attaches it to the
 * `$default` route, creates the `$default` stage with `autoDeploy`, and
 * triggers the first deployment.
 *
 * Called with no args (legacy stub probe) it still throws 501 so old callers
 * degrade to `quickCreatePending`. When the db port lacks the S04/S05 tables
 * it also throws 501 and `createApi` keeps the pending path.
 */
export async function provisionQuickCreateTarget(db = null, options = {}) {
  const { projectId, api, target, actor = null, requestId = null } = options ?? {};
  if (!db || !api || !target) {
    throw new HttpError(501, "not_implemented", "quickCreate requires S04/S05");
  }
  if (typeof target !== "string" || !/^https?:\/\//.test(target)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.quickCreate.target: must be an http(s) URL");
  }
  const required = ["insertIntegration", "getRouteByKey", "updateRoute", "getStageByName", "insertStage"];
  for (const method of required) {
    if (typeof db[method] !== "function") {
      throw new HttpError(501, "not_implemented", "quickCreate requires S04/S05");
    }
  }
  const { newPublicId: makeId } = await import("../gateway/ids.mjs");
  const integrationRow = await db.insertIntegration({
    project_id: projectId ?? api.project_id,
    api_id: api.id,
    public_id: makeId(),
    type: "HTTP_PROXY",
    integration_method: "ANY",
    uri: target,
    function: null,
    aws: null,
    connection_type: "INTERNET",
    connector_id: null,
    timeout_ms: 30000,
    payload_format_version: "2.0",
    passthrough_behavior: "WHEN_NO_MATCH",
    content_handling: null,
    tls: { insecureSkipVerification: false, serverNameToVerify: null },
    backend_auth: null,
    description: `quickCreate target ${target}`,
    created_by: actor?.userId ?? null,
  });
  let route = null;
  try {
    route = await db.getRouteByKey({ apiId: api.id, routeKey: "$default" });
  } catch {
    route = null;
  }
  if (!route && typeof db.listRoutesByApi === "function") {
    const all = await db.listRoutesByApi({ apiId: api.id }).catch(() => []);
    route = (all ?? []).find((entry) => entry.route_key === "$default") ?? null;
  }
  if (route) {
    await db.updateRoute({ id: route.id, patch: { integration_id: integrationRow.id, version: (route.version ?? 1) + 1 } });
  }
  let stage = null;
  try {
    stage = await db.getStageByName({ apiId: api.id, name: "$default" });
  } catch {
    stage = null;
  }
  if (!stage) {
    stage = await db.insertStage({
      project_id: projectId ?? api.project_id,
      api_id: api.id,
      name: "$default",
      deployment_id: null,
      description: "quickCreate $default stage",
      variables: {},
      auto_deploy: true,
      created_by: actor?.userId ?? null,
    });
    if (typeof db.insertStageHistory === "function") {
      try {
        await db.insertStageHistory({
          project_id: projectId ?? api.project_id,
          stage_id: stage.id,
          from_deployment_id: null,
          to_deployment_id: null,
          reason: "deploy",
          actor_id: actor?.userId ?? null,
        });
      } catch {
        // History is best-effort during provisioning.
      }
    }
  } else if (!stage.auto_deploy) {
    try {
      stage = await db.updateStage({ id: stage.id, patch: { auto_deploy: true, version: (stage.version ?? 1) + 1 } });
    } catch {
      // Keep the existing stage when the update races.
    }
  }
  try {
    const { compileDraft } = await import("./deployments.mjs");
    const { randomUUID } = await import("node:crypto");
    const { artifact, warnings } = await compileDraft(db, api);
    if (typeof db.insertDeployment === "function") {
      const deploymentRow = await db.insertDeployment({
        id: randomUUID(),
        project_id: projectId ?? api.project_id,
        api_id: api.id,
        public_id: makeId().slice(0, 6),
        description: "quickCreate initial deployment",
        artifact,
        digest: artifact.digest,
        schema_version: 1,
        warnings,
        created_by: actor?.userId ?? null,
      });
      const targetStage = await db.getStageByName({ apiId: api.id, name: "$default" }).catch(() => stage);
      if (targetStage && typeof db.updateStage === "function") {
        try {
          await db.updateStage({ id: targetStage.id, patch: { deployment_id: deploymentRow.id, version: (targetStage.version ?? 1) + 1 } });
        } catch {
          // Stage pointer races resolve via auto-deploy.
        }
      }
      if (typeof db.insertStageHistory === "function") {
        try {
          await db.insertStageHistory({
            project_id: projectId ?? api.project_id,
            stage_id: (targetStage ?? stage).id,
            from_deployment_id: null,
            to_deployment_id: deploymentRow.id,
            reason: "deploy",
            actor_id: actor?.userId ?? null,
          });
        } catch {
          // Best-effort.
        }
      }
      try {
        const { audit: writeAudit } = await import("./audit.mjs");
        await writeAudit(db, actor, {
          action: "deployment.create", resourceType: "deployment", resourceId: deploymentRow.id,
          projectId: projectId ?? api.project_id, apiId: api.id, before: null,
          after: { id: deploymentRow.id, digest: deploymentRow.digest }, requestId,
        });
      } catch {
        // Audit is best-effort during provisioning.
      }
      return { integrationId: integrationRow.id, stageId: (targetStage ?? stage)?.id ?? null, deploymentId: deploymentRow.id };
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 422) {
      return { integrationId: integrationRow.id, stageId: stage?.id ?? null, deploymentId: null, warning: error.message };
    }
    return { integrationId: integrationRow.id, stageId: stage?.id ?? null, deploymentId: null };
  }
  return { integrationId: integrationRow.id, stageId: stage?.id ?? null, deploymentId: null };
}

/** List APIs in a project. Supports `?tag:Key=Value` filters (F26). */
export async function listApis(db, actor, { projectId, limit = 25, cursor = null, tagFilters = [] }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const { take, decoded } = parsePaging({ limit, cursor });
  const rows = await db.listApis({ projectId, limit: take + 1, cursor: decoded });
  if (!tagFilters || tagFilters.length === 0) return toPage(rows, take, toApiView);
  const { matchesTagFilters, resolveResourceTags } = await import("./tags.mjs");
  const kept = [];
  for (const row of rows) {
    const tags = await resolveResourceTags(db, { projectId, resourceType: "api", resourceId: row.id, rowTags: row.tags });
    if (matchesTagFilters(tags, tagFilters)) kept.push(row);
  }
  const items = kept.slice(0, take).map(toApiView);
  const nextCursor = kept.length > take
    ? encodeCursor(kept[take - 1])
    : rows.length > take && kept.length > 0
      ? encodeCursor(kept[kept.length - 1])
      : rows.length > take
        ? encodeCursor(rows[take - 1])
        : null;
  return { items, nextCursor };
}

/** GET one API. */
export async function getApi(db, actor, { projectId, apiId }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  return toApiView(await resolveApi(db, projectId, apiId));
}

/** Create an API. REST APIs get their root `/` resource; HTTP quick-create gets a `$default` route. */
export async function createApi(db, actor, { projectId, requestId = null, quickCreate, ...input }) {
  await requirePermission(db, actor, "pods.api.create", { projectId });
  const clean = cleanApiInput(input, { isUpdate: false });
  gateCapabilities(clean.protocol, clean);
  if (await db.getApiByName({ projectId, name: clean.name })) {
    throw new HttpError(409, "conflict", `An API named "${clean.name}" already exists.`);
  }
  let quick = null;
  if (quickCreate !== undefined) {
    if (clean.protocol !== "HTTP") {
      throw new HttpError(422, "invalid_input", "quickCreate is only available for HTTP APIs.");
    }
    if (typeof quickCreate !== "object" || quickCreate === null || typeof quickCreate.target !== "string" || !/^https?:\/\//.test(quickCreate.target)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.quickCreate.target: must be an http(s) URL");
    }
    quick = { target: quickCreate.target };
  }
  if (clean.protocol === "WEBSOCKET" && clean.api_key_selection_expression === null) {
    clean.api_key_selection_expression = "$request.header.x-api-key";
  }
  const row = await db.insertApi({ project_id: projectId, public_id: newPublicId(), ...clean });
  if (clean.protocol === "REST") {
    await insertResourceRow(db, { project_id: projectId, api_id: row.id, parent_id: null, path_part: "", path: "/" });
  }
  let quickCreatePending = null;
  if (quick) {
    await insertRouteRow(db, {
      project_id: projectId, api_id: row.id, route_key: "$default",
      authorization_type: "NONE", authorizer_id: null, authorization_scopes: [],
      api_key_required: false, integration_id: null, operation_name: "",
      request_parameters: {}, request_models: {},
      model_selection_expression: null, route_response_selection_expression: null,
    });
    try {
      await provisionQuickCreateTarget(db, { projectId, api: row, target: quick.target, actor, requestId });
    } catch (error) {
      if (error instanceof HttpError && error.code === "not_implemented") {
        quickCreatePending = error.message;
      } else {
        throw error;
      }
    }
  }
  const after = toApiView(row);
  await audit(db, actor, {
    action: "api.create", resourceType: "api", resourceId: row.id,
    projectId, apiId: row.id, before: null,
    after: quickCreatePending ? { ...after, quickCreatePending } : after, requestId,
  });
  return {
    status: 201,
    body: quickCreatePending ? { ...after, quickCreatePending } : after,
  };
}

/** PATCH an API. `protocol` is immutable (422 on change). */
export async function updateApi(db, actor, { projectId, apiId, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.api.update", { projectId });
  const existing = await resolveApi(db, projectId, apiId);
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new HttpError(422, "invalid_input", "Provide at least one API field to update.");
  }
  if (patch.protocol !== undefined && patch.protocol !== existing.protocol) {
    throw new HttpError(422, "invalid_input", "The API protocol is immutable; create a new API instead.");
  }
  if (expectedVersion !== null && existing.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `API changed (expected version ${expectedVersion}, found ${existing.version}).`);
  }
  const { protocol: _ignored, ...rest } = patch;
  const clean = cleanApiInput(rest, { isUpdate: true });
  gateCapabilities(existing.protocol, {
    endpoint_type: clean.endpoint_type ?? existing.endpoint_type,
    api_key_source: clean.api_key_source ?? existing.api_key_source,
    binary_media_types: clean.binary_media_types ?? existing.binary_media_types ?? [],
    minimum_compression_size: clean.minimum_compression_size ?? existing.minimum_compression_size ?? null,
    resource_policy: clean.resource_policy ?? existing.resource_policy ?? null,
    cors: clean.cors ?? existing.cors ?? null,
    route_selection_expression: clean.route_selection_expression ?? existing.route_selection_expression ?? null,
    api_key_selection_expression: clean.api_key_selection_expression ?? existing.api_key_selection_expression ?? null,
    missing_route_behavior: clean.missing_route_behavior ?? existing.missing_route_behavior ?? "aws",
  });
  if (clean.name !== undefined && clean.name !== existing.name) {
    if (await db.getApiByName({ projectId, name: clean.name })) {
      throw new HttpError(409, "conflict", `An API named "${clean.name}" already exists.`);
    }
  }
  const before = toApiView(existing);
  const row = await db.updateApi({ id: existing.id, patch: { ...clean, version: existing.version + 1 } });
  await audit(db, actor, {
    action: "api.update", resourceType: "api", resourceId: row.id,
    projectId, apiId: row.id, before, after: toApiView(row), requestId,
  });
  return toApiView(row);
}

/** DELETE an API (soft delete; children become unreachable with it). */
export async function deleteApi(db, actor, { projectId, apiId, requestId = null }) {
  await requirePermission(db, actor, "pods.api.delete", { projectId });
  const existing = await resolveApi(db, projectId, apiId);
  const before = toApiView(existing);
  await db.softDeleteApi({ id: existing.id, version: existing.version + 1 });
  await audit(db, actor, {
    action: "api.delete", resourceType: "api", resourceId: existing.id,
    projectId, apiId: existing.id, before, after: null, requestId,
  });
  return { id: existing.id, deleted: true };
}

async function uniqueCloneName(db, projectId, base) {
  let name = `${base} (copy)`;
  for (let attempt = 1; attempt <= 100; attempt++) {
    if (!(await db.getApiByName({ projectId, name }))) return name;
    name = `${base} (copy ${attempt + 1})`;
  }
  throw new HttpError(409, "conflict", "Too many copies; rename one first.");
}

/**
 * Deep-copy an API draft (resources, methods, routes) with new ids, then
 * run {@link CLONE_HANDLERS} so later specs copy their tables too.
 */
export async function cloneApi(db, actor, { projectId, apiId, name = null, requestId = null }) {
  await requirePermission(db, actor, "pods.api.create", { projectId });
  const source = await resolveApi(db, projectId, apiId);
  const targetName = name !== null && name !== undefined ? checkName(name) : null;
  const finalName = targetName ?? await uniqueCloneName(db, projectId, source.name);
  if (targetName && await db.getApiByName({ projectId, name: targetName })) {
    throw new HttpError(409, "conflict", `An API named "${targetName}" already exists.`);
  }
  const { id: _sid, public_id: _spublic, created_at: _sc, updated_at: _su, version: _sv, deleted_at: _sd, ...sourceFields } = source;
  void _sid;
  void _spublic;
  void _sc;
  void _su;
  void _sv;
  void _sd;
  const sources = (await listResourceRows(db, source.id)).sort((a, b) => a.path.length - b.path.length);
  const sourceMethods = await listMethodRows(db, source.id);
  const sourceResourceIds = new Set(sources.map((resource) => resource.id));
  for (const method of sourceMethods) {
    if (!sourceResourceIds.has(method.resource_id)) {
      throw new HttpError(500, "internal_error", "Clone aborted: a method references a missing resource.");
    }
  }
  const target = await db.insertApi({
    ...sourceFields, project_id: projectId, public_id: newPublicId(), name: finalName, version: 1,
  });
  const idMaps = { resources: new Map(), methods: new Map(), routes: new Map() };
  for (const resource of sources) {
    const copied = await insertResourceRow(db, {
      project_id: projectId, api_id: target.id,
      parent_id: resource.parent_id === null ? null : idMaps.resources.get(resource.parent_id) ?? null,
      path_part: resource.path_part, path: resource.path,
    });
    idMaps.resources.set(resource.id, copied.id);
  }
  for (const method of sourceMethods) {
    const { id: _mid, created_at: _mc, updated_at: _mu, version: _mv, deleted_at: _md, ...fields } = method;
    void _mid;
    void _mc;
    void _mu;
    void _mv;
    void _md;
    const mappedResourceId = idMaps.resources.get(method.resource_id);
    if (!mappedResourceId) {
      throw new HttpError(500, "internal_error", "Clone aborted: a method references a missing resource.");
    }
    const copied = await insertMethodRow(db, {
      ...fields, project_id: projectId, api_id: target.id,
      resource_id: mappedResourceId,
    });
    idMaps.methods.set(method.id, copied.id);
  }
  for (const route of await listRouteRows(db, source.id)) {
    const { id: _rid, created_at: _rc, updated_at: _ru, version: _rv, deleted_at: _rd, ...fields } = route;
    void _rid;
    void _rc;
    void _ru;
    void _rv;
    void _rd;
    const copied = await insertRouteRow(db, { ...fields, project_id: projectId, api_id: target.id });
    idMaps.routes.set(route.id, copied.id);
  }
  for (const handler of CLONE_HANDLERS) {
    await handler(db, { projectId, sourceApiId: source.id, targetApiId: target.id, idMaps });
  }
  await audit(db, actor, {
    action: "api.clone", resourceType: "api", resourceId: target.id,
    projectId, apiId: target.id, before: toApiView(source), after: toApiView(target), requestId,
  });
  return { status: 201, body: toApiView(target) };
}

/**
 * Debug helper for the UI route tester: which draft route/method a sample
 * `METHOD /path` hits. Never throws a gateway error; reports the miss.
 */
export async function matchDraft(db, actor, { projectId, apiId, method, path }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const api = await resolveApi(db, projectId, apiId);
  if (typeof method !== "string" || method === "") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.method: must be a non-empty string");
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.path: must start with \"/\"");
  }
  const normalized = method.toUpperCase();
  if (api.protocol === "REST") {
    const resources = await listResourceRows(db, api.id);
    const methods = await listMethodRows(db, api.id);
    const found = matchRestResource(compileRestResources(resources, methods), normalized, path);
    if (!found) {
      return { matched: false, reason: "no_resource", resourceId: null, resourcePath: null, methodId: null, httpMethod: null, pathParameters: {} };
    }
    if (!found.methodId) {
      return {
        matched: false, reason: "missing_method", resourceId: found.resourceId,
        resourcePath: found.resourcePath, methodId: null, httpMethod: null, pathParameters: found.pathParameters,
      };
    }
    return {
      matched: true, reason: null, resourceId: found.resourceId,
      resourcePath: found.resourcePath, methodId: found.methodId,
      httpMethod: found.httpMethod, pathParameters: found.pathParameters,
    };
  }
  if (api.protocol === "HTTP") {
    const routes = await listRouteRows(db, api.id);
    const found = matchHttpRoute(compileHttpRoutes(routes.map((row) => ({ id: row.id, routeKey: row.route_key }))), normalized, path);
    if (!found) {
      return { matched: false, reason: "no_route", routeId: null, routeKey: null, pathParameters: {} };
    }
    return { matched: true, reason: null, routeId: found.routeId, routeKey: found.routeKey, pathParameters: found.pathParameters };
  }
  return { matched: false, reason: "websocket_matching_arrives_in_s12", routeId: null, routeKey: null, pathParameters: {} };
}
