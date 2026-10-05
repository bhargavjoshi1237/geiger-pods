/**
 * Custom (Lambda) authorizers (S07 §5): `TOKEN` and `REQUEST`, REST + HTTP
 * (payload 1.0/2.0) + WebSocket `$connect`.
 *
 * **Inputs.** REST `TOKEN`: `{"type":"TOKEN","authorizationToken","methodArn"}`;
 * an `identityValidationExpression` mismatch → 401 without invoking. REST
 * `REQUEST`: the full request-context event. HTTP `1.0`: same as REST
 * REQUEST plus `identitySource`. HTTP `2.0`: the 2.0 shape with
 * `identitySource`, `routeKey`, `rawPath`, `cookies`, ... WebSocket
 * `$connect`: REQUEST with `requestContext.connectionId`, `eventType:
 * CONNECT`. Any missing/empty identity source → 401 `UNAUTHORIZED` without
 * invoking (AWS behavior).
 *
 * **Outputs.** Policy format (`principalId`, `policyDocument`,
 * `context`, `usageIdentifierKey?`): Allow iff some Allow statement matches
 * the current `methodArn`/`routeArn` and no Deny matches. Simple format
 * (HTTP 2.0 + `enable_simple_responses`): `{ isAuthorized, context }`. The
 * function throwing/returning `"Unauthorized"`, or a webhook HTTP 401 →
 * 401. Deny → 403 `ACCESS_DENIED` (`User is not authorized to access this
 * resource`). Timeout/function error/malformed output → 500
 * (`AUTHORIZER_FAILURE`; malformed policy → `AUTHORIZER_CONFIGURATION_ERROR`;
 * non-scalar `context` values → `AUTHORIZER_CONFIGURATION_ERROR`).
 *
 * **Caching.** `result_ttl_seconds > 0`: KV key
 * `authz:{authorizerId}:{sha256(identity values joined)}` holds the full
 * output. A cached policy is re-evaluated against each request's methodArn
 * (the AWS gotcha: a policy cached from `GET /pets` may deny `POST /pets`).
 * Deny and 401 results are cached too; errors are not.
 *
 * Function targets reuse the S04 shape (`webhook` POST or `aws_lambda`
 * SigV4-signed Invoke); secrets resolve through `ports.secrets` so artifacts
 * never carry plaintext.
 *
 * @module lib/gateway/core/auth/custom
 */

import { GatewayError } from "../errors.mjs";
import { matchArn } from "./policy.mjs";
import { signRequest } from "./sigv4.mjs";

export const DEFAULT_TOKEN_SOURCE = "method.request.header.Authorization";

/**
 * Resolves one identity-source expression to its request value.
 * Supported: `method.request.header.<N>`, `method.request.querystring.<N>`,
 * `method.request.path.<N>`, `$request.header.<N>`, `$request.querystring.<N>`,
 * `$stageVariables.<N>`, `$context.<path>`. Returns `null` when absent.
 *
 * @param {string} expression
 * @param {{ request: Request, stageVariables?: object, context?: object, pathParameters?: object }} input
 * @returns {string|null}
 */
