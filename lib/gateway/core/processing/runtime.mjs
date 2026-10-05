/**
 * Shared runtime helpers for the S06 pipeline phases (`cors`, `validate`,
 * `integrationRequest`, `integrationResponse`, `methodResponse`).
 *
 * The S06 pure modules (`processing/*`) know nothing about pipeline contexts
 * or artifacts; the phase files know nothing about each other's internals.
 * Everything they share lives here:
 *
 * - `resolveTarget(ctx)` — finds the matched method/route, its integration
 *   and the S06 request/response configuration in the compiled artifact.
 * - `readRequestBody(ctx)` — reads the client body once, caching the raw
 *   bytes on the context and replacing `ctx.request` with a re-readable
 *   clone so downstream phases/adapters can read it again.
 * - `snapshotMethodRequest(ctx)` — `{ headers, querystring, path }` view of
 *   the client request used by validation, mapping sources and
 *   `gatewayresponse.header.*` parameters.
 * - `gatewayErrorResponse(ctx, err)` — records `$context.error.*`, renders
 *   the (possibly customized) gateway response for a `GatewayError` and
 *   applies managed HTTP CORS headers.
 * - `validatorsFor(artifact)` — per-artifact cache of compiled draft-04
 *   model validators.
 * - `renderVtl(template, data)` — template rendering with a per-artifact
 *   AST cache (the pure `renderTemplate` re-parses on every call).
 *
 * Context fields this module reads/writes (see the S06W report):
 * `rawBody`, `decodedBody`, `methodRequest`, `routeKey`, `pathParams`,
 * `greedyParams`, `methodConfig`, `integrationConfig`, `outbound`, `s06`,
 * `integrationResult`, `s06result`.
 *
 * @module lib/gateway/core/processing/runtime
 */

import { GatewayError } from "../errors.mjs";
import {
  renderCustomGatewayResponse,
  renderGatewayError,
  resolveGatewayCustomization,
  statusFor,
} from "../gateway-responses.mjs";
import { applyCorsToResponse } from "./cors.mjs";
import { compileModelSchemas } from "./validation.mjs";
import { parseTemplate, renderTemplate } from "./templates/index.mjs";

/**
 * Finds the S06 configuration for the current match in an S05 artifact.
 *
 * @param {object} ctx - Pipeline context (`match`, `artifact`).
 * @returns {{ kind: "http"|"rest", method: object|null, route: object|null,
 *   integration: object|null, methodResponses: Array<object>,
 *   integrationResponses: Array<object> } | null} Null when no match or no
 *   integration is configured (the S05 invoke fallback or the pipeline
 *   fallback owns those requests).
 */
export function resolveTarget(ctx) {
  const artifact = ctx?.artifact ?? {};
  const match = ctx?.match ?? null;
  if (!match) return null;
  const protocol = artifact.protocol ?? "REST";
  const integrations = artifact.integrations ?? {};

  if (protocol === "HTTP") {
    if (!match.routeId) return null;
    const routes = artifact.routes ?? artifact.httpRoutes ?? [];
    const route = routes.find((entry) => String(entry?.id) === String(match.routeId)) ?? null;
    const integrationId = route?.integrationId ?? route?.integration_id ?? null;
    if (!integrationId) return null;
    const integration = integrations[integrationId] ?? integrations[String(integrationId)] ?? null;
    if (!integration) return null;
    return {
      kind: "http",
      method: null,
      route,
      integration,
      methodResponses: [],
      integrationResponses: [],
    };
  }

  if (protocol === "REST") {
    const methodId = match.methodId ?? null;
    if (!methodId) return null;
    let method = null;
    for (const resource of artifact.resources ?? []) {
      for (const entry of Object.values(resource?.methods ?? {})) {
        if (String(entry?.id) === String(methodId)) method = entry;
      }
    }
    if (!method) {
      const flat = artifact.restMethods ?? [];
      const row = flat.find((entry) => String(entry?.id) === String(methodId));
      if (row?.integrationId) {
        method = { id: row.id, integrationId: row.integrationId, methodResponses: [] };
      }
    }
    if (!method) return null;
    const integrationId = method.integrationId ?? method.integration_id ?? null;
    if (!integrationId) return null;
    const integration = integrations[integrationId] ?? integrations[String(integrationId)] ?? null;
    if (!integration) return null;
    return {
      kind: "rest",
      method,
      route: null,
      integration,
      methodResponses: method.methodResponses ?? method.method_responses ?? [],
      integrationResponses: integration.integrationResponses ?? integration.integration_responses ?? [],
    };
  }

  return null;
}

