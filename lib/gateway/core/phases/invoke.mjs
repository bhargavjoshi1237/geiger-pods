/**
 * `invoke` phase (pipeline row 17 — integration adapter with timeout, streaming option).
 *
 * S04 owns the adapter dispatch (`lib/gateway/core/integrations/`); S09 owns
 * streaming transfer. Contract: S06 sets `ctx.integrationConfig` (the
 * integration) and `ctx.outbound` (method/url/headers/body built by
 * `integrationRequest`). S05 adds a proxy fallback so the first working
 * gateway runs without S06: when `integrationConfig`/`outbound` are absent,
 * the phase resolves the integration from the matched route/method in the
 * artifact and builds the outbound request directly from the client request
 * (method/path/query/headers/body, stage-variable substitution in the URI).
 * On success the adapter result lands on `ctx.integrationResult` for S06's
 * `integrationResponse`/`methodResponse` phases; when those phases are still
 * stubs, this phase returns the backend response directly.
 * S04 §3.6 wire statuses that refine the S01 catalog (HTTP 503/500, REST 502)
 * are rendered here directly; other gateway errors rethrow for the pipeline
 * renderer.
 *
 * @module lib/gateway/core/phases/invoke
 */

import { statusFor } from "../gateway-responses.mjs";
import { invoke } from "../integrations/index.mjs";
import { maybeAppendDefaultPath, renderIntegrationUri } from "../integrations/uri.mjs";
import { invokeHttpStream, parseLambdaStreamPrelude, streamingLimits } from "../release/streaming.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "invoke";

/**
 * Finds the integration id for the current match in an S05 artifact.
 *
 * @param {object} artifact
 * @param {object} match
 * @returns {string|null}
 */
function integrationIdForMatch(artifact, match) {
  if (!match) return null;
  if (match.routeId) {
    const routes = artifact.routes ?? artifact.httpRoutes ?? [];
    const found = routes.find((route) => String(route.id) === String(match.routeId));
    if (found) return found.integrationId ?? found.integration_id ?? null;
    return null;
  }
  const methodId = match.methodId ?? null;
  if (methodId) {
    const flat = artifact.restMethods ?? [];
    const direct = flat.find((entry) => String(entry.id) === String(methodId));
    if (direct && (direct.integrationId ?? direct.integration_id)) {
      return direct.integrationId ?? direct.integration_id;
    }
    for (const resource of artifact.resources ?? []) {
      for (const method of Object.values(resource.methods ?? {})) {
        if (String(method?.id) === String(methodId)) return method.integrationId ?? null;
      }
    }
  }
  return null;
}

/**
 * Parses greedy parameter names from a route key or resource path.
 *
 * @param {string} pattern
 * @returns {Set<string>}
 */
function greedyNames(pattern) {
  const out = new Set();
  for (const match of String(pattern ?? "").matchAll(/\{([A-Za-z0-9_-]+)\+\}/g)) {
    out.add(match[1]);
  }
  return out;
}

/**
 * Builds a proxy outbound request directly from the client request (S05
 * fallback when S06 `integrationRequest` has not run).
 *
 * @param {object} ctx
 * @returns {Promise<{ method: string, url: null, headers: Headers, body: Uint8Array|null, queryString: string }>}
 */
async function buildProxyOutbound(ctx) {
  const request = ctx.request;
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  let body = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > 0) body = new Uint8Array(buffer);
    } catch {
      body = null;
    }
  }
  return {
    method: request.method,
    url: null,
    headers,
    body,
    queryString: url.search ? url.search.slice(1) : "",
  };
}

/**
 * Runs the integration adapter for the matched integration.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<Response | undefined>}
 */
