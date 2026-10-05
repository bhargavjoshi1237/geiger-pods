/**
 * `integrationResponse` phase (pipeline row 18 — selection pattern,
 * mappings, templates).
 *
 * S06W implementation (replaces the S01 no-op stub, keeping the `name` +
 * `run(ctx)` contract). Transforms `ctx.integrationResult` (set by `invoke`)
 * into `ctx.s06result` (`{ status, headers, body, contentType }`) for the
 * `methodResponse` phase. Returns `undefined` always — the final `Response`
 * is built downstream so compression and managed CORS apply uniformly.
 *
 * - HTTP APIs: per-status response mapping (`responseMappings`, else the
 *   global `artifact.httpMappings.responses`); `overwrite:statuscode` may
 *   rewrite the status. Bodies pass through byte-identical (no templates on
 *   HTTP APIs).
 * - REST: select the integration response (status regex for HTTP
 *   integrations, `errorMessage` regex for FUNCTION/AWS errors, rendered
 *   `statusCode` for MOCK; default response fallback; no default → 500
 *   `API_CONFIGURATION_ERROR`). The selected status must declare a
 *   `method_responses` row (compile enforces; re-checked defensively).
 *   Apply response parameters, then the response template chosen by `Accept`
 *   (`application/json` preferred, else first, else passthrough);
 *   `$context.responseOverride.*` wins last. Binary conversion follows the
 *   selected response's `content_handling` with binary-ness from `Accept`.
 * - MOCK without integration responses keeps S04 parity: the request-template
 *   payload renders as the JSON body.
 *
 * @module lib/gateway/core/phases/integration-response
 */

import { GatewayError } from "../errors.mjs";
import { convertResponseBody } from "../processing/content.mjs";
import {
  applyHttpResponseMapping,
  applyRestResponseMapping,
} from "../processing/param-mapping.mjs";
import {
  gatewayErrorResponse,
  renderVtl,
} from "../processing/runtime.mjs";
import {
  applyResponseOverrides,
  selectIntegrationResponse,
  selectMockStatus,
  selectResponseTemplate,
} from "../processing/responses.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "integrationResponse";

/**
 * Transforms the integration result into the method-response input.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<Response|undefined>} Error response, or `undefined`.
 */
export async function run(ctx) {
  if (!ctx?.s06?.built || !ctx?.integrationResult) return undefined;
  try {
    if (ctx.s06.kind === "http") {
      ctx.s06result = applyHttpResult(ctx);
    } else {
      ctx.s06result = await applyRestResult(ctx);
    }
  } catch (error) {
    if (error instanceof GatewayError) return gatewayErrorResponse(ctx, error);
    throw error;
  }
  return undefined;
}

/**
 * HTTP-API result: per-status response mapping over the backend result.
 *
 * @param {object} ctx
 * @returns {{ status: number, headers: Headers, body: Uint8Array|null, contentType: string|null }}
 */
function applyHttpResult(ctx) {
  const artifact = ctx.artifact ?? {};
  const result = ctx.integrationResult;
  const integration = ctx.methodConfig?.integration ?? {};
  const tables = integration.responseMappings ?? integration.response_mappings
    ?? artifact.httpMappings?.responses ?? {};
  const backendHeaders = {};
  try {
    for (const [name, value] of result.headers?.entries?.() ?? []) backendHeaders[name] = value;
  } catch {
    // Treat unreadable backend headers as absent.
  }
  let backendText = "";
  try {
    backendText = result.body ? Buffer.from(result.body).toString("utf8") : "";
  } catch {
    backendText = "";
  }
  const mapped = applyHttpResponseMapping(
    { statusCode: result.status ?? 200, headers: backendHeaders },
    tables,
    {
      request: {
        headers: ctx.methodRequest?.headers ?? {},
        query: ctx.methodRequest?.querystring ?? {},
        path: "",
        pathParams: ctx.pathParams ?? {},
        bodyText: "",
      },
      response: { headers: backendHeaders, bodyText: backendText },
      context: ctx.context,
      stageVariables: ctx.stageVariables ?? {},
    },
  );
  const headers = new Headers();
  for (const [name, value] of Object.entries(mapped.headers ?? {})) {
    try {
      headers.set(name, String(value));
    } catch {
      // Skip headers with illegal values; the backend value is preserved below.
    }
  }
  // Preserve backend headers the mapping did not touch.
  for (const [name, value] of Object.entries(backendHeaders)) {
    if (!headers.has(name)) {
      try {
        headers.set(name, value);
      } catch {
        // Skip unsettable backend headers.
      }
    }
  }
  return {
    status: mapped.statusCode,
    headers,
    body: result.body && result.body.byteLength > 0 ? result.body : null,
    contentType: headers.get("content-type"),
  };
}

