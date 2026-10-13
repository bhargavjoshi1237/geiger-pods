// OpenAPI import service (S13 part A, §A).
//
// `POST …/apis/import` (new API) and `PUT …/apis/{apiId}/import`
// (`mode=overwrite|merge`) share one planner (`lib/gateway/distribution`)
// and apply the plan through the control db port with direct row writes —
// the same pattern as `cloneApi` (S03), since import replaces validation
// with the planner's warnings. Both affect only the draft; a deploy is
// still required (AWS parity), and HTTP auto-deploy stages redeploy via
// the shared `scheduleAutoDeploy` hook afterwards.
//
// Later passes (SDKs, portals) reuse the plan shape; keep it stable.
//
// @module lib/control/openapi-import

import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi } from "./apis.mjs";
import { newPublicId } from "../gateway/ids.mjs";
import { detectVersion, parseDocument, planImport, rewriteModelRefs } from "../gateway/distribution/openapi.mjs";
import { modelRefBase } from "../gateway/core/processing/validation.mjs";
import { validateUriTemplate } from "./integrations.mjs";
import { isBlockedIp } from "../gateway/core/integrations/ssrf.mjs";
import {
  validateHttpMapping,
  validateRestRequestMapping,
} from "../gateway/core/processing/param-mapping.mjs";
import { parseTemplate } from "../gateway/core/processing/templates/index.mjs";
import { validateCorsConfig } from "../gateway/core/processing/cors.mjs";

const MODES = ["overwrite", "merge"];
const BASEPATHS = ["ignore", "prepend", "split"];
const IMPORT_CAPABILITY = { REST: "routing.resources", HTTP: "routing.routes" };

/** Import plan caps mirroring the management services (S15 limits). */
const MAX_IMPORT_OPERATIONS = 300;
const MAX_IMPORT_RESOURCES = 300;
const MAX_IMPORT_TEMPLATE_BYTES = 300 * 1024;
const MAX_IMPORT_MODELS_BYTES = 400 * 1024;
const MAX_IMPORT_REGEX_CHARS = 512;

/**
 * F41: runs the same per-field validation as the management services before
 * anything is written — integration URIs (+ SSRF literal rules), header
 * mapping tables (names/values incl. CRLF), template size/grammar, regex
 * safety, CORS shape and plan limits. Throws `HttpError` 422 on the first
 * problem (an error, not a warning: `failOnWarnings` semantics are
 * unchanged — warnings still only warn).
 *
 * @param {object} plan - `planImport` output.
 * @param {"REST"|"HTTP"} protocol
 */
export function validatePlanFields(plan, protocol) {
  const fail = (message) => {
    throw new HttpError(422, "invalid_input", `Invalid import: ${message}`);
  };
  if ((plan.operations ?? []).length > MAX_IMPORT_OPERATIONS) {
    fail(`at most ${MAX_IMPORT_OPERATIONS} operations per import`);
  }
  if ((plan.resources ?? []).length > MAX_IMPORT_RESOURCES) {
    fail(`at most ${MAX_IMPORT_RESOURCES} resources per import`);
  }
  let modelBytes = 0;
  for (const model of plan.models ?? []) {
    modelBytes += Buffer.byteLength(JSON.stringify(model.schema ?? {}), "utf8");
  }
  if (modelBytes > MAX_IMPORT_MODELS_BYTES) {
    fail("combined model schemas exceed 400 KB");
  }
  if (plan.api?.cors) {
    for (const message of validateCorsConfig(plan.api.cors)) {
      fail(`cors: ${message}`);
    }
  }
  for (const operation of plan.operations ?? []) {
    const where = `${operation.method} ${operation.path}`;
    // Method-side request parameter grammar (`method.request.*`).
    for (const key of Object.keys(operation.requestParameters ?? {})) {
      if (!/^method\.request\.(header|querystring|path|multivalueheader|multivaluequerystring)\.[A-Za-z0-9_.\-]+$/.test(key)) {
        fail(`${where}: invalid request parameter "${key}"`);
      }
    }
    const integration = operation.integration ?? null;
    if (!integration) continue;
    checkIntegrationFields(integration, protocol, where, fail);
  }
}

