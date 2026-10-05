/**
 * REST "Enable CORS" orchestration (S06 §2).
 *
 * Applies `planRestEnableCors` atomically-as-possible: an OPTIONS MOCK
 * method (+ its integration, method responses and integration responses)
 * plus `Access-Control-Allow-Origin` mappings on the selected methods'
 * 200 responses (method + integration sides), and optionally the
 * DEFAULT_4XX/DEFAULT_5XX gateway-response headers. REST-only, RBAC like
 * other draft mutations (`pods.route.write` + `pods.integration.write`),
 * audited via `audit()` (the hook only auto-deploys HTTP, so REST is a
 * no-op there).
 *
 * @module lib/control/enable-cors
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi } from "./apis.mjs";
import { resolveResource, REST_METHODS } from "./rest-resources.mjs";
import { planRestEnableCors, isValidRestCorsOriginValue } from "../gateway/core/processing/cors.mjs";
import { newPublicId } from "../gateway/ids.mjs";

const DEFAULT_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
const DEFAULT_HEADERS = [
  "Content-Type",
  "X-Amz-Date",
  "Authorization",
  "X-Api-Key",
  "X-Amz-Security-Token",
];

function checkStringArray(value, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${field}: expected an array`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "" || entry.length > 256) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.${field}[]: must be a non-empty string of at most 256 characters`);
    }
  }
  if (!allowEmpty && value.length === 0) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${field}: must not be empty`);
  }
  return [...value];
}

async function upsertMethodResponse(db, { projectId, apiId, methodId, statusCode, responseParameters }) {
  const existing = typeof db.getMethodResponse === "function"
    ? await db.getMethodResponse({ methodId, statusCode }).catch(() => null)
    : null;
  if (existing) {
    const merged = { ...(existing.response_parameters ?? {}), ...responseParameters };
    if (typeof db.updateMethodResponse === "function") {
      return db.updateMethodResponse({ id: existing.id, response_parameters: merged, response_models: existing.response_models ?? {}, version: (existing.version ?? 1) + 1 });
    }
    Object.assign(existing, { response_parameters: merged });
    return existing;
  }
  if (typeof db.insertMethodResponse !== "function") return null;
  return db.insertMethodResponse({
    project_id: projectId,
    api_id: apiId,
    method_id: methodId,
    status_code: statusCode,
    response_parameters: responseParameters,
    response_models: statusCode === "200" ? { "application/json": "Empty" } : {},
  });
}

async function upsertIntegrationResponse(db, { projectId, apiId, integrationId, statusCode, selectionPattern, responseParameters, responseTemplates }) {
  const all = typeof db.listIntegrationResponses === "function"
    ? await db.listIntegrationResponses({ integrationId })
    : [];
  const existing = (all ?? []).find((row) => String(row.status_code ?? row.statusCode) === String(statusCode)
    && String(row.selection_pattern ?? row.selectionPattern ?? "") === String(selectionPattern ?? ""));
  if (existing) {
    const mergedParams = { ...(existing.response_parameters ?? existing.responseParameters ?? {}), ...responseParameters };
    const mergedTemplates = { ...(existing.response_templates ?? existing.responseTemplates ?? {}), ...responseTemplates };
    if (typeof db.updateIntegrationResponse === "function") {
      return db.updateIntegrationResponse(existing.id, {
        response_parameters: mergedParams,
        response_templates: mergedTemplates,
      });
    }
    Object.assign(existing, { response_parameters: mergedParams, response_templates: mergedTemplates });
    return existing;
  }
  if (typeof db.insertIntegrationResponse !== "function") return null;
  return db.insertIntegrationResponse({
    project_id: projectId,
    api_id: apiId,
    integration_id: integrationId,
    status_code: statusCode,
    selection_pattern: selectionPattern ?? null,
    response_parameters: responseParameters,
    response_templates: responseTemplates,
    content_handling: null,
  });
}

/**
 * Applies the REST Enable-CORS plan to a resource.
 *
 * @param {object} db - Control db port.
 * @param {object} actor
 * @param {{ projectId: string, apiId: string, resourceId: string, input?: object, requestId?: string|null }} options
 */
