/**
 * Models (JSON Schema draft-04) and request validation (spec §4).
 *
 * Schemas compile at deploy (S05) via `ajv` + `ajv-draft-04` and are cached
 * per deployment. `$ref` between models uses
 * `https://pods.geiger/apis/{apiPublicId}/models/{name}`. The runtime entry
 * `validateRequest` enforces required parameters and body models, producing
 * the AWS status/message pairs (`BAD_REQUEST_PARAMETERS` 400 with the
 * missing list, `BAD_REQUEST_BODY` 400 with `validationErrorString`).
 *
 * @module lib/gateway/core/processing/validation
 */

import AjvDraft04 from "ajv-draft-04";
import { GatewayError } from "../errors.mjs";

/** Sum of schema sizes per API is ≤ 400 KB (AWS quota). */
export const MAX_API_SCHEMA_BYTES = 400 * 1024;

export const MODEL_NAME_PATTERN = /^[A-Za-z0-9]{1,128}$/;

/**
 * Builds the canonical `$ref` base for one API's models.
 *
 * @param {string} apiPublicId
 * @returns {string}
 */
export function modelRefBase(apiPublicId) {
  return `https://pods.geiger/apis/${apiPublicId}/models/`;
}

/**
 * Compiles a set of model schemas into validators. Pure at compile time —
 * S05 caches the returned map per deployment.
 *
 * @param {Array<{ name: string, schema: object }>} models
 * @param {{ apiPublicId?: string }} [options]
 * @returns {{ validators: Map<string, Function>, errors: Array<string> }}
 */
export function compileModelSchemas(models = [], options = {}) {
  const errors = [];
  const validators = new Map();
  const ajv = new AjvDraft04({ allErrors: true, strict: false, validateSchema: true });
  const base = modelRefBase(options.apiPublicId ?? "unknown");
  const byName = new Map();
  for (const model of models ?? []) {
    if (!model || !MODEL_NAME_PATTERN.test(model.name ?? "")) {
      errors.push(`model "${model?.name}": name must match ^[A-Za-z0-9]{1,128}$`);
      continue;
    }
    byName.set(model.name, model.schema ?? {});
  }
  for (const [name, schema] of byName) {
    const withIds = { ...schema, id: `${base}${name}` };
    try {
      for (const [other, otherSchema] of byName) {
        if (other !== name) ajv.addSchema({ ...otherSchema, id: `${base}${other}` }, `${base}${other}`);
      }
      validators.set(name, ajv.compile(withIds));
      ajv.removeSchema(`${base}${name}`);
      for (const [other] of byName) {
        if (other !== name) ajv.removeSchema(`${base}${other}`);
      }
    } catch (error) {
      errors.push(`model "${name}": invalid draft-04 schema (${error.message})`);
    }
  }
  return { validators, errors };
}

/**
 * Returns the total UTF-8 size of an API's model schemas.
 *
 * @param {Array<{ schema: object }>} models
 * @returns {number}
 */
export function totalSchemaBytes(models = []) {
  return (models ?? []).reduce((sum, model) => sum + Buffer.byteLength(JSON.stringify(model?.schema ?? {}), "utf8"), 0);
}

/**
 * Picks the request model for a Content-Type: exact match on the lowercased
 * type with parameters stripped, falling back to the `$default` key.
 * No model → no body validation.
 *
 * @param {Record<string,string>} [requestModels={}]
 * @param {string|null} [contentType=null]
 * @returns {string|null} model name or null.
 */
export function selectModelForContentType(requestModels = {}, contentType = null) {
  const table = requestModels ?? {};
  if (!contentType) return table.$default ?? null;
  const normalized = String(contentType).split(";")[0].trim().toLowerCase();
  return table[normalized] ?? table.$default ?? null;
}

/**
 * Validates required method-request parameters.
 *
 * @param {Record<string, boolean>} [required={}] - `method.request.<loc>.<n>` → required flag.
 * @param {{ headers?: object, querystring?: object, path?: object }} [actual={}]
 * @returns {Array<string>} missing parameter display names.
 */
export function findMissingParameters(required = {}, actual = {}) {
  const missing = [];
  for (const [key, isRequired] of Object.entries(required ?? {})) {
    if (!isRequired) continue;
    const match = key.match(/^method\.request\.(header|querystring|path)\.(.+)$/);
    if (!match) continue;
    const [, location, name] = match;
    const bag = location === "header" ? (actual.headers ?? {}) : location === "querystring" ? (actual.querystring ?? {}) : (actual.path ?? {});
    const value = location === "header" ? lookupHeader(bag, name) : bag[name];
    if (value === undefined || value === null || String(value).trim() === "") missing.push(name);
  }
  return missing;
}