/**
 * Validates one planned integration exactly like `createIntegration` would.
 *
 * @param {object} integration - Planned integration fields.
 * @param {"REST"|"HTTP"} protocol
 * @param {string} where - Operation label for messages.
 * @param {(message: string) => never} fail
 */
function checkIntegrationFields(integration, protocol, where, fail) {
  // Timeout bounds mirror the management service (REST default ceiling).
  if (integration.timeoutMs !== null && integration.timeoutMs !== undefined) {
    const max = protocol === "HTTP" ? 30000 : 29000;
    if (!Number.isInteger(integration.timeoutMs) || integration.timeoutMs < 50 || integration.timeoutMs > max) {
      fail(`${where}: timeoutMs must be 50–${max} for ${protocol} APIs`);
    }
  }
  // URIs: syntactic template rules plus the SSRF literal rules. Blocked
  // non-loopback literals (metadata, RFC1918, link-local, …) are rejected
  // here; loopback literals stay a runtime decision (accepted at import like
  // `createIntegration` accepts them, enforced at invoke time with the F4
  // production refusal), so dev fixtures keep working.
  if (typeof integration.uri === "string" && integration.uri !== "") {
    try {
      validateUriTemplate(integration.uri);
    } catch (error) {
      fail(`${where}: ${error.message}`);
    }
    if ((integration.connectionType ?? "INTERNET") === "INTERNET") {
      const hostname = probeHostname(integration.uri);
      if (hostname && isBlockedIp(hostname, { allowLoopback: true })) {
        fail(`${where}: integration uri resolves to a blocked address ("${hostname}")`);
      }
    }
  }
  // Header mapping tables: names, reserved headers and CRLF values.
  const tables = integration.requestParameters ?? {};
  if (Object.keys(tables).length > 0) {
    const { errors } = protocol === "HTTP"
      ? validateHttpMapping(tables, "request")
      : validateRestRequestMapping(tables);
    if (errors.length > 0) fail(`${where}: ${errors[0]}`);
  }
  // Templates: size cap, grammar and no embedded secrets (same as S04/S06).
  for (const [contentType, template] of Object.entries(integration.requestTemplates ?? {})) {
    if (typeof template !== "string") fail(`${where}: requestTemplates["${contentType}"]: expected a string`);
    else if (template.length > MAX_IMPORT_TEMPLATE_BYTES) {
      fail(`${where}: requestTemplates["${contentType}"]: template exceeds the 300 KB limit`);
    } else if (template.includes("secret:")) {
      fail(`${where}: requestTemplates["${contentType}"]: templates must not embed secret values`);
    } else {
      try {
        parseTemplate(template);
      } catch (error) {
        fail(`${where}: invalid template for ${contentType}: ${error.message}`);
      }
    }
  }
  // Regex-shaped fields that survive import must be linear (≤ 512, RE2-safe).
  for (const [field, pattern] of Object.entries(pickRegexFields(integration))) {
    if (typeof pattern !== "string" || pattern === "") continue;
    if (pattern.length > MAX_IMPORT_REGEX_CHARS) {
      fail(`${where}: ${field} exceeds ${MAX_IMPORT_REGEX_CHARS} characters`);
    }
    if (/\\[1-9]/.test(pattern)) fail(`${where}: ${field} backreferences are not allowed`);
    if (/\(\?[=!<]/.test(pattern)) fail(`${where}: ${field} lookaround is not allowed`);
    try {
      void new RegExp(pattern);
    } catch {
      fail(`${where}: ${field} must be a valid regular expression`);
    }
  }
  // Webhook function URLs get the same URI/SSRF rules as HTTP integrations.
  const fn = integration.function ?? null;
  if (fn?.provider === "webhook" && typeof fn.url === "string" && fn.url !== "") {
    try {
      validateUriTemplate(fn.url);
    } catch (error) {
      fail(`${where}: ${error.message}`);
    }
    const hostname = probeHostname(fn.url);
    if (hostname && isBlockedIp(hostname, { allowLoopback: true })) {
      fail(`${where}: function url resolves to a blocked address ("${hostname}")`);
    }
  }
  if (fn?.provider === "aws_lambda" && typeof fn.functionArn === "string" && !/^arn:aws:lambda:/.test(fn.functionArn)) {
    fail(`${where}: function.functionArn must be a Lambda function ARN`);
  }
}

/**
 * Extracts the hostname from a URI template (placeholders become `p`).
 *
 * @param {string} uri
 * @returns {string} Hostname, or "" when unparseable.
 */
function probeHostname(uri) {
  try {
    const probe = String(uri)
      .replace(/\{[A-Za-z0-9_-]+\+?\}/g, "p")
      .replace(/\$\{[^}]+\}/g, "p");
    return new URL(probe).hostname;
  } catch {
    return "";
  }
}