export async function run(ctx) {
  const integration = ctx?.integrationConfig;
  if (integration && ctx?.outbound) {
    const streamed = await maybeStream(ctx, integration, ctx.outbound);
    if (streamed) return streamed;
    try {
      ctx.integrationResult = await invoke(ctx, integration, ctx.outbound, ctx.ports ?? {});
      // S06W: when the S06 `integrationRequest` phase built the outbound
      // request, the S06 `integrationResponse`/`methodResponse` phases own
      // rendering — store the result and continue the pipeline. Otherwise
      // (pre-S06 callers that set these fields directly) keep the S05
      // behavior of returning the backend response here.
      if (ctx?.s06?.built) return undefined;
      return finalize(ctx, ctx.integrationResult);
    } catch (error) {
      return renderRefined(ctx, error);
    }
  }
  // S05 proxy fallback (no S06): resolve the integration from the artifact.
  if (!integration && !ctx?.outbound && ctx?.match && ctx?.artifact) {
    const artifact = ctx.artifact;
    const integrationId = integrationIdForMatch(artifact, ctx.match);
    if (!integrationId) return undefined;
    const integrations = artifact.integrations ?? {};
    const config = integrations[integrationId] ?? integrations[String(integrationId)];
    if (!config) return undefined;
    if (config.type !== "HTTP_PROXY" && config.type !== "HTTP" && config.type !== "MOCK") return undefined;
    // Expose path params + greedy flags + stage variables for URI rendering.
    ctx.pathParams = { ...(ctx.pathParameters ?? {}) };
    ctx.pathParameters = ctx.pathParameters ?? {};
    const routeKey = ctx.context?.routeKey ?? ctx.match.routeKey ?? "";
    const resourcePath = ctx.context?.resourcePath ?? ctx.match.resourcePath ?? "";
    ctx.routeKey = routeKey;
    ctx.greedyParams = [...greedyNames(`${routeKey} ${resourcePath}`)];
    ctx.stageVariables = ctx.stageVariables ?? artifact.stageVariables ?? {};
    // Normalize the engine integration shape (artifact uses camelCase).
    // F4: production ignores the loopback escape hatch entirely.
    const engineIntegration = {
      type: config.type,
      uri: config.uri,
      integration_method: config.integrationMethod ?? config.integration_method ?? "ANY",
      timeout_ms: config.timeoutMs ?? config.timeout_ms ?? 29000,
      tls: config.tls ?? null,
      connection_type: config.connectionType ?? config.connection_type ?? "INTERNET",
      connector_id: config.connectorId ?? config.connector_id ?? null,
      backend_auth: config.backendAuth ?? config.backend_auth ?? null,
      allowLoopback: process.env.NODE_ENV === "production"
        ? undefined
        : (config.allowLoopback ?? artifact.allowLoopback ?? undefined),
    };
    // Test escape hatch: loopback is allowed in runtime tests via env.
    // F4: production never honors it.
    if (process.env.NODE_ENV !== "production" && process.env.PODS_ALLOW_LOOPBACK === "1") engineIntegration.allowLoopback = true;
    const outbound = await buildProxyOutbound(ctx);
    try {
      const result = await invoke(ctx, engineIntegration, outbound, ctx.ports ?? {});
      ctx.integrationConfig = engineIntegration;
      ctx.outbound = outbound;
      ctx.integrationResult = result;
      return finalize(ctx, result);
    } catch (error) {
      return renderRefined(ctx, error);
    }
  }
  return undefined;
}

/**
 * `STREAM` transfer mode (S09 §3, owned by S09; S04 owns adapter dispatch).
 * Streams without buffering and short-circuits the pipeline even when S06
 * built the outbound request (STREAM is incompatible with response mapping
 * templates, compression and caching — compile rejects those combos).
 *
 * @param {object} ctx - Pipeline context.
 * @param {object} integration - Engine integration.
 * @param {object} outbound - Built outbound request.
 * @returns {Promise<Response|null>} Streaming response, or null when buffered.
 */
