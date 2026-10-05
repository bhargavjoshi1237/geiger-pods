/**
 * Authorizers control-plane service (S07 §3–§5).
 *
 * `pods.authorizers`: per-API `JWT` / `TOKEN` / `REQUEST` authorizer configs.
 * Writes need API-scoped `pods.authorizer.write`; reads need `pods.apis.view`.
 * Rows carry no secrets, only `credentials_ref` (`secret:<id>`) pointers, so
 * snapshots are artifact-safe. Every mutation is audited.
 *
 * `db` port (faked in tests, Supabase in production via `auth-db.mjs`):
 * - `getApiByRef({ projectId, ref })` → API row (`id`, `protocol`) or null
 * - `listAuthorizers({ projectId, apiId, limit, cursor })`,
 *   `getAuthorizerById(id)`, `insertAuthorizer(row)`,
 *   `updateAuthorizer({ id, patch })`, `deleteAuthorizer({ id })`
 *
 * @module lib/control/authorizers
 */

import { randomUUID } from "node:crypto";
import { newPublicId } from "../gateway/ids.mjs";
import { validateAuthorizerEntry } from "../gateway/core/auth/validate-authorization.mjs";
import {
  buildAuthorizerEvent,
  evaluateAuthorizerOutput,
  gatherIdentity,
  invokeAuthorizerTarget,
} from "../gateway/core/auth/custom.mjs";
import { GatewayError } from "../gateway/core/errors.mjs";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";

const AUTHORIZER_TYPES = ["JWT", "TOKEN", "REQUEST"];

function field(row, ...names) {
  for (const name of names) {
    if (row && Object.hasOwn(row, name) && row[name] !== undefined) return row[name];
  }
  return undefined;
}

function toView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    apiId: row.api_id,
    publicId: row.public_id,
    name: row.name,
    type: row.type,
    identitySource: row.identity_source ?? [],
    identityValidationExpression: row.identity_validation_expression ?? null,
    jwt: row.jwt ?? null,
    function: row.function ?? null,
    payloadFormatVersion: row.payload_format_version ?? null,
    enableSimpleResponses: row.enable_simple_responses ?? false,
    resultTtlSeconds: row.result_ttl_seconds ?? 300,
    timeoutMs: row.timeout_ms ?? 10000,
    credentialsRef: row.credentials_ref ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (typeof parsed.createdAt === "string" && typeof parsed.id === "string") return parsed;
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_input", "Invalid pagination cursor.");
}

async function resolveApi(db, projectId, apiRef) {
  const api = await db.getApiByRef({ projectId, ref: apiRef });
  if (!api) throw new HttpError(404, "not_found", "API does not exist.");
  return api;
}

async function scopedAuthorizer(db, projectId, apiUuid, authorizerId) {
  const row = await db.getAuthorizerById(authorizerId);
  if (!row || row.project_id !== projectId || String(row.api_id) !== String(apiUuid)) {
    throw new HttpError(404, "not_found", "Authorizer does not exist.");
  }
  return row;
}

function checkName(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > 128) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
  }
}