export function resolveIdentitySource(expression, { request, stageVariables = {}, context = {}, pathParameters = {} } = {}) {
  const expr = String(expression ?? "").trim();
  const headers = request?.headers;
  const getHeader = (name) => {
    if (!headers) return null;
    if (typeof headers.get === "function") {
      const direct = headers.get(name);
      if (direct !== null) return direct;
      for (const [key, value] of headers.entries()) {
        if (key.toLowerCase() === String(name).toLowerCase()) return value;
      }
      return null;
    }
    const bag = headers ?? {};
    if (Object.hasOwn(bag, name)) return bag[name];
    const lower = String(name).toLowerCase();
    for (const key of Object.keys(bag)) {
      if (key.toLowerCase() === lower) return bag[key];
    }
    return null;
  };
  let match = expr.match(/^method\.request\.header\.(.+)$/i) ?? expr.match(/^\$request\.header\.(.+)$/i);
  if (match) {
    const value = getHeader(match[1]);
    return value === null || value === undefined ? null : String(value);
  }
  match = expr.match(/^method\.request\.querystring\.(.+)$/i) ?? expr.match(/^\$request\.querystring\.(.+)$/i);
  if (match) {
    const url = new URL(request.url);
    const value = url.searchParams.get(match[1]);
    return value === null ? null : String(value);
  }
  match = expr.match(/^method\.request\.path\.(.+)$/);
  if (match) {
    const value = pathParameters?.[match[1]];
    return value === null || value === undefined || value === "" ? null : String(value);
  }
  match = expr.match(/^\$stageVariables\.(.+)$/);
  if (match) {
    const value = stageVariables?.[match[1]];
    return value === null || value === undefined || value === "" ? null : String(value);
  }
  match = expr.match(/^\$context\.(.+)$/);
  if (match) {
    let current = context;
    for (const segment of match[1].split(".")) {
      if (segment === "__proto__" || segment === "constructor" || segment === "prototype") return null;
      if (current === null || current === undefined || typeof current !== "object") return null;
      current = current[segment];
    }
    return current === null || current === undefined || current === "" ? null : String(current);
  }
  return null;
}

/**
 * Gathers all identity values for an authorizer. `missing` is true when any
 * source is absent/empty (caller renders 401 without invoking).
 *
 * @param {{ identitySource?: Array<string>, type?: string }} authorizer
 * @param {{ request: Request, stageVariables?: object, context?: object, pathParameters?: object }} input
 * @returns {{ values: Array<string|null>, missing: boolean }}
 */
export function gatherIdentity(authorizer, input) {
  let sources = authorizer?.identitySource;
  if (!Array.isArray(sources) || sources.length === 0) {
    sources = authorizer?.type === "REQUEST" ? [] : [DEFAULT_TOKEN_SOURCE];
  }
  const values = sources.map((expression) => resolveIdentitySource(expression, input));
  return { values, missing: values.some((value) => value === null || String(value) === "") };
}

function headerObject(request) {
  if (request?.headers && typeof request.headers.entries === "function") {
    return Object.fromEntries(request.headers.entries());
  }
  return { ...(request?.headers ?? {}) };
}

function multiValue(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = String(name).toLowerCase();
    out[lower] = [...(out[lower] ?? []), String(value)];
  }
  return out;
}

function queryMaps(url) {
  const single = {};
  const multi = {};
  for (const [name, value] of url.searchParams) {
    if (single[name] === undefined) single[name] = value;
    multi[name] = [...(multi[name] ?? []), value];
  }
  return { single, multi };
}

/**
 * Builds the authorizer event for one invocation.
 *
 * @param {{ kind?: "TOKEN" | "REQUEST" | "HTTP10" | "HTTP20" | "WS", identityValues?: Array<string>, identitySources?: Array<string>, request: Request, methodArn: string, resourcePath?: string, httpMethod?: string, pathParameters?: object, stageVariables?: object, context?: object, routeKey?: string, connectionId?: string }} input
 * @returns {object}
 */