async function maybeStream(ctx, integration, outbound) {
  try {
    const artifact = ctx?.artifact ?? {};
    if ((artifact.protocol ?? "REST") !== "REST") return null;
    const declared = ctx?.methodConfig?.integration
      ?? artifact.integrations?.[ctx?.methodConfig?.integrationId ?? ""]
      ?? null;
    const mode = String(
      integration.response_transfer_mode
      ?? integration.responseTransferMode
      ?? declared?.responseTransferMode
      ?? declared?.response_transfer_mode
      ?? "BUFFERED",
    ).toUpperCase();
    if (mode !== "STREAM") return null;
    const type = String(integration.type ?? declared?.type ?? "").toUpperCase();
    if (type !== "HTTP_PROXY" && type !== "FUNCTION_PROXY") return null;
    // S06 REST-proxy outbound carries `url: null` (rendered from the URI
    // template in the adapter); render here so STREAM works on that path.
    let url = outbound?.url ?? null;
    if (!url) {
      const template = integration.uri ?? declared?.uri ?? null;
      if (!template) return null;
      url = renderIntegrationUri(template, {
        pathParams: ctx.pathParams ?? {},
        greedyParams: ctx.greedyParams ?? [],
        stageVariables: ctx.stageVariables ?? {},
        requestPathParams: {},
      });
      url = maybeAppendDefaultPath(url, {
        protocol: ctx.artifact?.protocol ?? "REST",
        routeKey: ctx.routeKey,
        requestPath: ctx.requestPath ?? new URL(ctx.request.url).pathname,
        stage: ctx.artifact?.stage ?? ctx.stage,
        uriTemplate: template,
      });
      const query = outbound?.queryString ?? new URL(ctx.request.url).search.slice(1);
      if (query) url += (url.includes("?") ? "&" : "?") + query;
    }
    if (type === "HTTP_PROXY" && !url) return null;
    const ports = ctx?.ports ?? {};
    const timeoutMs = Number(integration.timeout_ms ?? 29000);
    const limits = streamingLimits({ artifact, integration: declared ?? integration, ctx });
    if (type === "FUNCTION_PROXY") {
      const streamed = await maybeStreamFunction(ctx, { url, outbound, ports, timeoutMs, limits });
      if (streamed) return streamed;
      return null;
    }
    const { response, latencyMs } = await invokeHttpStream(ctx, { url, method: outbound.method, headers: outbound.headers, body: outbound.body }, {
      ports,
      timeoutMs,
      idleMs: limits.idleMs,
      maxMs: limits.maxMs,
      cap: limits.cap,
    });
    ctx.streaming = true;
    ctx.integrationResult = { status: response.status, headers: response.headers, body: null, latencyMs, streamed: true };
    if (ctx?.context?.integration) {
      ctx.context.integration.status = String(response.status);
      ctx.context.integration.integrationStatus = String(response.status);
      ctx.context.integration.latency = String(latencyMs);
    }
    return response;
  } catch (error) {
    return renderRefined(ctx, error);
  }
}

/**
 * `FUNCTION_PROXY` streaming: webhook URLs stream with Lambda prelude
 * framing; `aws_lambda` needs `ports.lambdaStream` (tests inject it).
 *
 * @param {object} ctx
 * @param {{ url: string|null, outbound: object, ports: object, timeoutMs: number, limits: object }} options
 * @returns {Promise<Response|null>}
 */
async function maybeStreamFunction(ctx, { url, outbound, ports, timeoutMs, limits }) {
  const fn = ctx?.methodConfig?.integration?.function ?? ctx?.integrationConfig?.function ?? null;
  if (fn?.provider === "webhook" && (fn.url ?? url)) {
    const target = fn.url ?? url;
    const { response, latencyMs } = await invokeHttpStream(ctx, { url: target, method: "POST", headers: outbound?.headers, body: outbound?.body ?? null }, {
      ports,
      timeoutMs,
      idleMs: limits.idleMs,
      maxMs: limits.maxMs,
      cap: limits.cap,
    });
    // Webhook framing matches Lambda: prelude + 8 NUL + body. Parse the
    // prelude lazily: buffer until the delimiter, then stream the rest.
    const parsed = await withPrelude(ctx, response);
    ctx.streaming = true;
    ctx.integrationResult = { status: parsed.status, headers: parsed.headers, body: null, latencyMs, streamed: true };
    return parsed.response;
  }
  if (typeof ports.lambdaStream === "function") {
    const frames = await ports.lambdaStream(ctx, fn ?? {});
    const first = frames?.prelude ?? {};
    const headers = new Headers(first.headers ?? {});
    for (const cookie of first.cookies ?? []) {
      try {
        headers.append("set-cookie", cookie);
      } catch {
        // Skip illegal cookies.
      }
    }
    ctx.streaming = true;
    const body = frames?.body ?? null;
    const response = new Response(body, { status: first.statusCode ?? 200, headers });
    ctx.integrationResult = { status: response.status, headers, body: null, latencyMs: 0, streamed: true };
    return response;
  }
  return null;
}

