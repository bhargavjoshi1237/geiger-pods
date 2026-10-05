/**
 * Function adapters: `FUNCTION_PROXY` (Lambda proxy, payload v1.0/v2.0) and
 * `FUNCTION` custom non-proxy (S04 §3.3–§3.4).
 *
 * Providers: `aws_lambda` (SigV4-signed Invoke API call) and `webhook`
 * (Pods POSTs the Lambda-format event as JSON, expects a Lambda-format
 * response; requests carry `x-pods-signature:
 * t=<unix>,v1=<hmac_sha256(secret, t + "." + body)>`).
 *
 * @module lib/gateway/core/integrations/function
 */

import { createHmac } from "node:crypto";
import { GatewayError } from "../errors.mjs";
import { formatClfTime } from "../context.mjs";
import { signRequest } from "../auth/sigv4.mjs";

/**
 * Signs a webhook body: `t=<unix>,v1=<hex hmac_sha256(secret, t + "." + body)>`.
 *
 * @param {string} secret - Webhook shared secret (from the vault).
 * @param {string} body - Exact JSON bytes sent.
 * @param {number} [nowSec=Math.floor(Date.now()/1000)] - Unix seconds (injectable for tests).
 * @returns {string} Signature header value.
 */
export function signWebhookBody(secret, body, nowSec = Math.floor(Date.now() / 1000)) {
  const digest = createHmac("sha256", secret).update(`${nowSec}.${body}`, "utf8").digest("hex");
  return `t=${nowSec},v1=${digest}`;
}

/**
 * Verifies an `x-pods-signature` value with a ±5 minute clock-skew window.
 *
 * @param {string} secret
 * @param {string} body
 * @param {string} signature
 * @param {number} [nowSec=Math.floor(Date.now()/1000)]
 * @returns {boolean}
 */