export function buildAuthorizerEvent({
  kind = "REQUEST",
  identityValues = [],
  identitySources = [],
  request,
  methodArn,
  resourcePath = "",
  httpMethod = "",
  pathParameters = {},
  stageVariables = {},
  context = {},
  routeKey = "",
  connectionId = null,
} = {}) {
  const url = new URL(request.url);
  const headers = headerObject(request);
  const { single, multi } = queryMaps(url);
  const requestContext = {
    ...(context?.accountId !== undefined ? { accountId: context.accountId } : {}),
    ...(context?.apiId !== undefined ? { apiId: context.apiId } : {}),
    ...(context?.stage !== undefined ? { stage: context.stage } : {}),
    ...(context?.requestId !== undefined ? { requestId: context.requestId } : {}),
  };
  if (kind === "TOKEN") {
    return { type: "TOKEN", authorizationToken: identityValues[0] ?? "", methodArn };
  }
  if (kind === "HTTP20") {
    const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : "";
    const cookies = String(headers.cookie ?? headers.Cookie ?? "")
      .split(";").map((part) => part.trim()).filter(Boolean);
    return {
      version: "2.0", type: "REQUEST", routeArn: methodArn,
      identitySource: [...identityValues], routeKey,
      rawPath: url.pathname, rawQueryString: rawQuery,
      cookies, headers,
      queryStringParameters: Object.keys(single).length > 0 ? single : undefined,
      requestContext, pathParameters,
      stageVariables: Object.keys(stageVariables ?? {}).length > 0 ? { ...stageVariables } : undefined,
    };
  }
  const event = {
    type: "REQUEST", methodArn,
    resource: resourcePath, path: url.pathname, httpMethod,
    headers, multiValueHeaders: multiValue(headers),
    queryStringParameters: Object.keys(single).length > 0 ? single : null,
    multiValueQueryStringParameters: Object.keys(multi).length > 0 ? multi : null,
    pathParameters: Object.keys(pathParameters ?? {}).length > 0 ? { ...pathParameters } : null,
    stageVariables: Object.keys(stageVariables ?? {}).length > 0 ? { ...stageVariables } : null,
    requestContext,
  };
  if (kind === "HTTP10") event.identitySource = [...identityValues];
  if (kind === "WS") {
    event.requestContext = {
      ...requestContext,
      ...(connectionId ? { connectionId } : {}),
      eventType: "CONNECT",
    };
  }
  void identitySources;
  return event;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cacheKey(authorizerId, identityValues) {
  return (async () => `authz:${authorizerId}:${await sha256Hex(identityValues.map((value) => String(value ?? "")).join("\n"))}`)();
}

async function readCache(ports, key) {
  try {
    const raw = await ports.kv.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Validates `context` values (must be string|number|boolean) and normalizes
 * to a string map for `$context.authorizer.*`.
 *
 * @param {unknown} context
 * @throws {GatewayError} `AUTHORIZER_CONFIGURATION_ERROR` on non-scalars.
 * @returns {Record<string, string|number|boolean>}
 */
export function normalizeAuthorizerContext(context) {
  if (context === undefined || context === null) return {};
  if (typeof context !== "object" || Array.isArray(context)) {
    throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
  }
  const out = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
    }
    out[key] = value;
  }
  return out;
}

function validatePolicyDocumentShape(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return false;
  const statements = document.Statement;
  if (!Array.isArray(statements)) return false;
  return statements.every((statement) =>
    statement && typeof statement === "object"
    && (statement.Effect === "Allow" || statement.Effect === "Deny")
    && statement.Action !== undefined
    && (statement.Resource !== undefined || statement.NotResource !== undefined));
}

/**
 * Evaluates one authorizer output (policy or simple format) against the
 * current methodArn.
 *
 * @param {{ output: object, methodArn: string, simpleResponses?: boolean }} input
 * @returns {{ verdict: "Allow" | "Deny", principalId: string, context: object, usageIdentifierKey?: string }}
 * @throws {GatewayError} `AUTHORIZER_CONFIGURATION_ERROR` on malformed output.
 */
export function evaluateAuthorizerOutput({ output, methodArn, simpleResponses = false } = {}) {
  if (!output || typeof output !== "object") {
    throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
  }
  if (output.policyDocument !== undefined) {
    if (typeof output.principalId !== "string" || output.principalId === "") {
      throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
    }
    if (!validatePolicyDocumentShape(output.policyDocument)) {
      throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
    }
    const context = normalizeAuthorizerContext(output.context);
    let allowed = false;
    for (const statement of output.policyDocument.Statement) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      if (!actions.some((action) => String(action) === "execute-api:Invoke" || String(action) === "execute-api:*" || String(action) === "*")) continue;
      const resources = statement.Resource !== undefined
        ? (Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource])
        : null;
      const notResources = statement.NotResource !== undefined
        ? (Array.isArray(statement.NotResource) ? statement.NotResource : [statement.NotResource])
        : null;
      const applies = resources
        ? resources.some((resource) => matchArn(String(resource), methodArn))
        : !(notResources.some((resource) => matchArn(String(resource), methodArn)));
      if (!applies) continue;
      if (statement.Effect === "Deny") return { verdict: "Deny", principalId: output.principalId, context };
      if (statement.Effect === "Allow") allowed = true;
    }
    const result = { verdict: allowed ? "Allow" : "Deny", principalId: output.principalId, context };
    if (output.usageIdentifierKey !== undefined) {
      if (typeof output.usageIdentifierKey !== "string") {
        throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
      }
      result.usageIdentifierKey = output.usageIdentifierKey;
    }
    return result;
  }
  if (typeof output.isAuthorized === "boolean") {
    if (!simpleResponses) throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
    return {
      verdict: output.isAuthorized ? "Allow" : "Deny",
      principalId: typeof output.principalId === "string" ? output.principalId : "",
      context: normalizeAuthorizerContext(output.context),
    };
  }
  throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
}

