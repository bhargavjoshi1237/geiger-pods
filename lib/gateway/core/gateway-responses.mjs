/**
 * Gateway response catalog and renderer.
 *
 * Default status codes and messages mirror AWS. The default body is
 * `{"message":$context.error.messageString}` with content type
 * `application/json`. Customization (status, headers, templates per type,
 * fallback DEFAULT_4XX/DEFAULT_5XX) is S06; HTTP APIs use these fixed
 * defaults only (capability `gatewayResponses.custom` = REST only).
 *
 * @module lib/gateway/core/gateway-responses
 */

/**
 * Catalog entry for one gateway response type.
 * @typedef {{ status: number | null, message: string }} GatewayResponseEntry
 */

/**
 * Default gateway responses. `DEFAULT_4XX`/`DEFAULT_5XX` have no fixed
 * status; the renderer falls back to 400/500 for them.
 * @type {Record<string, GatewayResponseEntry>}
 */
export const GATEWAY_RESPONSES = {
  ACCESS_DENIED: { status: 403, message: "Forbidden" },
  API_CONFIGURATION_ERROR: { status: 500, message: "Internal server error" },
  AUTHORIZER_CONFIGURATION_ERROR: { status: 500, message: "Internal server error" },
  AUTHORIZER_FAILURE: { status: 500, message: "Internal server error" },
  BAD_REQUEST_PARAMETERS: { status: 400, message: "Invalid request parameters" },
  BAD_REQUEST_BODY: { status: 400, message: "Invalid request body" },
  DEFAULT_4XX: { status: null, message: "Bad request" },
  DEFAULT_5XX: { status: null, message: "Internal server error" },
  EXPIRED_TOKEN: { status: 403, message: "Forbidden" },
  INTEGRATION_FAILURE: { status: 504, message: "Internal server error" },
  INTEGRATION_TIMEOUT: { status: 504, message: "Endpoint request timed out" },
  INVALID_API_KEY: { status: 403, message: "Forbidden" },
  INVALID_SIGNATURE: { status: 403, message: "Forbidden" },
  MISSING_AUTHENTICATION_TOKEN: { status: 403, message: "Missing Authentication Token" },
  QUOTA_EXCEEDED: { status: 429, message: "Limit Exceeded" },
  REQUEST_TOO_LARGE: { status: 413, message: "Request Too Long" },
  RESOURCE_NOT_FOUND: { status: 404, message: "Not Found" },
  THROTTLED: { status: 429, message: "Too Many Requests" },
  UNAUTHORIZED: { status: 401, message: "Unauthorized" },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "Unsupported Media Type" },
  WAF_FILTERED: { status: 403, message: "Forbidden" },
};

/**
 * Returns the HTTP status for a response type.
 * Unknown types fall back to 500 (fail closed, never leak).
 *
 * @param {string} type
 * @returns {number}
 */
export function statusFor(type) {
  const entry = GATEWAY_RESPONSES[type];
  if (!entry) return 500;
  if (entry.status != null) return entry.status;
  return type === "DEFAULT_4XX" ? 400 : 500;
}

/**
 * Returns the default message for a response type.
 *
 * @param {string} type
 * @returns {string}
 */
export function messageFor(type) {
  return GATEWAY_RESPONSES[type]?.message ?? "Internal server error";
}

/**
 * Renders a gateway error as a JSON `Response`, setting
 * `x-pods-request-id` (AWS: `x-amzn-RequestId`) and `x-pods-error-type`
 * (AWS: `x-amzn-ErrorType`).
 *
 * @param {{ type: string, message?: string }} err - GatewayError-like.
 * @param {{ requestId?: string, context?: { requestId?: string } }} [ctx]
 * @returns {Response}
 */
export function renderGatewayError(err, ctx) {
  const type = err?.type ?? "DEFAULT_5XX";
  const message = err?.message ?? messageFor(type);
  const requestId = ctx?.requestId ?? ctx?.context?.requestId ?? "";
  return new Response(JSON.stringify({ message }), {
    status: statusFor(type),
    headers: {
      "content-type": "application/json",
      "x-pods-request-id": requestId,
      "x-pods-error-type": type,
    },
  });
}

/**
 * Renders a gateway response type with an optional message override.
 *
 * @param {string} type
 * @param {{ requestId?: string, context?: { requestId?: string } }} [ctx]
 * @param {string} [messageOverride]
 * @returns {Response}
 */
export function renderGatewayResponse(type, ctx, messageOverride) {
  return renderGatewayError({ type, message: messageOverride ?? messageFor(type) }, ctx);
}

// ---------------------------------------------------------------------------
// S06: gateway-response customization (spec §9, additive; defaults above
// are untouched). For a gateway-generated error of type T: use the
// customization for T when present; otherwise, when T's status is 4xx/5xx,
// fall back to the DEFAULT_4XX/DEFAULT_5XX customization; otherwise use the
// built-in default.
// ---------------------------------------------------------------------------

/**
 * A per-type customization row (as stored in `pods.gateway_responses`).
 * @typedef {{ response_type: string, status_code?: string|null, response_parameters?: Record<string,string>, response_templates?: Record<string,string> }} GatewayCustomization
 */

/**
 * Resolves the effective customization for `type` with DEFAULT_4XX/5XX
 * fallback. Returns null when nothing is customized (use built-in defaults).
 *
 * @param {string} type
 * @param {Array<GatewayCustomization>|Record<string,GatewayCustomization>} [customizations=[]]
 * @returns {GatewayCustomization|null}
 */
