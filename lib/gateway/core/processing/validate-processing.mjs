/**
 * Compile-time validation for request/response processing (spec §10).
 *
 * `validateProcessing(draft)` is the entry S05's compile step calls: it
 * parses templates, compiles schemas, checks mapping grammar and reserved
 * headers, and verifies method-response declarations, so configuration
 * errors fail at deploy rather than at request time.
 *
 * Each error is `{ path, message, code }`; warnings are advisory (unknown
 * `$` sources, shadowing, missing defaults).
 *
 * @module lib/gateway/core/processing/validate-processing
 */

import { validateCorsConfig } from "./cors.mjs";
import {
  validateHttpMapping,
  validateRestRequestMapping,
  validateRestResponseMapping,
} from "./param-mapping.mjs";
import { compileModelSchemas, totalSchemaBytes, MAX_API_SCHEMA_BYTES } from "./validation.mjs";
import { compileTemplates } from "./templates/index.mjs";
import { MAX_COMPRESSION_SIZE } from "./compression.mjs";
import { GATEWAY_RESPONSES } from "../gateway-responses.mjs";

const STATUS_PATTERN = /^[1-5]\d\d$/;

/**
 * Validates a draft's processing configuration at compile time.
 *
 * Draft shape (all fields optional):
 * ```
 * {
 *   protocol: "REST" | "HTTP" | "WEBSOCKET",
 *   cors: { allowOrigins, allowMethods, allowHeaders, exposeHeaders, maxAge, allowCredentials },
 *   models: [{ name, schema }],
 *   validators: [{ name, validate_request_body, validate_request_parameters }],
 *   methods: [{
 *     methodId, requestParameters, requestModels, validatorId,
 *     requestTemplates, passthroughBehavior,
 *     integrationResponses: [{ statusCode, selectionPattern, responseParameters, responseTemplates }],
 *     methodResponses: [{ statusCode, responseParameters, responseModels }],
 *   }],
 *   httpMappings: { request: {...}, responses: { "<status>": {...} } },
 *   binaryMediaTypes: [...],
 *   minimumCompressionSize: number | null,
 *   gatewayResponses: [{ response_type, status_code, response_parameters, response_templates }],
 *   features: { corsWildcardSubdomains, brotliCompression },
 * }
 * ```
 *
 * @param {object} [draft={}]
 * @returns {{ errors: Array<object>, warnings: Array<object> }}
 */
export function validateProcessing(draft = {}) {
  const errors = [];
  const warnings = [];
  const fail = (path, message, code = "invalid_config") => errors.push({ path, message, code });
  const warn = (path, message, code = "suspicious_config") => warnings.push({ path, message, code });

  validateCors(draft, fail);
  validateModels(draft, fail, warn);
  validateMethods(draft, fail, warn);
  validateHttpMappingsBlock(draft, fail, warn);
  validateBinaryAndCompression(draft, fail, warn);
  validateGatewayResponsesBlock(draft, fail, warn);

  return { errors, warnings };
}

function validateCors(draft, fail) {
  if (draft.cors === undefined || draft.cors === null) return;
  for (const message of validateCorsConfig(draft.cors)) fail("cors", message, "invalid_cors");
}

function validateModels(draft, fail, warn) {
  const models = draft.models ?? [];
  if (totalSchemaBytes(models) > MAX_API_SCHEMA_BYTES) {
    fail("models", "Combined model schema size exceeds 400 KB", "schema_quota");
  }
  const { errors } = compileModelSchemas(models, { apiPublicId: draft.apiPublicId ?? "unknown" });
  for (const message of errors) fail("models", message, "invalid_model");
  const names = new Set((models ?? []).map((model) => model?.name));
  for (const validator of draft.validators ?? []) {
    if (!validator?.name) fail("validators", "Request validator needs a name", "invalid_validator");
  }
  void names;
  void warn;
}