/**
 * Collects regex-shaped fields from a planned integration (selection
 * patterns and template-selection expressions when present).
 */
function pickRegexFields(integration) {
  const out = {};
  if (integration.selectionPattern !== undefined) out.selectionPattern = integration.selectionPattern;
  if (integration.templateSelectionExpression !== undefined) {
    out.templateSelectionExpression = integration.templateSelectionExpression;
  }
  return out;
}

function checkMode(mode) {
  if (!MODES.includes(mode)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.mode: must be one of overwrite, merge");
  }
  return mode;
}

/** Normalizes the query/body import options shared by both endpoints. */
export function cleanImportOptions(input = {}) {
  const options = {};
  if (input.mode !== undefined) options.mode = checkMode(input.mode);
  if (input.failOnWarnings !== undefined) options.failOnWarnings = input.failOnWarnings === true || input.failOnWarnings === "true";
  if (input.dryRun !== undefined) options.dryRun = input.dryRun === true || input.dryRun === "true";
  if (input.basepath !== undefined) {
    if (!BASEPATHS.includes(input.basepath)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.basepath: must be one of ignore, prepend, split");
    }
    options.basepath = input.basepath;
  }
  if (input.protocol !== undefined) {
    if (input.protocol !== "REST" && input.protocol !== "HTTP") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.protocol: must be one of REST, HTTP");
    }
    options.protocol = input.protocol;
  }
  if (input.ignore !== undefined) options.ignore = String(input.ignore).slice(0, 256);
  if (input.endpointConfigurationTypes !== undefined) {
    options.endpointConfigurationTypes = String(input.endpointConfigurationTypes).slice(0, 256);
  }
  return options;
}

/**
 * Parses the request document from a JSON management body:
 * `{ document: <object|string>, fileType?: "json"|"yaml" }` or the raw
 * document itself.
 */
export function readImportBody(body) {
  const raw = body && typeof body === "object" && ("document" in body) ? body.document : body;
  if (raw === undefined || raw === null) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.document: an OpenAPI 2.0/3.x document is required");
  }
  try {
    return parseDocument(raw);
  } catch (error) {
    if (error.code === "body_too_large") throw new HttpError(413, "body_too_large", error.message);
    throw new HttpError(422, "invalid_input", error.message);
  }
}

/** Applies top-level API fields from the plan (protocol-gated). */
function apiPatchFromPlan(plan, protocol) {
  const patch = {};
  if (plan.api.description) patch.description = plan.api.description;
  if (protocol === "REST") {
    if (plan.api.binaryMediaTypes.length > 0) patch.binary_media_types = plan.api.binaryMediaTypes;
    if (plan.api.minimumCompressionSize !== null) patch.minimum_compression_size = plan.api.minimumCompressionSize;
  }
  if (plan.api.endpointType && plan.api.endpointType !== "REGIONAL" && protocol === "REST") {
    patch.endpoint_type = plan.api.endpointType;
  }
  if (plan.api.cors && protocol === "HTTP") patch.cors = plan.api.cors;
  if (plan.api.tags && Object.keys(plan.api.tags).length > 0) patch.tags = plan.api.tags;
  return patch;
}

