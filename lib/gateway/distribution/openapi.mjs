/**
 * Pure OpenAPI import/export engine (S13 part A).
 *
 * No Next.js, Supabase or Node-only APIs except the `yaml` package for
 * YAML parsing. All functions are deterministic: parsing, plan building
 * (OpenAPI → draft operations), extension translation and export
 * document building (artifact → OpenAPI/Postman). Storage lives in
 * `lib/control/openapi-import.mjs` / `openapi-export.mjs`, which call in
 * here and then write through the control db port.
 *
 * Plan shape (also consumed by the later SDK/portal passes — keep stable):
 * ```
 * {
 *   protocol: "REST" | "HTTP",
 *   api: { name, description, binaryMediaTypes, minimumCompressionSize,
 *          endpointType, cors, tags },
 *   resources: [{ path }],                       // REST only
 *   operations: [{ path, method, operationName, authType, authorizerName,
 *                  apiKeyRequired, requestParameters, requestModels,
 *                  integration, responses, documentation }],
 *   models: [{ name, contentType, schema }],
 *   authorizers: [{ name, type, identitySource, jwt, function }],
 *   gatewayResponses: [{ responseType, statusCode, ... }],
 *   documentationParts: [{ location, properties }],
 * }
 * ```
 * `integration` is null when the operation carries no integration
 * extension (the control layer then leaves any existing link alone on
 * merge, and fails the deploy later per S05 `missing_integration`).
 *
 * @module lib/gateway/distribution/openapi
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** AWS import payload cap (S13 §A). Mirrors `lib/control/http.mjs`. */
export const MAX_IMPORT_BYTES = 6 * 1024 * 1024;

/** Keys that must never become object keys (prototype-pollution guard). */
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warn(warnings, path, message) {
  warnings.push({ path, message });
  return warnings;
}

/** Deep-clone JSON data while dropping poison keys. */
function cleanKeys(value) {
  if (Array.isArray(value)) return value.map(cleanKeys);
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (POISON_KEYS.has(key)) continue;
    out[key] = cleanKeys(entry);
  }
  return out;
}

/**
 * Parses an OpenAPI 2.0 / 3.0.x / 3.1 document from text (JSON or YAML).
 *
 * @param {string|object} input - Raw text or an already-parsed object.
 * @returns {{ doc: object, format: "json"|"yaml" }}
 * @throws {Error} `body_too_large` / `invalid_document`.
 */
export function parseDocument(input) {
  if (isObject(input)) return { doc: cleanKeys(input), format: "json" };
  if (typeof input !== "string" || input.length === 0) {
    throw Object.assign(new Error("Import body must be a non-empty OpenAPI document."), { code: "invalid_document" });
  }
  if (Buffer.byteLength(input, "utf8") > MAX_IMPORT_BYTES) {
    throw Object.assign(new Error("OpenAPI document exceeds the 6 MB limit."), { code: "body_too_large" });
  }
  const trimmed = input.trimStart();
  let doc;
  let format = "json";
  try {
    if (trimmed.startsWith("{")) {
      doc = JSON.parse(input);
    } else {
      format = "yaml";
      doc = parseYaml(input);
    }
  } catch {
    throw Object.assign(new Error("OpenAPI document is not valid JSON or YAML."), { code: "invalid_document" });
  }
  if (!isObject(doc)) {
    throw Object.assign(new Error("OpenAPI document must be an object."), { code: "invalid_document" });
  }
  return { doc: cleanKeys(doc), format };
}

/**
 * Detects Swagger 2.0 vs OpenAPI 3.x.
 *
 * @param {object} doc
 * @returns {{ kind: "swagger"|"oas3", version: string }}
 * @throws {Error} `invalid_document` for anything else.
 */
export function detectVersion(doc) {
  if (typeof doc.swagger === "string" && doc.swagger.startsWith("2.")) {
    return { kind: "swagger", version: doc.swagger };
  }
  if (typeof doc.openapi === "string" && /^3\.[01]/.test(doc.openapi)) {
    return { kind: "oas3", version: doc.openapi };
  }
  throw Object.assign(new Error("Only OpenAPI 2.0 / 3.0.x / 3.1 documents can be imported."), { code: "invalid_document" });
}

/** Matches either vendor prefix; returns the suffix or null. */
function extensionSuffix(key) {
  if (typeof key !== "string") return null;
  if (key.startsWith("x-amazon-apigateway-")) return key.slice("x-amazon-apigateway-".length);
  if (key.startsWith("x-pods-")) return key.slice("x-pods-".length);
  return null;
}

/** Reads `x-amazon-apigateway-*` or the `x-pods-*` alias, vendor-agnostic. */
function readExtension(node, name) {
  if (!isObject(node)) return undefined;
  if (Object.hasOwn(node, `x-amazon-apigateway-${name}`)) return node[`x-amazon-apigateway-${name}`];
  if (Object.hasOwn(node, `x-pods-${name}`)) return node[`x-pods-${name}`];
  return undefined;
}