export function verifyWebhookSignature(secret, body, signature, nowSec = Math.floor(Date.now() / 1000)) {
  const match = String(signature ?? "").match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (Math.abs(nowSec - timestamp) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
  return expected === match[2];
}

function multiValue(headers) {
  // Null-prototype accumulators: header names are consumer-controlled and
  // `__proto__`/`constructor` keys must stay own data, never touch Object.prototype
  // (a `?__proto__`-style key previously threw `TypeError: not iterable`).
  const out = Object.create(null);
  for (const [name, value] of headers instanceof Headers ? headers.entries() : Object.entries(headers ?? {})) {
    const lower = String(name).toLowerCase();
    out[lower] = [...(out[lower] ?? []), String(value)];
  }
  return out;
}

function singleValue(headers) {
  const out = Object.create(null);
  for (const [name, value] of headers instanceof Headers ? headers.entries() : Object.entries(headers ?? {})) {
    out[String(name).toLowerCase()] = String(value);
  }
  return out;
}

function queryParams(url) {
  const single = Object.create(null);
  const multi = Object.create(null);
  for (const [name, value] of url.searchParams) {
    if (single[name] === undefined) single[name] = value;
    multi[name] = [...(multi[name] ?? []), value];
  }
  return { single, multi };
}

/**
 * Builds a REST (format 1.0) proxy event — the `set-up-lambda-proxy-integrations`
 * reference shape.
 */
export function buildRestEvent(ctx, { body = null, isBase64Encoded = false } = {}) {
  const url = new URL(ctx.request.url);
  const headers = ctx.request.headers instanceof Headers
    ? Object.fromEntries(ctx.request.headers.entries())
    : { ...(ctx.request.headers ?? {}) };
  const { single, multi } = queryParams(url);
  const authorizer = ctx.authorizerContext ?? ctx.context?.authorizer ?? {};
  return {
    resource: ctx.resourcePath ?? ctx.context?.resourcePath ?? url.pathname,
    path: url.pathname,
    httpMethod: ctx.request.method,
    headers,
    multiValueHeaders: multiValue(ctx.request.headers),
    queryStringParameters: Object.keys(single).length > 0 ? { ...single } : null,
    multiValueQueryStringParameters: Object.keys(multi).length > 0 ? multi : null,
    pathParameters: ctx.pathParams && Object.keys(ctx.pathParams).length > 0 ? { ...ctx.pathParams } : null,
    stageVariables: ctx.stageVariables && Object.keys(ctx.stageVariables).length > 0 ? { ...ctx.stageVariables } : null,
    requestContext: {
      accountId: ctx.context?.accountId ?? "",
      resourceId: ctx.context?.resourceId ?? "",
      stage: ctx.context?.stage ?? "",
      requestId: ctx.requestId ?? ctx.context?.requestId ?? "",
      requestTime: ctx.context?.requestTime ?? "",
      requestTimeEpoch: ctx.context?.requestTimeEpoch ?? 0,
      identity: {
        sourceIp: ctx.context?.identity?.sourceIp ?? "",
        userAgent: ctx.context?.identity?.userAgent ?? "",
      },
      resourcePath: ctx.resourcePath ?? ctx.context?.resourcePath ?? url.pathname,
      httpMethod: ctx.request.method,
      apiId: ctx.context?.apiId ?? "",
      ...(Object.keys(authorizer).length > 0 ? { authorizer } : {}),
    },
    body: body === null || body === undefined ? null : (typeof body === "string" ? body : Buffer.from(body).toString(isBase64Encoded ? "base64" : "utf8")),
    isBase64Encoded,
  };
}

/**
 * Builds an HTTP-API proxy event, format 1.0 or 2.0 exactly as the AWS
 * payload-format reference shows. In 2.0 header names are lowercased,
 * multi-values are comma-joined, and `cookies` are split out.
 */
export function buildHttpEvent(ctx, { version = "2.0", body = null, isBase64Encoded = false } = {}) {
  const url = new URL(ctx.request.url);
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : "";
  const headers = ctx.request.headers instanceof Headers
    ? [...ctx.request.headers.entries()]
    : Object.entries(ctx.request.headers ?? {});
  // AWS splits the Cookie header on ";" — one array entry per cookie.
  const cookies = headers
    .filter(([name]) => String(name).toLowerCase() === "cookie")
    .flatMap(([, value]) => String(value).split(";").map((part) => part.trim()).filter(Boolean));
  const joined = Object.create(null);
  for (const [name, value] of headers) {
    const lower = String(name).toLowerCase();
    joined[lower] = joined[lower] === undefined ? String(value) : `${joined[lower]},${String(value)}`;
  }
  const query = Object.create(null);
  for (const [name, value] of url.searchParams) {
    query[name] = query[name] === undefined ? value : `${query[name]},${value}`;
  }
  // AWS payload-format 2.0 `requestContext.time` is CLF (`dd/MMM/yyyy:HH:mm:ss
  // +0000`), the same string as `$context.requestTime` — not ISO.
  const epoch = ctx.context?.requestTimeEpoch ?? Date.now();
  const time = ctx.context?.requestTime ?? formatClfTime(epoch);
  const bodyText = body === null || body === undefined
    ? null
    : (typeof body === "string" ? body : Buffer.from(body).toString(isBase64Encoded ? "base64" : "utf8"));
  if (version === "1.0") {
    return {
      version: "1.0",
      resource: ctx.routeKey ?? "$default",
      path: url.pathname,
      httpMethod: ctx.request.method,
      headers: singleValue(Object.fromEntries(headers)),
      multiValueHeaders: multiValue(Object.fromEntries(headers.map(([name, value]) => [name, value]))),
      queryStringParameters: Object.keys(query).length > 0 ? { ...query } : null,
      multiValueQueryStringParameters: null,
      pathParameters: ctx.pathParams && Object.keys(ctx.pathParams).length > 0 ? { ...ctx.pathParams } : null,
      stageVariables: ctx.stageVariables && Object.keys(ctx.stageVariables).length > 0 ? { ...ctx.stageVariables } : null,
      requestContext: {
        accountId: ctx.context?.accountId ?? "",
        apiId: ctx.context?.apiId ?? "",
        stage: ctx.context?.stage ?? "",
        requestId: ctx.requestId ?? ctx.context?.requestId ?? "",
        identity: { sourceIp: ctx.context?.identity?.sourceIp ?? "", userAgent: ctx.context?.identity?.userAgent ?? "" },
        resourcePath: ctx.routeKey ?? "$default",
        httpMethod: ctx.request.method,
        path: url.pathname,
      },
      body: bodyText,
      isBase64Encoded,
    };
  }
  return {
    version: "2.0",
    routeKey: ctx.routeKey ?? "$default",
    rawPath: url.pathname,
    rawQueryString: rawQuery,
    cookies: cookies.length > 0 ? cookies : [],
    headers: joined,
    queryStringParameters: Object.keys(query).length > 0 ? { ...query } : undefined,
    pathParameters: ctx.pathParams && Object.keys(ctx.pathParams).length > 0 ? { ...ctx.pathParams } : undefined,
    stageVariables: ctx.stageVariables && Object.keys(ctx.stageVariables).length > 0 ? { ...ctx.stageVariables } : undefined,
    requestContext: {
      accountId: ctx.context?.accountId ?? "",
      apiId: ctx.context?.apiId ?? "",
      stage: ctx.context?.stage ?? "",
      requestId: ctx.requestId ?? ctx.context?.requestId ?? "",
      http: {
        method: ctx.request.method,
        path: url.pathname,
        protocol: "HTTP/1.1",
        sourceIp: ctx.context?.identity?.sourceIp ?? "",
        userAgent: ctx.context?.identity?.userAgent ?? "",
      },
      ...(ctx.authorizerContext ? { authorizer: ctx.authorizerContext } : {}),
      time,
      timeEpoch: epoch,
    },
    body: bodyText,
    isBase64Encoded,
    ...(cookies.length > 0 ? {} : {}),
  };
}

/**
 * Parses a Lambda proxy response (payload 1.0 rules).
 * Missing `statusCode` or invalid JSON → GatewayError `DEFAULT_5XX`
 * (mapped to REST 502 / HTTP 500 by the dispatcher).
 */
export function parseProxyResponse10(payload) {
  let parsed = payload;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new GatewayError("DEFAULT_5XX", "Internal server error", { reason: "malformed-function-response" });
    }
  }
  if (!parsed || typeof parsed !== "object" || !Number.isInteger(parsed.statusCode)) {
    throw new GatewayError("DEFAULT_5XX", "Internal server error", { reason: "malformed-function-response" });
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(parsed.headers ?? {})) headers.set(name, String(value));
  for (const [name, values] of Object.entries(parsed.multiValueHeaders ?? {})) {
    for (const value of values ?? []) headers.append(name, String(value));
  }
  const bodyText = parsed.body ?? "";
  const body = parsed.isBase64Encoded
    ? new Uint8Array(Buffer.from(String(bodyText), "base64"))
    : new TextEncoder().encode(String(bodyText));
  return { status: parsed.statusCode, headers, body };
}