function buildIntegrationRow(projectId, apiId, entry, actor) {
  const timeoutMs = Number.isInteger(entry.timeoutMs)
    ? Math.min(Math.max(entry.timeoutMs, 50), 29000)
    : 29000;
  return {
    project_id: projectId,
    api_id: apiId,
    public_id: newPublicId(),
    type: entry.type,
    integration_method: entry.integrationMethod ?? "ANY",
    uri: entry.uri ?? null,
    function: entry.function ?? null,
    aws: entry.aws ?? null,
    connection_type: entry.connectionType ?? "INTERNET",
    connector_id: entry.connectorId ?? null,
    timeout_ms: timeoutMs,
    payload_format_version: "1.0",
    passthrough_behavior: entry.passthroughBehavior ?? "WHEN_NO_MATCH",
    content_handling: entry.contentHandling ?? null,
    request_parameters: entry.requestParameters ?? {},
    request_templates: entry.requestTemplates ?? {},
    response_parameters: {},
    tls: { insecureSkipVerification: false, serverNameToVerify: null },
    backend_auth: null,
    description: "imported",
    created_by: actor?.userId ?? null,
  };
}

/** Ensures the full REST resource chain for `path`; returns the leaf row. */
async function ensureResource(db, { projectId, apiId, path, cache }) {
  if (cache.has(path)) return cache.get(path);
  if (path === "/") {
    const existing = (await db.listResourcesByApi({ apiId })).find((row) => row.path === "/") ?? null;
    if (!existing) throw new HttpError(500, "internal_error", "REST API has no root resource.");
    cache.set("/", existing);
    return existing;
  }
  const slash = path.lastIndexOf("/");
  const parentPath = slash === 0 ? "/" : path.slice(0, slash);
  const part = path.slice(slash + 1);
  const parent = await ensureResource(db, { projectId, apiId, path: parentPath, cache });
  const row = await db.insertResource({
    project_id: projectId, api_id: apiId, parent_id: parent.id, path_part: part, path,
  });
  cache.set(path, row);
  return row;
}

function toMethodRow({ projectId, apiId, resourceId, operation, authorizerId, integrationId }) {
  return {
    project_id: projectId,
    api_id: apiId,
    resource_id: resourceId,
    http_method: operation.method,
    authorization_type: authorizerId ? operation.authType : (operation.authType === "NONE" ? "NONE" : operation.authType),
    authorizer_id: authorizerId,
    authorization_scopes: [],
    api_key_required: operation.apiKeyRequired,
    operation_name: operation.operationName ?? "",
    request_validator_id: null,
    request_parameters: operation.requestParameters ?? {},
    request_models: operation.requestModels ?? {},
    integration_id: integrationId,
    settings: {},
  };
}

function toRouteRow({ projectId, apiId, operation, authorizerId, integrationId }) {
  return {
    project_id: projectId,
    api_id: apiId,
    route_key: `${operation.method} ${operation.path}`,
    authorization_type: operation.authType === "NONE" ? "NONE" : operation.authType,
    authorizer_id: authorizerId,
    authorization_scopes: [],
    api_key_required: false,
    integration_id: integrationId,
    operation_name: operation.operationName ?? "",
    request_parameters: {},
    request_models: {},
    model_selection_expression: null,
    route_response_selection_expression: null,
  };
}

function sameOperationRevision(before, operation, integrationId) {
  const view = {
    authorization_type: before.authorization_type,
    authorizer_id: before.authorizer_id ?? null,
    api_key_required: before.api_key_required ?? false,
    operation_name: before.operation_name ?? "",
    request_parameters: before.request_parameters ?? {},
    request_models: before.request_models ?? {},
    integration_id: before.integration_id ?? null,
  };
  const next = {
    authorization_type: operation.authType,
    authorizer_id: operation.authorizerId ?? null,
    api_key_required: operation.apiKeyRequired,
    operation_name: operation.operationName ?? "",
    request_parameters: operation.requestParameters ?? {},
    request_models: operation.requestModels ?? {},
    integration_id: integrationId,
  };
  return JSON.stringify(view) === JSON.stringify(next);
}