/** Lambda proxy URI → the embedded function ARN, or null. Bounded input. */
const LAMBDA_URI_PATTERN = /^arn:aws:apigateway:[a-z0-9-]{1,64}:lambda:path\/2015-03-31\/functions\/(arn:aws:lambda:[^/]{1,1024})\/invocations$/;

/** AWS service URI (`…:{service}:path|action/…`) parts, or null. */
const AWS_SERVICE_URI_PATTERN = /^arn:aws:apigateway:([a-z0-9-]{1,64}):([A-Za-z0-9]{1,64}):(path|action)\/(.{1,2048})$/;

/**
 * Down-converts an OAS 3.0/3.1 schema to JSON Schema draft-04 (what Pods
 * models store). Unsupported keywords become warnings; `$ref`s are kept.
 *
 * @param {unknown} schema
 * @param {Array} warnings
 * @param {string} path
 * @returns {object}
 */
export function downconvertSchema(schema, warnings, path) {
  if (!isObject(schema)) return isObject(schema) ? schema : {};
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case "exclusiveMinimum":
      case "exclusiveMaximum":
        // OAS 3.1 numeric form vs draft-04 boolean form.
        if (typeof value === "number") {
          warn(warnings, path, `Schema keyword "${key}" as a number is not draft-04; kept the boundary as a 3.1 extension.`);
          out[key] = value;
        } else {
          out[key] = value;
        }
        break;
      case "contains":
      case "unevaluatedProperties":
      case "unevaluatedItems":
      case "dependentRequired":
      case "dependentSchemas":
      case "prefixItems":
      case "$dynamicRef":
      case "$dynamicAnchor":
      case "contentSchema":
        warn(warnings, path, `Schema keyword "${key}" is not supported in draft-04 and was dropped.`);
        break;
      case "if":
      case "then":
      case "else":
        warn(warnings, path, `Conditional schema keyword "${key}" is not supported in draft-04 and was dropped.`);
        break;
      default:
        if (key === "properties" && isObject(value)) {
          out.properties = {};
          for (const [name, sub] of Object.entries(value)) {
            out.properties[name] = downconvertSchema(sub, warnings, `${path}.properties.${name}`);
          }
        } else if (key === "items") {
          out.items = Array.isArray(value)
            ? value.map((entry, index) => downconvertSchema(entry, warnings, `${path}.items[${index}]`))
            : downconvertSchema(value, warnings, `${path}.items`);
        } else if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
          out[key] = value.map((entry, index) => downconvertSchema(entry, warnings, `${path}.${key}[${index}]`));
        } else if (key === "additionalProperties" && isObject(value)) {
          out.additionalProperties = downconvertSchema(value, warnings, `${path}.additionalProperties`);
        } else {
          out[key] = value;
        }
        break;
    }
  }
  return out;
}

/**
 * Translates one integration extension block to Pods integration fields.
 * Lambda URIs become `FUNCTION_PROXY` with provider `aws_lambda`;
 * `VPC_LINK` becomes `CONNECTOR` (unmapped connection ids are warnings);
 * AWS service URIs become `AWS_SERVICE`. `$stageVariables` references in
 * URIs pass through untouched.
 *
 * @param {object} extension
 * @param {Array} warnings
 * @param {string} path
 * @returns {object|null} Pods integration fields, or null when absent.
 */