function lookupHeader(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  if (name in headers) return headers[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/**
 * Formats AJV errors AWS-style into `$context.error.validationErrorString`,
 * e.g. `[object has missing required properties (["name"])]`.
 *
 * @param {Array<object>} [ajvErrors=[]]
 * @returns {string}
 */
export function formatValidationErrorString(ajvErrors = []) {
  if (!ajvErrors || ajvErrors.length === 0) return "[object has invalid value]";
  const parts = [];
  const missing = ajvErrors.filter((error) => error.keyword === "required").map((error) => error.params?.missingProperty);
  if (missing.length > 0) parts.push(`[object has missing required properties (${JSON.stringify(missing)})]`);
  for (const error of ajvErrors) {
    if (error.keyword === "required") continue;
    const path = error.instancePath && error.instancePath.length > 0 ? error.instancePath : "object";
    if (error.keyword === "additionalProperties") {
      parts.push(`[${path} has additional properties (${JSON.stringify(error.params?.additionalProperty)})]`);
      continue;
    }
    parts.push(`[${path} ${error.message}]`);
  }
  return parts.join(" ");
}

/**
 * Validates one method request (params then body). Throws `GatewayError`
 * (`BAD_REQUEST_PARAMETERS` / `BAD_REQUEST_BODY`) on failure, mirroring AWS.
 *
 * @param {{ requiredParams?: Record<string,boolean>, requestModels?: Record<string,string>, contentType?: string|null, bodyText?: string, validators?: Map<string,Function>, validateBody?: boolean, validateParameters?: boolean, actualParams?: object }} [input={}]
 * @returns {{ modelName: string|null }} on success.
 * @throws {GatewayError}
 */
export function validateRequest(input = {}) {
  const {
    requiredParams = {},
    requestModels = {},
    contentType = null,
    bodyText = "",
    validators = new Map(),
    validateBody = true,
    validateParameters = true,
    actualParams = {},
  } = input;
  if (validateParameters) {
    const missing = findMissingParameters(requiredParams, actualParams);
    if (missing.length > 0) {
      throw new GatewayError(
        "BAD_REQUEST_PARAMETERS",
        `Missing required request parameters: [${missing.join(", ")}]`,
        { missing },
      );
    }
  }
  if (!validateBody) return { modelName: null };
  const modelName = selectModelForContentType(requestModels, contentType);
  if (!modelName) return { modelName: null };
  const validate = validators.get(modelName);
  if (!validate) {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error", { modelName });
  }
  const type = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  const isJson = type === "" || type === "application/json" || type.endsWith("+json");
  if (!isJson) return { modelName };
  let parsed;
  try {
    parsed = JSON.parse(String(bodyText ?? ""));
  } catch {
    throw new GatewayError("BAD_REQUEST_BODY", "Invalid request body", {
      validationErrorString: "[object has invalid JSON]",
    });
  }
  const ok = validate(parsed);
  if (!ok) {
    throw new GatewayError("BAD_REQUEST_BODY", "Invalid request body", {
      validationErrorString: formatValidationErrorString(validate.errors),
    });
  }
  return { modelName };
}

/**
 * Validates model/validator control-plane input (structure only; schemas are
 * compiled separately so syntax errors fail at deploy, not at request time).
 *
 * @param {Array<{ name: string, schema: object }>} [models=[]]
 * @param {{ validateSchemas?: boolean, apiPublicId?: string }} [options]
 * @returns {{ errors: Array<string>, warnings: Array<string> }}
 */
export function validateModelsInput(models = [], options = {}) {
  const errors = [];
  const warnings = [];
  if (totalSchemaBytes(models) > MAX_API_SCHEMA_BYTES) {
    errors.push(`models: combined schema size exceeds 400 KB`);
  }
  const seen = new Set();
  for (const model of models ?? []) {
    if (!model || !MODEL_NAME_PATTERN.test(model.name ?? "")) {
      errors.push(`model "${model?.name}": name must match ^[A-Za-z0-9]{1,128}$`);
      continue;
    }
    if (seen.has(model.name)) errors.push(`model "${model.name}": duplicate name`);
    seen.add(model.name);
  }
  if (options.validateSchemas !== false) {
    const compiled = compileModelSchemas(models, { apiPublicId: options.apiPublicId });
    errors.push(...compiled.errors);
  }
  void warnings;
  return { errors, warnings: [] };
}