/**
 * Applies a plan to an existing draft. `overwrite` deletes every draft
 * row first (keeping the API id); `merge` upserts by `(path, method)` /
 * route key / model name and never deletes.
 *
 * @returns {Promise<{ added: number, updated: number, unchanged: number, removed: number }>}
 */
async function applyPlan(db, { projectId, api, plan, mode, actor }) {
  const summary = { added: 0, updated: 0, unchanged: 0, removed: 0 };
  const apiId = api.id;

  if (mode === "overwrite") {
    const [methods, resources, routes, integrations, models, authorizers] = await Promise.all([
      db.listMethodsByApi({ apiId }).catch(() => []),
      db.listResourcesByApi({ apiId }).catch(() => []),
      db.listRoutesByApi({ apiId }).catch(() => []),
      (typeof db.listIntegrations === "function" ? db.listIntegrations({ apiId }) : []).catch(() => []),
      (typeof db.listModels === "function" ? db.listModels({ projectId, apiId }) : []).catch(() => []),
      (typeof db.listAuthorizers === "function" ? db.listAuthorizers({ projectId, apiId }) : []).catch(() => []),
    ]);
    if (methods.length > 0) await db.deleteMethods({ ids: methods.map((row) => row.id) });
    const nonRoot = resources.filter((row) => row.path !== "/");
    if (nonRoot.length > 0 && typeof db.deleteResources === "function") {
      await db.deleteResources({ ids: nonRoot.map((row) => row.id) });
    }
    for (const row of routes) await db.deleteRoute({ id: row.id });
    for (const row of integrations) {
      if (typeof db.deleteIntegration === "function") await db.deleteIntegration(row.id);
    }
    for (const row of models) {
      if (typeof db.deleteModel === "function") await db.deleteModel({ id: row.id });
    }
    for (const row of authorizers) {
      if (typeof db.deleteAuthorizer === "function") await db.deleteAuthorizer({ id: row.id });
    }
    summary.removed = methods.length + nonRoot.length + routes.length + integrations.length + models.length + authorizers.length;
  }

  // Authorizers first so operations can link by name.
  const authorizerIds = new Map();
  const existingAuthorizers = mode === "merge" && typeof db.listAuthorizers === "function"
    ? await db.listAuthorizers({ projectId, apiId }).catch(() => [])
    : [];
  for (const entry of existingAuthorizers) authorizerIds.set(entry.name, entry.id);
  for (const entry of plan.authorizers) {
    if (authorizerIds.has(entry.name)) continue;
    if (typeof db.insertAuthorizer !== "function") continue;
    const row = await db.insertAuthorizer({
      id: randomUUID(),
      project_id: projectId,
      api_id: apiId,
      public_id: newPublicId().slice(0, 8),
      name: entry.name,
      type: entry.type,
      identity_source: entry.identitySource ?? [],
      jwt: entry.jwt ?? null,
      function: entry.function ?? null,
    });
    authorizerIds.set(entry.name, row.id);
    summary.added += 1;
  }

  // Models (upsert by name on merge). Local `#/definitions/*` refs are
  // rewritten to the API's canonical model refs so deploys compile.
  const refBase = modelRefBase(api.public_id);
  const rewrite = (schema) => rewriteModelRefs(schema, refBase);
  const knownModels = new Map(plan.models.map((entry) => [entry.name, entry]));
  if (mode === "merge" && typeof db.listModels === "function") {
    for (const row of await db.listModels({ projectId, apiId }).catch(() => [])) {
      knownModels.delete(row.name);
      const wanted = plan.models.find((entry) => entry.name === row.name);
      if (!wanted) continue;
      if (JSON.stringify(row.schema ?? {}) === JSON.stringify(rewrite(wanted.schema))) {
        summary.unchanged += 1;
      } else if (typeof db.updateModel === "function") {
        await db.updateModel({ id: row.id, schema: rewrite(wanted.schema), version: (row.version ?? 1) + 1 });
        summary.updated += 1;
      }
    }
  }
  if (typeof db.insertModel === "function") {
    for (const entry of (mode === "merge" ? [...knownModels.values()] : plan.models)) {
      await db.insertModel({
        project_id: projectId, api_id: apiId, name: entry.name,
        content_type: entry.contentType ?? "application/json",
        schema: rewrite(entry.schema), description: "",
      });
      summary.added += 1;
    }
  }

  // Operations.
  if (plan.protocol === "REST") {
    const cache = new Map();
    for (const row of await db.listResourcesByApi({ apiId }).catch(() => [])) {
      if (!cache.has(row.path)) cache.set(row.path, row);
    }
    for (const resource of plan.resources) {
      await ensureResource(db, { projectId, apiId, path: resource.path, cache });
    }
    for (const operation of plan.operations) {
      const resource = await ensureResource(db, { projectId, apiId, path: operation.path, cache });
      const authorizerId = operation.authorizerName ? (authorizerIds.get(operation.authorizerName) ?? null) : null;
      const savedIntegration = operation.integration ? await db.insertIntegration(buildIntegrationRow(projectId, apiId, operation.integration, actor)) : null;
      if (mode === "merge") {
        const existing = await db.getMethod({ resourceId: resource.id, httpMethod: operation.method }).catch(() => null);
        if (existing) {
          if (sameOperationRevision(existing, { ...operation, authorizerId }, savedIntegration?.id ?? existing.integration_id)) {
            summary.unchanged += 1;
          } else {
            await db.updateMethod({
              id: existing.id,
              patch: {
                ...toMethodRow({ projectId, apiId, resourceId: resource.id, operation: { ...operation, authorizerId }, authorizerId, integrationId: savedIntegration?.id ?? existing.integration_id }),
                version: (existing.version ?? 1) + 1,
              },
            });
            summary.updated += 1;
          }
          continue;
        }
      }
      await db.insertMethod(toMethodRow({ projectId, apiId, resourceId: resource.id, operation: { ...operation, authorizerId }, authorizerId, integrationId: savedIntegration?.id ?? null }));
      summary.added += 1;
    }
  } else {
    for (const operation of plan.operations) {
      const authorizerId = operation.authorizerName ? (authorizerIds.get(operation.authorizerName) ?? null) : null;
      const savedIntegration = operation.integration ? await db.insertIntegration(buildIntegrationRow(projectId, apiId, operation.integration, actor)) : null;
      const routeKey = `${operation.method} ${operation.path}`;
      if (mode === "merge" && typeof db.getRouteByKey === "function") {
        const existing = await db.getRouteByKey({ apiId, routeKey }).catch(() => null);
        if (existing) {
          await db.updateRoute({
            id: existing.id,
            patch: {
              ...toRouteRow({ projectId, apiId, operation: { ...operation, authorizerId }, authorizerId, integrationId: savedIntegration?.id ?? existing.integration_id }),
              version: (existing.version ?? 1) + 1,
            },
          });
          summary.updated += 1;
          continue;
        }
      }
      await db.insertRoute(toRouteRow({ projectId, apiId, operation: { ...operation, authorizerId }, authorizerId, integrationId: savedIntegration?.id ?? null }));
      summary.added += 1;
    }
  }

  // API-level fields.
  const patch = apiPatchFromPlan(plan, plan.protocol);
  if (Object.keys(patch).length > 0) {
    await db.updateApi({ id: apiId, patch: { ...patch, version: (api.version ?? 1) + 1 } });
  }
  return summary;
}