export function translateIntegration(extension, warnings, path) {
  if (extension === undefined) return null;
  if (!isObject(extension)) {
    warn(warnings, path, "Integration extension must be an object; ignored.");
    return null;
  }
  const rawType = String(extension.type ?? "http_proxy").toLowerCase();
  const uri = typeof extension.uri === "string" ? extension.uri : null;
  const integration = {
    type: "HTTP_PROXY",
    uri,
    integrationMethod: "ANY",
    connectionType: "INTERNET",
    connectorId: null,
    function: null,
    aws: null,
    timeoutMs: null,
    passthroughBehavior: null,
    contentHandling: null,
    requestParameters: isObject(extension.requestParameters) ? { ...extension.requestParameters } : {},
    requestTemplates: isObject(extension.requestTemplates) ? { ...extension.requestTemplates } : {},
  };
  if (typeof extension.httpMethod === "string" && extension.httpMethod !== "") {
    integration.integrationMethod = extension.httpMethod.toUpperCase();
  }
  if (typeof extension.passthroughBehavior === "string") integration.passthroughBehavior = extension.passthroughBehavior;
  if (typeof extension.contentHandling === "string") integration.contentHandling = extension.contentHandling;
  if (Number.isInteger(extension.timeoutInMillis)) integration.timeoutMs = extension.timeoutInMillis;

  const connectionType = String(extension.connectionType ?? "INTERNET").toUpperCase();
  if (connectionType === "VPC_LINK") {
    integration.connectionType = "CONNECTOR";
    const connectionId = extension.connectionId;
    if (typeof connectionId === "string" && connectionId !== "") {
      warn(warnings, path, `VPC_LINK connection "${connectionId}" has no Pods connector mapping; imported as CONNECTOR without a target.`);
    } else {
      warn(warnings, path, "VPC_LINK integration without a connection id; imported as CONNECTOR without a target.");
    }
  }

  if (uri) {
    const lambda = uri.match(LAMBDA_URI_PATTERN);
    if (lambda) {
      integration.type = rawType === "aws" ? "FUNCTION" : "FUNCTION_PROXY";
      integration.uri = null;
      integration.function = { provider: "aws_lambda", functionArn: lambda[1] };
      return integration;
    }
    const service = uri.match(AWS_SERVICE_URI_PATTERN);
    if (service) {
      integration.type = "AWS_SERVICE";
      integration.uri = null;
      const [, region, serviceName, kind, rest] = service;
      integration.aws = kind === "action"
        ? { service: serviceName, region, action: rest }
        : { service: serviceName, region, path: `/${rest}` };
      return integration;
    }
  }
  switch (rawType) {
    case "aws_proxy":
      integration.type = "FUNCTION_PROXY";
      if (!integration.function) warn(warnings, path, "aws_proxy integration without a Lambda URI imports as FUNCTION_PROXY with the URI kept.");
      break;
    case "aws":
      integration.type = "AWS_SERVICE";
      if (!integration.aws) warn(warnings, path, "aws integration without a service URI imports as AWS_SERVICE with the URI kept.");
      break;
    case "http":
      integration.type = "HTTP";
      break;
    case "http_proxy":
      integration.type = "HTTP_PROXY";
      break;
    case "mock":
      integration.type = "MOCK";
      integration.uri = null;
      break;
    default:
      warn(warnings, path, `Unknown integration type "${extension.type}"; imported as HTTP_PROXY.`);
      integration.type = "HTTP_PROXY";
      break;
  }
  return integration;
}

/**
 * Rewrites OpenAPI-local schema refs (`#/definitions/X`,
 * `#/components/schemas/X`) to the Pods canonical model refs
 * (`https://pods.geiger/apis/{apiPublicId}/models/X`) so imported
 * models compile at deploy. Only `$ref` string values are touched.
 *
 * @param {unknown} schema
 * @param {string} base - Canonical base (`modelRefBase` in S06 validation).
 * @returns {unknown}
 */
export function rewriteModelRefs(schema, base) {
  if (Array.isArray(schema)) return schema.map((entry) => rewriteModelRefs(entry, base));
  if (!isObject(schema)) return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" && typeof value === "string") {
      const local = /^(#\/definitions\/|#\/components\/schemas\/)([A-Za-z0-9]{1,128})$/.exec(value);
      out[key] = local ? `${base}${local[2]}` : value;
    } else {
      out[key] = rewriteModelRefs(value, base);
    }
  }
  return out;
}

/** Known top-level extension suffixes (anything else warns, AWS parity). */
const KNOWN_TOP_LEVEL = new Set([
  "binary-media-types", "minimum-compression-size", "cors", "gateway-responses",
  "api-key-source", "endpoint-configuration", "policy", "documentation",
  "importexport-version", "tag-value", "request-validators", "request-validator",
]);

/**
 * Builds an import plan from a parsed document. Pure: no I/O, warnings
 * carry `{ path, message }`.
 *
 * @param {object} doc - Parsed OpenAPI document (use `parseDocument` first).
 * @param {{ protocol?: "REST"|"HTTP", basepath?: "ignore"|"prepend"|"split", ignore?: string }} [options]
 * @returns {{ plan: object, warnings: Array<{ path: string, message: string }> }}
 */
