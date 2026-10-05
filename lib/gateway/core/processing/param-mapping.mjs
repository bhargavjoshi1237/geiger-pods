/**
 * Parameter mapping for HTTP APIs (AWS grammar) and REST APIs (spec §3).
 *
 * HTTP request keys: `append|overwrite|remove:header.<name>`,
 * `append|overwrite|remove:querystring.<name>`, `overwrite:path`.
 * HTTP response keys: `append|overwrite|remove:header.<name>`,
 * `overwrite:statuscode`. Application order is remove → overwrite → append.
 *
 * REST integration request: `integration.request.{header|querystring|path}.<n>`
 * from `method.request.*` / `method.request.body[.JSONPath]` / `'static'` /
 * `context.*` / `stageVariables.*`. REST method response maps
 * `method.response.header.<n>` from integration response sources.
 *
 * Reserved headers can never be mapping targets (compile error).
 *
 * @module lib/gateway/core/processing/param-mapping
 */

import { evaluateJsonPath } from "./jsonpath.mjs";

/** Headers that cannot be mapping targets (lowercase; `*` entries are prefixes). */
export const RESERVED_HEADERS = [
  "access-control-*",
  "apigw-*",
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
  "x-amz-*",
  "x-amzn-*",
  "x-pods-*",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "via",
];

/** HTTP mapping bodies are truncated to 100 KB before evaluation (spec §3). */
export const HTTP_BODY_TRUNCATE_BYTES = 100 * 1024;

/**
 * True when `name` is a reserved mapping target (case-insensitive).
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isReservedHeader(name) {
  const lower = String(name ?? "").toLowerCase();
  return RESERVED_HEADERS.some((pattern) =>
    pattern.endsWith("*") ? lower.startsWith(pattern.slice(0, -1)) : lower === pattern,
  );
}

/**
 * Parses an HTTP mapping key such as `overwrite:header.X-Name`.
 *
 * @param {string} key
 * @param {"request"|"response"} [side="request"]
 * @returns {{ op: string, location: string, name: string|null }}
 * @throws {Error} on grammar violations.
 */
export function parseHttpMappingKey(key, side = "request") {
  const match = String(key).match(/^(append|overwrite|remove):(header|querystring|path|statuscode)(?:\.(.+))?$/);
  if (!match) throw new Error(`Invalid mapping key: ${key}`);
  const [, op, location, name] = match;
  if (location === "header" || location === "querystring") {
    if (!name) throw new Error(`Invalid mapping key (missing name): ${key}`);
  }
  if (location === "path" && (side !== "request" || op !== "overwrite")) {
    throw new Error(`Invalid mapping key: ${key} (path supports overwrite:path on requests only)`);
  }
  if (location === "path" && name !== undefined) throw new Error(`Invalid mapping key: ${key} (overwrite:path takes no name)`);
  if (location === "statuscode" && (side !== "response" || op !== "overwrite")) {
    throw new Error(`Invalid mapping key: ${key} (overwrite:statuscode on responses only)`);
  }
  if (location === "statuscode" && name !== undefined) throw new Error(`Invalid mapping key: ${key}`);
  return { op, location, name: name ?? null };
}

/**
 * Validates HTTP request/response mapping tables. Returns error strings —
 * the S05 compile step fails the deploy when non-empty. Reserved headers and
 * grammar violations are errors; unknown `$` sources are warnings.
 *
 * @param {Record<string,string>} [mapping={}]
 * @param {"request"|"response"} [side="request"]
 * @returns {{ errors: Array<string>, warnings: Array<string> }}
 */
