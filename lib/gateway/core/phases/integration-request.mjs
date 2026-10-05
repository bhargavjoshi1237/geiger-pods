/**
 * `integrationRequest` phase (pipeline row 16 — param mapping, template,
 * content handling).
 *
 * S06W implementation (replaces the S01 no-op stub, keeping the `name` +
 * `run(ctx)` contract). Builds `ctx.integrationConfig` (engine integration
 * for the S04 dispatcher) and `ctx.outbound` (method/url/headers/body), then
 * returns `undefined` — the `invoke` phase consumes them and the
 * `integrationResponse`/`methodResponse` phases render the result.
 *
 * Per protocol/kind:
 * - Proxy integrations (`HTTP_PROXY`, and `FUNCTION_PROXY` for the body
 *   shape) ignore templates (AWS). `HTTP_PROXY` additionally receives the
 *   original (still content-encoded) body plus header; everything else gets
 *   the decompressed body (`ctx.decodedBody`, set by `validate`).
 * - HTTP APIs: AWS parameter-mapping grammar (`requestMapping` per
 *   integration, else the global `artifact.httpMappings.request`);
 *   remove → overwrite → append. No mapping templates.
 * - REST custom integrations: `integration.request.*` mapping (with
 *   `{param}` URI defaults), then the request template selected by
 *   Content-Type with passthrough behavior; `$context.requestOverride.*`
 *   wins last. Non-proxy integrations send only mapped parameters.
 * - MOCK: the rendered request template becomes `outbound.renderedTemplate`
 *   (its JSON `statusCode` selects the response downstream).
 * - FUNCTION (non-proxy) / AWS custom: rendered template output travels as
 *   `outbound.renderedTemplate`; the function event still carries the
 *   (binary-aware) body.
 * - Binary bodies convert per `integration.content_handling`; templates see
 *   the converted text (base64 for binary).
 *
 * Template/selection failures become 415/500 gateway responses (returned
 * directly, with customization + CORS applied).
 *
 * @module lib/gateway/core/phases/integration-request
 */

import { GatewayError } from "../errors.mjs";
import { isBinaryContent, convertRequestBody } from "../processing/content.mjs";
import {
  applyHttpRequestMapping,
  applyRestRequestMapping,
  defaultPathMappings,
} from "../processing/param-mapping.mjs";
import {
  gatewayErrorResponse,
  readRequestBody,
  renderVtl,
  resolveTarget,
  snapshotMethodRequest,
} from "../processing/runtime.mjs";
import {
  applyRequestOverrides,
  selectRequestTemplate,
} from "../processing/responses.mjs";
import { renderIntegrationUri } from "../integrations/uri.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "integrationRequest";

/**
 * Parses greedy parameter names (`{name+}`) from a route key/resource path.
 *
 * @param {string} pattern
 * @returns {Array<string>}
 */