export function planImport(doc, options = {}) {
  const { kind } = detectVersion(doc);
  const warnings = [];
  const protocol = options.protocol === "HTTP" ? "HTTP" : "REST";
  const basepathMode = options.basepath ?? "ignore";
  const ignoreList = new Set(
    String(options.ignore ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  );

  const info = isObject(doc.info) ? doc.info : {};
  const plan = {
    protocol,
    api: {
      name: typeof info.title === "string" && info.title !== "" ? info.title.slice(0, 128) : "Imported API",
      description: typeof info.description === "string" ? info.description.slice(0, 1024) : "",
      binaryMediaTypes: [],
      minimumCompressionSize: null,
      endpointType: "REGIONAL",
      cors: null,
      tags: {},
    },
    resources: [],
    operations: [],
    models: [],
    authorizers: [],
    gatewayResponses: [],
    documentationParts: [],
  };

  // --- Top-level extensions -------------------------------------------------
  for (const key of Object.keys(doc)) {
    const suffix = extensionSuffix(key);
    if (!suffix) continue;
    if (!KNOWN_TOP_LEVEL.has(suffix)) {
      warn(warnings, `$.${key}`, `Unsupported extension "${key}"; ignored.`);
      continue;
    }
    const value = doc[key];
    if (suffix === "binary-media-types" && Array.isArray(value)) {
      plan.api.binaryMediaTypes = value.filter((entry) => typeof entry === "string").slice(0, 64);
    } else if (suffix === "minimum-compression-size" && Number.isInteger(value)) {
      plan.api.minimumCompressionSize = value;
    } else if (suffix === "cors" && isObject(value)) {
      plan.api.cors = value;
    } else if (suffix === "api-key-source" && typeof value === "string") {
      plan.api.apiKeySource = value;
    } else if (suffix === "endpoint-configuration" && isObject(value)) {
      const types = Array.isArray(value.types) ? value.types : [];
      if (types.includes("PRIVATE")) plan.api.endpointType = "PRIVATE";
      else if (types.includes("EDGE")) plan.api.endpointType = "EDGE";
    } else if (suffix === "tag-value" && isObject(value)) {
      for (const [tagKey, tagValue] of Object.entries(value).slice(0, 50)) {
        if (typeof tagValue === "string") plan.api.tags[tagKey] = tagValue;
      }
    } else if (suffix === "importexport-version") {
      // Informational only; accepted silently.
    } else if (suffix === "gateway-responses" && isObject(value)) {
      for (const [responseType, entry] of Object.entries(value)) {
        if (isObject(entry)) plan.gatewayResponses.push({ responseType, ...entry });
      }
    } else if (suffix === "documentation" && !ignoreList.has("documentation")) {
      collectDocumentationParts(value, plan.documentationParts, warnings);
    } else if ((suffix === "request-validators" || suffix === "request-validator") && isObject(value)) {
      plan.requestValidators = value;
    } else if (suffix === "policy") {
      warn(warnings, `$.${key}`, "Resource policy import is not supported; configure it in Pods instead.");
    }
  }

  // --- basePath (REST only) ---------------------------------------------------
  let basePrefix = "";
  const rawBase = kind === "swagger" && typeof doc.basePath === "string" ? doc.basePath : "";
  if (protocol === "REST" && rawBase && rawBase !== "/") {
    if (basepathMode === "prepend" || basepathMode === "split") {
      basePrefix = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase;
      if (basepathMode === "split") {
        warn(warnings, "$.basePath", 'basepath=split imports every path under one API with the base path prepended (Pods has no multi-base import).');
      }
    }
  }

  // --- Models -----------------------------------------------------------------
  const schemas = kind === "swagger"
    ? (isObject(doc.definitions) ? doc.definitions : {})
    : (isObject(doc.components) && isObject(doc.components.schemas) ? doc.components.schemas : {});
  for (const [name, schema] of Object.entries(schemas)) {
    if (!/^[A-Za-z0-9]{1,128}$/.test(name)) {
      warn(warnings, `$.definitions.${name}`, `Model name "${name}" is not Pods-compatible; skipped.`);
      continue;
    }
    plan.models.push({
      name,
      contentType: "application/json",
      schema: downconvertSchema(schema, warnings, `$.definitions.${name}`),
    });
  }

  // --- Security schemes → authorizers ------------------------------------------
  const schemes = kind === "swagger"
    ? (isObject(doc.securityDefinitions) ? doc.securityDefinitions : {})
    : (isObject(doc.components) && isObject(doc.components.securitySchemes) ? doc.components.securitySchemes : {});
  const apiKeySchemes = new Set();
  for (const [name, scheme] of Object.entries(schemes)) {
    if (!isObject(scheme)) {
      warn(warnings, "$.securityDefinitions", `Security scheme "${name}" must be an object; ignored.`);
      continue;
    }
    const type = String(scheme.type ?? "").toLowerCase();
    if ((kind === "swagger" && type === "apikey") || (kind === "oas3" && type === "apikey")) {
      apiKeySchemes.add(name);
    } else if (type === "oauth2" || type === "openidconnect" || type === "openIdConnect" || type === "http") {
      const authorizerExt = readExtension(scheme, "authorizer");
      plan.authorizers.push({
        name: name.slice(0, 64),
        type: "JWT",
        identitySource: [],
        jwt: { issuer: scheme.openIdConnectUrl ?? scheme.openIdConnectUrl ?? null, audiences: [] },
        fromScheme: type,
      });
      if (!authorizerExt) {
        warn(warnings, "$.securityDefinitions", `Security scheme "${name}" imports as a JWT authorizer placeholder; review issuer and audiences.`);
      }
    } else {
      warn(warnings, "$.securityDefinitions", `Security scheme "${name}" of type "${scheme.type}" is not supported; ignored.`);
    }
  }

  // --- Paths → operations --------------------------------------------------------
  const paths = isObject(doc.paths) ? doc.paths : {};
  const resourcePaths = new Set();
  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) {
      warn(warnings, `$.paths.${rawPath}`, "Path item must be an object; ignored.");
      continue;
    }
    if (!rawPath.startsWith("/")) {
      warn(warnings, "$.paths", `Path "${rawPath}" must start with "/"; ignored.`);
      continue;
    }
    const fullPath = `${basePrefix}${rawPath}`;
    const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    const pathExt = {};
    for (const key of Object.keys(pathItem)) {
      const suffix = extensionSuffix(key);
      if (suffix && suffix !== "any-method" && suffix !== "integration") {
        warn(warnings, `$.paths.${rawPath}.${key}`, `Unsupported path-level extension "${key}"; ignored.`);
      }
      if (suffix === "integration") pathExt.integration = pathItem[key];
    }
    const methodNames = Object.keys(pathItem).filter((key) => /^(get|post|put|patch|delete|head|options|any|x-amazon-apigateway-any-method|x-pods-any-method)$/i.test(key));
    for (const rawMethod of methodNames) {
      const operation = pathItem[rawMethod];
      if (!isObject(operation)) {
        warn(warnings, `$.paths.${rawPath}.${rawMethod}`, "Operation must be an object; ignored.");
        continue;
      }
      const method = rawMethod.toLowerCase().includes("any-method") ? "ANY" : rawMethod.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"].includes(method)) continue;
      resourcePaths.add(fullPath);
      plan.operations.push(buildOperation({
        doc, kind, fullPath, rawPath, method, operation, pathParameters,
        apiKeySchemes, warnings, protocol,
      }));
    }
    // Unknown methods (e.g. trace) warn.
    for (const key of Object.keys(pathItem)) {
      if (!methodNames.includes(key) && !key.startsWith("x-") && !["parameters", "summary", "description", "$ref"].includes(key)) {
        warn(warnings, `$.paths.${rawPath}.${key}`, `Unknown HTTP method "${key}"; ignored.`);
      }
    }
  }
  plan.resources = [...resourcePaths].map((path) => ({ path }));

  return { plan, warnings };
}