/**
 * Reads the client request body once; later calls return the cached bytes.
 * Replaces `ctx.request` with a clone carrying the same bytes so downstream
 * readers (`arrayBuffer()`) keep working.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<Uint8Array>} Raw request bytes (possibly empty).
 */
export async function readRequestBody(ctx) {
  if (ctx?.rawBody instanceof Uint8Array) return ctx.rawBody;
  let bytes = new Uint8Array(0);
  const request = ctx?.request;
  if (request && request.method !== "GET" && request.method !== "HEAD") {
    try {
      const buffer = await request.arrayBuffer();
      bytes = new Uint8Array(buffer);
    } catch {
      bytes = new Uint8Array(0);
    }
  }
  if (ctx) {
    ctx.rawBody = bytes;
    try {
      const headers = new Headers(request?.headers ?? {});
      const init = { method: request?.method ?? "GET", headers };
      if (bytes.byteLength > 0 && init.method !== "GET" && init.method !== "HEAD") {
        init.body = bytes;
        init.duplex = "half";
      }
      ctx.request = new Request(request?.url ?? "http://localhost/", init);
    } catch {
      // Keep the original request when cloning is impossible.
    }
  }
  return bytes;
}

/**
 * Builds the `{ headers, querystring, path }` method-request view:
 * headers as a plain object (original casing), multi-value query params
 * comma-joined, path params from the match phase.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {{ headers: Record<string,string>, querystring: Record<string,string>, path: Record<string,string> }}
 */
export function snapshotMethodRequest(ctx) {
  const headers = {};
  try {
    for (const [name, value] of ctx?.request?.headers?.entries?.() ?? []) {
      headers[name] = headers[name] === undefined ? value : `${headers[name]},${value}`;
    }
  } catch {
    // Ignore unreadable headers; validation treats them as absent.
  }
  const querystring = {};
  try {
    const url = new URL(ctx?.request?.url ?? "http://localhost/");
    for (const name of new Set([...url.searchParams.keys()])) {
      querystring[name] = url.searchParams.getAll(name).join(",");
    }
  } catch {
    // Ignore malformed URLs; validation treats params as absent.
  }
  if (ctx) ctx.methodRequest = { headers, querystring, path: { ...(ctx.pathParameters ?? {}) } };
  return ctx?.methodRequest;
}

/**
 * Renders a `GatewayError` as a `Response`, honoring gateway-response
 * customization (`artifact.gatewayResponses`, with `DEFAULT_4XX`/`DEFAULT_5XX`
 * fallback) and managed HTTP CORS headers. Records `$context.error.*`
 * (`message`, `responseType`, `validationErrorString`) first so custom
 * templates can read them. Non-gateway errors become 500
 * `API_CONFIGURATION_ERROR`. Refined per-protocol wire statuses carried on
 * the error (`err.statusCode`, see S04 §3.6) are preserved when the
 * customization does not override the status.
 *
 * @param {object} ctx - Pipeline context.
 * @param {unknown} err - Thrown value (usually `GatewayError`).
 * @returns {Promise<Response>}
 */