/**
 * Parses a payload-format 2.0 response with AWS inference rules: valid JSON
 * without `statusCode` → 200 JSON; a string output becomes the body;
 * `cookies[]` → separate `set-cookie` headers.
 */
export function parseProxyResponse20(payload) {
  let parsed = payload;
  let wasString = false;
  if (typeof parsed === "string") {
    wasString = true;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { status: 200, headers: new Headers({ "content-type": "text/plain" }), body: new TextEncoder().encode(payload) };
    }
  }
  if (parsed && typeof parsed === "object" && !Number.isInteger(parsed.statusCode)) {
    const headers = new Headers({ "content-type": "application/json" });
    for (const cookie of parsed.cookies ?? []) headers.append("set-cookie", String(cookie));
    return { status: 200, headers, body: new TextEncoder().encode(JSON.stringify(parsed)) };
  }
  if (wasString && typeof parsed !== "object") {
    return { status: 200, headers: new Headers({ "content-type": "text/plain" }), body: new TextEncoder().encode(String(parsed)) };
  }
  return parseProxyResponse10(parsed);
}

/**
 * Tests `selection_pattern` regexes against a function error payload's
 * `errorMessage` (AWS semantics for custom `FUNCTION` integrations).
 *
 * @param {{ errorMessage?: string }} errorPayload
 * @param {Array<{ status_code: number, selection_pattern: string | null }>} responses
 * @returns {{ status_code: number, selection_pattern: string | null } | null}
 */
export function selectCustomResponse(errorPayload, responses) {
  const message = String(errorPayload?.errorMessage ?? "");
  for (const response of responses ?? []) {
    if (!response.selection_pattern) continue;
    let regex;
    try {
      regex = new RegExp(response.selection_pattern);
    } catch {
      continue;
    }
    if (regex.test(message)) return response;
  }
  return (responses ?? []).find((response) => !response.selection_pattern) ?? null;
}

function lambdaInvokeUrl(functionArn, qualifier) {
  const match = String(functionArn).match(/^arn:aws:lambda:([^:]+):\d+:function:([^:/]+)(?::([^/]+))?$/);
  if (!match) throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error", { reason: "bad-function-arn" });
  const region = match[1];
  const name = match[2];
  const qual = qualifier ?? match[3] ?? "$LATEST";
  return {
    region,
    url: `https://lambda.${region}.amazonaws.com/2015-03-31/functions/${encodeURIComponent(name)}/invocations?Qualifier=${encodeURIComponent(qual)}`,
  };
}

/**
 * Invokes a function integration.
 *
 * @param {object} ctx
 * @param {object} integration - (`function`: `{provider, functionArn|url, qualifier}`, `payload_format_version`).
 * @param {{ body?: Uint8Array | string | null, isBase64Encoded?: boolean, renderedTemplate?: string | null }} [outbound={}]
 * @param {object} ports - (`fetch`, `secrets`).
 * @param {{ fetchFn?: Function, nowSec?: number }} [deps={}]
 */
