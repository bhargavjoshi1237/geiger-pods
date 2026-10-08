/**
 * Routing-rule matching (S11 §A4).
 *
 * A rule matches when **all** conditions hold. Header names match
 * case-insensitively; value globs are case-sensitive and limited to the AWS
 * shapes `*x` (suffix), `x*` (prefix), `*x*` (infix), exact, or bare `*`.
 * Base-path conditions match a path prefix at segment boundaries,
 * case-sensitive. Rules evaluate in ascending priority order.
 *
 * @module lib/gateway/core/edge/routing-rules
 */

/**
 * Condition headers AWS rejects at save time (S11 §A4, exact list).
 * Stored lowercase; lookups lowercase the candidate.
 * @type {Set<string>}
 */
export const RESTRICTED_CONDITION_HEADERS = new Set(
  [
    "access-control-",
    "apigw-",
    "authorization",
    "connection",
    "content-encoding",
    "content-length",
    "content-location",
    "forwarded",
    "keep-alive",
    "origin",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "x-amz-",
    "x-amzn-",
    "x-pods-",
    "x-forwarded-",
    "via",
  ].map((entry) => entry.toLowerCase()),
);

/**
 * Returns true when a header name is restricted (exact match, or a
 * trailing-dash entry matching the prefix, e.g. `x-amzn-*`).
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isRestrictedHeader(name) {
  const lower = String(name ?? "").toLowerCase();
  if (RESTRICTED_CONDITION_HEADERS.has(lower)) return true;
  for (const entry of RESTRICTED_CONDITION_HEADERS) {
    if (entry.endsWith("-") && lower.startsWith(entry)) return true;
  }
  return false;
}

/**
 * Matches a header value against an AWS value glob (`*x`, `x*`, `*x*`,
 * exact, bare `*`). Case-sensitive.
 *
 * @param {string} glob
 * @param {string} value
 * @returns {boolean}
 * @throws {TypeError} When the glob has interior stars (`a*b`).
 */
export function matchHeaderGlob(glob, value) {
  const pattern = String(glob ?? "");
  const text = String(value ?? "");
  if (!pattern.includes("*")) return text === pattern;
  if (pattern === "*") return true;
  const leading = pattern.startsWith("*");
  const trailing = pattern.endsWith("*");
  const inner = trailing ? pattern.slice(leading ? 1 : 0, -1) : pattern.slice(leading ? 1 : 0);
  if (inner.includes("*")) {
    throw new TypeError(`Invalid header glob "${glob}": only *x, x*, *x* or exact are supported.`);
  }
  if (leading && trailing) return text.includes(inner);
  if (leading) return text.endsWith(inner);
  return text.startsWith(inner);
}

/**
 * Validates one header glob shape (AWS limits, S11 §A4).
 *
 * @param {unknown} glob
 * @returns {string|null} Error message, or null when valid.
 */
export function checkHeaderGlob(glob) {
  if (typeof glob !== "string" || glob.length === 0 || glob.length > 128) {
    return "header glob value must be a string of 1–128 characters";
  }
  const infix = glob.startsWith("*") && glob.endsWith("*") ? glob.slice(1, -1) : null;
  if (infix !== null && infix.length > 40) {
    return "infix glob must be at most 40 characters";
  }
  if (glob !== "*" && glob.includes("*")) {
    const leading = glob.startsWith("*");
    const inner = glob.slice(leading ? 1 : 0, glob.endsWith("*") ? -1 : 0);
    if (inner.includes("*")) return `header glob "${glob}" is invalid: only *x, x*, *x* or exact are supported`;
  }
  return null;
}

/**
 * Matches a base-path condition against a request path: prefix at segment
 * boundaries, case-sensitive.
 *
 * @param {string} basePath - Without leading/trailing `/` (e.g. `"v2"`).
 * @param {string} path - Request path (e.g. `"/v2/pets"`).
 * @returns {boolean}
 */
export function matchBasePathCondition(basePath, path) {
  const base = `/${String(basePath ?? "").replace(/^\/+|\/+$/g, "")}`;
  const target = String(path ?? "/").split("?")[0] || "/";
  if (base === "/") return true;
  return target === base || target.startsWith(`${base}/`);
}

