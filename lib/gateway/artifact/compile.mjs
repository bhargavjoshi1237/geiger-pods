/**
 * Deployment artifact compiler (S05 §1).
 *
 * `compile(draft) → { artifact, warnings, errors }`. Pure and deterministic:
 * the same draft always gives the same bytes. Calls S03's matcher compile,
 * S04's integration URI validation and S06's `validateProcessing`.
 *
 * Draft shape (all fields optional unless noted):
 * ```
 * {
 *   projectId, apiId, apiPublicId, protocol: "REST"|"HTTP"|"WEBSOCKET",
 *   settings?: { apiKeySource, binaryMediaTypes, minimumCompressionSize,
 *     missingRouteBehavior, cors, resourcePolicy, routeSelectionExpression },
 *   // REST draft rows (DB snake_case or camelCase both accepted):
 *   resources?: [{ id, path }], methods?: [{ id, resourceId, httpMethod,
 *     authorizationType, authorizerId, authorizationScopes, apiKeyRequired,
 *     requestValidatorId, requestParameters, requestModels, integrationId }],
 *   // HTTP draft rows:
 *   routes?: [{ id, routeKey, authorizationType, authorizerId,
 *     authorizationScopes, apiKeyRequired, integrationId }],
 *   integrations?: [{ id, type, uri, integrationMethod, timeoutMs, tls,
 *     connectionType, connectorId, backendAuth, function, aws, ... }]
 *     | Record<string, object>,
 *   integrationResponses?: [...], models?: [{ name, schema, ... }],
 *   validators?: [{ name, ... }], gatewayResponses?: [...],
 *   authorizers?: [{ id, ... }] | Record<string, object>,
 *   methodResponses?: [...], features?: object,
 * }
 * ```
 *
 * The artifact contains no secret plaintext; `compile` throws when a backend
 * auth field carries a non-ref value or any string matches the vault
 * plaintext test hook.
 *
 * @module lib/gateway/artifact/compile
 */

import { createHash } from "node:crypto";
import { supports } from "../capabilities.mjs";
import { compileHttpRoutes, parseHttpRouteKey } from "../core/match/http-routes.mjs";
import { parseResourcePath } from "../core/match/rest-resources.mjs";
import { validateProcessing } from "../core/processing/validate-processing.mjs";
import { validateAuthSnapshot } from "../core/auth/snapshot.mjs";
import { validateHttpMapping } from "../core/processing/param-mapping.mjs";
import { canonicalJson } from "./canonical.mjs";
import { validateStageVariables } from "./stage-variables.mjs";

export const SCHEMA_VERSION = 1;

/** Test hook: plaintext values the vault holds (S05 §1 secret scan). */
let plaintextCache = [];

/**
 * Sets the vault plaintext cache for the secret-leak test hook.
 *
 * @param {Array<string>} values
 */
export function setPlaintextCache(values) {
  plaintextCache = [...(values ?? [])];
}

/** Clears the plaintext test hook. */
export function clearPlaintextCache() {
  plaintextCache = [];
}

function field(row, ...names) {
  for (const name of names) {
    if (row && Object.hasOwn(row, name) && row[name] !== undefined) return row[name];
  }
  return undefined;
}

function normResources(draft) {
  return (draft.resources ?? []).map((row) => ({
    id: String(field(row, "id")),
    path: String(field(row, "path")),
  }));
}

function normMethods(draft) {
  return (draft.methods ?? []).map((row) => ({
    id: String(field(row, "id")),
    resourceId: String(field(row, "resourceId", "resource_id") ?? ""),
    httpMethod: String(field(row, "httpMethod", "http_method") ?? "GET").toUpperCase(),
    authorizationType: field(row, "authorizationType", "authorization_type") ?? "NONE",
    authorizerId: field(row, "authorizerId", "authorizer_id") ?? null,
    authorizationScopes: field(row, "authorizationScopes", "authorization_scopes") ?? [],
    apiKeyRequired: field(row, "apiKeyRequired", "api_key_required") ?? false,
    requestValidatorId: field(row, "requestValidatorId", "request_validator_id") ?? null,
    requestParameters: field(row, "requestParameters", "request_parameters") ?? {},
    requestModels: field(row, "requestModels", "request_models") ?? {},
    integrationId: field(row, "integrationId", "integration_id") ?? null,
    // S06 runtime wiring (S06W): per-method response declarations. These are
    // the `method_responses` rows (`status_code` + required response
    // parameters + response models); the compile step verifies every
    // integration-response status declares one.
    methodResponses: normMethodResponseRows(field(row, "methodResponses", "method_responses")),
  }));
}