export async function invokeFunction(ctx, integration, outbound = {}, ports, deps = {}) {
  const started = Date.now();
  const fn = integration.function ?? {};
  const provider = fn.provider ?? "webhook";
  const protocol = ctx.artifact?.protocol ?? ctx.protocol ?? "REST";
  const payloadVersion = integration.payload_format_version
    ?? (protocol === "HTTP" ? "2.0" : "1.0");
  const timeoutMs = integration.timeout_ms ?? (protocol === "HTTP" ? 30000 : 29000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("integration-timeout")), timeoutMs);
  ctx.signal?.addEventListener?.("abort", () => controller.abort(new Error("client-abort")), { once: true });

  try {
    const event = protocol === "HTTP"
      ? buildHttpEvent(ctx, { version: payloadVersion, body: outbound.body ?? null, isBase64Encoded: outbound.isBase64Encoded ?? false })
      : buildRestEvent(ctx, { body: outbound.body ?? null, isBase64Encoded: outbound.isBase64Encoded ?? false });
    const fetchFn = deps.fetchFn ?? ports.fetch ?? globalThis.fetch;

    if (provider === "webhook") {
      if (!fn.url) throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
      const bodyText = outbound.renderedTemplate ?? JSON.stringify(event);
      let secretValue = "";
      if (fn.secretRef && ports.secrets) {
        const resolved = await ports.secrets.resolve(fn.secretRef);
        const value = resolved?.value ?? resolved;
        secretValue = String(value?.value ?? value?.token ?? (typeof value === "string" ? value : ""));
      }
      const headers = { "content-type": "application/json" };
      if (secretValue) headers["x-pods-signature"] = signWebhookBody(secretValue, bodyText, deps.nowSec);
      const response = await fetchFn(fn.url, {
        method: "POST",
        headers,
        body: bodyText,
        signal: controller.signal,
        // Never follow redirects (adapter contract §3.3): a 3xx from the
        // webhook host is a function error, not a new destination.
        redirect: "manual",
      });
      const text = await response.text();
      if (!response.ok) {
        throw Object.assign(new GatewayError("DEFAULT_5XX", "Internal server error", { reason: "function-error" }), {
          functionError: { errorMessage: text.slice(0, 4096) },
        });
      }
      const parsed = payloadVersion === "2.0" ? parseProxyResponse20(text) : parseProxyResponse10(text);
      return { ...parsed, latencyMs: Date.now() - started };
    }

    if (provider === "aws_lambda") {
      if (!fn.functionArn) throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
      const { region, url } = lambdaInvokeUrl(fn.functionArn, fn.qualifier);
      const credentials = fn.credentialsRef && ports.secrets
        ? await ports.secrets.resolve(fn.credentialsRef)
        : null;
      const creds = credentials?.value ?? {};
      // Custom (non-proxy) FUNCTION integrations send the S06 rendered
      // template output; proxy integrations always send the proxy event.
      const payload = outbound.renderedTemplate ?? JSON.stringify(event);
      const signed = await signRequest({
        method: "POST",
        url,
        headers: { "content-type": "application/json", "x-amz-invocation-type": "RequestResponse" },
        body: payload,
        service: "lambda",
        region,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      });
      const response = await fetchFn(signed.url, {
        method: "POST",
        headers: signed.headers,
        body: payload,
        signal: controller.signal,
        redirect: "manual",
      });
      const text = await response.text();
      if (response.headers?.get?.("x-amz-function-error") || !response.ok) {
        throw Object.assign(new GatewayError("DEFAULT_5XX", "Internal server error", { reason: "function-error" }), {
          functionError: safeJson(text),
        });
      }
      const parsed = payloadVersion === "2.0" && protocol === "HTTP"
        ? parseProxyResponse20(text)
        : parseProxyResponse10(text);
      return { ...parsed, latencyMs: Date.now() - started };
    }

    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error", { reason: "unknown-function-provider" });
  } catch (error) {
    if (error instanceof GatewayError && error.type === "DEFAULT_5XX" && error.extra?.reason === "function-error") throw error;
    if (error instanceof GatewayError) throw error;
    const message = String(error?.message ?? error);
    if (message === "integration-timeout" || error?.name === "AbortError") {
      throw new GatewayError("INTEGRATION_TIMEOUT", "Endpoint request timed out");
    }
    throw new GatewayError("INTEGRATION_FAILURE", "Internal server error");
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { errorMessage: String(text).slice(0, 4096) };
  }
}