function checkSecretRef(ref, path) {
  if (ref === undefined || ref === null) return;
  if (typeof ref !== "string" || !ref.startsWith("secret:")) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${path}: must reference a secret (secret:<id>)`);
  }
}

/**
 * Validates an authorizer input object against the engine grammar plus
 * control-plane cross-field rules. Throws 422/400 `HttpError`.
 *
 * @param {object} input - camelCase authorizer fields.
 * @param {string} protocol - API protocol.
 */
export function checkAuthorizerInput(input, protocol) {
  if (!input || typeof input !== "object") {
    throw new HttpError(422, "invalid_input", "Invalid request: expected an object");
  }
  const { errors } = validateAuthorizerEntry(
    {
      type: input.type,
      identitySource: input.identitySource,
      resultTtlSeconds: input.resultTtlSeconds,
      timeoutMs: input.timeoutMs,
      jwt: input.jwt,
      function: input.function,
      payloadFormatVersion: input.payloadFormatVersion,
    },
    protocol,
    "authorizer",
  );
  if (errors.length > 0) {
    const first = errors[0];
    const code = first.code === "capability_unsupported" ? "capability_unsupported" : "invalid_input";
    throw new HttpError(code === "capability_unsupported" ? 400 : 422, code, `Invalid authorizer: ${first.path}: ${first.message}`, { errors });
  }
  const type = input.type;
  if (type === "JWT") {
    if (input.function !== undefined) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.function: JWT authorizers take no function target");
    }
  } else {
    const fn = input.function;
    if (!fn || typeof fn !== "object") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.function: custom authorizers require a function target");
    }
    if (fn.provider === "webhook") {
      if (typeof fn.url !== "string" || fn.url === "") {
        throw new HttpError(422, "invalid_input", "Invalid request: $.function.url: webhook functions require a url");
      }
      try {
        const url = new URL(fn.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad scheme");
      } catch {
        throw new HttpError(422, "invalid_input", "Invalid request: $.function.url: must be a valid http(s) URL");
      }
    } else if (fn.provider === "aws_lambda") {
      if (typeof fn.functionArn !== "string" || !/^arn:aws:lambda:/.test(fn.functionArn)) {
        throw new HttpError(422, "invalid_input", "Invalid request: $.function.functionArn: must be a Lambda function ARN");
      }
    } else {
      throw new HttpError(422, "invalid_input", "Invalid request: $.function.provider: must be webhook or aws_lambda");
    }
    checkSecretRef(fn.secretRef, "function.secretRef");
    checkSecretRef(fn.credentialsRef, "function.credentialsRef");
    if (input.payloadFormatVersion !== undefined && !["1.0", "2.0"].includes(String(input.payloadFormatVersion))) {
      throw new HttpError(422, "invalid_input", 'Invalid request: $.payloadFormatVersion: must be "1.0" or "2.0"');
    }
  }
  if (input.identityValidationExpression !== undefined && input.identityValidationExpression !== null) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(input.identityValidationExpression);
    } catch {
      throw new HttpError(422, "invalid_input", "Invalid request: $.identityValidationExpression: must be a valid regex");
    }
    if (type !== "TOKEN") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.identityValidationExpression: only TOKEN authorizers support it");
    }
  }
  checkSecretRef(input.credentialsRef, "credentialsRef");
}

async function requireSecretUse(db, actor, projectId, input) {
  const refs = [
    input?.function?.secretRef,
    input?.function?.credentialsRef,
    input?.credentialsRef,
  ].filter((ref) => typeof ref === "string" && ref.length > 0);
  if (refs.length > 0) {
    await requirePermission(db, actor, "pods.secret.use", { projectId });
  }
}

function toRow(projectId, apiUuid, input) {
  return {
    id: randomUUID(),
    project_id: projectId,
    api_id: apiUuid,
    public_id: newPublicId().slice(0, 8),
    name: input.name,
    type: input.type,
    identity_source: [...(input.identitySource ?? [])],
    identity_validation_expression: input.identityValidationExpression ?? null,
    jwt: input.type === "JWT" ? { ...(input.jwt ?? {}) } : null,
    function: input.type === "JWT" ? null : { ...(input.function ?? {}) },
    payload_format_version: input.payloadFormatVersion ?? null,
    enable_simple_responses: input.enableSimpleResponses ?? false,
    result_ttl_seconds: input.resultTtlSeconds ?? null,
    timeout_ms: input.timeoutMs ?? 10000,
    credentials_ref: input.credentialsRef ?? null,
  };
}

/** List authorizers for an API (creation order). */
export async function listAuthorizers(db, actor, { projectId, apiId, limit = 25, cursor = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId, apiId: api.id });
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const rows = await db.listAuthorizers({ projectId, apiId: api.id, limit: take + 1, cursor: cursor ? decodeCursor(cursor) : null });
  const page = rows.slice(0, take);
  return {
    items: page.map(toView),
    nextCursor: rows.length > take ? encodeCursor(rows[take - 1]) : null,
  };
}

/** Get one authorizer. */
export async function getAuthorizer(db, actor, { projectId, apiId, authorizerId }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId, apiId: api.id });
  return toView(await scopedAuthorizer(db, projectId, api.id, authorizerId));
}

/** Create an authorizer; 409 on duplicate name. */
export async function createAuthorizer(db, actor, { projectId, apiId, input, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.authorizer.write", { projectId, apiId: api.id });
  checkName(input?.name);
  if (!AUTHORIZER_TYPES.includes(input?.type)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.type: must be one of ${AUTHORIZER_TYPES.join(", ")}`);
  }
  checkAuthorizerInput(input, api.protocol);
  await requireSecretUse(db, actor, projectId, input);
  let row;
  try {
    row = await db.insertAuthorizer(toRow(projectId, api.id, input));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, "conflict", `An authorizer named "${input.name}" already exists.`);
  }
  await audit(db, actor, {
    action: "authorizer.create", resourceType: "authorizer", resourceId: row.id,
    projectId, apiId: api.id, before: null, after: toView(row), requestId,
  });
  return { status: 201, body: toView(row) };
}