export async function gatewayErrorResponse(ctx, err) {
  const gateway = err instanceof GatewayError
    ? err
    : new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  const message = gateway.message;
  const validationErrorString = gateway.extra?.validationErrorString
    ?? ctx?.context?.error?.validationErrorString
    ?? "";
  if (ctx?.context) {
    ctx.context.error = {
      message,
      messageString: JSON.stringify(message),
      responseType: gateway.type,
      validationErrorString,
    };
  }
  const customizations = ctx?.artifact?.gatewayResponses ?? [];
  let accept = null;
  try {
    accept = ctx?.request?.headers?.get?.("accept") ?? null;
  } catch {
    accept = null;
  }
  const methodRequest = ctx?.methodRequest ?? snapshotMethodRequest(ctx);
  let response;
  try {
    response = await renderCustomGatewayResponse(
      { type: gateway.type, message, validationErrorString },
      ctx,
      customizations,
      { accept, methodRequest, stageVariables: ctx?.stageVariables ?? {} },
    );
  } catch {
    response = renderGatewayError({ type: gateway.type, message }, ctx);
  }
  const wireStatus = typeof gateway.statusCode === "number" ? gateway.statusCode : statusFor(gateway.type);
  const customization = resolveGatewayCustomization(gateway.type, customizations);
  const hasStatusOverride = customization?.status_code !== undefined && customization?.status_code !== null;
  if (!hasStatusOverride && response.status !== wireStatus) {
    const headers = new Headers(response.headers);
    response = new Response(response.body, { status: wireStatus, headers });
  }
  response = withManagedCors(ctx, response);
  return response;
}

/**
 * Applies managed HTTP CORS headers to a response (no-op for REST APIs,
 * missing configs and disallowed origins).
 *
 * @param {object} ctx - Pipeline context.
 * @param {Response} response
 * @returns {Response}
 */
export function withManagedCors(ctx, response) {
  try {
    const artifact = ctx?.artifact ?? {};
    if ((artifact.protocol ?? "REST") !== "HTTP") return response;
    const cors = artifact.settings?.cors ?? null;
    if (!cors) return response;
    return applyCorsToResponse(ctx.request, response, cors, { features: artifact.features ?? {} });
  } catch {
    return response;
  }
}

const validatorCache = new WeakMap();

/**
 * Returns compiled draft-04 model validators for an artifact, cached per
 * artifact object. Models come from `artifact.models` (`{ [name]:
 * { schema } }`); entries that fail to compile are absent from the map (the
 * deploy step rejects them, so absence at runtime is a 500).
 *
 * @param {object} artifact - Compiled deployment artifact.
 * @returns {Map<string, Function>}
 */
export function validatorsFor(artifact) {
  if (!artifact || typeof artifact !== "object") return new Map();
  const cached = validatorCache.get(artifact);
  if (cached) return cached;
  const models = Object.entries(artifact.models ?? {}).map(([name, entry]) => ({
    name,
    schema: entry?.schema ?? {},
  }));
  const { validators } = compileModelSchemas(models, { apiPublicId: artifact.apiPublicId ?? "unknown" });
  validatorCache.set(artifact, validators);
  return validators;
}

const templateAstCache = new WeakMap();

/**
 * Renders a VTL template, caching the parsed AST per artifact. Parse and
 * render failures propagate to the caller (request templates become 500
 * `API_CONFIGURATION_ERROR`, response templates 500 `DEFAULT_5XX`).
 *
 * @param {object|null} artifact - Compiled artifact (cache scope; uncached when null).
 * @param {string} template - Template source.
 * @param {object} data - `renderTemplate` request data.
 * @returns {{ output: string, context: object }}
 */
export function renderVtl(artifact, template, data) {
  let ast = null;
  if (artifact && typeof artifact === "object") {
    let table = templateAstCache.get(artifact);
    if (!table) {
      table = new Map();
      templateAstCache.set(artifact, table);
    }
    if (table.has(template)) {
      ast = table.get(template);
    } else {
      ast = parseTemplate(template);
      table.set(template, ast);
    }
  }
  return renderTemplate(ast ?? template, data);
}