/**
 * Normalizes one `method_responses`-style row list (S06W).
 *
 * @param {Array<object>} [rows=[]]
 * @returns {Array<{ statusCode: string, responseParameters: object, responseModels: object }>}
 */
function normMethodResponseRows(rows = []) {
  return (rows ?? []).map((row) => ({
    statusCode: String(field(row, "statusCode", "status_code") ?? ""),
    responseParameters: field(row, "responseParameters", "response_parameters") ?? {},
    responseModels: field(row, "responseModels", "response_models") ?? {},
  }));
}

/**
 * Normalizes one `integration_responses`-style row list (S06W).
 *
 * @param {Array<object>} [rows=[]]
 * @returns {Array<{ statusCode: string, selectionPattern: string, responseParameters: object, responseTemplates: object, contentHandling: string|null }>}
 */
function normIntegrationResponseRows(rows = []) {
  return (rows ?? []).map((row) => ({
    statusCode: String(field(row, "statusCode", "status_code") ?? ""),
    selectionPattern: field(row, "selectionPattern", "selection_pattern") ?? "",
    responseParameters: field(row, "responseParameters", "response_parameters") ?? {},
    responseTemplates: field(row, "responseTemplates", "response_templates") ?? {},
    contentHandling: field(row, "contentHandling", "content_handling") ?? null,
  }));
}

function normRoutes(draft) {
  return (draft.routes ?? []).map((row) => ({
    id: String(field(row, "id")),
    routeKey: String(field(row, "routeKey", "route_key")),
    authorizationType: field(row, "authorizationType", "authorization_type") ?? "NONE",
    authorizerId: field(row, "authorizerId", "authorizer_id") ?? null,
    authorizationScopes: field(row, "authorizationScopes", "authorization_scopes") ?? [],
    apiKeyRequired: field(row, "apiKeyRequired", "api_key_required") ?? false,
    integrationId: field(row, "integrationId", "integration_id") ?? null,
  }));
}

function normIntegrations(draft) {
  const list = Array.isArray(draft.integrations)
    ? draft.integrations
    : Object.entries(draft.integrations ?? {}).map(([id, value]) => ({ id, ...(value ?? {}) }));
  return list.map((row) => ({
    id: String(field(row, "id")),
    type: String(field(row, "type")),
    uri: field(row, "uri") ?? null,
    integrationMethod: field(row, "integrationMethod", "integration_method") ?? "ANY",
    timeoutMs: field(row, "timeoutMs", "timeout_ms") ?? null,
    connectionType: field(row, "connectionType", "connection_type") ?? "INTERNET",
    connectorId: field(row, "connectorId", "connector_id") ?? null,
    backendAuth: field(row, "backendAuth", "backend_auth") ?? null,
    function: field(row, "function") ?? null,
    aws: field(row, "aws") ?? null,
    tls: field(row, "tls") ?? null,
    payloadFormatVersion: field(row, "payloadFormatVersion", "payload_format_version") ?? null,
    passthroughBehavior: field(row, "passthroughBehavior", "passthrough_behavior") ?? null,
    contentHandling: field(row, "contentHandling", "content_handling") ?? null,
    // S06 runtime wiring (S06W): request mapping/templates live on the
    // integration (S04 created the columns; S06 defines the semantics).
    // `requestParameters` holds `integration.request.*` mappings (distinct
    // from the method's `method.request.*` validation table);
    // `requestMapping`/`responseMappings` hold HTTP-API mapping tables.
    // B3: the control plane persists HTTP mappings in the same
    // `request_parameters` / `response_parameters` columns (S04 §2), so the
    // compiler treats those columns as HTTP tables when the API is HTTP.
    requestParameters: field(row, "requestParameters", "request_parameters") ?? {},
    requestTemplates: field(row, "requestTemplates", "request_templates") ?? {},
    requestMapping: field(row, "requestMapping", "request_mapping") ?? null,
    responseMappings: field(row, "responseMappings", "response_mappings") ?? null,
    responseParameters: field(row, "responseParameters", "response_parameters") ?? null,
    templateSelectionExpression: field(row, "templateSelectionExpression", "template_selection_expression") ?? null,
    integrationResponses: normIntegrationResponseRows(field(row, "integrationResponses", "integration_responses")),
  }));
}