/**
 * REST result: integration-response selection, parameter mapping, response
 * template, overrides and binary conversion.
 *
 * @param {object} ctx
 * @returns {Promise<{ status: number, headers: Headers, body: Uint8Array|null, contentType: string|null }>}
 */
async function applyRestResult(ctx) {
  const artifact = ctx.artifact ?? {};
  const result = ctx.integrationResult;
  const target = ctx.methodConfig ?? {};
  const type = target.integration?.type;
  const responses = ctx.s06.integrationResponses ?? [];
  const binaryMediaTypes = artifact.settings?.binaryMediaTypes ?? [];
  let accept = null;
  try {
    accept = ctx.request.headers.get("accept");
  } catch {
    accept = null;
  }

  // MOCK with no integration responses: S04 parity (render the payload).
  if (type === "MOCK" && responses.length === 0) {
    return mockPassthrough(result);
  }

  // No integration responses configured (plain proxy): pass the backend
  // result through byte-identical (status/headers/body preserved).
  if (responses.length === 0) {
    const headers = new Headers();
    try {
      for (const [name, value] of result.headers?.entries?.() ?? []) headers.set(name, value);
    } catch {
      // Treat unreadable backend headers as absent.
    }
    return {
      status: result.status ?? 200,
      headers,
      body: result.body && result.body.byteLength > 0 ? result.body : null,
      contentType: contentTypeOf(headers),
    };
  }

  const outcome = selectionOutcome(type, result, ctx.outbound?.renderedTemplate ?? null);
  const selected = selectIntegrationResponse(responses, outcome);
  if (!selected) {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  }
  const declared = new Set((ctx.s06.methodResponses ?? []).map((entry) => String(entry?.statusCode)));
  if (!declared.has(String(selected.statusCode))) {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  }

  const backendHeaders = {};
  try {
    for (const [name, value] of result.headers?.entries?.() ?? []) backendHeaders[name] = value;
  } catch {
    // Treat unreadable backend headers as absent.
  }
  const backendText = backendBodyText(type, result, ctx.outbound?.renderedTemplate ?? null);
  const mappedHeaders = applyRestResponseMapping(selected.responseParameters ?? {}, {
    integrationResponse: { headers: backendHeaders },
    bodyText: backendText,
    context: ctx.context,
    stageVariables: ctx.stageVariables ?? {},
  });

  const templates = selected.responseTemplates ?? {};
  const picked = selectResponseTemplate(templates, accept);
  let body = new TextEncoder().encode(backendText);
  let contentType = backendHeaders["content-type"] ?? backendHeaders["Content-Type"] ?? null;
  let templateContext = null;
  if (picked) {
    const data = {
      bodyText: backendText,
      headers: backendHeaders,
      querystring: {},
      pathParams: { ...(ctx.pathParams ?? {}) },
      context: ctx.context,
      stageVariables: ctx.stageVariables ?? {},
    };
    try {
      const rendered = renderVtl(artifact, picked.template, data);
      body = new TextEncoder().encode(rendered.output);
      contentType = picked.contentType;
      templateContext = rendered.context;
    } catch {
      throw new GatewayError("DEFAULT_5XX", "Internal server error");
    }
  }
  let status = Number.parseInt(String(selected.statusCode), 10);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  }
  const headers = new Headers();
  for (const [headerName, value] of Object.entries(mappedHeaders ?? {})) {
    try {
      headers.set(headerName, String(value));
    } catch {
      // Skip unsettable mapped headers.
    }
  }
  if (templateContext) {
    // `applyResponseOverrides` merges base headers with the template's
    // `responseOverride.header.*` (override wins); rebuild from the merge.
    const overridden = applyResponseOverrides({ statusCode: status, headers: Object.fromEntries(headers.entries()) }, templateContext);
    status = overridden.statusCode;
    const next = new Headers();
    for (const [headerName, value] of Object.entries(overridden.headers ?? {})) {
      try {
        next.set(headerName, String(value));
      } catch {
        // Skip unsettable override headers.
      }
    }
    return finishRestResult(ctx, { status, headers: next, convertedBody: body, contentType, binaryMediaTypes, accept, selected });
  }

  return finishRestResult(ctx, { status, headers, convertedBody: body, contentType, binaryMediaTypes, accept, selected });

  const converted = convertResponseBody({
    body,
    contentType,
    acceptHeader: accept,
    contentHandling: selected.contentHandling ?? selected.content_handling ?? null,
    binaryMediaTypes,
    isBase64Encoded: false,
  });
  return finishRestResult(ctx, {
    status, headers, convertedBody: converted.bytes, contentType,
  });
}