function lambdaArnToUrl(functionArn, qualifier) {
  const match = String(functionArn).match(/^arn:aws:lambda:([^:]+):\d+:function:([^:/]+)(?::([^/]+))?$/);
  if (!match) throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
  return {
    region: match[1],
    url: `https://lambda.${match[1]}.amazonaws.com/2015-03-31/functions/${encodeURIComponent(match[2])}/invocations?Qualifier=${encodeURIComponent(qualifier ?? match[3] ?? "$LATEST")}`,
  };
}

/**
 * Invokes the authorizer function target once (no cache). Webhook: POSTs the
 * event as JSON. `aws_lambda`: SigV4-signed Invoke API call.
 *
 * @param {{ target?: object, event: object, ports: object, timeoutMs?: number }} input
 * @returns {Promise<object>} Parsed output object.
 * @throws {GatewayError} `UNAUTHORIZED` (401/`"Unauthorized"`),
 * `AUTHORIZER_FAILURE` (timeout/function error/malformed), or
 * `AUTHORIZER_CONFIGURATION_ERROR` (bad target).
 */
export async function invokeAuthorizerTarget({ target = {}, event, ports, timeoutMs = 10000 } = {}) {
  const provider = target.provider ?? "webhook";
  const timeout = Math.min(Math.max(Number(timeoutMs) || 10000, 1), 30000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("authorizer-timeout")), timeout);
  const fetchFn = ports?.fetch ?? globalThis.fetch;
  try {
    const bodyText = JSON.stringify(event);
    let url;
    let headers = { "content-type": "application/json" };
    if (provider === "webhook") {
      if (!target.url) throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
      url = target.url;
      if (target.secretRef && ports?.secrets) {
        const resolved = await ports.secrets.resolve(target.secretRef);
        const secret = resolved?.value ?? resolved;
        const secretText = String(secret?.value ?? secret?.token ?? (typeof secret === "string" ? secret : ""));
        if (secretText) {
          const { createHmac } = await import("node:crypto");
          const nowSec = Math.floor(Date.now() / 1000);
          const digest = createHmac("sha256", secretText).update(`${nowSec}.${bodyText}`, "utf8").digest("hex");
          headers["x-pods-signature"] = `t=${nowSec},v1=${digest}`;
        }
      }
    } else if (provider === "aws_lambda") {
      if (!target.functionArn) throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
      const { region, url: invokeUrl } = lambdaArnToUrl(target.functionArn, target.qualifier);
      const credentials = target.credentialsRef && ports?.secrets
        ? await ports.secrets.resolve(target.credentialsRef)
        : null;
      const creds = credentials?.value ?? {};
      const signed = await signRequest({
        method: "POST", url: invokeUrl,
        headers: { "content-type": "application/json", "x-amz-invocation-type": "RequestResponse" },
        body: bodyText, service: "lambda", region,
        accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      });
      url = signed.url;
      headers = signed.headers;
    } else {
      throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
    }
    const response = await fetchFn(url, { method: "POST", headers, body: bodyText, signal: controller.signal, redirect: "manual" });
    const text = await response.text();
    if (response.status === 401) throw new GatewayError("UNAUTHORIZED", "Unauthorized");
    if (!response.ok && response.status !== 200) {
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (parsed?.errorMessage === "Unauthorized") throw new GatewayError("UNAUTHORIZED", "Unauthorized");
      throw new GatewayError("AUTHORIZER_FAILURE", "Internal server error");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GatewayError("AUTHORIZER_FAILURE", "Internal server error");
    }
    if (parsed?.errorMessage === "Unauthorized") throw new GatewayError("UNAUTHORIZED", "Unauthorized");
    return parsed;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("AUTHORIZER_FAILURE", "Internal server error");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs a custom authorizer for one request: identity check → cache → invoke
 * → evaluate. Returns the allow/deny verdict with context for `$context`.
 *
 * @param {{ authorizer: object, kind?: "TOKEN" | "REQUEST" | "HTTP10" | "HTTP20" | "WS", request: Request, methodArn: string, resourcePath?: string, httpMethod?: string, pathParameters?: object, stageVariables?: object, context?: object, routeKey?: string, connectionId?: string|null, ports: object }} input
 * @returns {Promise<{ principalId: string, context: object, usageIdentifierKey?: string, latencyMs: number, cached: boolean }}>}
 * @throws {GatewayError} `UNAUTHORIZED` / `ACCESS_DENIED` / `AUTHORIZER_*`.
 */
