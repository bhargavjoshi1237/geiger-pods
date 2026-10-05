/**
 * CORS handling for HTTP APIs (managed config) and the REST "Enable CORS"
 * control-plane helper (spec §2).
 *
 * HTTP runtime semantics mirror AWS: preflight (OPTIONS + Origin +
 * Access-Control-Request-Method) is answered 204 in phase 6 without
 * authorizer/integration; actual responses get the configured headers, which
 * replace any backend CORS headers. Disallowed origins get no CORS headers
 * and the request proceeds (browsers enforce CORS).
 *
 * @module lib/gateway/core/processing/cors
 */

export const CORS_MAX_AGE_MIN = 0;
export const CORS_MAX_AGE_MAX = 86400;

const SIMPLE_ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i;

/**
 * Validates a managed HTTP CORS config. Returns error strings (empty = ok).
 * `allowCredentials: true` with `*` in allowOrigins is rejected, as AWS does.
 *
 * @param {object|null|undefined} cors
 * @returns {Array<string>}
 */
export function validateCorsConfig(cors) {
  if (cors == null) return [];
  const errors = [];
  if (typeof cors !== "object" || Array.isArray(cors)) return ["cors: must be an object"];
  for (const key of ["allowOrigins", "allowMethods", "allowHeaders", "exposeHeaders"]) {
    if (cors[key] !== undefined && !Array.isArray(cors[key])) errors.push(`cors.${key}: must be an array`);
    else if (Array.isArray(cors[key]) && cors[key].some((v) => typeof v !== "string")) {
      errors.push(`cors.${key}: must be an array of strings`);
    }
  }
  if (cors.maxAge !== undefined && cors.maxAge !== null && (!Number.isInteger(cors.maxAge) || cors.maxAge < CORS_MAX_AGE_MIN || cors.maxAge > CORS_MAX_AGE_MAX)) {
    errors.push(`cors.maxAge: must be an integer ${CORS_MAX_AGE_MIN}-${CORS_MAX_AGE_MAX}`);
  }
  if (cors.allowOrigins?.includes("*") && cors.allowCredentials === true) {
    errors.push("cors: allowCredentials must not be true when allowOrigins contains *");
  }
  return errors;
}

/**
 * True when `origin` is permitted by `allowOrigins`.
 * `*` matches any origin. `https://*.example.com` subdomain wildcards are a
 * Pods extension, honored only when `features.corsWildcardSubdomains` is set.
 *
 * @param {string|null} origin
 * @param {Array<string>} [allowOrigins=[]]
 * @param {object} [features={}]
 * @returns {boolean}
 */
export function originAllowed(origin, allowOrigins = [], features = {}) {
  if (!origin || typeof origin !== "string") return false;
  if (allowOrigins.includes("*")) return true;
  for (const allowed of allowOrigins) {
    if (allowed === origin) return true;
    if (features.corsWildcardSubdomains && typeof allowed === "string" && allowed.includes("*")) {
      if (wildcardOriginMatches(allowed, origin)) return true;
    }
  }
  return false;
}

function wildcardOriginMatches(pattern, origin) {
  const patternUrl = safeUrl(pattern.replace(/\*/g, "WILDCARD"));
  const originUrl = safeUrl(origin);
  if (!patternUrl || !originUrl) return false;
  if (patternUrl.protocol !== originUrl.protocol) return false;
  const patternHost = pattern.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0];
  const hostRegex = new RegExp(`^${patternHost.split(".").map((part) => (part === "*" ? "[^.]+(?:\\.[^.]+)*" : part.replace(/[[\]{}()+?.\\^$|]/g, "\\$&"))).join("\\.")}$`, "i");
  if (!hostRegex.test(originUrl.host.split(":")[0])) return false;
  const patternPort = patternUrl.port || defaultPort(patternUrl.protocol);
  const originPort = originUrl.port || defaultPort(originUrl.protocol);
  return patternPort === originPort;
}