/** Collects `x-amazon-apigateway-documentation` parts into the plan. */
function collectDocumentationParts(value, out, warnings) {
  const parts = Array.isArray(value?.documentationParts) ? value.documentationParts : (Array.isArray(value) ? value : null);
  if (!parts) {
    warn(warnings, "$.x-amazon-apigateway-documentation", "Documentation extension has no documentationParts array; ignored.");
    return;
  }
  for (const entry of parts.slice(0, 2000)) {
    if (isObject(entry?.location) && isObject(entry?.properties)) out.push({ location: entry.location, properties: entry.properties });
  }
}

/**
 * Builds one plan operation from an OpenAPI operation object.
 */
function buildOperation({ doc, kind, fullPath, rawPath, method, operation, pathParameters, apiKeySchemes, warnings, protocol }) {
  const opPath = `$.paths.${rawPath}.${method.toLowerCase()}`;
  const parameters = [...pathParameters, ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
  const requestParameters = {};
  const requestModels = {};
  let bodySchemaName = null;

  for (const param of parameters) {
    if (!isObject(param)) continue;
    if (param.$ref) {
      warn(warnings, opPath, "Parameter $refs are not resolved; the parameter was skipped.");
      continue;
    }
    const location = param.in;
    const name = param.name;
    if (typeof name !== "string" || (location !== "query" && location !== "header" && location !== "path")) continue;
    if (location === "header") {
      const lowered = name.toLowerCase();
      if (["accept", "content-type", "authorization"].includes(lowered)) continue;
    }
    const key = location === "query" ? `method.request.querystring.${name}`
      : location === "header" ? `method.request.header.${name}`
      : `method.request.path.${name}`;
    requestParameters[key] = param.required === true;
  }

  if (kind === "swagger") {
    const body = parameters.find((entry) => isObject(entry) && entry.in === "body");
    if (body && isObject(body.schema)) {
      const ref = typeof body.schema.$ref === "string" ? body.schema.$ref : null;
      const name = ref ? ref.split("/").pop() : null;
      if (name) {
        bodySchemaName = name;
        requestModels["application/json"] = name;
      } else {
        warn(warnings, opPath, "Inline body schemas are not imported as models; the body model was skipped.");
      }
    }
    // Swagger `responses` with schema refs are informational for import.
  } else {
    const requestBody = isObject(operation.requestBody) ? operation.requestBody : null;
    const content = requestBody && isObject(requestBody.content) ? requestBody.content : {};
    for (const [contentType, media] of Object.entries(content).slice(0, 8)) {
      const ref = isObject(media?.schema) && typeof media.schema.$ref === "string" ? media.schema.$ref : null;
      const name = ref ? ref.split("/").pop() : null;
      if (name) requestModels[contentType] = name;
      else warn(warnings, opPath, `Inline requestBody schema for "${contentType}" was skipped (named models only).`);
    }
  }

  // Security → auth type / API key.
  let authType = "NONE";
  let authorizerName = null;
  let apiKeyRequired = false;
  const security = Array.isArray(operation.security) ? operation.security
    : Array.isArray(doc.security) ? doc.security : [];
  for (const requirement of security) {
    if (!isObject(requirement)) continue;
    for (const name of Object.keys(requirement)) {
      if (apiKeySchemes.has(name)) apiKeyRequired = true;
      else {
        authType = "JWT";
        authorizerName = name;
      }
    }
  }
  if (authorizerName && protocol === "HTTP") {
    // HTTP APIs carry authorizers on routes via the same authorizer rows.
  }

  const integrationExt = readExtension(operation, "integration");
  const integration = translateIntegration(
    integrationExt === undefined ? null : integrationExt,
    warnings,
    `${opPath}.x-amazon-apigateway-integration`,
  );

  // Method-level authorizer extension overrides the security-derived one.
  const authorizerExt = readExtension(operation, "authorizer");
  if (authorizerExt !== undefined) {
    if (isObject(authorizerExt) && typeof authorizerExt.authorizerUri === "string") {
      const lambda = authorizerExt.authorizerUri.match(LAMBDA_URI_PATTERN);
      if (lambda) {
        authorizerName = `imported-${String(operation.operationId ?? `${method}-${fullPath}`).slice(0, 40)}`;
        authType = "CUSTOM";
      } else {
        warn(warnings, opPath, "Custom authorizer without a Lambda authorizerUri imports without an authorizer.");
      }
    } else if (authorizerExt !== null) {
      warn(warnings, opPath, "Authorizer extension shape not understood; the operation imports unauthenticated.");
    }
  }

  // Request validator hints.
  const validatorExt = readExtension(operation, "request-validator");
  if (validatorExt !== undefined) {
    warn(warnings, opPath, "Request validator references are accepted but must be rebound after import.");
  }

  return {
    path: fullPath,
    method,
    operationName: typeof operation.operationId === "string" ? operation.operationId.slice(0, 256) : "",
    summary: typeof operation.summary === "string" ? operation.summary : "",
    description: typeof operation.description === "string" ? operation.description : "",
    authType,
    authorizerName,
    apiKeyRequired,
    requestParameters,
    requestModels,
    bodySchemaName,
    integration,
    responses: collectResponses(operation, kind, warnings, opPath),
    documentation: readExtension(operation, "documentation") ?? null,
  };
}

function collectResponses(operation, kind, warnings, opPath) {
  const responses = isObject(operation.responses) ? operation.responses : {};
  const out = [];
  for (const [status, entry] of Object.entries(responses).slice(0, 32)) {
    if (!isObject(entry)) continue;
    out.push({
      statusCode: status,
      description: typeof entry.description === "string" ? entry.description : "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export builders (artifact → OpenAPI / Postman). The control layer loads
// the deployed artifact (never the draft) and the stage documentation
// version, then calls in here.
// ---------------------------------------------------------------------------

/**
 * Rebuilds the `x-amazon-apigateway-integration` block for one artifact
 * integration (the inverse of `translateIntegration`, so `extensions=aws`
 * round-trips back to AWS).
 */
export function integrationToExtension(integration, { flavour }) {
  if (!integration) return null;
  const prefix = flavour === "pods" ? "x-pods-integration" : "x-amazon-apigateway-integration";
  if (integration.type === "MOCK") {
    const templates = integration.requestTemplates ?? {};
    return {
      [prefix]: {
        type: "mock",
        passthroughBehavior: integration.passthroughBehavior ?? "WHEN_NO_MATCH",
        ...(Object.keys(templates).length > 0 ? { requestTemplates: templates } : {}),
      },
    };
  }
  if ((integration.type === "FUNCTION_PROXY" || integration.type === "FUNCTION") && integration.function?.provider === "aws_lambda") {
    const functionArn = integration.function.functionArn ?? "";
    const region = /arn:aws:lambda:([^:]+):/.exec(functionArn)?.[1] ?? "us-east-1";
    return {
      [prefix]: {
        type: integration.type === "FUNCTION" ? "aws" : "aws_proxy",
        httpMethod: "POST",
        uri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${functionArn}/invocations`,
        passthroughBehavior: integration.passthroughBehavior ?? "WHEN_NO_MATCH",
      },
    };
  }
  if (integration.type === "AWS_SERVICE" && integration.aws?.service) {
    const aws = integration.aws;
    const suffix = aws.action ? `action/${aws.action}` : `path${aws.path ?? "/"}`;
    return {
      [prefix]: {
        type: "aws",
        httpMethod: integration.integrationMethod ?? "ANY",
        uri: `arn:aws:apigateway:${aws.region ?? "us-east-1"}:${aws.service}:${suffix}`,
        passthroughBehavior: integration.passthroughBehavior ?? "WHEN_NO_MATCH",
      },
    };
  }
  const block = {
    type: integration.type === "HTTP" ? "http" : "http_proxy",
    httpMethod: integration.integrationMethod ?? "ANY",
    passthroughBehavior: integration.passthroughBehavior ?? "WHEN_NO_MATCH",
  };
  if (integration.uri) block.uri = integration.uri;
  if (integration.connectionType === "CONNECTOR") {
    block.connectionType = "vpc-link";
    if (integration.connectorId) block.connectionId = integration.connectorId;
  }
  if (integration.contentHandling) block.contentHandling = integration.contentHandling;
  if (integration.requestParameters && Object.keys(integration.requestParameters).length > 0) {
    block.requestParameters = integration.requestParameters;
  }
  if (integration.requestTemplates && Object.keys(integration.requestTemplates).length > 0) {
    block.requestTemplates = integration.requestTemplates;
  }
  return { [prefix]: block };
}

/**
 * Builds an export document from a compiled artifact.
 *
 * @param {{ artifact: object, stageName: string, invokeUrl: string|null,
 *   type: "oas30"|"swagger", extensions: "none"|"pods"|"aws",
 *   includeDocs: boolean, docsByLocation?: Map<string, object> }} input
 * @returns {object} OpenAPI document (JSON-serializable).
 */
export function buildExportDocument({ artifact, stageName, invokeUrl, type, extensions, includeDocs, docsByLocation = new Map() }) {
  const flavour = extensions === "pods" ? "pods" : "aws";
  const withExtensions = extensions !== "none";
  const doc = type === "swagger"
    ? {
        swagger: "2.0",
        info: { title: artifact.apiPublicId ?? "API", version: stageName },
        host: invokeUrl ? new URL(invokeUrl).host : undefined,
        basePath: invokeUrl ? stagePath(invokeUrl) : "/",
        schemes: ["https"],
        paths: {},
        definitions: {},
      }
    : {
        openapi: "3.0.3",
        info: { title: artifact.apiPublicId ?? "API", version: stageName },
        servers: invokeUrl ? [{ url: invokeUrl }] : [],
        paths: {},
        components: { schemas: {} },
      };
  if (type === "swagger" && doc.host === undefined) delete doc.host;

  // Models.
  for (const [name, model] of Object.entries(artifact.models ?? {})) {
    if (type === "swagger") doc.definitions[name] = model.schema ?? {};
    else doc.components.schemas[name] = model.schema ?? {};
  }

  // Paths.
  const paths = type === "swagger" ? doc.paths : doc.paths;
  if (artifact.protocol === "HTTP") {
    for (const route of artifact.routes ?? []) {
      const { method, path } = splitRouteKey(route.routeKey);
      if (!method || !path) continue;
      const operation = buildExportOperation({ artifact, routeOrMethod: route, path, method, withExtensions, flavour, includeDocs, docsByLocation, type });
      paths[path] = { ...(paths[path] ?? {}), [method.toLowerCase()]: operation };
    }
  } else {
    for (const resource of artifact.resources ?? []) {
      for (const [method, entry] of Object.entries(resource.methods ?? {})) {
        const operation = buildExportOperation({ artifact, routeOrMethod: entry, path: resource.path, method, withExtensions, flavour, includeDocs, docsByLocation, type });
        paths[resource.path] = { ...(paths[resource.path] ?? {}), [method.toLowerCase()]: operation };
      }
    }
  }

  // API-level extensions (aws flavour round-trips them back to AWS).
  if (withExtensions) {
    const prefix = flavour === "pods" ? "x-pods" : "x-amazon-apigateway";
    const binary = artifact.settings?.binaryMediaTypes ?? [];
    if (binary.length > 0) doc[`${prefix}-binary-media-types`] = binary;
    if (artifact.settings?.minimumCompressionSize !== null && artifact.settings?.minimumCompressionSize !== undefined) {
      doc[`${prefix}-minimum-compression-size`] = artifact.settings.minimumCompressionSize;
    }
    if (artifact.settings?.cors) doc[`${prefix}-cors`] = artifact.settings.cors;
    doc[`${prefix}-importexport-version`] = "1.0";
  }
  return doc;
}

function stagePath(invokeUrl) {
  try {
    const path = new URL(invokeUrl).pathname;
    return path === "" ? "/" : path;
  } catch {
    return "/";
  }
}

function splitRouteKey(routeKey) {
  if (typeof routeKey !== "string") return {};
  if (routeKey === "$default") return { method: null, path: null };
  const space = routeKey.indexOf(" ");
  if (space === -1) return {};
  return { method: routeKey.slice(0, space), path: routeKey.slice(space + 1) };
}

function buildExportOperation({ artifact, routeOrMethod, path, method, withExtensions, flavour, includeDocs, docsByLocation, type }) {
  const auth = routeOrMethod.auth ?? {};
  const integration = artifact.integrations?.[routeOrMethod.integrationId] ?? null;
  const parameters = [];
  for (const [key, required] of Object.entries(routeOrMethod.requestParameters ?? {})) {
    const match = /^method\.request\.(querystring|header|path)\.(.+)$/.exec(key);
    if (!match) continue;
    const [, location, name] = match;
    parameters.push({
      name,
      in: location === "querystring" ? "query" : location,
      required: required === true,
      ...(type === "swagger" ? { type: "string" } : { schema: { type: "string" } }),
    });
  }
  const operation = {
    ...(routeOrMethod.operationName ? { operationId: routeOrMethod.operationName } : {}),
    parameters,
    responses: buildExportResponses(routeOrMethod, type),
  };
  if (auth.type && auth.type !== "NONE") {
    operation.security = [{ [auth.authorizerId ?? auth.type]: [] }];
  }
  if (routeOrMethod.apiKeyRequired) {
    operation.security = [...(operation.security ?? []), { api_key: [] }];
  }
  if (withExtensions) {
    Object.assign(operation, integrationToExtension(integration, { flavour }) ?? {});
  }
  if (includeDocs) {
    const docs = docsByLocation.get(`${method} ${path}`) ?? docsByLocation.get(`* ${path}`) ?? null;
    if (docs?.description) operation.description = docs.description;
    if (docs?.summary) operation.summary = docs.summary;
  }
  return operation;
}

function buildExportResponses(routeOrMethod, type) {
  const declared = routeOrMethod.methodResponses ?? routeOrMethod.responses ?? null;
  if (Array.isArray(declared) && declared.length > 0) {
    const out = {};
    for (const entry of declared) {
      const status = String(entry.statusCode ?? entry.status ?? "200");
      out[status] = { description: entry.description ?? "" };
      const modelName = Object.values(entry.responseModels ?? entry.requestModels ?? {})[0];
      if (modelName && type === "swagger") out[status].schema = { $ref: `#/definitions/${modelName}` };
      else if (modelName) out[status].content = { "application/json": { schema: { $ref: `#/components/schemas/${modelName}` } } };
    }
    return out;
  }
  return { 200: { description: "" } };
}

/**
 * Serializes an export document to text.
 *
 * @param {object} doc
 * @param {"json"|"yaml"} format
 * @returns {string}
 */
export function serializeExport(doc, format) {
  return format === "yaml" ? stringifyYaml(doc) : JSON.stringify(doc, null, 2);
}

/** Postman Collection v2.1 schema URL stamped into every export. */
export const POSTMAN_SCHEMA_URL = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/**
 * Builds a Postman Collection v2.1 document from an export document.
 *
 * @param {{ doc: object, name: string, baseUrl: string }} input
 * @returns {object} Collection v2.1 JSON.
 */
export function buildPostmanCollection({ doc, name, baseUrl }) {
  const items = [];
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!isObject(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isObject(operation)) continue;
      const query = [];
      const headers = [];
      for (const param of operation.parameters ?? []) {
        if (param.in === "query") query.push({ key: param.name, value: "", disabled: param.required !== true });
        if (param.in === "header") headers.push({ key: param.name, value: "" });
      }
      const templated = path.replace(/\{([A-Za-z0-9_.-]+)\+?\}/g, ":$1");
      const urlPath = templated.split("/").filter(Boolean);
      items.push({
        name: operation.operationId ?? `${method.toUpperCase()} ${path}`,
        request: {
          method: method.toUpperCase(),
          header: headers,
          url: {
            raw: `${baseUrl}${templated}`,
            protocol: baseUrl.startsWith("https") ? "https" : "http",
            host: [baseUrl.replace(/^https?:\/\//, "").split("/")[0]],
            path: urlPath,
            query,
          },
          description: operation.description ?? operation.summary ?? "",
        },
        response: [],
      });
    }
  }
  return {
    info: { name, schema: POSTMAN_SCHEMA_URL },
    variable: [{ key: "baseUrl", value: baseUrl }],
    item: items,
  };
}