function validateMethods(draft, fail, warn) {
  for (const method of draft.methods ?? []) {
    const prefix = `methods[${method?.methodId ?? "?"}]`;
    // Templates must parse now, not at request time.
    for (const side of ["requestTemplates"]) {
      const { errors } = compileTemplates(method?.[side] ?? {});
      for (const message of errors) fail(`${prefix}.${side}`, message, "invalid_template");
    }
    for (const response of method?.integrationResponses ?? []) {
      const { errors } = compileTemplates(response?.responseTemplates ?? {});
      for (const message of errors) {
        fail(`${prefix}.integrationResponses[${response?.statusCode ?? "?"}]`, message, "invalid_template");
      }
      if (response?.selectionPattern) {
        try {
          void new RegExp(`^(?:${response.selectionPattern})$`);
        } catch {
          fail(`${prefix}.integrationResponses[${response?.statusCode ?? "?"}]`, `Invalid selection_pattern regex: ${response.selectionPattern}`, "invalid_selection_pattern");
        }
      }
      if (response?.statusCode && !STATUS_PATTERN.test(String(response.statusCode))) {
        fail(`${prefix}.integrationResponses`, `Invalid status_code: ${response.statusCode}`, "invalid_status");
      }
    }
    // REST request mapping grammar + reserved headers.
    if (method?.requestParameters && typeof method.requestParameters === "object") {
      const { errors, warnings } = validateRestRequestMapping(method.requestParameters);
      for (const message of errors) fail(`${prefix}.requestParameters`, message, "invalid_mapping");
      for (const message of warnings) warn(`${prefix}.requestParameters`, message);
    }
    // Every integration-response status must declare a method response,
    // and every method.response.header mapping must be declared there.
    const declared = new Map(
      (method?.methodResponses ?? []).map((entry) => [String(entry?.statusCode), entry]),
    );
    let hasDefault = false;
    for (const response of method?.integrationResponses ?? []) {
      if ((response?.selectionPattern ?? "") === "") hasDefault = true;
      const status = String(response?.statusCode ?? "");
      if (status && !declared.has(status)) {
        fail(
          `${prefix}.integrationResponses[${status || "?"}]`,
          `status_code ${status || "(missing)"} has no method_responses row`,
          "undeclared_method_response",
        );
      } else if (status && declared.has(status)) {
        const declaredParams = declared.get(status)?.responseParameters ?? {};
        const { errors: mapErrors, warnings: mapWarnings } = validateRestResponseMapping(
          response?.responseParameters ?? {},
          declaredParams,
        );
        for (const message of mapErrors) fail(`${prefix}.integrationResponses[${status}]`, message, "invalid_mapping");
        for (const message of mapWarnings) warn(`${prefix}.integrationResponses[${status}]`, message);
      }
    }
    if ((method?.integrationResponses ?? []).length > 0 && !hasDefault) {
      warn(`${prefix}.integrationResponses`, "No default (empty selection_pattern) response; unmatched results become 500 API_CONFIGURATION_ERROR");
    }
    for (const entry of method?.methodResponses ?? []) {
      const status = String(entry?.statusCode ?? "");
      if (!STATUS_PATTERN.test(status)) fail(`${prefix}.methodResponses`, `Invalid status_code: ${status || "(missing)"}`, "invalid_status");
      for (const [contentType, modelName] of Object.entries(entry?.responseModels ?? {})) {
        void contentType;
        if (modelName && !compileModelSchemasHas(draft.models ?? [], modelName) && !["Empty", "Error"].includes(modelName)) {
          fail(`${prefix}.methodResponses[${status}]`, `response model "${modelName}" does not exist`, "unknown_model");
        }
      }
    }
    // Request models must reference known models.
    for (const modelName of Object.values(method?.requestModels ?? {})) {
      if (modelName && !compileModelSchemasHas(draft.models ?? [], modelName) && !["Empty", "Error"].includes(modelName)) {
        fail(`${prefix}.requestModels`, `request model "${modelName}" does not exist`, "unknown_model");
      }
    }
    if (method?.passthroughBehavior && !["WHEN_NO_MATCH", "WHEN_NO_TEMPLATES", "NEVER"].includes(method.passthroughBehavior)) {
      fail(`${prefix}.passthroughBehavior`, `Invalid passthrough_behavior: ${method.passthroughBehavior}`, "invalid_passthrough");
    }
  }
}

function compileModelSchemasHas(models, name) {
  return (models ?? []).some((model) => model?.name === name);
}

function validateHttpMappingsBlock(draft, fail, warn) {
  const http = draft.httpMappings;
  if (!http) return;
  const request = validateHttpMapping(http.request ?? {}, "request");
  for (const message of request.errors) fail("httpMappings.request", message, "invalid_mapping");
  for (const message of request.warnings) warn("httpMappings.request", message);
  for (const [status, table] of Object.entries(http.responses ?? {})) {
    const checked = validateHttpMapping(table ?? {}, "response");
    for (const message of checked.errors) fail(`httpMappings.responses[${status}]`, message, "invalid_mapping");
    for (const message of checked.warnings) warn(`httpMappings.responses[${status}]`, message);
  }
}

function validateBinaryAndCompression(draft, fail, warn) {
  for (const entry of draft.binaryMediaTypes ?? []) {
    const text = typeof entry === "string" ? entry.trim() : "";
    if (typeof entry !== "string" || !/^(\*\/\*|[A-Za-z0-9!#$&^_.+-]+\/\*|[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+*-]+)$/.test(text)) {
      fail("binaryMediaTypes", `Invalid media type: ${entry}`, "invalid_media_type");
    }
  }
  const threshold = draft.minimumCompressionSize;
  if (threshold !== undefined && threshold !== null) {
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > MAX_COMPRESSION_SIZE) {
      fail("minimumCompressionSize", `Must be an integer 0-${MAX_COMPRESSION_SIZE}`, "invalid_compression");
    }
  }
  void warn;
}

function validateGatewayResponsesBlock(draft, fail, warn) {
  const seen = new Set();
  for (const entry of draft.gatewayResponses ?? []) {
    const type = entry?.response_type;
    if (!type || !GATEWAY_RESPONSES[type]) {
      fail("gatewayResponses", `Unknown response_type: ${type ?? "(missing)"}`, "unknown_response_type");
      continue;
    }
    if (seen.has(type)) fail("gatewayResponses", `Duplicate customization for ${type}`, "duplicate_response_type");
    seen.add(type);
    if (entry.status_code !== undefined && entry.status_code !== null && !STATUS_PATTERN.test(String(entry.status_code))) {
      fail(`gatewayResponses[${type}]`, `Invalid status_code: ${entry.status_code}`, "invalid_status");
    }
    for (const key of Object.keys(entry?.response_parameters ?? {})) {
      if (!key.startsWith("gatewayresponse.header.")) {
        fail(`gatewayResponses[${type}]`, `Invalid response_parameters key: ${key}`, "invalid_mapping");
      }
    }
    const { errors } = compileTemplates(entry?.response_templates ?? {});
    for (const message of errors) fail(`gatewayResponses[${type}]`, message, "invalid_template");
  }
  void warn;
}