/**
 * Imports a document as a brand-new API.
 *
 * Query/body options mirror AWS: `protocol=REST|HTTP` (new API),
 * `basepath`, `endpointConfigurationTypes`, `ignore=documentation`.
 */
export async function importNewApi(db, actor, { projectId, body, options = {}, requestId = null }) {
  await requirePermission(db, actor, "pods.api.import", { projectId });
  await requirePermission(db, actor, "pods.api.create", { projectId });
  const { doc } = readImportBody(body);
  const clean = cleanImportOptions(options);
  const protocol = clean.protocol ?? "REST";
  if (!IMPORT_CAPABILITY[protocol]) throw new HttpError(422, "invalid_input", "Invalid request: $.protocol: must be one of REST, HTTP");
  const { plan, warnings } = planImport(doc, clean);
  plan.protocol = protocol;
  // F41: per-field service validation before anything is written (errors —
  // failOnWarnings only governs warnings, unchanged).
  validatePlanFields(plan, protocol);
  if (clean.failOnWarnings && warnings.length > 0) {
    throw new HttpError(400, "import_warnings", "Import has warnings and failOnWarnings is true.", { warnings });
  }
  if (clean.dryRun) {
    return { dryRun: true, protocol, warnings, summary: null, api: null };
  }
  const { createApi } = await import("./apis.mjs");
  const created = await createApi(db, actor, {
    projectId,
    requestId,
    name: plan.api.name,
    description: plan.api.description,
    protocol,
    ...(protocol === "REST" && plan.api.binaryMediaTypes.length > 0 ? { binaryMediaTypes: plan.api.binaryMediaTypes } : {}),
    ...(protocol === "REST" && plan.api.minimumCompressionSize !== null ? { minimumCompressionSize: plan.api.minimumCompressionSize } : {}),
    ...(protocol === "REST" && plan.api.endpointType !== "REGIONAL" ? { endpointType: plan.api.endpointType } : {}),
    ...(protocol === "HTTP" && plan.api.cors ? { cors: plan.api.cors } : {}),
    ...(Object.keys(plan.api.tags).length > 0 ? { tags: plan.api.tags } : {}),
  });
  const api = await resolveApi(db, projectId, created.body.id);
  const summary = await applyPlan(db, { projectId, api, plan, mode: "overwrite", actor });
  const { scheduleAutoDeploy } = await import("./deployments.mjs");
  scheduleAutoDeploy(db, { projectId, apiId: api.id, actor });
  await audit(db, actor, {
    action: "api.import", resourceType: "api", resourceId: api.id,
    projectId, apiId: api.id, before: null,
    after: { id: api.id, mode: "new", summary, warnings: warnings.length }, requestId,
  });
  return { status: 201, body: { api: created.body, summary, warnings } };
}