function greedyNames(pattern) {
  const out = [];
  for (const match of String(pattern ?? "").matchAll(/\{([A-Za-z0-9_-]+)\+\}/g)) {
    if (!out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

/**
 * Normalizes an artifact integration into the engine shape the S04
 * dispatcher consumes (same fields as the S05 invoke fallback, plus
 * function/aws/payload versions for non-HTTP integrations).
 *
 * @param {object} config - Artifact integration.
 * @param {object} artifact
 * @returns {object} Engine integration.
 */
function engineIntegrationFor(config, artifact) {
  const engine = {
    type: config.type,
    uri: config.uri,
    integration_method: config.integrationMethod ?? config.integration_method ?? "ANY",
    timeout_ms: config.timeoutMs ?? config.timeout_ms ?? 29000,
    tls: config.tls ?? null,
    connection_type: config.connectionType ?? config.connection_type ?? "INTERNET",
    connector_id: config.connectorId ?? config.connector_id ?? null,
    backend_auth: config.backendAuth ?? config.backend_auth ?? null,
    function: config.function ?? null,
    aws: config.aws ?? null,
    payload_format_version: config.payloadFormatVersion ?? config.payload_format_version ?? null,
    // S04 dispatcher snake_case aliases (function custom-response selection).
    integration_responses: config.integrationResponses ?? config.integration_responses ?? [],
    // F4: production ignores the loopback escape hatch entirely.
    allowLoopback: process.env.NODE_ENV === "production"
      ? undefined
      : (config.allowLoopback ?? artifact?.allowLoopback ?? undefined),
  };
  if (process.env.NODE_ENV !== "production" && process.env.PODS_ALLOW_LOOPBACK === "1") engine.allowLoopback = true;
  return engine;
}

/**
 * Renders a VTL request template for `contentType`, honoring passthrough
 * behavior. Returns `{ output, templateContext }` or `{ passthrough: true }`.
 *
 * @param {object} artifact
 * @param {Record<string,string>} templates
 * @param {string|null} contentType
 * @param {string} passthroughBehavior
 * @param {object} data - Template request data.
 * @returns {Promise<{ output: string, templateContext: object }|{ passthrough: true }>}
 * @throws {GatewayError} 415/500 per spec §§5-6.
 */
async function renderRequestTemplate(artifact, templates, contentType, passthroughBehavior, data) {
  let selected;
  try {
    selected = selectRequestTemplate(templates ?? {}, contentType, passthroughBehavior);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  }
  if (selected.passthrough) return { passthrough: true };
  try {
    const { output, context } = renderVtl(artifact, selected.template, data);
    return { output, contentType: selected.contentType, templateContext: context };
  } catch {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  }
}

/**
 * Builds the outbound request for the matched integration.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<Response|undefined>} Error response, or `undefined`.
 */
export async function run(ctx) {
  const artifact = ctx?.artifact ?? {};
  const target = resolveTarget(ctx);
  if (!target) return undefined;
  const { kind, integration } = target;

  ctx.methodRequest = snapshotMethodRequest(ctx);
  ctx.pathParams = { ...(ctx.pathParameters ?? {}) };
  const routeKey = kind === "http"
    ? (ctx.match?.routeKey ?? ctx.context?.routeKey ?? "")
    : (ctx.context?.routeKey ?? ctx.match?.resourcePath ?? "");
  ctx.routeKey = routeKey;
  ctx.resourcePath = ctx.context?.resourcePath ?? "";
  ctx.greedyParams = greedyNames(`${routeKey} ${ctx.context?.resourcePath ?? ""}`);
  ctx.stageVariables = ctx.stageVariables ?? artifact.stageVariables ?? {};

  const raw = ctx.rawBody instanceof Uint8Array ? ctx.rawBody : await readRequestBody(ctx);
  const decoded = ctx.decodedBody instanceof Uint8Array ? ctx.decodedBody : raw;
  let contentType = null;
  try {
    contentType = ctx.request.headers.get("content-type");
  } catch {
    contentType = null;
  }
  const binaryMediaTypes = artifact.settings?.binaryMediaTypes ?? [];
  const contentHandling = integration.contentHandling ?? integration.content_handling ?? null;
  const type = integration.type;

  ctx.integrationConfig = engineIntegrationFor(integration, artifact);
  ctx.methodConfig = target;

  try {
    if (kind === "http") {
      ctx.outbound = buildHttpOutbound(ctx, {
        artifact, integration, raw, routeKey, contentType,
      });
    } else if (type === "HTTP_PROXY") {
      // REST proxy: original encoded bytes, client headers/query, no mapping.
      const url = new URL(ctx.request.url);
      ctx.outbound = {
        method: ctx.request.method,
        url: null,
        headers: new Headers(ctx.request.headers),
        body: raw.byteLength > 0 ? raw : null,
        queryString: url.search ? url.search.slice(1) : "",
      };
    } else if (type === "MOCK") {
      ctx.outbound = await buildMockOutbound(ctx, {
        artifact, integration, decoded, contentType, binaryMediaTypes, contentHandling,
      });
    } else if (type === "FUNCTION_PROXY") {
      const binary = isBinaryContent(contentType, binaryMediaTypes);
      ctx.outbound = {
        body: decoded.byteLength > 0 ? decoded : null,
        isBase64Encoded: binary,
      };
    } else {
      // REST custom: HTTP / FUNCTION (non-proxy) / AWS_SERVICE.
      ctx.outbound = await buildRestCustomOutbound(ctx, {
        artifact, integration, decoded, contentType, binaryMediaTypes, contentHandling, type,
      });
    }
  } catch (error) {
    if (error instanceof GatewayError) return gatewayErrorResponse(ctx, error);
    throw error;
  }
  ctx.s06 = {
    built: true,
    kind,
    methodResponses: target.methodResponses,
    integrationResponses: target.integrationResponses,
  };
  return undefined;
}

/**
 * HTTP-API outbound: passthrough base + AWS parameter mapping.
 *
 * @param {object} ctx
 * @param {object} opts
 * @returns {{ method: string, url: string|null, headers: Headers, body: Uint8Array|null, queryString: string }}
 */
function buildHttpOutbound(ctx, { artifact, integration, raw, routeKey, contentType }) {
  const url = new URL(ctx.request.url);
  const mapping = integration.requestMapping ?? integration.request_mapping
    ?? artifact.httpMappings?.request ?? null;
  const base = {
    headers: Object.fromEntries(ctx.request.headers.entries()),
    query: Object.fromEntries(url.searchParams.entries()),
    path: ctx.requestPath ?? url.pathname,
  };
  const data = {
    request: {
      headers: base.headers,
      query: base.query,
      path: base.path,
      pathParams: ctx.pathParams,
      bodyText: Buffer.from(ctx.decodedBody ?? raw).toString("utf8"),
    },
    context: ctx.context,
    stageVariables: ctx.stageVariables,
  };
  if (!mapping || Object.keys(mapping).length === 0) {
    return {
      method: ctx.request.method,
      url: null,
      headers: new Headers(ctx.request.headers),
      body: raw.byteLength > 0 ? raw : null,
      queryString: url.search ? url.search.slice(1) : "",
    };
  }
  const mapped = applyHttpRequestMapping(base, mapping, data);
  // Pre-render the integration URL so `overwrite:path` has an effect; the
  // adapter still appends `$default`/query handling on top.
  let rendered = renderIntegrationUri(integration.uri, {
    pathParams: ctx.pathParams,
    greedyParams: ctx.greedyParams,
    stageVariables: ctx.stageVariables,
    requestPathParams: {},
  });
  if (mapped.path && mapped.path !== base.path) {
    const parsed = new URL(rendered);
    parsed.pathname = mapped.path.startsWith("/") ? mapped.path : `/${mapped.path}`;
    rendered = parsed.toString();
  }
  return {
    method: ctx.request.method,
    url: rendered,
    headers: new Headers(Object.entries(mapped.headers)),
    body: raw.byteLength > 0 ? raw : null,
    queryString: new URLSearchParams(mapped.query).toString(),
  };
}

/**
 * Template request data shared by REST custom/MOCK/FUNCTION rendering.
 *
 * @param {object} ctx
 * @param {string} bodyText - Converted body text templates see.
 * @returns {object}
 */
function templateDataFor(ctx, bodyText) {
  return {
    bodyText,
    headers: { ...(ctx.methodRequest?.headers ?? {}) },
    querystring: { ...(ctx.methodRequest?.querystring ?? {}) },
    pathParams: { ...(ctx.methodRequest?.path ?? {}) },
    context: ctx.context,
    stageVariables: ctx.stageVariables ?? {},
  };
}

/**
 * MOCK outbound: the rendered request template (or passthrough).
 *
 * @param {object} ctx
 * @param {object} opts
 * @returns {Promise<{ renderedTemplate: string|null }>}
 */
async function buildMockOutbound(ctx, { artifact, integration, decoded, contentType }) {
  const templates = integration.requestTemplates ?? integration.request_templates ?? {};
  const passthrough = integration.passthroughBehavior ?? integration.passthrough_behavior ?? "WHEN_NO_MATCH";
  let bodyText = "";
  try {
    bodyText = Buffer.from(decoded).toString("utf8");
  } catch {
    bodyText = "";
  }
  const rendered = await renderRequestTemplate(
    artifact, templates, contentType, passthrough, templateDataFor(ctx, bodyText),
  );
  if (rendered.passthrough) return { renderedTemplate: null };
  return { renderedTemplate: rendered.output };
}

/**
 * REST custom outbound (HTTP / FUNCTION non-proxy / AWS_SERVICE): mapped
 * parameters only, template-rendered body, request overrides last.
 *
 * @param {object} ctx
 * @param {object} opts
 * @returns {Promise<{ method: string, url: string, headers: Headers, body: Uint8Array|null,
 *   queryString: string, renderedTemplate: string|null, isBase64Encoded: boolean }>}
 */
async function buildRestCustomOutbound(ctx, {
  artifact, integration, decoded, contentType, binaryMediaTypes, contentHandling, type,
}) {
  const converted = convertRequestBody({
    body: decoded, contentType, contentHandling, binaryMediaTypes,
  });
  const rawMapping = integration.requestParameters ?? integration.request_parameters ?? {};
  const uri = integration.uri ?? "";
  const mapping = { ...defaultPathMappings(uri, rawMapping), ...rawMapping };
  const mapped = applyRestRequestMapping(mapping, {
    methodRequest: {
      headers: ctx.methodRequest?.headers ?? {},
      querystring: ctx.methodRequest?.querystring ?? {},
      path: ctx.methodRequest?.path ?? {},
    },
    bodyText: converted.templateText,
    context: ctx.context,
    stageVariables: ctx.stageVariables ?? {},
  });

  const templates = integration.requestTemplates ?? integration.request_templates ?? {};
  const passthrough = integration.passthroughBehavior ?? integration.passthrough_behavior ?? "WHEN_NO_MATCH";
  const rendered = await renderRequestTemplate(
    artifact, templates, contentType, passthrough, templateDataFor(ctx, converted.templateText),
  );
  let headers = { ...mapped.headers };
  let query = { ...mapped.querystring };
  let pathParams = { ...ctx.pathParams, ...mapped.path };
  let body = converted.bytes;
  let renderedTemplate = null;
  let responseContentType = contentType;
  if (!rendered.passthrough) {
    const overridden = applyRequestOverrides(
      { headers, querystring: query, path: pathParams }, rendered.templateContext,
    );
    headers = overridden.headers;
    query = overridden.querystring;
    pathParams = overridden.path;
    body = new TextEncoder().encode(rendered.output);
    renderedTemplate = rendered.output;
    responseContentType = rendered.contentType ?? contentType;
    if (type === "HTTP" && rendered.contentType && !hasContentType(headers)) {
      headers["content-type"] = rendered.contentType;
    }
  } else if (type === "HTTP" && !hasContentType(headers) && contentType && body.byteLength > 0) {
    headers["content-type"] = contentType;
  }
  void responseContentType;

  let renderedUrl = null;
  if (type === "HTTP") {
    renderedUrl = renderIntegrationUri(uri, {
      pathParams,
      greedyParams: ctx.greedyParams,
      stageVariables: ctx.stageVariables,
      requestPathParams: {},
    });
  }
  return {
    method: type === "HTTP"
      ? String(integration.integrationMethod ?? integration.integration_method ?? ctx.request.method ?? "GET").toUpperCase()
      : ctx.request.method,
    url: renderedUrl,
    headers: new Headers(Object.entries(headers).map(([k, v]) => [k, String(v)])),
    body: body.byteLength > 0 ? body : null,
    queryString: new URLSearchParams(query).toString(),
    renderedTemplate,
    isBase64Encoded: isBinaryContent(contentType, binaryMediaTypes),
  };
}

/**
 * Case-insensitive content-type presence check on a plain header object.
 *
 * @param {Record<string,string>} headers
 * @returns {boolean}
 */
function hasContentType(headers) {
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "content-type");
}