export async function runCustomAuth({
  authorizer,
  kind = "REQUEST",
  request,
  methodArn,
  resourcePath = "",
  httpMethod = "",
  pathParameters = {},
  stageVariables = {},
  context = {},
  routeKey = "",
  connectionId = null,
  ports,
} = {}) {
  const started = Date.now();
  const type = authorizer?.type ?? "REQUEST";
  const input = { request, stageVariables, context, pathParameters };
  const { values, missing } = gatherIdentity(authorizer, input);
  if (missing) throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  if (type === "TOKEN" && authorizer?.identityValidationExpression) {
    let regex;
    try {
      regex = new RegExp(authorizer.identityValidationExpression);
    } catch {
      throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
    }
    if (!regex.test(String(values[0] ?? ""))) throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  }
  const ttlSec = Number(authorizer?.resultTtlSeconds ?? 300);
  const cacheable = Number.isFinite(ttlSec) && ttlSec > 0 && ports?.kv;
  const key = cacheable ? await cacheKey(authorizer.id, values) : null;
  if (cacheable) {
    const cached = await readCache(ports, key);
    if (cached) {
      if (cached.status === "unauthorized") throw new GatewayError("UNAUTHORIZED", "Unauthorized");
      const evaluated = evaluateAuthorizerOutput({
        output: cached.output, methodArn, simpleResponses: authorizer?.enableSimpleResponses === true,
      });
      if (evaluated.verdict === "Deny") {
        throw new GatewayError("ACCESS_DENIED", "User is not authorized to access this resource");
      }
      return { ...evaluated, latencyMs: 0, cached: true };
    }
  }
  const eventKind = type === "TOKEN" ? "TOKEN" : kind;
  const event = buildAuthorizerEvent({
    kind: eventKind, identityValues: values, identitySources: authorizer?.identitySource ?? [],
    request, methodArn, resourcePath, httpMethod, pathParameters, stageVariables, context, routeKey, connectionId,
  });
  let output;
  try {
    output = await invokeAuthorizerTarget({
      target: authorizer?.function ?? {}, event, ports, timeoutMs: authorizer?.timeoutMs ?? 10000,
    });
  } catch (error) {
    if (error instanceof GatewayError && error.type === "UNAUTHORIZED" && cacheable) {
      await ports.kv.set(key, JSON.stringify({ status: "unauthorized" }), { ttlMs: ttlSec * 1000 });
    }
    throw error;
  }
  const evaluated = evaluateAuthorizerOutput({
    output, methodArn, simpleResponses: authorizer?.enableSimpleResponses === true,
  });
  if (cacheable) {
    // Deny verdicts are cached too (re-evaluated per methodArn on hits);
    // only transport/config errors bypass the cache.
    await ports.kv.set(key, JSON.stringify({ status: "ok", output }), { ttlMs: ttlSec * 1000 });
  }
  if (evaluated.verdict === "Deny") {
    throw new GatewayError("ACCESS_DENIED", "User is not authorized to access this resource");
  }
  return { ...evaluated, latencyMs: Date.now() - started, cached: false };
}