export async function enableCors(db, actor, { projectId, apiId, resourceId, input = {}, requestId = null }) {
  await requirePermission(db, actor, "pods.route.write", { projectId, apiId });
  await requirePermission(db, actor, "pods.integration.write", { projectId, apiId });
  const api = await resolveApi(db, projectId, apiId);
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Enable CORS is only available on REST APIs.");
  }
  const resource = await resolveResource(db, api, resourceId);

  const allowOrigin = input?.allowOrigin ?? "'*'";
  if (typeof allowOrigin !== "string" || !isValidRestCorsOriginValue(allowOrigin)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.allowOrigin: must be a quoted literal like \"'*'\" or an origin URL.");
  }
  const allowMethods = input?.allowMethods !== undefined
    ? checkStringArray(input.allowMethods, "allowMethods")
    : [...DEFAULT_METHODS];
  const allowHeaders = input?.allowHeaders !== undefined
    ? checkStringArray(input.allowHeaders, "allowHeaders")
    : [...DEFAULT_HEADERS];
  let targetMethods = null;
  if (input?.methods !== undefined) {
    targetMethods = checkStringArray(input.methods, "methods", { allowEmpty: true }).map((entry) => String(entry).toUpperCase());
    for (const entry of targetMethods) {
      if (!REST_METHODS.includes(entry)) {
        throw new HttpError(422, "invalid_input", `Invalid request: $.methods[]: must be one of ${REST_METHODS.join(", ")}`);
      }
    }
  }
  const includeGatewayResponses = input?.includeGatewayResponses ?? false;
  if (typeof includeGatewayResponses !== "boolean") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.includeGatewayResponses: expected a boolean");
  }
  for (const key of Object.keys(input ?? {})) {
    if (!["allowOrigin", "allowMethods", "allowHeaders", "methods", "includeGatewayResponses"].includes(key)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
    }
  }

  const plan = planRestEnableCors({ allowOrigin, allowMethods, allowHeaders });
  const applied = { optionsMethod: null, patchedMethods: [], gatewayResponses: [] };

  // --- OPTIONS MOCK method (+ integration + responses) ---
  const existingOptions = typeof db.getMethod === "function"
    ? await db.getMethod({ resourceId: resource.id, httpMethod: "OPTIONS" }).catch(() => null)
    : null;
  let optionsIntegrationId = existingOptions?.integration_id ?? existingOptions?.integrationId ?? null;
  if (!optionsIntegrationId) {
    const integrationRow = await db.insertIntegration({
      project_id: projectId,
      api_id: api.id,
      public_id: newPublicId(),
      type: "MOCK",
      integration_method: "ANY",
      uri: null,
      function: null,
      aws: null,
      connection_type: "INTERNET",
      connector_id: null,
      timeout_ms: 29000,
      payload_format_version: "1.0",
      passthrough_behavior: plan.optionsMethod.integration.passthroughBehavior ?? "WHEN_NO_MATCH",
      content_handling: null,
      request_parameters: {},
      request_templates: plan.optionsMethod.integration.requestTemplates ?? {},
      response_parameters: {},
      tls: { insecureSkipVerification: false, serverNameToVerify: null },
      backend_auth: null,
      description: "CORS preflight mock",
      created_by: actor?.userId ?? null,
    });
    optionsIntegrationId = integrationRow.id;
  } else if (typeof db.updateIntegration === "function" && typeof db.getIntegrationById === "function") {
    try {
      const current = await db.getIntegrationById(optionsIntegrationId);
      if (current) {
        await db.updateIntegration(optionsIntegrationId, {
          request_templates: plan.optionsMethod.integration.requestTemplates ?? {},
          passthrough_behavior: plan.optionsMethod.integration.passthroughBehavior ?? "WHEN_NO_MATCH",
        });
      }
    } catch {
      // Best-effort: the OPTIONS method already exists.
    }
  }

  let optionsMethodRow = existingOptions;
  if (!existingOptions) {
    optionsMethodRow = await db.insertMethod({
      project_id: projectId,
      api_id: api.id,
      resource_id: resource.id,
      http_method: "OPTIONS",
      authorization_type: "NONE",
      authorizer_id: null,
      authorization_scopes: [],
      api_key_required: false,
      operation_name: "",
      request_validator_id: null,
      request_parameters: {},
      request_models: {},
      integration_id: optionsIntegrationId,
      settings: {},
    });
  } else if (typeof db.updateMethod === "function" && optionsIntegrationId !== existingOptions.integration_id) {
    try {
      optionsMethodRow = await db.updateMethod({
        id: existingOptions.id,
        patch: { integration_id: optionsIntegrationId, version: (existingOptions.version ?? 1) + 1 },
      });
    } catch {
      optionsMethodRow = existingOptions;
    }
  }
  applied.optionsMethod = optionsMethodRow?.id ?? null;

  const optionsMethodId = optionsMethodRow?.id ?? null;
  if (optionsMethodId) {
    for (const entry of plan.optionsMethod.methodResponses ?? []) {
      await upsertMethodResponse(db, {
        projectId,
        apiId: api.id,
        methodId: optionsMethodId,
        statusCode: entry.statusCode,
        responseParameters: entry.responseParameters ?? {},
      });
    }
  }
  if (optionsIntegrationId) {
    for (const entry of plan.optionsMethod.integration.integrationResponses ?? []) {
      await upsertIntegrationResponse(db, {
        projectId,
        apiId: api.id,
        integrationId: optionsIntegrationId,
        statusCode: entry.statusCode,
        selectionPattern: entry.selectionPattern ?? "",
        responseParameters: entry.responseParameters ?? {},
        responseTemplates: entry.responseTemplates ?? {},
      });
    }
  }

  // --- Selected methods gain Allow-Origin on their 200 responses ---
  const allMethods = typeof db.listMethodsByApi === "function"
    ? await db.listMethodsByApi({ apiId: api.id })
    : [];
  const onResource = (allMethods ?? []).filter((row) => String(row.resource_id ?? row.resourceId) === String(resource.id));
  let selected = onResource.filter((row) => String(row.http_method ?? row.httpMethod) !== "OPTIONS");
  if (targetMethods !== null) {
    const wanted = new Set(targetMethods.filter((entry) => entry !== "OPTIONS"));
    selected = selected.filter((row) => wanted.has(String(row.http_method ?? row.httpMethod)));
  }
  for (const method of selected) {
    const methodId = method.id;
    const httpMethod = String(method.http_method ?? method.httpMethod);
    await upsertMethodResponse(db, {
      projectId,
      apiId: api.id,
      methodId,
      statusCode: "200",
      responseParameters: { ...plan.methodResponseHeaders },
    });
    const integrationId = method.integration_id ?? method.integrationId ?? null;
    if (integrationId) {
      await upsertIntegrationResponse(db, {
        projectId,
        apiId: api.id,
        integrationId,
        statusCode: "200",
        selectionPattern: "",
        responseParameters: {
          "method.response.header.Access-Control-Allow-Origin": allowOrigin,
        },
        responseTemplates: {},
      });
    }
    applied.patchedMethods.push(httpMethod);
  }

  // --- Optional gateway-response headers ---
  if (includeGatewayResponses) {
    for (const type of ["DEFAULT_4XX", "DEFAULT_5XX"]) {
      const existing = typeof db.getGatewayResponse === "function"
        ? await db.getGatewayResponse({ apiId: api.id, responseType: type }).catch(() => null)
        : null;
      const merged = {
        ...(existing?.response_parameters ?? existing?.responseParameters ?? {}),
        "gatewayresponse.header.Access-Control-Allow-Origin": allowOrigin,
      };
      if (existing && typeof db.updateGatewayResponse === "function") {
        await db.updateGatewayResponse({
          id: existing.id,
          status_code: existing.status_code ?? existing.statusCode ?? null,
          response_parameters: merged,
          response_templates: existing.response_templates ?? existing.responseTemplates ?? {},
          version: (existing.version ?? 1) + 1,
        });
      } else if (!existing && typeof db.insertGatewayResponse === "function") {
        await db.insertGatewayResponse({
          project_id: projectId,
          api_id: api.id,
          response_type: type,
          status_code: null,
          response_parameters: merged,
          response_templates: {},
        });
      }
      applied.gatewayResponses.push(type);
    }
  }

  await audit(db, actor, {
    action: "resource.enable_cors",
    resourceType: "rest_resource",
    resourceId: resource.id,
    projectId,
    apiId: api.id,
    before: null,
    after: { resourceId: resource.id, path: resource.path, ...applied, allowOrigin, allowMethods, allowHeaders },
    requestId,
  });
  return { resourceId: resource.id, path: resource.path, ...applied };
}