/** Imports a document into an existing API (`mode=overwrite|merge`). */
export async function importExistingApi(db, actor, { projectId, apiId, body, options = {}, requestId = null }) {
  await requirePermission(db, actor, "pods.api.import", { projectId });
  const api = await resolveApi(db, projectId, apiId);
  if (api.protocol !== "REST" && api.protocol !== "HTTP") {
    throw new HttpError(400, "capability_unsupported", "OpenAPI import is only available on REST and HTTP APIs.");
  }
  const clean = cleanImportOptions({ mode: "overwrite", ...options });
  const { doc } = readImportBody(body);
  let version = null;
  try {
    version = detectVersion(doc).version;
  } catch (error) {
    throw new HttpError(422, "invalid_input", error.message);
  }
  void version;
  const { plan, warnings } = planImport(doc, { ...clean, protocol: api.protocol });
  plan.protocol = api.protocol;
  // F41: per-field service validation before anything is written (errors —
  // failOnWarnings only governs warnings, unchanged).
  validatePlanFields(plan, api.protocol);
  if (clean.failOnWarnings && warnings.length > 0) {
    throw new HttpError(400, "import_warnings", "Import has warnings and failOnWarnings is true; nothing was written.", { warnings });
  }
  if (clean.dryRun) {
    return { dryRun: true, apiId: api.id, mode: clean.mode, warnings, summary: null };
  }
  const summary = await applyPlan(db, { projectId, api, plan, mode: clean.mode, actor });
  const { scheduleAutoDeploy } = await import("./deployments.mjs");
  scheduleAutoDeploy(db, { projectId, apiId: api.id, actor });
  await audit(db, actor, {
    action: "api.import", resourceType: "api", resourceId: api.id,
    projectId, apiId: api.id, before: null,
    after: { id: api.id, mode: clean.mode, summary, warnings: warnings.length }, requestId,
  });
  return { apiId: api.id, mode: clean.mode, summary, warnings };
}