/**
 * Collects integration responses for one integration (S06W): rows embedded
 * on the integration plus top-level `draft.integrationResponses` entries
 * carrying a matching `integrationId`.
 *
 * @param {object} draft
 * @param {string|null} integrationId
 * @param {{ id: string }} integration - Normalized integration (embedded rows).
 * @returns {Array<object>}
 */
function responsesForIntegration(draft, integrationId, integration) {
  const embedded = integration?.integrationResponses ?? [];
  const top = (draft.integrationResponses ?? []).filter(
    (row) => String(field(row, "integrationId", "integration_id") ?? "") === String(integrationId ?? ""),
  );
  return [...embedded, ...normIntegrationResponseRows(top)];
}

/**
 * Collects method responses for one method (S06W): rows embedded on the
 * method plus top-level `draft.methodResponses` entries carrying a matching
 * `methodId`.
 *
 * @param {object} draft
 * @param {string|null} methodId
 * @param {{ id: string }} method - Normalized method (embedded rows).
 * @returns {Array<object>}
 */
function responsesForMethod(draft, methodId, method) {
  const embedded = method?.methodResponses ?? [];
  const top = (draft.methodResponses ?? []).filter(
    (row) => String(field(row, "methodId", "method_id") ?? "") === String(methodId ?? ""),
  );
  return [...embedded, ...normMethodResponseRows(top)];
}

/**
 * Normalizes gateway-response customizations to an array (S06W). Accepts the
 * `pods.gateway_responses` row list (`[{ response_type, ... }]`) and plain
 * maps keyed by response type.
 *
 * @param {Array<object>|Record<string,object>} [value=[]]
 * @returns {Array<object>}
 */
function normGatewayResponses(value = []) {
  if (Array.isArray(value)) return value;
  return Object.entries(value ?? {}).map(([type, row]) => ({
    response_type: row?.response_type ?? type,
    ...(row ?? {}),
  }));
}

function normSettings(draft) {
  const s = draft.settings ?? draft.api ?? {};
  return {
    apiKeySource: field(s, "apiKeySource", "api_key_source") ?? "HEADER",
    binaryMediaTypes: field(s, "binaryMediaTypes", "binary_media_types") ?? [],
    minimumCompressionSize: field(s, "minimumCompressionSize", "minimum_compression_size") ?? null,
    missingRouteBehavior: field(s, "missingRouteBehavior", "missing_route_behavior") ?? "aws",
    cors: field(s, "cors") ?? null,
    resourcePolicy: field(s, "resourcePolicy", "resource_policy") ?? null,
    routeSelectionExpression: field(s, "routeSelectionExpression", "route_selection_expression") ?? null,
  };
}

const INTEGRATION_CAPABILITY = {
  HTTP_PROXY: "integration.http",
  HTTP: "integration.httpCustom",
  MOCK: "integration.mock",
  FUNCTION_PROXY: "integration.function",
  FUNCTION: "integration.function",
  AWS_SERVICE: "integration.awsService",
};

/**
 * Syntactic URI-template check shared with the control plane.
 *
 * @param {string} uri
 * @returns {boolean}
 */