export function validateHttpMapping(mapping = {}, side = "request") {
  const errors = [];
  const warnings = [];
  for (const [key, value] of Object.entries(mapping ?? {})) {
    let parsed;
    try {
      parsed = parseHttpMappingKey(key, side);
    } catch (error) {
      errors.push(`${key}: ${error.message}`);
      continue;
    }
    if (parsed.location === "header" && isReservedHeader(parsed.name)) {
      errors.push(`${key}: header "${parsed.name}" is reserved and cannot be mapped`);
    }
    if (typeof value !== "string") {
      errors.push(`${key}: value must be a string`);
      continue;
    }
    for (const source of extractSources(value)) {
      if (!isKnownHttpSource(source, side)) warnings.push(`${key}: unknown mapping source $${source}`);
    }
    if (/\$[{]?(?:request|response)\.body[^\n]*?\.\./.test(String(value))) {
      errors.push(`${key}: recursive descent (..) and filters are not allowed in HTTP mappings`);
    }
    if (/\[\?\(@/.test(value)) errors.push(`${key}: filter expressions are not allowed in HTTP mappings`);
  }
  return { errors, warnings };
}

function extractSources(value) {
  const sources = [];
  for (const match of String(value).matchAll(/\$\{([^}]+)\}/g)) sources.push(match[1].trim());
  const bare = String(value).trim();
  if (!bare.includes("${") && bare.startsWith("$")) sources.push(bare.slice(1).trim());
  return sources;
}

const HTTP_SOURCE = /^(request|response|context|stageVariables)\b/;

function isKnownHttpSource(source, side) {
  if (!HTTP_SOURCE.test(source)) return false;
  if (source.startsWith("response.") && side === "request") return false;
  return /^(request\.(header|querystring|path|body)|response\.(header|body)|context\.|stageVariables\.)/.test(source)
    || source === "request.path"
    || /^request\.path\.[A-Za-z0-9_]+$/.test(source);
}

/**
 * Resolves one `$`-expression against HTTP mapping evaluation data.
 *
 * @param {string} expression - Without leading `$` (`request.header.id`, …).
 * @param {{ request: object, response?: object, context?: object, stageVariables?: object }} data
 * @returns {string}
 */
export function resolveHttpSource(expression, data) {
  const expr = String(expression).trim();
  const { request = {}, response = {}, context = {}, stageVariables = {} } = data ?? {};
  if (expr === "request.path") return request.path ?? "";
  let match = expr.match(/^request\.path\.([A-Za-z0-9_]+)$/);
  if (match) {
    const bag = request.pathParams ?? {};
    if (!Object.hasOwn(bag, match[1])) return "";
    return firstOf(bag[match[1]]) ?? "";
  }
  match = expr.match(/^request\.header\.(.+)$/);
  if (match) return joinMulti(lookupCaseInsensitive(request.headers ?? {}, match[1]));
  match = expr.match(/^request\.querystring\.(.+)$/);
  if (match) {
    const bag = request.query ?? {};
    if (!Object.hasOwn(bag, match[1])) return "";
    return joinMulti(bag[match[1]]);
  }
  match = expr.match(/^request\.body(\..+)?$/);
  if (match) return resolveBodyPath(request.bodyText, match[1] ?? "", { allowRecursive: false, allowFilter: false });
  match = expr.match(/^response\.header\.(.+)$/);
  if (match) return joinMulti(lookupCaseInsensitive(response.headers ?? {}, match[1]));
  match = expr.match(/^response\.body(\..+)?$/);
  if (match) return resolveBodyPath(response.bodyText, match[1] ?? "", { allowRecursive: false, allowFilter: false });
  match = expr.match(/^context\.(.+)$/);
  if (match) return readDotted(context, match[1]);
  match = expr.match(/^stageVariables\.(.+)$/);
  if (match) {
    if (!stageVariables || typeof stageVariables !== "object" || !Object.hasOwn(stageVariables, match[1])) return "";
    const value = stageVariables[match[1]];
    return value === undefined || value === null ? "" : String(value);
  }
  return "";
}

function firstOf(value) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function joinMulti(value) {
  if (value === undefined || value === null) return "";
  return Array.isArray(value) ? value.join(",") : String(value);
}

function resolveBodyPath(bodyText, suffix, options) {
  if (bodyText === undefined || bodyText === null) return "";
  const truncated = truncateBody(String(bodyText));
  if (!suffix) return truncated;
  let parsed;
  try {
    parsed = JSON.parse(truncated);
  } catch {
    return "";
  }
  let selected;
  try {
    selected = evaluateJsonPath(parsed, `$${suffix}`, options);
  } catch {
    return "";
  }
  if (selected === undefined) return "";
  return typeof selected === "string" ? selected : JSON.stringify(selected);
}

/** Truncates a body to 100 KB before mapping evaluation. */
export function truncateBody(bodyText) {
  const text = String(bodyText ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= HTTP_BODY_TRUNCATE_BYTES) return text;
  let end = HTTP_BODY_TRUNCATE_BYTES;
  while (end > 0 && (text.charCodeAt(end) & 0xfc00) === 0xdc00) end -= 1;
  return text.slice(0, end);
}

function readDotted(root, dotted) {
  let current = root;
  for (const segment of dotted.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return "";
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") return "";
    if (!Object.hasOwn(current, segment)) return "";
    current = current[segment];
  }
  if (current === undefined || current === null) return "";
  if (typeof current === "function") return "";
  return typeof current === "object" ? JSON.stringify(current) : String(current);
}

/**
 * Interpolates a mapping value: `${…}` segments are expanded inline, a whole
 * value that is a single `$source` resolves directly, anything else is static.
 * Example: `"${request.path.name} ${request.path.id}"`.
 *
 * @param {string} value
 * @param {{ request: object, response?: object, context?: object, stageVariables?: object }} data
 * @returns {string}
 */
export function interpolateValue(value, data) {
  const text = String(value ?? "");
  if (!text.includes("$")) return text;
  if (!text.includes("${") && /^\$[A-Za-z]/.test(text.trim())) {
    return resolveHttpSource(text.trim().slice(1), data);
  }
  return text.replace(/\$\{([^}]+)\}/g, (_, expr) => resolveHttpSource(expr.trim().replace(/^\$/, ""), data));
}

/**
 * Applies HTTP request parameter mapping (remove → overwrite → append).
 * Pure: returns new `{ headers, query, path }` objects, never mutates inputs.
 *
 * @param {{ headers?: Record<string, string|Array<string>>, query?: Record<string, string|Array<string>>, path?: string }} target
 * @param {Record<string,string>} [mapping={}]
 * @param {{ request: object, context?: object, stageVariables?: object }} data
 * @returns {{ headers: Record<string,string>, query: Record<string,string>, path: string }}
 */
export function applyHttpRequestMapping(target = {}, mapping = {}, data = {}) {
  const headers = normalizeMulti(target.headers ?? {}, true);
  const query = normalizeMulti(target.query ?? {}, false);
  let path = target.path ?? data?.request?.path ?? "";
  const ordered = sortMappingKeys(Object.keys(mapping ?? {}));
  for (const phase of ["remove", "overwrite", "append"]) {
    for (const key of ordered) {
      const parsed = parseHttpMappingKey(key, "request");
      if (parsed.op !== phase) continue;
      const value = interpolateValue(mapping[key], data);
      if (parsed.location === "header") {
        const name = parsed.name.toLowerCase();
        if (phase === "remove") delete headers[name];
        else if (phase === "overwrite") headers[name] = value;
        else headers[name] = headers[name] === undefined ? value : `${headers[name]},${value}`;
      } else if (parsed.location === "querystring") {
        if (phase === "remove") delete query[parsed.name];
        else if (phase === "overwrite") query[parsed.name] = value;
        else query[parsed.name] = query[parsed.name] === undefined ? value : `${query[parsed.name]},${value}`;
      } else if (parsed.location === "path" && phase === "overwrite") {
        path = value;
      }
    }
  }
  return { headers, query, path };
}

/**
 * Applies per-status HTTP response mapping. `mappingByStatus` selects the
 * table by backend status string. Supports `overwrite:statuscode`.
 *
 * @param {{ statusCode?: number, headers?: Record<string,string> }} result
 * @param {Record<string, Record<string,string>>} [mappingByStatus={}]
 * @param {{ request: object, response: object, context?: object, stageVariables?: object }} data
 * @returns {{ statusCode: number, headers: Record<string,string> }}
 */
export function applyHttpResponseMapping(result = {}, mappingByStatus = {}, data = {}) {
  let statusCode = result.statusCode ?? 200;
  const headers = normalizeMulti(result.headers ?? {}, true);
  const table = mappingByStatus?.[String(statusCode)] ?? {};
  const ordered = sortMappingKeys(Object.keys(table));
  for (const phase of ["remove", "overwrite", "append"]) {
    for (const key of ordered) {
      const parsed = parseHttpMappingKey(key, "response");
      if (parsed.op !== phase) continue;
      if (parsed.location === "statuscode" && phase === "overwrite") {
        const next = Number.parseInt(interpolateValue(table[key], data), 10);
        if (Number.isInteger(next) && next >= 100 && next <= 599) statusCode = next;
        continue;
      }
      const value = interpolateValue(table[key], data);
      const name = parsed.name.toLowerCase();
      if (phase === "remove") delete headers[name];
      else if (phase === "overwrite") headers[name] = value;
      else headers[name] = headers[name] === undefined ? value : `${headers[name]},${value}`;
    }
  }
  return { statusCode, headers };
}

function normalizeMulti(entries, lowercaseKeys = false) {
  const out = {};
  for (const [key, value] of Object.entries(entries ?? {})) {
    const name = lowercaseKeys ? String(key).toLowerCase() : String(key);
    const joined = Array.isArray(value) ? value.join(",") : (value ?? "");
    // Last write wins when different casings collapse (headers are case-insensitive).
    out[name] = joined;
  }
  return out;
}

function sortMappingKeys(keys) {
  return [...keys].sort();
}

// ---------------------------------------------------------------------------
// REST parameter mapping
// ---------------------------------------------------------------------------

const REST_REQUEST_SOURCE =
  /^(method\.request\.(header|querystring|path|multivalueheader|multivaluequerystring)\.[A-Za-z0-9_.\-]+|method\.request\.body(\..+)?|context\.[A-Za-z0-9_.]+|stageVariables\.[A-Za-z0-9_]+|'.*')$/s;

const REST_RESPONSE_SOURCE =
  /^(integration\.response\.(header|multivalueheader)\.[A-Za-z0-9_.\-]+|integration\.response\.body(\..+)?|context\.[A-Za-z0-9_.]+|stageVariables\.[A-Za-z0-9_]+|'.*')$/s;

/**
 * Validates a REST integration-request mapping table.
 *
 * @param {Record<string,string>} [mapping={}]
 * @returns {{ errors: Array<string>, warnings: Array<string> }}
 */
export function validateRestRequestMapping(mapping = {}) {
  const errors = [];
  const warnings = [];
  for (const [key, value] of Object.entries(mapping ?? {})) {
    const target = key.match(/^integration\.request\.(header|querystring|path)\.[A-Za-z0-9_.\-]+$/);
    if (!target) errors.push(`${key}: must be integration.request.{header|querystring|path}.<name>`);
    if (target?.[1] === "header" && isReservedHeader(key.split(".").pop())) {
      errors.push(`${key}: header is reserved and cannot be mapped`);
    }
    if (typeof value !== "string") errors.push(`${key}: value must be a string`);
    else if (!REST_REQUEST_SOURCE.test(value)) warnings.push(`${key}: unrecognized source expression ${value}`);
    else if (value.includes("..")) warnings.push(`${key}: recursive descent in ${value} is templates-only`);
  }
  return { errors, warnings };
}

/**
 * Validates a REST method-response mapping table. Every mapped header must be
 * declared in `method_responses.response_parameters` (checked by compile).
 *
 * @param {Record<string,string>} [mapping={}]
 * @param {Record<string, boolean>} [declared={}]
 * @returns {{ errors: Array<string>, warnings: Array<string> }}
 */
export function validateRestResponseMapping(mapping = {}, declared = {}) {
  const errors = [];
  const warnings = [];
  for (const [key, value] of Object.entries(mapping ?? {})) {
    const target = key.match(/^method\.response\.header\.([A-Za-z0-9_.\-]+)$/);
    if (!target) {
      errors.push(`${key}: must be method.response.header.<name>`);
      continue;
    }
    if (declared[target[1]] === undefined && declared[key] === undefined) {
      errors.push(`${key}: header "${target[1]}" is not declared in method_responses.response_parameters`);
    }
    if (typeof value !== "string") errors.push(`${key}: value must be a string`);
    else if (!REST_RESPONSE_SOURCE.test(value)) warnings.push(`${key}: unrecognized source expression ${value}`);
  }
  return { errors, warnings };
}

/**
 * Resolves a REST integration-request mapping against method request data.
 *
 * @param {Record<string,string>} [mapping={}]
 * @param {{ methodRequest?: object, bodyText?: string, context?: object, stageVariables?: object }} data
 * @returns {{ headers: Record<string,string>, querystring: Record<string,string>, path: Record<string,string> }}
 */
export function applyRestRequestMapping(mapping = {}, data = {}) {
  const headers = {};
  const querystring = {};
  const path = {};
  const { methodRequest = {}, bodyText = "", context = {}, stageVariables = {} } = data;
  for (const [key, value] of Object.entries(mapping ?? {})) {
    const target = key.match(/^integration\.request\.(header|querystring|path)\.(.+)$/);
    if (!target) continue;
    const resolved = resolveRestSource(value, { methodRequest, bodyText, context, stageVariables });
    if (target[1] === "header") headers[target[2]] = resolved;
    else if (target[1] === "querystring") querystring[target[2]] = resolved;
    else path[target[2]] = resolved;
  }
  return { headers, querystring, path };
}

/**
 * Resolves a REST method-response mapping against integration response data.
 *
 * @param {Record<string,string>} [mapping={}]
 * @param {{ integrationResponse?: object, bodyText?: string, context?: object, stageVariables?: object }} data
 * @returns {Record<string,string>}
 */
export function applyRestResponseMapping(mapping = {}, data = {}) {
  const headers = {};
  const { integrationResponse = {}, bodyText = "", context = {}, stageVariables = {} } = data;
  for (const [key, value] of Object.entries(mapping ?? {})) {
    const target = key.match(/^method\.response\.header\.(.+)$/);
    if (!target) continue;
    headers[target[1]] = resolveRestResponseSource(value, { integrationResponse, bodyText, context, stageVariables });
  }
  return headers;
}

function resolveRestSource(value, { methodRequest, bodyText, context, stageVariables }) {
  const text = String(value ?? "");
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
  let match = text.match(/^method\.request\.(header|querystring|path|multivalueheader|multivaluequerystring)\.(.+)$/);
  if (match) {
    const [, location, name] = match;
    const bag = methodRequest?.[location === "header" ? "headers" : location === "querystring" ? "querystring" : location] ?? {};
    const found = lookupCaseInsensitive(bag, name);
    return found === undefined ? "" : joinMulti(found);
  }
  match = text.match(/^method\.request\.body(\..+)?$/);
  if (match) {
    if (!match[1]) return String(bodyText ?? "");
    return resolveBodyPath(bodyText, match[1], { allowRecursive: true, allowFilter: true });
  }
  match = text.match(/^context\.(.+)$/);
  if (match) return readDotted(context, match[1]);
  match = text.match(/^stageVariables\.(.+)$/);
  if (match) {
    if (!stageVariables || typeof stageVariables !== "object" || !Object.hasOwn(stageVariables, match[1])) return "";
    const found = stageVariables[match[1]];
    return found === undefined || found === null ? "" : String(found);
  }
  return "";
}

function resolveRestResponseSource(value, { integrationResponse, bodyText, context, stageVariables }) {
  const text = String(value ?? "");
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
  let match = text.match(/^integration\.response\.(header|multivalueheader)\.(.+)$/);
  if (match) {
    const found = lookupCaseInsensitive(integrationResponse?.headers ?? {}, match[2]);
    return found === undefined ? "" : joinMulti(found);
  }
  match = text.match(/^integration\.response\.body(\..+)?$/);
  if (match) {
    if (!match[1]) return String(bodyText ?? "");
    return resolveBodyPath(bodyText, match[1], { allowRecursive: true, allowFilter: true });
  }
  match = text.match(/^context\.(.+)$/);
  if (match) return readDotted(context, match[1]);
  match = text.match(/^stageVariables\.(.+)$/);
  if (match) {
    if (!stageVariables || typeof stageVariables !== "object" || !Object.hasOwn(stageVariables, match[1])) return "";
    const found = stageVariables[match[1]];
    return found === undefined || found === null ? "" : String(found);
  }
  return "";
}

function lookupCaseInsensitive(bag, name) {
  if (!bag || typeof bag !== "object") return undefined;
  if (typeof name !== "string" || name === "__proto__" || name === "constructor" || name === "prototype") return undefined;
  if (Object.hasOwn(bag, name)) return bag[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(bag)) {
    if (key.toLowerCase() === lower) return bag[key];
  }
  return undefined;
}

/**
 * Defaults path params referenced in an integration URI (`{id}`) to
 * `method.request.path.id` when unmapped (AWS console behavior).
 *
 * @param {string} uri
 * @param {Record<string,string>} [mapping={}]
 * @returns {Record<string,string>} additional entries to merge into the mapping.
 */
export function defaultPathMappings(uri, mapping = {}) {
  const declared = new Set(
    Object.keys(mapping ?? {})
      .filter((key) => key.startsWith("integration.request.path."))
      .map((key) => key.slice("integration.request.path.".length)),
  );
  const out = {};
  for (const match of String(uri ?? "").matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    if (!declared.has(match[1])) out[`integration.request.path.${match[1]}`] = `method.request.path.${match[1]}`;
  }
  return out;
}