/**
 * Attaches the content-type header and normalizes empty bodies.
 *
 * @param {object} ctx
 * @param {{ status: number, headers: Headers, convertedBody: Uint8Array, contentType: string|null }} result
 * @returns {{ status: number, headers: Headers, body: Uint8Array|null, contentType: string|null }}
 */
function finishRestResult(ctx, { status, headers, convertedBody, contentType }) {
  void ctx;
  if (contentType && !headers.has("content-type")) {
    try {
      headers.set("content-type", contentType);
    } catch {
      // Leave the header unset when illegal.
    }
  }
  const empty = convertedBody.byteLength === 0 || statusBodyEmpty(status);
  return {
    status,
    headers,
    body: empty ? null : convertedBody,
    contentType,
  };
}

/**
 * Builds the selection probe for an integration result.
 *
 * @param {string} type - Integration type.
 * @param {object} result - Dispatcher result.
 * @param {string|null} renderedTemplate - MOCK request-template output.
 * @returns {object} `selectIntegrationResponse` outcome.
 */
function selectionOutcome(type, result, renderedTemplate) {
  if (type === "MOCK") {
    return {
      integrationType: "MOCK",
      mockStatusCode: selectMockStatus(renderedTemplate) ?? result.status ?? 200,
    };
  }
  const errorMessage = result?.functionError?.errorMessage ?? null;
  return {
    backendStatus: result?.status ?? "",
    errorMessage,
    integrationType: type,
  };
}

/**
 * Backend body text the response mapping/template sees: the rendered MOCK
 * template output for MOCK integrations, else the raw bytes as UTF-8.
 *
 * @param {string} type
 * @param {object} result
 * @param {string|null} renderedTemplate
 * @returns {string}
 */
function backendBodyText(type, result, renderedTemplate) {
  if (type === "MOCK") {
    if (renderedTemplate !== null && renderedTemplate !== undefined) return String(renderedTemplate);
    if (result?.mockPayload !== undefined && result?.mockPayload !== null) {
      return typeof result.mockPayload === "string" ? result.mockPayload : JSON.stringify(result.mockPayload);
    }
    return "";
  }
  try {
    return result?.body ? Buffer.from(result.body).toString("utf8") : "";
  } catch {
    return "";
  }
}

/**
 * S04 parity for MOCK integrations without integration responses: render
 * the request-template payload (or empty 200).
 *
 * @param {object} result - Dispatcher result.
 * @returns {{ status: number, headers: Headers, body: Uint8Array|null, contentType: string|null }}
 */
function mockPassthrough(result) {
  const headers = new Headers();
  const payload = result?.mockPayload ?? null;
  if ((result?.body && result.body.byteLength > 0)) {
    return { status: result.status ?? 200, headers: result.headers ?? headers, body: result.body, contentType: null };
  }
  if (payload === null || payload === undefined) {
    return { status: result?.status ?? 200, headers, body: null, contentType: null };
  }
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  headers.set("content-type", "application/json");
  return {
    status: result?.status ?? 200,
    headers,
    body: new TextEncoder().encode(text),
    contentType: "application/json",
  };
}

/**
 * True for statuses that must not carry a body.
 *
 * @param {number} status
 * @returns {boolean}
 */
function statusBodyEmpty(status) {
  return status === 204 || status === 304;
}

/**
 * Reads the content type from already-collected headers (case-insensitive).
 *
 * @param {Headers} headers
 * @returns {string|null}
 */
function contentTypeOf(headers) {
  try {
    return headers.get("content-type");
  } catch {
    return null;
  }
}
