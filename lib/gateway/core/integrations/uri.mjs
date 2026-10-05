/**
 * Integration URI rendering (S04 §3.1).
 *
 * Templates may contain `{param}` (method/route path params), `${stageVariables.name}`
 * and `${request.path.name}` tokens. Greedy params (e.g. `{proxy+}`/`{proxy}` for
 * catch-all routes) keep their slashes; all other values are percent-encoded per
 * segment. A rendered URL with an empty host or a non-http(s) scheme is an
 * `API_CONFIGURATION_ERROR`.
 *
 * @module lib/gateway/core/integrations/uri
 */

import { GatewayError } from "../errors.mjs";

/**
 * Percent-encodes a path-param value, preserving slashes for greedy params.
 *
 * @param {string} value - Raw param value.
 * @param {boolean} greedy - When true, `/` separators are preserved.
 * @returns {string}
 */
export function encodePathParam(value, greedy) {
  const text = String(value ?? "");
  if (greedy) {
    return text
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }
  return text
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("%2F");
}

/**
 * Renders an integration URI template.
 *
 * @param {string} template - URI template, e.g. `https://b.example.com/{proxy}?v=${stageVariables.ver}`.
 * @param {{ pathParams?: Record<string,string>, greedyParams?: string[] | Set<string>, stageVariables?: Record<string,string>, requestPathParams?: Record<string,string> }} [vars={}]
 * @returns {string} Rendered URL string.
 * @throws {GatewayError} `API_CONFIGURATION_ERROR` when the result has an empty host or non-http(s) scheme.
 */
export function renderIntegrationUri(template, vars = {}) {
  const pathParams = vars.pathParams ?? {};
  const greedy = vars.greedyParams instanceof Set
    ? vars.greedyParams
    : new Set(vars.greedyParams ?? []);
  const stageVariables = vars.stageVariables ?? {};
  const requestPathParams = vars.requestPathParams ?? {};

  if (typeof template !== "string" || template.length === 0) {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  }

  let rendered = template.replace(/\$\{stageVariables\.([A-Za-z0-9_-]+)\}/g, (_match, name) =>
    encodeURIComponent(String(stageVariables[name] ?? "")));
  rendered = rendered.replace(/\$\{request\.path\.([A-Za-z0-9_-]+)\}/g, (_match, name) =>
    encodeURIComponent(String(requestPathParams[name] ?? pathParams[name] ?? "")));
  rendered = rendered.replace(/\{([A-Za-z0-9_-]+)\+?\}/g, (_match, name) =>
    encodePathParam(pathParams[name] ?? "", greedy.has(name)));

  let url;
  try {
    url = new URL(rendered);
  } catch {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  }
  if (!url.host || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  }
  return url.toString();
}

/**
 * AWS parity for HTTP APIs: for the `$default` route, or an `ANY /{proxy+}` route
 * whose URI has no `{proxy}`, append the full request path (without stage) to the
 * URI path. The query string always passes through at invoke time.
 *
 * `opts.uriTemplate` is the pre-render integration URI template when known; the
 * `{proxy}` presence check must run against the template, not the rendered URL
 * (rendering substitutes every placeholder away, so checking the rendered URL
 * always claims "no placeholder" and double-appends the path).
 *
 * @param {string} uri - Already-rendered integration URI.
 * @param {{ protocol?: string, routeKey?: string, requestPath?: string, stage?: string, uriTemplate?: string | null }} [opts={}]
 * @returns {string}
 */
export function maybeAppendDefaultPath(uri, opts = {}) {
  if (opts.protocol !== "HTTP") return uri;
  const routeKey = opts.routeKey ?? "";
  const isDefault = routeKey === "$default" || routeKey === "$default ";
  const proxyMatch = routeKey.trim().match(/^ANY \/\{([A-Za-z0-9_-]+)\+\}$/);
  let isAnyProxy = false;
  if (proxyMatch) {
    if (opts.uriTemplate != null) {
      isAnyProxy = !new RegExp(`\\{${proxyMatch[1]}\\+?\\}`).test(opts.uriTemplate);
    } else {
      // Template unknown (caller passed a prebuilt URL): legacy behavior —
      // the rendered URL cannot carry placeholders, so assume none.
      isAnyProxy = !/\{[A-Za-z0-9_-]+\+?\}/.test(uri);
    }
  }
  if (!isDefault && !isAnyProxy) return uri;
  const url = new URL(uri);
  let suffix = String(opts.requestPath ?? "");
  const stage = opts.stage ? `/${opts.stage}` : "";
  if (stage && suffix.startsWith(stage)) suffix = suffix.slice(stage.length);
  if (!suffix.startsWith("/")) suffix = `/${suffix}`;
  const base = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${base}${suffix === "/" ? "" : suffix}`;
  return url.toString();
}