/**
 * Reads header values from a plain object (case-insensitive) and/or a
 * `rawHeaders` pair list.
 *
 * @param {object} headers - Lower- or mixed-case header object.
 * @param {Array<[string, string]>} [rawHeaders=[]]
 * @param {string} name
 * @returns {Array<string>}
 */
export function headerValues(headers, rawHeaders, name) {
  const out = [];
  const lower = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (String(key).toLowerCase() === lower) {
      if (Array.isArray(value)) out.push(...value.map(String));
      else out.push(String(value));
    }
  }
  for (const [key, value] of rawHeaders ?? []) {
    if (String(key).toLowerCase() === lower) out.push(String(value));
  }
  return out;
}

/**
 * Tests one rule's conditions against a request.
 *
 * @param {object} rule - `{ conditions: { matchHeaders?, matchBasePaths? } }`.
 * @param {{ headers?: object, rawHeaders?: Array<[string,string]>, path?: string }} request
 * @returns {boolean}
 */
export function ruleMatches(rule, request) {
  const conditions = rule?.conditions ?? {};
  const headers = request?.headers ?? {};
  const rawHeaders = request?.rawHeaders ?? [];
  const path = String(request?.path ?? "/").split("?")[0] || "/";
  for (const entry of conditions.matchHeaders ?? []) {
    const values = headerValues(headers, rawHeaders, entry?.header ?? "");
    if (!values.some((value) => {
      try {
        return matchHeaderGlob(entry?.valueGlob ?? "", value);
      } catch {
        return false;
      }
    })) return false;
  }
  for (const base of conditions.matchBasePaths ?? []) {
    if (!matchBasePathCondition(base, path)) return false;
  }
  return true;
}

/**
 * Evaluates routing rules in ascending priority order; the first rule whose
 * conditions all hold wins.
 *
 * @param {Array<object>} rules
 * @param {{ headers?: object, rawHeaders?: Array<[string,string]>, path?: string }} request
 * @returns {object|null}
 */
export function evaluateRoutingRules(rules, request) {
  const ordered = [...(rules ?? [])].sort((a, b) => (a?.priority ?? 0) - (b?.priority ?? 0));
  for (const rule of ordered) {
    if (ruleMatches(rule, request)) return rule;
  }
  return null;
}

/**
 * Validates a routing rule body (save-time, S11 §A4).
 *
 * @param {object} rule - `{ priority, conditions, action }`.
 * @returns {Array<string>} Error messages (empty when valid).
 */
export function validateRoutingRule(rule) {
  const errors = [];
  if (!Number.isInteger(rule?.priority) || rule.priority < 1 || rule.priority > 1000000) {
    errors.push("priority must be an integer 1–1000000");
  }
  const conditions = rule?.conditions;
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) {
    errors.push("conditions must be an object");
    return errors;
  }
  const headers = conditions.matchHeaders ?? [];
  const basePaths = conditions.matchBasePaths ?? [];
  if (!Array.isArray(headers) || !Array.isArray(basePaths)) {
    errors.push("conditions.matchHeaders and conditions.matchBasePaths must be arrays");
    return errors;
  }
  if (headers.length > 2) errors.push("at most 2 matchHeaders are allowed (AND)");
  if (basePaths.length > 1) errors.push("at most 1 matchBasePaths entry is allowed");
  if (headers.length === 0 && basePaths.length === 0) {
    errors.push("at least one condition is required");
  }
  for (const entry of headers) {
    const name = entry?.header ?? "";
    if (typeof name !== "string" || name.length === 0 || name.length >= 40) {
      errors.push("condition header name must be a string of 1–39 characters");
      continue;
    }
    if (isRestrictedHeader(name)) {
      errors.push(`condition header "${name}" is restricted and cannot be used in routing rules`);
      continue;
    }
    const globError = checkHeaderGlob(entry?.valueGlob);
    if (globError) errors.push(globError);
  }
  for (const base of basePaths) {
    if (typeof base !== "string" || base.length === 0) {
      errors.push("matchBasePaths entries must be non-empty strings");
    }
  }
  const invoke = rule?.action?.invokeApi;
  if (!invoke || typeof invoke.apiId !== "string" || typeof invoke.stage !== "string") {
    errors.push("action.invokeApi requires { apiId, stage }");
  }
  if (invoke && typeof invoke.stripBasePath !== "boolean") {
    errors.push("action.invokeApi.stripBasePath must be a boolean");
  }
  return errors;
}