function safeUrl(text) {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function defaultPort(protocol) {
  return protocol === "https:" ? "443" : protocol === "http:" ? "80" : "";
}

/**
 * True for a CORS preflight: OPTIONS with Origin and
 * Access-Control-Request-Method (spec §2). A non-preflight OPTIONS goes
 * through normal routing.
 *
 * @param {Request} request
 * @returns {boolean}
 */
export function isPreflightRequest(request) {
  if (request.method !== "OPTIONS") return false;
  return request.headers.get("origin") !== null && request.headers.get("access-control-request-method") !== null;
}

/**
 * Answers a preflight request directly (204) without invoking an authorizer
 * or integration. Returns `null` when `request` is not a preflight.
 * A disallowed origin still gets 204 but with no allow headers — the actual
 * request itself always proceeds and browsers enforce the policy.
 *
 * @param {Request} request
 * @param {object|null|undefined} corsConfig
 * @param {{ features?: object }} [options]
 * @returns {Response|null}
 */
export function handlePreflight(request, corsConfig, options = {}) {
  if (!corsConfig || !isPreflightRequest(request)) return null;
  const origin = request.headers.get("origin") ?? "";
  const headers = new Headers();
  headers.set("content-length", "0");
  if (originAllowed(origin, corsConfig.allowOrigins ?? [], options.features ?? {})) {
    headers.set("access-control-allow-origin", corsConfig.allowOrigins?.includes("*") && !corsConfig.allowCredentials ? "*" : origin);
    const methods = [...(corsConfig.allowMethods ?? [])];
    if (methods.length > 0) headers.set("access-control-allow-methods", methods.join(", "));
    if ((corsConfig.allowHeaders ?? []).length > 0) {
      headers.set("access-control-allow-headers", corsConfig.allowHeaders.join(", "));
    } else {
      const requested = request.headers.get("access-control-request-headers");
      if (requested) headers.set("access-control-allow-headers", requested);
    }
    if (corsConfig.maxAge !== undefined && corsConfig.maxAge !== null) {
      headers.set("access-control-max-age", String(corsConfig.maxAge));
    }
    if (corsConfig.allowCredentials === true) headers.set("access-control-allow-credentials", "true");
    headers.set("vary", "Origin");
  } else {
    headers.set("vary", "Origin");
  }
  return new Response(null, { status: 204, headers });
}

/**
 * Applies managed CORS headers to an actual response, replacing any backend
 * CORS headers (the API configuration takes precedence, as in AWS).
 * Returns a new Response; the input is never mutated.
 *
 * @param {Request} request
 * @param {Response} response
 * @param {object|null|undefined} corsConfig
 * @param {{ features?: object }} [options]
 * @returns {Response}
 */
export function applyCorsToResponse(request, response, corsConfig, options = {}) {
  if (!corsConfig) return response;
  const origin = request.headers.get("origin");
  if (!origin) return response;
  if (!originAllowed(origin, corsConfig.allowOrigins ?? [], options.features ?? {})) return response;
  const headers = new Headers(response.headers);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("access-control-")) headers.delete(name);
  }
  headers.set("access-control-allow-origin", corsConfig.allowOrigins?.includes("*") && !corsConfig.allowCredentials ? "*" : origin);
  if ((corsConfig.exposeHeaders ?? []).length > 0) {
    headers.set("access-control-expose-headers", corsConfig.exposeHeaders.join(", "));
  }
  if (corsConfig.allowCredentials === true) headers.set("access-control-allow-credentials", "true");
  appendVary(headers, "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function appendVary(headers, value) {
  const current = headers.get("vary");
  if (!current) {
    headers.set("vary", value);
    return;
  }
  const parts = current.split(",").map((part) => part.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) headers.set("vary", `${current}, ${value}`);
}

/**
 * REST "Enable CORS" planner (control-plane helper, spec §2). Computes the
 * OPTIONS mock method, the 200 header mappings and optional gateway-response
 * header additions for a resource. The caller persists the returned draft
 * objects through the S03/S06 control services.
 *
 * @param {{ allowOrigin?: string, allowMethods?: Array<string>, allowHeaders?: Array<string> }} [options]
 * @returns {{ optionsMethod: object, methodResponseHeaders: Record<string, boolean>, gatewayResponseHeaders: Record<string, string> }}
 */
export function planRestEnableCors(options = {}) {
  const allowOrigin = options.allowOrigin ?? "'*'";
  const allowMethods = options.allowMethods ?? ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
  const allowHeaders = options.allowHeaders ?? [
    "Content-Type",
    "X-Amz-Date",
    "Authorization",
    "X-Api-Key",
    "X-Amz-Security-Token",
  ];
  const quoted = (list) => `'${list.join(",")}'`;
  return {
    optionsMethod: {
      httpMethod: "OPTIONS",
      authorizationType: "NONE",
      integration: {
        type: "MOCK",
        passthroughBehavior: "WHEN_NO_MATCH",
        requestTemplates: { "application/json": '{"statusCode": 200}' },
        integrationResponses: [
          {
            statusCode: "200",
            selectionPattern: "",
            responseParameters: {
              "method.response.header.Access-Control-Allow-Origin": allowOrigin,
              "method.response.header.Access-Control-Allow-Methods": quoted(allowMethods),
              "method.response.header.Access-Control-Allow-Headers": quoted(allowHeaders),
            },
            responseTemplates: { "application/json": "" },
          },
        ],
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": false,
            "method.response.header.Access-Control-Allow-Methods": false,
            "method.response.header.Access-Control-Allow-Headers": false,
          },
          responseModels: { "application/json": "Empty" },
        },
      ],
    },
    methodResponseHeaders: {
      "method.response.header.Access-Control-Allow-Origin": true,
    },
    gatewayResponseHeaders: {
      "gatewayresponse.header.Access-Control-Allow-Origin": allowOrigin,
    },
  };
}

/** Validates a REST Enable-CORS origin value (a quoted literal or `*`). */
export function isValidRestCorsOriginValue(value) {
  return typeof value === "string" && (value === "'*'" || SIMPLE_ORIGIN.test(value.replace(/^'|'$/g, "")));
}