function isValidUriTemplate(uri) {
  const probe = String(uri)
    .replace(/\{[A-Za-z0-9_-]+\+?\}/g, "p")
    .replace(/\$\{[^}]+\}/g, "p");
  try {
    const url = new URL(probe);
    return Boolean(url.host) && (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

function collectStrings(value, out) {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStrings(entry, out);
  }
}

/**
 * Compiles a draft into an immutable artifact.
 *
 * @param {object} [draft={}]
 * @returns {{ artifact: object|null, warnings: Array<object>, errors: Array<object> }}
 */
export function compile(draft = {}) {
  const warnings = [];
  const errors = [];
  const fail = (path, message, code = "invalid_config") => errors.push({ path, message, code });
  const warn = (path, message, code = "suspicious_config") => warnings.push({ path, message, code });

  const protocol = draft.protocol ?? draft.api?.protocol ?? "REST";
  const projectId = draft.projectId ?? draft.api?.project_id ?? draft.api?.projectId ?? "";
  const apiId = draft.apiId ?? draft.api?.id ?? "";
  const apiPublicId = draft.apiPublicId ?? draft.api?.public_id ?? draft.api?.publicId ?? "";
  const settings = normSettings(draft);
  const resources = normResources(draft);
  const methods = normMethods(draft);
  const routes = normRoutes(draft);
  const integrations = normIntegrations(draft);
  const byIntegration = new Map(integrations.map((entry) => [entry.id, entry]));
  const authorizerIds = new Set(
    Array.isArray(draft.authorizers)
      ? draft.authorizers.map((entry) => String(entry?.id ?? entry))
      : Object.keys(draft.authorizers ?? {}),
  );

  // --- Protocol capability gates (settings) ---
  if (settings.binaryMediaTypes.length > 0 && protocol !== "REST") {
    fail("settings.binaryMediaTypes", "binaryMediaTypes is only supported on REST APIs.", "capability_unsupported");
  }
  if (settings.minimumCompressionSize !== null && protocol !== "REST") {
    fail("settings.minimumCompressionSize", "minimumCompressionSize is only supported on REST APIs.", "capability_unsupported");
  }
  if (settings.resourcePolicy !== null && protocol !== "REST") {
    fail("settings.resourcePolicy", "resourcePolicy is only supported on REST APIs.", "capability_unsupported");
  }
  if (settings.cors !== null && protocol !== "HTTP") {
    fail("settings.cors", "cors is only supported on HTTP APIs.", "capability_unsupported");
  }
  if (settings.missingRouteBehavior !== "aws" && protocol !== "REST") {
    fail("settings.missingRouteBehavior", "missingRouteBehavior is only supported on REST APIs.", "capability_unsupported");
  }

  // --- Route/resource grammar (S03) ---
  if (protocol === "HTTP" || protocol === "WEBSOCKET") {
    for (const route of routes) {
      if (protocol === "HTTP") {
        try {
          parseHttpRouteKey(route.routeKey);
        } catch (error) {
          fail(`routes[${route.id}]`, error.message, "invalid_route");
        }
      }
    }
    try {
      compileHttpRoutes(routes.map((route) => ({ id: route.id, routeKey: route.routeKey })));
    } catch (error) {
      fail("routes", error.message, "invalid_route");
    }
  }
  if (protocol === "REST") {
    for (const resource of resources) {
      try {
        parseResourcePath(resource.path);
      } catch (error) {
        fail(`resources[${resource.id}]`, error.message, "invalid_resource");
      }
    }
  }

  // --- REST: at least one method ---
  if (protocol === "REST" && methods.length === 0) {
    fail("methods", "The REST API doesn't contain any methods", "no_methods");
  }

  // --- REST methods: integration + authorizer refs + capabilities ---
  const referencedIntegrations = new Set();
  if (protocol === "REST") {
    for (const method of methods) {
      const prefix = `methods[${method.id}]`;
      if (!method.integrationId) {
        fail(prefix, "No integration defined for method", "missing_integration");
      } else if (!byIntegration.has(String(method.integrationId))) {
        fail(prefix, `Integration "${method.integrationId}" does not exist`, "unknown_integration");
      } else {
        referencedIntegrations.add(String(method.integrationId));
      }
      if (method.authorizerId && !authorizerIds.has(String(method.authorizerId))) {
        fail(prefix, `Authorizer "${method.authorizerId}" does not exist`, "unknown_authorizer");
      }
      if (method.integrationId && byIntegration.has(String(method.integrationId))) {
        const integration = byIntegration.get(String(method.integrationId));
        const capability = INTEGRATION_CAPABILITY[integration.type];
        if (capability && !supports(protocol, capability)) {
          fail(prefix, `Integration type ${integration.type} is not supported for ${protocol} APIs.`, "capability_unsupported");
        }
      }
    }
  }

  // --- HTTP routes: integration targets ---
  if (protocol === "HTTP") {
    const hasDefault = routes.some((route) => route.routeKey === "$default");
    for (const route of routes) {
      const prefix = `routes[${route.id}]`;
      if (!route.integrationId) {
        if (!hasDefault) {
          fail(prefix, `Route "${route.routeKey}" has no target and the API has no $default route`, "missing_integration");
        }
      } else if (!byIntegration.has(String(route.integrationId))) {
        fail(prefix, `Integration "${route.integrationId}" does not exist`, "unknown_integration");
      } else {
        referencedIntegrations.add(String(route.integrationId));
      }
      if (route.authorizerId && !authorizerIds.has(String(route.authorizerId))) {
        fail(prefix, `Authorizer "${route.authorizerId}" does not exist`, "unknown_authorizer");
      }
      if (route.integrationId && byIntegration.has(String(route.integrationId))) {
        const integration = byIntegration.get(String(route.integrationId));
        const capability = INTEGRATION_CAPABILITY[integration.type];
        if (capability && !supports(protocol, capability)) {
          fail(prefix, `Integration type ${integration.type} is not supported for ${protocol} APIs.`, "capability_unsupported");
        }
      }
    }
    // A lone $default without integration is also refused.
    if (routes.length === 1 && routes[0].routeKey === "$default" && !routes[0].integrationId) {
      fail("routes", 'Route "$default" has no target', "missing_integration");
    }
  }

  // --- WEBSOCKET routes: light touch (S12 owns semantics) ---
  if (protocol === "WEBSOCKET") {
    for (const route of routes) {
      if (route.integrationId) referencedIntegrations.add(String(route.integrationId));
      if (route.authorizerId && !authorizerIds.has(String(route.authorizerId))) {
        fail(`routes[${route.id}]`, `Authorizer "${route.authorizerId}" does not exist`, "unknown_authorizer");
      }
    }
  }

  // --- Integrations: URI + connector refs + capability ---
  for (const integration of integrations) {
    const prefix = `integrations[${integration.id}]`;
    const capability = INTEGRATION_CAPABILITY[integration.type];
    if (!capability) {
      fail(prefix, `Unknown integration type "${integration.type}".`, "unknown_integration_type");
      continue;
    }
    if (!supports(protocol, capability)) {
      fail(prefix, `Integration type ${integration.type} is not supported for ${protocol} APIs.`, "capability_unsupported");
    }
    if ((integration.type === "HTTP_PROXY" || integration.type === "HTTP") && integration.uri) {
      if (!isValidUriTemplate(integration.uri)) {
        fail(prefix, "Integration uri must be a valid http(s) URL template.", "invalid_uri");
      }
    }
    if ((integration.connectionType ?? "INTERNET") === "CONNECTOR" && !integration.connectorId) {
      fail(prefix, "CONNECTOR integrations require a connector.", "missing_connector");
    }
    const auth = integration.backendAuth;
    if (auth && typeof auth === "object") {
      if (auth.secretRef !== undefined && auth.secretRef !== null) {
        if (typeof auth.secretRef !== "string" || !auth.secretRef.startsWith("secret:")) {
          fail(`${prefix}.backendAuth`, "backend_auth must reference a secret (secret:<id>).", "invalid_secret_ref");
        }
      } else if (["bearer", "header", "basic_auth", "oauth_client_credentials", "aws_sigv4"].includes(auth.type)) {
        // A backend-auth block that carries a value instead of a ref leaks.
        const carriesValue = ["value", "token", "password", "clientSecret", "secretAccessKey"].some(
          (key) => auth[key] !== undefined && auth[key] !== null && auth[key] !== "",
        );
        if (carriesValue) {
          throw new Error(`Artifact must not contain secret values (${prefix}.backendAuth carries a value, not a ref).`);
        }
      }
    }
    const fn = integration.function;
    if (fn && typeof fn === "object") {
      for (const key of ["secretRef", "credentialsRef"]) {
        if (fn[key] !== undefined && fn[key] !== null && typeof fn[key] === "string" && !fn[key].startsWith("secret:")) {
          fail(`${prefix}.function`, `${key} must reference a secret (secret:<id>).`, "invalid_secret_ref");
        }
      }
    }
    const aws = integration.aws;
    if (aws && typeof aws === "object" && aws.roleSecretRef !== undefined && aws.roleSecretRef !== null) {
      if (typeof aws.roleSecretRef !== "string" || !aws.roleSecretRef.startsWith("secret:")) {
        fail(`${prefix}.aws`, "roleSecretRef must reference a secret (secret:<id>).", "invalid_secret_ref");
      }
    }
  }

  // --- S06 processing validation (S06W: fed with real per-method and
  // per-integration data so template/grammar/selection/declaration errors
  // fail at deploy rather than at request time) ---
  try {
    const forS06 = {
      protocol,
      apiPublicId,
      cors: settings.cors,
      models: (draft.models ?? []).map((entry) => ({ name: entry?.name, schema: entry?.schema })),
      validators: draft.validators ?? [],
      methods: methods.map((method) => {
        const integration = byIntegration.get(String(method.integrationId));
        return {
          methodId: method.id,
          // NOTE: this is the integration `integration.request.*` mapping
          // table (checked by `validateRestRequestMapping`), not the
          // method's `method.request.*` validation table, which is enforced
          // at request time by the `validate` phase instead.
          requestParameters: integration?.requestParameters ?? {},
          requestModels: method.requestModels,
          validatorId: method.requestValidatorId,
          requestTemplates: integration?.requestTemplates ?? {},
          passthroughBehavior: integration?.passthroughBehavior ?? "WHEN_NO_MATCH",
          integrationResponses: responsesForIntegration(draft, method.integrationId, integration),
          methodResponses: responsesForMethod(draft, method.id, method),
        };
      }),
      httpMappings: draft.httpMappings,
      binaryMediaTypes: settings.binaryMediaTypes,
      minimumCompressionSize: settings.minimumCompressionSize,
      gatewayResponses: normGatewayResponses(draft.gatewayResponses),
      features: draft.features ?? {},
    };
    const checked = validateProcessing(forS06);
    for (const entry of checked.errors) fail(String(entry.path), String(entry.message), entry.code ?? "invalid_config");
    for (const entry of checked.warnings) warn(String(entry.path), String(entry.message), entry.code ?? "suspicious_config");
    // Per-integration HTTP-API mapping tables (S06 §3 grammar + reserved
    // headers). `validateProcessing` only covers the global `httpMappings`
    // block; integrations carry their own tables. B3 control-plane rows
    // persist HTTP tables in `request_parameters` / `response_parameters`
    // (S04 §2), so those aliases are validated here too.
    for (const integration of integrations) {
      if (protocol !== "HTTP") continue;
      const prefix = `integrations[${integration.id}]`;
      const effectiveRequest = integration.requestMapping
        ?? (integration.requestParameters && Object.keys(integration.requestParameters).length > 0 ? integration.requestParameters : null);
      if (effectiveRequest) {
        const { errors: mapErrors } = validateHttpMapping(effectiveRequest, "request");
        for (const message of mapErrors) fail(`${prefix}.requestMapping`, message, "invalid_mapping");
      }
      const effectiveResponses = integration.responseMappings
        ?? (integration.responseParameters && Object.keys(integration.responseParameters).length > 0 ? integration.responseParameters : null);
      for (const [status, table] of Object.entries(effectiveResponses ?? {})) {
        const { errors: mapErrors } = validateHttpMapping(table ?? {}, "response");
        for (const message of mapErrors) fail(`${prefix}.responseMappings[${status}]`, message, "invalid_mapping");
      }
      if (integration.requestTemplates && Object.keys(integration.requestTemplates).length > 0) {
        fail(`${prefix}.requestTemplates`, "requestTemplates is only supported on REST and WebSocket APIs.", "capability_unsupported");
      }
    }
    // WEBSOCKET integrations must not carry HTTP/REST mapping tables.
    for (const integration of integrations) {
      if (protocol !== "WEBSOCKET") continue;
      const prefix = `integrations[${integration.id}]`;
      if (integration.requestParameters && Object.keys(integration.requestParameters).length > 0) {
        fail(`${prefix}.requestParameters`, "requestParameters is only supported on REST and HTTP APIs.", "capability_unsupported");
      }
      const effectiveResponses = integration.responseMappings
        ?? (integration.responseParameters && Object.keys(integration.responseParameters).length > 0 ? integration.responseParameters : null);
      if (effectiveResponses && Object.keys(effectiveResponses).length > 0) {
        fail(`${prefix}.responseParameters`, "responseParameters is only supported on HTTP APIs.", "capability_unsupported");
      }
    }
  } catch (error) {
    fail("processing", error.message, "invalid_config");
  }

  // --- S07 authorization snapshot (additive hook; S07 owns auth/snapshot.mjs).
  // Validates authorizers, method/route auth types and the resource policy,
  // and normalizes them for the artifact. Secret values stay behind refs.
  const authSnapshot = validateAuthSnapshot({
    protocol,
    authorizers: draft.authorizers,
    resourcePolicy: settings.resourcePolicy,
    methods,
    routes,
  });
  for (const entry of authSnapshot.errors) fail(String(entry.path), String(entry.message), entry.code ?? "invalid_config");
  for (const entry of authSnapshot.warnings) warn(String(entry.path), String(entry.message), entry.code ?? "suspicious_config");

  // --- Warnings: unused integrations / models ---
  for (const integration of integrations) {
    if (!referencedIntegrations.has(integration.id)) {
      warn(`integrations[${integration.id}]`, `Integration "${integration.id}" is not referenced by any route or method.`, "unused_integration");
    }
  }
  const usedModels = new Set();
  for (const method of methods) {
    for (const name of Object.values(method.requestModels ?? {})) {
      if (typeof name === "string") usedModels.add(name);
    }
  }
  for (const model of draft.models ?? []) {
    if (model?.name && !usedModels.has(model.name)) {
      warn(`models[${model.name}]`, `Model "${model.name}" is not referenced by any method.`, "unused_model");
    }
  }

  if (errors.length > 0) return { artifact: null, warnings, errors };

  // --- Build the artifact body (without digest) ---
  const integrationsMap = {};
  for (const integration of integrations) {
    const effectiveRequestMapping = protocol === "HTTP"
      ? (integration.requestMapping
        ?? (integration.requestParameters && Object.keys(integration.requestParameters).length > 0 ? { ...integration.requestParameters } : null))
      : (integration.requestMapping ? { ...integration.requestMapping } : null);
    const effectiveResponseMappings = protocol === "HTTP"
      ? (integration.responseMappings
        ?? (integration.responseParameters && Object.keys(integration.responseParameters).length > 0
          ? Object.fromEntries(Object.entries(integration.responseParameters).map(([status, table]) => [status, { ...(table ?? {}) }]))
          : null))
      : (integration.responseMappings ? { ...integration.responseMappings } : null);
    integrationsMap[integration.id] = {
      type: integration.type,
      uri: integration.uri,
      integrationMethod: integration.integrationMethod,
      timeoutMs: integration.timeoutMs,
      connectionType: integration.connectionType,
      connectorId: integration.connectorId,
      backendAuth: integration.backendAuth,
      function: integration.function,
      aws: integration.aws,
      tls: integration.tls,
      payloadFormatVersion: integration.payloadFormatVersion,
      passthroughBehavior: integration.passthroughBehavior,
      contentHandling: integration.contentHandling,
      // S06 runtime wiring (S06W): mapping/template/response config the
      // `integrationRequest`/`integrationResponse` phases consume.
      requestParameters: { ...(integration.requestParameters ?? {}) },
      requestTemplates: { ...(integration.requestTemplates ?? {}) },
      requestMapping: effectiveRequestMapping,
      responseMappings: effectiveResponseMappings,
      responseParameters: integration.responseParameters ? { ...integration.responseParameters } : null,
      templateSelectionExpression: integration.templateSelectionExpression ?? null,
      integrationResponses: responsesForIntegration(draft, integration.id, integration),
    };
  }
  // S07: normalized authorizer snapshot (validated above; raw entries that
  // failed validation are omitted so the artifact never carries them).
  const authorizersMap = { ...authSnapshot.authorizers };
  const modelsMap = {};
  for (const entry of draft.models ?? []) {
    if (entry?.name) modelsMap[entry.name] = { contentType: entry.contentType ?? "application/json", schema: entry.schema ?? {} };
  }

  const body = {
    schemaVersion: SCHEMA_VERSION,
    projectId: String(projectId),
    apiId: String(apiId),
    apiPublicId: String(apiPublicId),
    protocol,
    settings: {
      apiKeySource: settings.apiKeySource,
      binaryMediaTypes: [...settings.binaryMediaTypes],
      minimumCompressionSize: settings.minimumCompressionSize,
      missingRouteBehavior: settings.missingRouteBehavior,
      cors: settings.cors,
      // S07: the validated resource-policy snapshot (null when unconfigured).
      resourcePolicy: authSnapshot.resourcePolicy,
      routeSelectionExpression: settings.routeSelectionExpression,
    },
    routes: routes.map((route) => ({
      id: route.id,
      routeKey: route.routeKey,
      auth: { type: route.authorizationType, authorizerId: route.authorizerId, scopes: [...(route.authorizationScopes ?? [])] },
      apiKeyRequired: Boolean(route.apiKeyRequired),
      integrationId: route.integrationId,
    })),
    resources: resources.map((resource) => ({
      id: resource.id,
      path: resource.path,
      methods: Object.fromEntries(
        methods
          .filter((method) => method.resourceId === resource.id)
          .map((method) => [method.httpMethod, {
            id: method.id,
            auth: { type: method.authorizationType, authorizerId: method.authorizerId, scopes: [...(method.authorizationScopes ?? [])] },
            apiKeyRequired: Boolean(method.apiKeyRequired),
            validatorId: method.requestValidatorId,
            requestParameters: { ...(method.requestParameters ?? {}) },
            requestModels: { ...(method.requestModels ?? {}) },
            integrationId: method.integrationId,
            // S06 runtime wiring (S06W): per-method response declarations
            // the `integrationResponse` phase selects into.
            methodResponses: responsesForMethod(draft, method.id, method),
          }]),
      ),
    })),
    integrations: integrationsMap,
    authorizers: authorizersMap,
    models: modelsMap,
    validators: Object.fromEntries((draft.validators ?? []).map((entry) => [entry?.name ?? entry?.id, entry])),
    // S06 runtime wiring (S06W): normalized array; the pipeline renders
    // gateway errors through these customizations.
    gatewayResponses: normGatewayResponses(draft.gatewayResponses),
    // S06 runtime wiring (S06W): API default request validator id and
    // engine feature flags (subdomain CORS wildcards, brotli).
    defaultValidatorId: draft.defaultValidatorId
      ?? draft.settings?.defaultValidatorId
      ?? draft.api?.defaultValidatorId
      ?? null,
    features: { ...(draft.features ?? {}) },
    integrationResponses: draft.integrationResponses ?? {},
    matcher: {
      http: routes.map((route) => ({ id: route.id, routeKey: route.routeKey })),
      rest: resources.map((resource) => ({ id: resource.id, path: resource.path })),
    },
    // Engine compatibility (S03 match phase reads these directly):
    httpRoutes: routes.map((route) => ({ id: route.id, routeKey: route.routeKey })),
    restResources: resources.map((resource) => ({ id: resource.id, path: resource.path })),
    restMethods: methods.map((method) => ({ id: method.id, resourceId: method.resourceId, httpMethod: method.httpMethod })),
    missingRouteBehavior: settings.missingRouteBehavior === "not_found" ? "not_found" : "aws",
    // S06 runtime wiring (S06W): global HTTP-API mapping tables (per S06
    // §3); integrations without their own tables fall back to these.
    httpMappings: draft.httpMappings ?? null,
  };

  // --- Secret scan (vault plaintext hook) ---
  const strings = [];
  collectStrings(body, strings);
  for (const plaintext of plaintextCache) {
    if (typeof plaintext !== "string" || plaintext.length < 4) continue;
    if (strings.some((entry) => entry.includes(plaintext))) {
      throw new Error("Artifact must not contain secret values (matched the vault plaintext cache).");
    }
  }

  const digest = `sha256:${createHash("sha256").update(canonicalJson(body), "utf8").digest("hex")}`;
  return { artifact: { ...body, digest }, warnings, errors };
}

/**
 * Computes the digest for an artifact body (without `digest`).
 *
 * @param {object} body
 * @returns {string}
 */
export function digestBody(body) {
  const { digest: _ignored, ...rest } = body ?? {};
  return `sha256:${createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex")}`;
}

export { validateStageVariables };