export function resolveGatewayCustomization(type, customizations = []) {
  const table = Array.isArray(customizations)
    ? Object.fromEntries(customizations.map((entry) => [entry?.response_type, entry]))
    : (customizations ?? {});
  if (Object.hasOwn(table, type) && table[type]) return table[type];
  const status = statusFor(type);
  if (status >= 400 && status < 500 && Object.hasOwn(table, "DEFAULT_4XX")) return table.DEFAULT_4XX;
  if (status >= 500 && Object.hasOwn(table, "DEFAULT_5XX")) return table.DEFAULT_5XX;
  return null;
}

/**
 * Resolves one `gatewayresponse.header.*` parameter value:
 * `'static'` | `method.request.{header,querystring,path,multivalue…}.<n>` |
 * `stageVariables.<n>` | `context.<v>`.
 *
 * @param {string} value
 * @param {{ methodRequest?: object, stageVariables?: object, context?: object }} [sources={}]
 * @returns {string}
 */
export function resolveGatewayParameter(value, sources = {}) {
  const text = String(value ?? "");
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
  const { methodRequest = {}, stageVariables = {}, context = {} } = sources;
  let match = text.match(/^method\.request\.(header|querystring|path|multivalueheader|multivaluequerystring)\.(.+)$/);
  if (match) {
    const [, location, name] = match;
    const bagKey = location === "header" || location === "multivalueheader"
      ? "headers"
      : location === "querystring" || location === "multivaluequerystring"
        ? "querystring"
        : "path";
    const bag = methodRequest?.[bagKey] ?? {};
    const found = bagKey === "headers" ? lookupGatewayHeader(bag, name) : ownValue(bag, name);
    if (found === undefined) return "";
    return Array.isArray(found) ? found.join(",") : String(found);
  }
  match = text.match(/^stageVariables\.(.+)$/);
  if (match) {
    const found = ownValue(stageVariables, match[1]);
    return found === undefined || found === null ? "" : String(found);
  }
  match = text.match(/^context\.(.+)$/);
  if (match) {
    let current = context;
    for (const segment of match[1].split(".")) {
      if (current === null || current === undefined || typeof current !== "object") return "";
      if (segment === "__proto__" || segment === "constructor" || segment === "prototype") return "";
      current = ownValue(current, segment);
    }
    if (current === undefined || current === null) return "";
    return typeof current === "object" ? JSON.stringify(current) : String(current);
  }
  return "";
}

/** Own-property read: never resolves through the prototype chain. */
function ownValue(bag, name) {
  return bag && typeof bag === "object" && Object.hasOwn(bag, name) ? bag[name] : undefined;
}

function lookupGatewayHeader(bag, name) {
  if (!bag || typeof bag !== "object") return undefined;
  if (Object.hasOwn(bag, name)) return bag[name];
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(bag)) {
    if (key.toLowerCase() === lower) return bag[key];
  }
  return undefined;
}

/**
 * Renders a gateway error with S06 customization applied: status override,
 * `gatewayresponse.header.*` parameters, and content-type-selected response
 * templates (evaluated with the §5 interpreter, `$context.error.*`
 * available). Falls back to the built-in default when nothing is customized.
 *
 * @param {{ type: string, message?: string, validationErrorString?: string }} err
 * @param {{ requestId?: string, context?: object }} [ctx]
 * @param {Array<GatewayCustomization>|Record<string,GatewayCustomization>} [customizations=[]]
 * @param {{ accept?: string|null, methodRequest?: object, stageVariables?: object }} [request={}]
 * @returns {Promise<Response>}
 */
export async function renderCustomGatewayResponse(err, ctx, customizations = [], request = {}) {
  const type = err?.type ?? "DEFAULT_5XX";
  const customization = resolveGatewayCustomization(type, customizations);
  if (!customization) return renderGatewayError(err, ctx);
  const status = customization.status_code ? Number(customization.status_code) : statusFor(type);
  const sources = {
    methodRequest: request.methodRequest ?? {},
    stageVariables: request.stageVariables ?? ctx?.stageVariables ?? {},
    context: ctx?.context ?? ctx ?? {},
  };
  const headers = new Headers();
  for (const [key, value] of Object.entries(customization.response_parameters ?? {})) {
    const header = key.match(/^gatewayresponse\.header\.(.+)$/i);
    if (header) headers.set(header[1], resolveGatewayParameter(value, sources));
  }
  const message = err?.message ?? messageFor(type);
  const errorContext = {
    ...(sources.context?.error ?? {}),
    message,
    messageString: JSON.stringify(message),
    responseType: type,
    validationErrorString: err?.validationErrorString ?? sources.context?.error?.validationErrorString ?? "",
  };
  let body = JSON.stringify({ message });
  let contentType = "application/json";
  const templates = customization.response_templates ?? {};
  const names = Object.keys(templates);
  if (names.length > 0) {
    const { selectResponseTemplate } = await import("./processing/responses.mjs");
    const { renderTemplate } = await import("./processing/templates/index.mjs");
    const selected = selectResponseTemplate(templates, request.accept ?? null);
    if (selected) {
      contentType = selected.contentType;
      const rendered = renderTemplate(selected.template, {
        context: { ...(sources.context ?? {}), error: errorContext },
        stageVariables: sources.stageVariables,
        headers: {},
        querystring: {},
        pathParams: {},
        bodyText: "",
      });
      body = rendered.output;
    }
  }
  headers.set("content-type", contentType);
  const requestId = ctx?.requestId ?? ctx?.context?.requestId ?? "";
  if (requestId) headers.set("x-pods-request-id", requestId);
  headers.set("x-pods-error-type", type);
  return new Response(body, { status, headers });
}
