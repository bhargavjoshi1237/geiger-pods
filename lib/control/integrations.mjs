// Integrations management service (S04 §2 + §7). One file per resource per
// S01 §8: pure-ish `(db, actor, input) → result`, validation first,
// API-scoped `pods.integration.write`, audit rows on mutation.

import { supports } from "../gateway/capabilities.mjs";
import { newPublicId } from "../gateway/ids.mjs";
import { v, validate } from "./validate.mjs";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import {
  validateHttpMapping,
  validateRestRequestMapping,
  validateRestResponseMapping,
} from "../gateway/core/processing/param-mapping.mjs";
import { parseTemplate } from "../gateway/core/processing/templates/index.mjs";

export const INTEGRATION_TYPES = ["HTTP_PROXY", "HTTP", "MOCK", "FUNCTION_PROXY", "FUNCTION", "AWS_SERVICE"];

const TYPE_CAPABILITY = {
  HTTP_PROXY: "integration.http",
  HTTP: "integration.httpCustom",
  MOCK: "integration.mock",
  FUNCTION_PROXY: "integration.function",
  FUNCTION: "integration.function",
  AWS_SERVICE: "integration.awsService",
};

const HTTP_METHODS = ["ANY", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const FUNCTION_SCHEMA = v.object({
  provider: v.enum(["aws_lambda", "webhook"]),
  functionArn: v.optional(v.string({ min: 1, max: 1024 })),
  url: v.optional(v.string({ min: 1, max: 2048 })),
  qualifier: v.optional(v.string({ min: 1, max: 128 })),
  secretRef: v.optional(v.string({ min: 1, max: 256 })),
  credentialsRef: v.optional(v.string({ min: 1, max: 256 })),
});

const AWS_SCHEMA = v.object({
  service: v.optional(v.string({ min: 1, max: 64 })),
  region: v.optional(v.string({ min: 1, max: 32 })),
  action: v.optional(v.string({ min: 1, max: 256 })),
  path: v.optional(v.string({ min: 1, max: 2048 })),
  subtype: v.optional(v.string({ min: 1, max: 64 })),
  parameters: v.optional(v.object({})),
  roleSecretRef: v.optional(v.string({ min: 1, max: 256 })),
});

const TLS_SCHEMA = v.object({
  insecureSkipVerification: v.optional(v.enum([true, false])),
  serverNameToVerify: v.optional(v.string({ min: 1, max: 253 })),
});

const BACKEND_AUTH_SCHEMA = v.object({
  type: v.enum(["header", "bearer", "basic_auth", "query", "oauth_client_credentials", "aws_sigv4", "client_certificate"]),
  secretRef: v.optional(v.string({ min: 1, max: 256 })),
  headerName: v.optional(v.string({ min: 1, max: 256 })),
  awsService: v.optional(v.string({ min: 1, max: 64 })),
  awsRegion: v.optional(v.string({ min: 1, max: 32 })),
});

const CREATE_SCHEMA = v.object({
  type: v.enum(INTEGRATION_TYPES),
  integrationMethod: v.optional(v.enum(HTTP_METHODS)),
  uri: v.optional(v.string({ min: 1, max: 2048 })),
  function: v.optional(FUNCTION_SCHEMA),
  aws: v.optional(AWS_SCHEMA),
  connectionType: v.optional(v.enum(["INTERNET", "CONNECTOR"])),
  connectorId: v.optional(v.string({ min: 1, max: 128 })),
  timeoutMs: v.optional(v.int({ min: 50, max: 300000 })),
  payloadFormatVersion: v.optional(v.enum(["1.0", "2.0"])),
  passthroughBehavior: v.optional(v.enum(["WHEN_NO_MATCH", "WHEN_NO_TEMPLATES", "NEVER"])),
  contentHandling: v.optional(v.enum(["CONVERT_TO_TEXT", "CONVERT_TO_BINARY"])),
  tls: v.optional(TLS_SCHEMA),
  backendAuth: v.optional(BACKEND_AUTH_SCHEMA),
  description: v.optional(v.string({ max: 1024 })),
  // S09 release controls (additive): cache key params + namespace, streaming.
  cacheKeyParameters: v.optional(v.array(v.string({ min: 1, max: 256 }))),
  cacheNamespace: v.optional(v.string({ min: 1, max: 128 })),
  responseTransferMode: v.optional(v.enum(["BUFFERED", "STREAM"])),
});

const PATCH_SCHEMA = v.object({
  integrationMethod: v.optional(v.enum(HTTP_METHODS)),
  uri: v.optional(v.string({ min: 1, max: 2048 })),
  function: v.optional(FUNCTION_SCHEMA),
  aws: v.optional(AWS_SCHEMA),
  connectionType: v.optional(v.enum(["INTERNET", "CONNECTOR"])),
  connectorId: v.optional(v.string({ min: 1, max: 128 })),
  timeoutMs: v.optional(v.int({ min: 50, max: 300000 })),
  payloadFormatVersion: v.optional(v.enum(["1.0", "2.0"])),
  passthroughBehavior: v.optional(v.enum(["WHEN_NO_MATCH", "WHEN_NO_TEMPLATES", "NEVER"])),
  contentHandling: v.optional(v.enum(["CONVERT_TO_TEXT", "CONVERT_TO_BINARY"])),
  tls: v.optional(TLS_SCHEMA),
  backendAuth: v.optional(BACKEND_AUTH_SCHEMA),
  description: v.optional(v.string({ max: 1024 })),
  // S09 release controls (additive).
  cacheKeyParameters: v.optional(v.array(v.string({ min: 1, max: 256 }))),
  cacheNamespace: v.optional(v.string({ min: 1, max: 128 })),
  responseTransferMode: v.optional(v.enum(["BUFFERED", "STREAM"])),
});

const RESPONSE_SCHEMA = v.object({
  statusCode: v.int({ min: 100, max: 599 }),
  selectionPattern: v.optional(v.string({ min: 1, max: 1024 })),
  contentHandling: v.optional(v.enum(["CONVERT_TO_TEXT", "CONVERT_TO_BINARY"])),
});

const S06_INTEGRATION_FIELDS = new Set([
  "requestParameters",
  "requestTemplates",
  "responseParameters",
  "templateSelectionExpression",
]);

const S06_RESPONSE_FIELDS = new Set(["responseParameters", "responseTemplates"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * S06 free-form tables use arbitrary mapping keys, so the tiny validator
 * cannot describe them: pull them out before `validate()` (like
 * `aws.parameters`) and validate per-protocol afterwards.
 */
function extractS06IntegrationFields(input) {
  const s06 = {};
  let rest = { ...(input ?? {}) };
  for (const key of S06_INTEGRATION_FIELDS) {
    if (Object.hasOwn(rest, key)) {
      s06[key] = rest[key];
      const { [key]: _dropped, ...kept } = rest;
      rest = kept;
    }
  }
  return { input: rest, s06 };
}

function extractS06ResponseFields(input) {
  const s06 = {};
  let rest = { ...(input ?? {}) };
  for (const key of S06_RESPONSE_FIELDS) {
    if (Object.hasOwn(rest, key)) {
      s06[key] = rest[key];
      const { [key]: _dropped, ...kept } = rest;
      rest = kept;
    }
  }
  return { input: rest, s06 };
}

function assertNoSecretInTemplates(templates, field) {
  for (const [contentType, template] of Object.entries(templates ?? {})) {
    if (typeof template === "string" && template.includes("secret:")) {
      throw new HttpError(422, "invalid_input", `${field}["${contentType}"]: templates must not embed secret values.`);
    }
  }
}

function checkTemplateTable(templates, field) {
  if (!isPlainObject(templates)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${field}: expected an object`);
  }
  for (const [contentType, template] of Object.entries(templates)) {
    if (typeof template !== "string") {
      throw new HttpError(422, "invalid_input", `Invalid request: $.${field}["${contentType}"]: expected a string`);
    }
    if (template.length > 300 * 1024) {
      throw new HttpError(422, "invalid_input", `${field}["${contentType}"]: template exceeds the 300 KB limit.`);
    }
    try {
      parseTemplate(template);
    } catch (error) {
      throw new HttpError(422, "invalid_input", `Invalid template for ${contentType}: ${error.message}`);
    }
  }
  assertNoSecretInTemplates(templates, field);
  return { ...templates };
}

/**
 * Validates S06 integration fields per protocol (S06 §3 + capabilities).
 * REST uses `integration.request.*` expressions; HTTP uses the
 * append/overwrite/remove grammar; templates are REST/WS only; the
 * integration-level `responseParameters` table (status → mapping) is
 * HTTP-only; `templateSelectionExpression` is WS-only.
 */
function checkS06IntegrationFields(s06, protocol) {
  const clean = {};
  if (s06.requestParameters !== undefined) {
    const value = s06.requestParameters;
    if (value === null) {
      clean.requestParameters = {};
    } else {
      if (!isPlainObject(value)) {
        throw new HttpError(422, "invalid_input", "Invalid request: $.requestParameters: expected an object");
      }
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== "string") {
          throw new HttpError(422, "invalid_input", `Invalid request: $.requestParameters["${key}"]: expected a string`);
        }
      }
      if (protocol === "REST") {
        const { errors } = validateRestRequestMapping(value);
        if (errors.length > 0) throw new HttpError(422, "invalid_input", `Invalid requestParameters: ${errors[0]}`);
      } else if (protocol === "HTTP") {
        const { errors } = validateHttpMapping(value, "request");
        if (errors.length > 0) throw new HttpError(422, "invalid_input", `Invalid requestParameters: ${errors[0]}`);
      } else if (Object.keys(value).length > 0) {
        throw new HttpError(400, "capability_unsupported", "Invalid request: $.requestParameters: only REST and HTTP integrations carry requestParameters.");
      }
      clean.requestParameters = { ...value };
    }
  }
  if (s06.requestTemplates !== undefined) {
    const value = s06.requestTemplates;
    if (value === null) {
      clean.requestTemplates = {};
    } else {
      if (Object.keys(value ?? {}).length > 0 && !supports(protocol, "templates")) {
        throw new HttpError(400, "capability_unsupported", "Invalid request: $.requestTemplates: only REST and WebSocket integrations carry requestTemplates.");
      }
      clean.requestTemplates = checkTemplateTable(value, "requestTemplates");
    }
  }
  if (s06.responseParameters !== undefined) {
    const value = s06.responseParameters;
    if (value === null) {
      clean.responseParameters = {};
    } else {
      if (!isPlainObject(value)) {
        throw new HttpError(422, "invalid_input", "Invalid request: $.responseParameters: expected an object");
      }
      if (protocol !== "HTTP" && Object.keys(value).length > 0) {
        throw new HttpError(400, "capability_unsupported", "Invalid request: $.responseParameters: only HTTP integrations carry responseParameters.");
      }
      if (protocol === "HTTP") {
        for (const [status, table] of Object.entries(value)) {
          if (!/^[1-5]\d\d$/.test(status)) {
            throw new HttpError(422, "invalid_input", `Invalid request: $.responseParameters["${status}"]: expected a 3-digit status code`);
          }
          if (!isPlainObject(table)) {
            throw new HttpError(422, "invalid_input", `Invalid request: $.responseParameters["${status}"]: expected an object`);
          }
          for (const [key, entry] of Object.entries(table)) {
            if (typeof entry !== "string") {
              throw new HttpError(422, "invalid_input", `Invalid request: $.responseParameters["${status}"]["${key}"]: expected a string`);
            }
          }
          const { errors } = validateHttpMapping(table, "response");
          if (errors.length > 0) throw new HttpError(422, "invalid_input", `Invalid responseParameters[${status}]: ${errors[0]}`);
        }
      }
      const deep = {};
      for (const [status, table] of Object.entries(value)) deep[status] = { ...(table ?? {}) };
      clean.responseParameters = deep;
    }
  }
  if (s06.templateSelectionExpression !== undefined) {
    const value = s06.templateSelectionExpression;
    if (value === null) {
      clean.templateSelectionExpression = null;
    } else {
      if (typeof value !== "string") {
        throw new HttpError(422, "invalid_input", "Invalid request: $.templateSelectionExpression: expected a string");
      }
      if (protocol !== "WEBSOCKET" && value !== "") {
        throw new HttpError(400, "capability_unsupported", "Invalid request: $.templateSelectionExpression: only WebSocket integrations carry templateSelectionExpression.");
      }
      if (value.length > 256) {
        throw new HttpError(422, "invalid_input", "Invalid request: $.templateSelectionExpression: must be at most 256 characters");
      }
      clean.templateSelectionExpression = value;
    }
  }
  return clean;
}

function checkS06ResponseFields(s06) {
  const clean = {};
  if (s06.responseParameters !== undefined) {
    const value = s06.responseParameters;
    if (!isPlainObject(value)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.responseParameters: expected an object");
    }
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== "string") {
        throw new HttpError(422, "invalid_input", `Invalid request: $.responseParameters["${key}"]: expected a string`);
      }
    }
    const declared = Object.fromEntries(Object.keys(value).map((key) => [key, true]));
    const { errors } = validateRestResponseMapping(value, declared);
    if (errors.length > 0) throw new HttpError(422, "invalid_input", `Invalid responseParameters: ${errors[0]}`);
    clean.responseParameters = { ...value };
  }
  if (s06.responseTemplates !== undefined) {
    const value = s06.responseTemplates;
    clean.responseTemplates = checkTemplateTable(value, "responseTemplates");
  }
  return clean;
}

function encodeCursor(row) {  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id }), "utf8").toString("base64url");
}

/**
 * Every vault reference an integration holds — backend_auth, function webhook
 * secret / Lambda credentials, AWS role credentials — needs `pods.secret.use`.
 * Without this, an actor with only `pods.integration.write` could arm the
 * gateway with somebody else's secret.
 */
async function requireSecretUseForRefs(db, actor, { projectId, backendAuth, functionConfig, aws }) {
  const refs = [
    backendAuth?.secretRef,
    functionConfig?.secretRef,
    functionConfig?.credentialsRef,
    aws?.roleSecretRef,
  ].filter((ref) => typeof ref === "string" && ref.length > 0);
  if (refs.length > 0) {
    await requirePermission(db, actor, "pods.secret.use", { projectId });
  }
}

/**
 * The stored shape uses `serverNameToVerify: null` for "no override"
 * (migration default), but the validator only knows strings: drop an explicit
 * null before validation so UI round-trips (GET → PATCH with the same tls)
 * do not 422.
 */
function normalizeTlsInput(input) {
  if (input?.tls && typeof input.tls === "object" && !Array.isArray(input.tls) && input.tls.serverNameToVerify === null) {
    const { serverNameToVerify: _dropped, ...rest } = input.tls;
    return { ...input, tls: rest };
  }
  return input;
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

/** Syntactic URI-template check: placeholders become `p`, then http(s) + host required.
 * Placeholders may only appear in path/query — a `{param}`/`${…}` in the
 * authority would render to an empty host at invoke time
 * (`API_CONFIGURATION_ERROR`), so it is a 422 here. */
export function validateUriTemplate(uri) {
  const text = String(uri);
  const authority = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").split("/")[0] ?? "";
  if (/[{}$]/.test(authority)) {
    throw new HttpError(422, "invalid_input", "Integration uri must be a valid http(s) URL template.");
  }
  const probe = text
    .replace(/\{[A-Za-z0-9_-]+\+?\}/g, "p")
    .replace(/\$\{[^}]+\}/g, "p");
  let url;
  try {
    url = new URL(probe);
  } catch {
    throw new HttpError(422, "invalid_input", "Integration uri must be a valid http(s) URL template.");
  }
  if (!url.host || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new HttpError(422, "invalid_input", "Integration uri must be a valid http(s) URL template.");
  }
}

function timeoutBounds(protocol, maxOverride = null) {
  if (protocol === "HTTP") return { min: 50, max: 30000, def: 30000 };
  if (protocol !== "REST") return { min: 50, max: 29000, def: 29000 };
  // REST may be raised per project via project_settings.max_integration_timeout_ms
  // (S04 §2: up to 300 s). The setting only raises, never lowers, the default.
  if (Number.isInteger(maxOverride)) {
    const max = Math.min(Math.max(maxOverride, 29000), 300000);
    return { min: 50, max, def: 29000 };
  }
  return { min: 50, max: 29000, def: 29000 };
}

/** Load the REST ceiling for a project (29000 unless the setting raises it). */
export async function resolveTimeoutBounds(db, projectId, protocol) {
  if (protocol !== "REST") return timeoutBounds(protocol);
  try {
    const row = typeof db?.getProjectSettings === "function"
      ? await db.getProjectSettings(projectId)
      : null;
    const raw = row?.max_integration_timeout_ms ?? row?.maxIntegrationTimeoutMs ?? null;
    if (raw !== null && raw !== undefined && Number.isFinite(Number(raw))) {
      return timeoutBounds(protocol, Math.trunc(Number(raw)));
    }
  } catch {
    // Fall through to the default ceiling.
  }
  return timeoutBounds(protocol);
}

/**
 * `aws.parameters` is free-form per-subtype data and the tiny validator has
 * no passthrough type, so it is checked (plain object) here and re-attached
 * after `validate` runs.
 */
function extractAwsParameters(input) {
  if (!input?.aws || !Object.hasOwn(input.aws, "parameters")) return { input, parameters: undefined };
  const { parameters } = input.aws;
  if (parameters !== undefined && (typeof parameters !== "object" || parameters === null || Array.isArray(parameters))) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.aws.parameters: expected an object");
  }
  const { parameters: _dropped, ...aws } = input.aws;
  return { input: { ...input, aws }, parameters };
}

function toView(row) {
  return {
    id: row.id,
    apiId: row.api_id,
    publicId: row.public_id,
    type: row.type,
    integrationMethod: row.integration_method,
    uri: row.uri,
    function: row.function ?? null,
    aws: row.aws ?? null,
    connectionType: row.connection_type,
    connectorId: row.connector_id,
    timeoutMs: row.timeout_ms,
    payloadFormatVersion: row.payload_format_version,
    passthroughBehavior: row.passthrough_behavior,
    contentHandling: row.content_handling ?? null,
    requestParameters: row.request_parameters ?? {},
    requestTemplates: row.request_templates ?? {},
    responseParameters: row.response_parameters ?? {},
    templateSelectionExpression: row.template_selection_expression ?? null,
    // S09 release controls.
    cacheKeyParameters: row.cache_key_parameters ?? [],
    cacheNamespace: row.cache_namespace ?? null,
    responseTransferMode: row.response_transfer_mode ?? "BUFFERED",
    tls: row.tls ?? { insecureSkipVerification: false, serverNameToVerify: null },
    backendAuth: row.backend_auth ?? null,
    description: row.description ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function scopedIntegration(db, projectId, apiId, integrationId) {
  const row = await db.getIntegrationById(integrationId);
  if (!row || row.project_id !== projectId || row.api_id !== apiId || row.deleted_at) {
    throw new HttpError(404, "not_found", "Integration does not exist.");
  }
  return row;
}

async function checkTypeSupport(db, projectId, apiId, type) {
  const protocol = await db.getApiProtocol({ projectId, apiId });
  if (!protocol) throw new HttpError(404, "not_found", "API does not exist.");
  const capability = TYPE_CAPABILITY[type];
  if (capability && !supports(protocol, capability)) {
    throw new HttpError(400, "capability_unsupported", `Integration type ${type} is not supported for ${protocol} APIs.`);
  }
  return protocol;
}

function checkCrossFields(clean, protocol, bounds = null) {
  // The private URL lives in `uri` for CONNECTOR integrations too (spec §4:
  // "Integration uri is the private URL") — without it the invoke renders
  // nothing and every call 500s.
  if ((clean.type === "HTTP_PROXY" || clean.type === "HTTP") && !clean.uri) {
    throw new HttpError(422, "invalid_input", "HTTP integrations require a uri.");
  }
  if (clean.uri) validateUriTemplate(clean.uri);
  if ((clean.connectionType ?? "INTERNET") === "CONNECTOR" && !clean.connectorId) {
    throw new HttpError(422, "invalid_input", "CONNECTOR integrations require a connectorId.");
  }
  if (clean.function) {
    if (clean.function.provider === "webhook" && !clean.function.url) {
      throw new HttpError(422, "invalid_input", "Webhook functions require a url.");
    }
    if (clean.function.provider === "aws_lambda" && !clean.function.functionArn) {
      throw new HttpError(422, "invalid_input", "aws_lambda functions require a functionArn.");
    }
  }
  if (clean.aws && clean.aws.subtype === undefined && !clean.aws.service) {
    throw new HttpError(422, "invalid_input", "AWS integrations require a service or a first-class subtype.");
  }
  if (clean.aws && !clean.aws.region) {
    throw new HttpError(422, "invalid_input", "AWS integrations require a region.");
  }
  if (clean.timeoutMs !== undefined) {
    const effective = bounds ?? timeoutBounds(protocol);
    if (clean.timeoutMs < effective.min || clean.timeoutMs > effective.max) {
      throw new HttpError(422, "invalid_input", `timeoutMs must be ${effective.min}–${effective.max} for ${protocol} APIs.`);
    }
  }
  if (clean.payloadFormatVersion === "2.0" && protocol !== "HTTP") {
    throw new HttpError(422, "invalid_input", "payload_format_version 2.0 is only available on HTTP APIs (REST always uses 1.0).");
  }
  // S09 (additive): cache key params shape; STREAM only on REST HTTP_PROXY /
  // FUNCTION_PROXY (full conflict matrix is a compile error at deploy).
  if (clean.cacheKeyParameters !== undefined) {
    for (const entry of clean.cacheKeyParameters ?? []) {
      if (!/^method\.request\.(querystring|header|path)\.[A-Za-z0-9._-]+$/i.test(entry)) {
        throw new HttpError(422, "invalid_input", `Invalid cacheKeyParameters entry "${entry}" (expected method.request.querystring|header|path.<name>).`);
      }
    }
  }
  if (clean.responseTransferMode === "STREAM") {
    if (protocol !== "REST") {
      throw new HttpError(400, "capability_unsupported", "responseTransferMode STREAM is only supported on REST APIs.");
    }
    if (clean.type && clean.type !== "HTTP_PROXY" && clean.type !== "FUNCTION_PROXY") {
      throw new HttpError(422, "invalid_input", "responseTransferMode STREAM is only supported for HTTP_PROXY and FUNCTION_PROXY integrations.");
    }
  }
  if (clean.backendAuth?.secretRef && !/^secret:[A-Za-z0-9._-]{1,128}(@\d{1,9})?$/.test(clean.backendAuth.secretRef)) {
    throw new HttpError(422, "invalid_input", "backendAuth.secretRef must be a vault reference like secret:<id>.");
  }
}

/** List integrations for an API (newest last, cursor pagination per S01 §8). */
export async function listIntegrations(db, actor, { projectId, apiId, limit = 25, cursor = null }) {
  await requirePermission(db, actor, "pods.integration.write", { projectId, apiId });
  const protocol = await db.getApiProtocol({ projectId, apiId });
  if (!protocol) throw new HttpError(404, "not_found", "API does not exist.");
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const rows = await db.listIntegrations({ apiId, limit: take + 1, cursor: cursor ? decodeCursor(cursor) : null });
  const items = rows.slice(0, take).map(toView);
  return { items, nextCursor: rows.length > take ? encodeCursor(rows[take - 1]) : null };
}

/** Create an integration on an API draft. */
export async function createIntegration(db, actor, { projectId, apiId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.integration.write", { projectId, apiId });
  const s06Extracted = extractS06IntegrationFields(normalizeTlsInput(input ?? {}));
  const extracted = extractAwsParameters(s06Extracted.input);
  const clean = validate(CREATE_SCHEMA, extracted.input ?? {});
  if (extracted.parameters !== undefined) clean.aws = { ...(clean.aws ?? {}), parameters: extracted.parameters };
  const protocol = await checkTypeSupport(db, projectId, apiId, clean.type);
  const s06 = checkS06IntegrationFields(s06Extracted.s06, protocol);
  Object.assign(clean, s06);
  const bounds = await resolveTimeoutBounds(db, projectId, protocol);
  checkCrossFields(clean, protocol, bounds);
  await requireSecretUseForRefs(db, actor, {
    projectId,
    backendAuth: clean.backendAuth,
    functionConfig: clean.function,
    aws: clean.aws,
  });
  const row = await db.insertIntegration({
    project_id: projectId,
    api_id: apiId,
    public_id: newPublicId(),
    type: clean.type,
    integration_method: clean.integrationMethod ?? "ANY",
    uri: clean.uri ?? null,
    function: clean.function ?? null,
    aws: clean.aws ?? null,
    connection_type: clean.connectionType ?? "INTERNET",
    connector_id: clean.connectorId ?? null,
    timeout_ms: clean.timeoutMs ?? bounds.def,
    payload_format_version: clean.payloadFormatVersion ?? (protocol === "HTTP" ? "2.0" : "1.0"),
    passthrough_behavior: clean.passthroughBehavior ?? "WHEN_NO_MATCH",
    content_handling: clean.contentHandling ?? null,
    request_parameters: clean.requestParameters ?? {},
    request_templates: clean.requestTemplates ?? {},
    response_parameters: clean.responseParameters ?? {},
    ...(clean.templateSelectionExpression !== undefined ? { template_selection_expression: clean.templateSelectionExpression } : {}),
    // S09 release controls.
    ...(clean.cacheKeyParameters !== undefined ? { cache_key_parameters: clean.cacheKeyParameters } : {}),
    ...(clean.cacheNamespace !== undefined ? { cache_namespace: clean.cacheNamespace } : {}),
    ...(clean.responseTransferMode !== undefined ? { response_transfer_mode: clean.responseTransferMode } : {}),
    tls: clean.tls ?? { insecureSkipVerification: false, serverNameToVerify: null },
    backend_auth: clean.backendAuth ?? null,
    description: clean.description ?? null,
    created_by: actor?.userId ?? null,
  });
  const view = toView(row);
  await audit(db, actor, {
    action: "integration.create", resourceType: "integration", resourceId: row.id,
    projectId, apiId, before: null, after: view, requestId,
  });
  return { status: 201, body: view };
}

/** Patch an integration (optimistic concurrency via If-Match). */
export async function updateIntegration(db, actor, { projectId, apiId, integrationId, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.integration.write", { projectId, apiId });
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new HttpError(422, "invalid_input", "Provide at least one field to update.");
  }
  const rawAuth = Object.hasOwn(patch, "backendAuth") ? patch.backendAuth : undefined;
  const { input: withoutS06, s06: s06Raw } = extractS06IntegrationFields(patch);
  const forValidate = { ...withoutS06 };
  if (rawAuth === null) delete forValidate.backendAuth;
  const clean = validate(PATCH_SCHEMA, normalizeTlsInput(forValidate) ?? {});
  const extracted = extractAwsParameters({ aws: patch?.aws });
  if (extracted.parameters !== undefined) clean.aws = { ...(clean.aws ?? {}), parameters: extracted.parameters };
  // Explicit null clears backend auth; undefined leaves it alone.
  if (rawAuth === null) clean.backendAuth = null;
  else if (rawAuth !== undefined && clean.backendAuth === undefined) {
    // validate() rejected an explicit backendAuth shape; rethrow as 422
    // (unreachable: PATCH_SCHEMA already covers it, kept for clarity).
  }
  const current = await scopedIntegration(db, projectId, apiId, integrationId);
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Integration changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const protocol = await checkTypeSupport(db, projectId, apiId, current.type);
  const s06 = checkS06IntegrationFields(s06Raw, protocol);
  Object.assign(clean, s06);
  const bounds = await resolveTimeoutBounds(db, projectId, protocol);
  checkCrossFields({ ...toView(current), ...clean, type: current.type }, protocol, bounds);
  await requireSecretUseForRefs(db, actor, {
    projectId,
    backendAuth: clean.backendAuth,
    functionConfig: clean.function,
    aws: clean.aws,
  });
  const before = toView(current);
  const snake = {
    ...(clean.integrationMethod !== undefined ? { integration_method: clean.integrationMethod } : {}),
    ...(clean.uri !== undefined ? { uri: clean.uri } : {}),
    ...(clean.function !== undefined ? { function: clean.function } : {}),
    ...(clean.aws !== undefined ? { aws: clean.aws } : {}),
    ...(clean.connectionType !== undefined ? { connection_type: clean.connectionType } : {}),
    ...(clean.connectorId !== undefined ? { connector_id: clean.connectorId } : {}),
    ...(clean.timeoutMs !== undefined ? { timeout_ms: clean.timeoutMs } : {}),
    ...(clean.payloadFormatVersion !== undefined ? { payload_format_version: clean.payloadFormatVersion } : {}),
    ...(clean.passthroughBehavior !== undefined ? { passthrough_behavior: clean.passthroughBehavior } : {}),
    ...(clean.contentHandling !== undefined ? { content_handling: clean.contentHandling } : {}),
    ...(clean.requestParameters !== undefined ? { request_parameters: clean.requestParameters } : {}),
    ...(clean.requestTemplates !== undefined ? { request_templates: clean.requestTemplates } : {}),
    ...(clean.responseParameters !== undefined ? { response_parameters: clean.responseParameters } : {}),
    ...(clean.templateSelectionExpression !== undefined ? { template_selection_expression: clean.templateSelectionExpression } : {}),
    // S09 release controls.
    ...(clean.cacheKeyParameters !== undefined ? { cache_key_parameters: clean.cacheKeyParameters } : {}),
    ...(clean.cacheNamespace !== undefined ? { cache_namespace: clean.cacheNamespace } : {}),
    ...(clean.responseTransferMode !== undefined ? { response_transfer_mode: clean.responseTransferMode } : {}),
    ...(clean.tls !== undefined ? { tls: clean.tls } : {}),
    ...(clean.backendAuth !== undefined ? { backend_auth: clean.backendAuth } : {}),
    ...(clean.description !== undefined ? { description: clean.description } : {}),
  };
  const updated = await db.updateIntegration(current.id, snake);
  const after = toView({ ...current, ...snake, ...updated });
  await audit(db, actor, {
    action: "integration.update", resourceType: "integration", resourceId: current.id,
    projectId, apiId, before, after, requestId,
  });
  return after;
}

/** Delete an integration and its integration responses. */
export async function deleteIntegration(db, actor, { projectId, apiId, integrationId, requestId = null }) {
  await requirePermission(db, actor, "pods.integration.write", { projectId, apiId });
  const current = await scopedIntegration(db, projectId, apiId, integrationId);
  const before = toView(current);
  await db.deleteIntegration(current.id);
  await audit(db, actor, {
    action: "integration.delete", resourceType: "integration", resourceId: current.id,
    projectId, apiId, before, after: null, requestId,
  });
  return { id: current.id, deleted: true };
}

/** Get one integration. */
export async function getIntegration(db, actor, { projectId, apiId, integrationId }) {
  await requirePermission(db, actor, "pods.integration.write", { projectId, apiId });
  return toView(await scopedIntegration(db, projectId, apiId, integrationId));
}

function responseView(row) {
  return {
    id: row.id,
    integrationId: row.integration_id,
    statusCode: row.status_code,
    selectionPattern: row.selection_pattern,
    responseParameters: row.response_parameters ?? {},
    responseTemplates: row.response_templates ?? {},
    contentHandling: row.content_handling ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Get one integration response. */
export async function getIntegrationResponse(db, actor, { projectId, apiId, integrationId, responseId }) {
  await requirePermission(db, actor, "pods.integration.write", { projectId, apiId });
  await scopedIntegration(db, projectId, apiId, integrationId);
  const row = await db.getIntegrationResponseById(responseId);
  if (!row || row.integration_id !== integrationId) {
    throw new HttpError(404, "not_found", "Integration response does not exist.");
  }
  return responseView(row);
}

/** List integration responses (REST/WS selection patterns; S06 owns matching semantics). */
export async function listIntegrationResponses(db, actor, { projectId, apiId, integrationId }) {
  await requirePermission(db, actor, "pods.integration.write", { projectId, apiId });
  await scopedIntegration(db, projectId, apiId, integrationId);
  return { items: (await db.listIntegrationResponses({ integrationId })).map(responseView) };
}

/** Create an integration response. */
export async function createIntegrationResponse(db, actor, { projectId, apiId, integrationId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.integration.write", { projectId, apiId });
  const integration = await scopedIntegration(db, projectId, apiId, integrationId);
  const protocol = await db.getApiProtocol({ projectId, apiId });
  if (protocol === "HTTP") {
    throw new HttpError(400, "capability_unsupported", "Integration responses are only available on REST and WebSocket APIs (HTTP uses integration responseParameters).");
  }
  const { input: withoutS06, s06 } = extractS06ResponseFields(input ?? {});
  const clean = validate(RESPONSE_SCHEMA, withoutS06);
  const s06Clean = checkS06ResponseFields(s06);
  Object.assign(clean, s06Clean);
  if (clean.selectionPattern) {
    try {
      new RegExp(clean.selectionPattern);
    } catch {
      throw new HttpError(422, "invalid_input", "selectionPattern must be a valid regular expression.");
    }
  }
  void integration;
  const row = await db.insertIntegrationResponse({
    project_id: projectId,
    api_id: apiId,
    integration_id: integrationId,
    status_code: clean.statusCode,
    selection_pattern: clean.selectionPattern ?? null,
    response_parameters: clean.responseParameters ?? {},
    response_templates: clean.responseTemplates ?? {},
    content_handling: clean.contentHandling ?? null,
    created_by: actor?.userId ?? null,
  });
  const view = responseView(row);
  await audit(db, actor, {
    action: "integration_response.create", resourceType: "integration_response", resourceId: row.id,
    projectId, apiId, before: null, after: view, requestId,
  });
  return { status: 201, body: view };
}

/** Patch an integration response (optimistic concurrency via If-Match). */
export async function updateIntegrationResponse(db, actor, { projectId, apiId, integrationId, responseId, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.integration.write", { projectId, apiId });
  await scopedIntegration(db, projectId, apiId, integrationId);
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new HttpError(422, "invalid_input", "Provide at least one field to update.");
  }
  const row = await db.getIntegrationResponseById(responseId);
  if (!row || row.integration_id !== integrationId) {
    throw new HttpError(404, "not_found", "Integration response does not exist.");
  }
  if (expectedVersion !== null && row.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Integration response changed (expected version ${expectedVersion}, found ${row.version}).`);
  }
  const { input: withoutS06, s06 } = extractS06ResponseFields(patch);
  // statusCode/selectionPattern/contentHandling share the create schema shape;
  // validate only the supplied keys manually to keep PATCH partial.
  const clean = {};
  if (Object.hasOwn(withoutS06, "statusCode")) {
    const value = withoutS06.statusCode;
    if (!Number.isInteger(value) || value < 100 || value > 599) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.statusCode: must be an integer 100–599");
    }
    clean.statusCode = value;
  }
  if (Object.hasOwn(withoutS06, "selectionPattern")) {
    const value = withoutS06.selectionPattern;
    if (value !== null && (typeof value !== "string" || value.length < 1 || value.length > 1024)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.selectionPattern: must be a string of 1–1024 characters");
    }
    if (value) {
      try {
        new RegExp(value);
      } catch {
        throw new HttpError(422, "invalid_input", "selectionPattern must be a valid regular expression.");
      }
    }
    clean.selectionPattern = value;
  }
  if (Object.hasOwn(withoutS06, "contentHandling")) {
    const value = withoutS06.contentHandling;
    if (value !== null && value !== "CONVERT_TO_TEXT" && value !== "CONVERT_TO_BINARY") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.contentHandling: must be one of CONVERT_TO_TEXT, CONVERT_TO_BINARY");
    }
    clean.contentHandling = value;
  }
  for (const key of Object.keys(withoutS06)) {
    if (!["statusCode", "selectionPattern", "contentHandling"].includes(key)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
    }
  }
  Object.assign(clean, checkS06ResponseFields(s06));
  const before = responseView(row);
  const snake = {
    ...(clean.statusCode !== undefined ? { status_code: clean.statusCode } : {}),
    ...(clean.selectionPattern !== undefined ? { selection_pattern: clean.selectionPattern } : {}),
    ...(clean.responseParameters !== undefined ? { response_parameters: clean.responseParameters } : {}),
    ...(clean.responseTemplates !== undefined ? { response_templates: clean.responseTemplates } : {}),
    ...(clean.contentHandling !== undefined ? { content_handling: clean.contentHandling } : {}),
  };
  const updated = typeof db.updateIntegrationResponse === "function"
    ? await db.updateIntegrationResponse(row.id, snake)
    : { ...row, ...snake, version: (row.version ?? 1) + 1 };
  const after = responseView({ ...row, ...snake, ...updated });
  await audit(db, actor, {
    action: "integration_response.update", resourceType: "integration_response", resourceId: row.id,
    projectId, apiId, before, after, requestId,
  });
  return after;
}

/** Delete an integration response. */
export async function deleteIntegrationResponse(db, actor, { projectId, apiId, integrationId, responseId, requestId = null }) {
  await requirePermission(db, actor, "pods.integration.write", { projectId, apiId });
  await scopedIntegration(db, projectId, apiId, integrationId);
  const row = await db.getIntegrationResponseById(responseId);
  if (!row || row.integration_id !== integrationId) {
    throw new HttpError(404, "not_found", "Integration response does not exist.");
  }
  await db.deleteIntegrationResponse(row.id);
  await audit(db, actor, {
    action: "integration_response.delete", resourceType: "integration_response", resourceId: row.id,
    projectId, apiId, before: responseView(row), after: null, requestId,
  });
  return { id: row.id, deleted: true };
}