/** Update an authorizer (compare-and-swap via `expectedVersion`). */
export async function updateAuthorizer(db, actor, { projectId, apiId, authorizerId, patch, expectedVersion = null, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.authorizer.write", { projectId, apiId: api.id });
  const current = await scopedAuthorizer(db, projectId, api.id, authorizerId);
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Authorizer changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new HttpError(422, "invalid_input", "Provide at least one field to update.");
  }
  const allowed = new Set([
    "name", "identitySource", "identityValidationExpression", "jwt", "function",
    "payloadFormatVersion", "enableSimpleResponses", "resultTtlSeconds", "timeoutMs", "credentialsRef",
  ]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new HttpError(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
  }
  const merged = { ...toView(current), ...patch, type: current.type };
  checkAuthorizerInput(merged, api.protocol);
  await requireSecretUse(db, actor, projectId, merged);
  const next = {};
  if (patch.name !== undefined) {
    checkName(patch.name);
    next.name = patch.name;
  }
  if (patch.identitySource !== undefined) next.identity_source = [...patch.identitySource];
  if (patch.identityValidationExpression !== undefined) next.identity_validation_expression = patch.identityValidationExpression;
  if (patch.jwt !== undefined) next.jwt = patch.jwt === null ? null : { ...patch.jwt };
  if (patch.function !== undefined) next.function = patch.function === null ? null : { ...patch.function };
  if (patch.payloadFormatVersion !== undefined) next.payload_format_version = patch.payloadFormatVersion;
  if (patch.enableSimpleResponses !== undefined) next.enable_simple_responses = patch.enableSimpleResponses;
  if (patch.resultTtlSeconds !== undefined) next.result_ttl_seconds = patch.resultTtlSeconds;
  if (patch.timeoutMs !== undefined) next.timeout_ms = patch.timeoutMs;
  if (patch.credentialsRef !== undefined) next.credentials_ref = patch.credentialsRef;
  next.version = current.version + 1;
  const before = toView(current);
  const updated = await db.updateAuthorizer({ id: current.id, patch: next });
  await audit(db, actor, {
    action: "authorizer.update", resourceType: "authorizer", resourceId: current.id,
    projectId, apiId: api.id, before, after: toView(updated), requestId,
  });
  return toView(updated);
}

/** Delete an authorizer. */
export async function deleteAuthorizer(db, actor, { projectId, apiId, authorizerId, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.authorizer.write", { projectId, apiId: api.id });
  const current = await scopedAuthorizer(db, projectId, api.id, authorizerId);
  const before = toView(current);
  await db.deleteAuthorizer({ id: current.id });
  await audit(db, actor, {
    action: "authorizer.delete", resourceType: "authorizer", resourceId: current.id,
    projectId, apiId: api.id, before, after: null, requestId,
  });
  return { id: current.id, deleted: true };
}

function maskIdentityValue(value, source) {
  const text = String(value ?? "");
  if (/auth|token|secret|key/i.test(String(source ?? "")) || text.length > 12) {
    return text.length <= 4 ? "***" : `${text.slice(0, 4)}…***`;
  }
  return text;
}

/**
 * Test-invoke an authorizer (REST control-plane equivalent of the AWS
 * "test authorizer" console). Uses no cache, never touches live traffic,
 * and masks secret-bearing identity values in the returned log.
 *
 * `input`: `{ headers, queryString, stageVariables, methodArn? }`.
 * Returns `{ status, principalId, policy, context, latencyMs, log }` where
 * `status` is `"allow"` or `"deny"`. Authorizer denials surface as
 * `{ status: "deny", ... }` (not thrown); 401s surface as
 * `{ status: "unauthorized", ... }`.
 */
export async function testAuthorizer(db, actor, { projectId, apiId, authorizerId, input = {}, requestId = null }, deps = {}) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.test.invoke", { projectId, apiId: api.id });
  const row = await scopedAuthorizer(db, projectId, api.id, authorizerId);
  const started = Date.now();
  const log = [];
  const view = toView(row);
  const authorizer = {
    ...view,
    resultTtlSeconds: 0,
  };
  const headers = new Headers();
  for (const [name, value] of Object.entries(input.headers ?? {})) headers.set(name, String(value));
  const query = new URLSearchParams(input.queryString ?? "");
  const url = `https://test.invalid/invoke${query.toString() ? `?${query.toString()}` : ""}`;
  const request = new Request(url, { headers });
  const methodArn = typeof input.methodArn === "string" && input.methodArn !== ""
    ? input.methodArn
    : `arn:pods:execute-api:auto:${projectId}:${api.public_id ?? api.id}/test/GET/`;
  const stageVariables = { ...(input.stageVariables ?? {}) };
  const { values, missing } = gatherIdentity(authorizer, { request, stageVariables, context: {}, pathParameters: {} });
  const maskedSources = (authorizer.identitySource ?? []).map((source, index) => `${source}=${maskIdentityValue(values[index], source)}`);
  log.push(`identity: ${maskedSources.join(", ") || "(none)"}`);
  if (missing) {
    return { status: "unauthorized", principalId: null, policy: null, context: {}, latencyMs: Date.now() - started, log: [...log, "missing identity source → 401 without invoking"] };
  }
  const kind = authorizer.type === "TOKEN" ? "TOKEN" : "REQUEST";
  const event = buildAuthorizerEvent({
    kind,
    identityValues: values,
    identitySources: authorizer.identitySource ?? [],
    request,
    methodArn,
    resourcePath: "/",
    httpMethod: "GET",
    pathParameters: {},
    stageVariables,
    context: {},
  });
  log.push(`event: ${kind} → ${authorizer.function?.provider ?? "webhook"} target`);
  const ports = {
    fetch: deps.fetch ?? globalThis.fetch,
    secrets: deps.secrets ?? null,
  };
  let output;
  try {
    output = await invokeAuthorizerTarget({ target: authorizer.function ?? {}, event, ports, timeoutMs: authorizer.timeoutMs });
  } catch (error) {
    if (error instanceof GatewayError && error.type === "UNAUTHORIZED") {
      return { status: "unauthorized", principalId: null, policy: null, context: {}, latencyMs: Date.now() - started, log: [...log, "function answered Unauthorized → 401"] };
    }
    const type = error instanceof GatewayError ? error.type : "AUTHORIZER_FAILURE";
    throw new HttpError(502, "authorizer_error", `Authorizer invocation failed (${type}).`);
  }
  const evaluated = evaluateAuthorizerOutput({
    output,
    methodArn,
    simpleResponses: authorizer.enableSimpleResponses === true,
  });
  const latencyMs = Date.now() - started;
  await audit(db, actor, {
    action: "authorizer.test", resourceType: "authorizer", resourceId: row.id,
    projectId, apiId: api.id, before: null, after: { id: row.id, status: evaluated.verdict === "Allow" ? "allow" : "deny" }, requestId,
  });
  return {
    status: evaluated.verdict === "Allow" ? "allow" : "deny",
    principalId: evaluated.principalId,
    policy: output.policyDocument ?? null,
    context: evaluated.context,
    latencyMs,
    log: [...log, `verdict: ${evaluated.verdict} (${latencyMs} ms)`],
  };
}
