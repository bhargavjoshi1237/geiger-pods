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