/**
 * Buffers a webhook/Lambda stream just past the prelude delimiter, then
 * re-streams status/headers/body.
 *
 * @param {object} ctx
 * @param {Response} response
 * @returns {Promise<{ status: number, headers: Headers, response: Response }>}
 */
async function withPrelude(ctx, response) {
  void ctx;
  const reader = response.body?.getReader?.() ?? null;
  if (!reader) return { status: response.status, headers: response.headers, response };
  const chunks = [];
  let buffered = 0;
  let parsed = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      buffered += value.byteLength;
    }
    const joined = Buffer.concat(chunks.map((entry) => Buffer.from(entry)));
    if (joined.includes(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]))) {
      try {
        parsed = parseLambdaStreamPrelude(joined);
      } catch {
        parsed = null;
      }
      if (parsed) {
        const rest = parsed.body;
        const headers = new Headers(parsed.headers ?? {});
        const stream = new ReadableStream({
          start(controller) {
            if (rest.byteLength > 0) controller.enqueue(rest);
            const pump = () => reader.read().then(({ done: finished, value: next }) => {
              if (finished) {
                controller.close();
                return;
              }
              if (next) controller.enqueue(next);
              pump();
            }).catch((error) => {
              try {
                controller.error(error);
              } catch {
                try {
                  controller.close();
                } catch {
                  // Last resort.
                }
              }
            });
            pump();
          },
          cancel() {
            try {
              reader.cancel();
            } catch {
              // Best-effort.
            }
          },
        });
        try {
          reader.releaseLock();
        } catch {
          // Best-effort.
        }
        return { status: parsed.statusCode, headers, response: new Response(stream, { status: parsed.statusCode, headers }) };
      }
    }
    if (buffered > 1024 * 1024) break;
  }
  try {
    reader.releaseLock();
  } catch {
    // Best-effort.
  }
  return { status: response.status, headers: response.headers, response };
}

/**
 * When S06 response phases are still stubs, return the backend result
 * directly; otherwise leave it for `integrationResponse`/`methodResponse`.
 */
function finalize(ctx, result) {
  void ctx;
  if (!result) return undefined;
  const headers = new Headers(result.headers ?? {});
  if (!headers.has("content-type") && result.body && result.body.byteLength > 0) {
    headers.set("content-type", "application/json");
  }
  const body = result.body && result.body.byteLength > 0 ? result.body : null;
  // MOCK with a JSON payload and no body: render the payload (S04 parity).
  if ((body === null || body.byteLength === 0) && result.mockPayload !== undefined && result.mockPayload !== null) {
    const text = typeof result.mockPayload === "string" ? result.mockPayload : JSON.stringify(result.mockPayload);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(text, { status: result.status ?? 200, headers });
  }
  return new Response(body, { status: result.status ?? 200, headers });
}

/**
 * Renders per-protocol refined errors (HTTP 503/500, REST 502) directly;
 * rethrows everything else for the pipeline renderer.
 */
function renderRefined(ctx, error) {
  const refined = error && typeof error.type === "string" && typeof error.statusCode === "number"
    ? error
    : null;
  if (!refined) throw error;
  const protocol = ctx?.artifact?.protocol ?? "REST";
  if (protocol !== "HTTP" && refined.statusCode === statusFor(refined.type)) throw error;
  return new Response(JSON.stringify({ message: refined.message }), {
    status: refined.statusCode,
    headers: {
      "content-type": "application/json",
      "x-pods-error-type": refined.type,
    },
  });
}
