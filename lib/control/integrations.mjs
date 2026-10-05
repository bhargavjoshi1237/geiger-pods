// Integrations management service (S04 §2 + §7). One file per resource per
// S01 §8: pure-ish `(db, actor, input) → result`, validation first,
// API-scoped `pods.integration.write`, audit rows on mutation.

import { supports } from "../gateway/capabilities.mjs";
import { newPublicId } from "../gateway/ids.mjs";
import { v, validate } from "./validate.mjs";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";

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
});

const RESPONSE_SCHEMA = v.object({
  statusCode: v.int({ min: 100, max: 599 }),
  selectionPattern: v.optional(v.string({ min: 1, max: 1024 })),
});

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

function timeoutBounds(protocol) {
  if (protocol === "HTTP") return { min: 50, max: 30000, def: 30000 };
  return { min: 50, max: 29000, def: 29000 };
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

function checkCrossFields(clean, protocol) {
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
    const bounds = timeoutBounds(protocol);
    if (clean.timeoutMs < bounds.min || clean.timeoutMs > bounds.max) {
      throw new HttpError(422, "invalid_input", `timeoutMs must be ${bounds.min}–${bounds.max} for ${protocol} APIs.`);
    }
  }
  if (clean.payloadFormatVersion === "2.0" && protocol !== "HTTP") {
    throw new HttpError(422, "invalid_input", "payload_format_version 2.0 is only available on HTTP APIs (REST always uses 1.0).");
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
  const extracted = extractAwsParameters(normalizeTlsInput(input ?? {}));
  const clean = validate(CREATE_SCHEMA, extracted.input ?? {});
  if (extracted.parameters !== undefined) clean.aws = { ...(clean.aws ?? {}), parameters: extracted.parameters };
  const protocol = await checkTypeSupport(db, projectId, apiId, clean.type);
  checkCrossFields(clean, protocol);
  await requireSecretUseForRefs(db, actor, {
    projectId,
    backendAuth: clean.backendAuth,
    functionConfig: clean.function,
    aws: clean.aws,
  });
  const bounds = timeoutBounds(protocol);
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
  const { backendAuth: rawAuth, ...rest } = patch ?? {};
  const clean = validate(PATCH_SCHEMA, normalizeTlsInput(rawAuth === null ? rest : patch) ?? {});
  const extracted = extractAwsParameters({ aws: patch?.aws });
  if (extracted.parameters !== undefined) clean.aws = { ...(clean.aws ?? {}), parameters: extracted.parameters };
  // Explicit null clears backend auth; undefined leaves it alone.
  if (rawAuth === null) clean.backendAuth = null;
  const current = await scopedIntegration(db, projectId, apiId, integrationId);
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Integration changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const protocol = await checkTypeSupport(db, projectId, apiId, current.type);
  checkCrossFields({ ...toView(current), ...clean, type: current.type }, protocol);
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
    ...(clean.tls !== undefined ? { tls: clean.tls } : {}),
    ...(clean.backendAuth !== undefined ? { backend_auth: clean.backendAuth } : {}),
    ...(clean.description !== undefined ? { description: clean.description } : {}),
  };
  const updated = await db.updateIntegration(current.id, snake);
  const after = toView(updated);
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
    version: row.version,
    createdAt: row.created_at,
  };
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
  await scopedIntegration(db, projectId, apiId, integrationId);
  const clean = validate(RESPONSE_SCHEMA, input ?? {});
  if (clean.selectionPattern) {
    try {
      new RegExp(clean.selectionPattern);
    } catch {
      throw new HttpError(422, "invalid_input", "selectionPattern must be a valid regular expression.");
    }
  }
  const row = await db.insertIntegrationResponse({
    project_id: projectId,
    api_id: apiId,
    integration_id: integrationId,
    status_code: clean.statusCode,
    selection_pattern: clean.selectionPattern ?? null,
    created_by: actor?.userId ?? null,
  });
  const view = responseView(row);
  await audit(db, actor, {
    action: "integration_response.create", resourceType: "integration_response", resourceId: row.id,
    projectId, apiId, before: null, after: view, requestId,
  });
  return { status: 201, body: view };
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
