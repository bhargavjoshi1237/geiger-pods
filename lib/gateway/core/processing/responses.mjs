/**
 * Integration & method responses for REST APIs (spec §6).
 *
 * 1. Select an integration response: HTTP integrations match each
 *    `selection_pattern` regex (full match) against the backend status code
 *    string; FUNCTION/AWS integrations match against the function
 *    `errorMessage` (on error) or status. No match → the default response
 *    (empty pattern); no default → 500 `API_CONFIGURATION_ERROR`. MOCK
 *    selects by the rendered request template `statusCode`.
 * 2. The selected `status_code` must have a `method_responses` row (compile
 *    enforces this via `validateProcessing`).
 * 3. Response parameters (§3) apply, then the response template chosen by
 *    the request's `Accept` header (`application/json` preferred, else the
 *    first defined, else passthrough). `$context.responseOverride.*` wins.
 *
 * @module lib/gateway/core/processing/responses
 */

import { GatewayError } from "../errors.mjs";

/**
 * Full-match helper: the pattern must match the entire value (AWS uses
 * Java `matches()` semantics for selection patterns).
 *
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
export function matchesSelectionPattern(pattern, value) {
  if (!pattern) return false;
  let regex;
  try {
    regex = new RegExp(`^(?:${pattern})$`);
  } catch {
    return false;
  }
  try {
    return regex.test(String(value ?? ""));
  } catch {
    return false;
  }
}

/**
 * Selects the integration response for a completed invocation.
 *
 * @param {Array<{ statusCode?: string, selectionPattern?: string }>} [responses=[]]
 * @param {{ backendStatus?: number|string|null, errorMessage?: string|null, integrationType?: string, mockStatusCode?: string|number|null }} [outcome={}]
 * @returns {object|null} the selected response, or null when there is no
 *   default (the caller raises 500 API_CONFIGURATION_ERROR).
 */
export function selectIntegrationResponse(responses = [], outcome = {}) {
  const list = responses ?? [];
  if (outcome.mockStatusCode !== undefined && outcome.mockStatusCode !== null) {
    const wanted = String(outcome.mockStatusCode);
    const exact = list.find((entry) => String(entry.statusCode) === wanted);
    if (exact) return exact;
  }
  const probe = selectionProbe(outcome);
  for (const entry of list) {
    const pattern = entry.selectionPattern ?? "";
    if (!pattern) continue;
    if (matchesSelectionPattern(pattern, probe)) return entry;
  }
  const fallback = list.find((entry) => (entry.selectionPattern ?? "") === "");
  return fallback ?? null;
}

function selectionProbe(outcome) {
  if (outcome.integrationType === "MOCK") return String(outcome.mockStatusCode ?? "");
  if (outcome.errorMessage !== undefined && outcome.errorMessage !== null && outcome.errorMessage !== "") {
    return String(outcome.errorMessage);
  }
  return String(outcome.backendStatus ?? "");
}

/**
 * Extracts `statusCode` from a rendered MOCK request template body.
 *
 * @param {string} rendered
 * @returns {string|null}
 */
export function selectMockStatus(rendered) {
  try {
    const parsed = JSON.parse(String(rendered ?? ""));
    if (parsed && parsed.statusCode !== undefined) return String(parsed.statusCode);
  } catch {
    // Not JSON — no status selection.
  }
  return null;
}

/**
 * Chooses the response template by the request's `Accept` header: exact
 * match first, then `application/json` when defined, else the first defined
 * entry, else null (pass the body through).
 *
 * @param {Record<string,string>} [templates={}]
 * @param {string|null} [acceptHeader=null]
 * @returns {{ contentType: string, template: string }|null}
 */
export function selectResponseTemplate(templates = {}, acceptHeader = null) {
  const entries = Object.entries(templates ?? {});
  if (entries.length === 0) return null;
  const accepted = parseAccept(acceptHeader);
  for (const { type } of accepted) {
    const exact = entries.find(([contentType]) => contentType.toLowerCase() === type);
    if (exact) return { contentType: exact[0], template: exact[1] };
    if (type.endsWith("/*")) {
      const prefix = type.slice(0, -1);
      const wildcard = entries.find(([contentType]) => contentType.toLowerCase().startsWith(prefix));
      if (wildcard) return { contentType: wildcard[0], template: wildcard[1] };
    }
    if (type === "*/*") return { contentType: entries[0][0], template: entries[0][1] };
  }
  const json = entries.find(([contentType]) => contentType.toLowerCase() === "application/json");
  if (json) return { contentType: json[0], template: json[1] };
  return { contentType: entries[0][0], template: entries[0][1] };
}

/**
 * Chooses the request template by Content-Type (default `application/json`
 * when absent), implementing passthrough behavior (spec §5):
 * - `WHEN_NO_MATCH`: unmatched type → pass through unchanged.
 * - `WHEN_NO_TEMPLATES`: no templates → pass through; templates defined but
 *   none match → 415 `UNSUPPORTED_MEDIA_TYPE`.
 * - `NEVER`: unmatched type → 415.
 * Proxy integrations ignore templates (handled by the caller).
 *
 * @param {Record<string,string>} [templates={}]
 * @param {string|null} [contentType=null]
 * @param {string} [passthroughBehavior="WHEN_NO_MATCH"]
 * @returns {{ contentType: string, template: string }|{ passthrough: true }}
 * @throws {GatewayError} 415 UNSUPPORTED_MEDIA_TYPE when the behavior demands it.
 */
export function selectRequestTemplate(templates = {}, contentType = null, passthroughBehavior = "WHEN_NO_MATCH") {
  const entries = Object.entries(templates ?? {});
  const normalized = contentType ? String(contentType).split(";")[0].trim().toLowerCase() : "application/json";
  const exact = entries.find(([key]) => key.toLowerCase() === normalized);
  if (exact) return { contentType: exact[0], template: exact[1] };
  if (entries.length === 0) {
    if (passthroughBehavior === "NEVER") {
      throw new GatewayError("UNSUPPORTED_MEDIA_TYPE", "Unsupported Media Type");
    }
    return { passthrough: true };
  }
  if (passthroughBehavior === "WHEN_NO_MATCH") return { passthrough: true };
  throw new GatewayError("UNSUPPORTED_MEDIA_TYPE", "Unsupported Media Type");
}

function parseAccept(header) {
  if (!header) return [];
  return String(header)
    .split(",")
    .map((part) => {
      const [type, ...params] = part.trim().split(";");
      let quality = 1;
      for (const param of params) {
        const match = param.trim().match(/^q=([0-9.]+)$/);
        if (match) quality = Number(match[1]);
      }
      return { type: type.trim().toLowerCase(), quality };
    })
    .filter((entry) => entry.type.length > 0)
    .sort((a, b) => b.quality - a.quality);
}

/**
 * Applies `$context.responseOverride.*` from a rendered response template:
 * `responseOverride.status` replaces the status code and
 * `responseOverride.header.<n>` replaces/adds headers. Last write wins.
 *
 * @param {{ statusCode?: number, headers?: Record<string,string> }} result
 * @param {object} [templateContext={}]
 * @returns {{ statusCode: number, headers: Record<string,string> }}
 */
export function applyResponseOverrides(result = {}, templateContext = {}) {
  let statusCode = result.statusCode ?? 200;
  const headers = { ...(result.headers ?? {}) };
  const override = templateContext?.responseOverride;
  if (override && typeof override === "object") {
    if (override.status !== null && override.status !== undefined && override.status !== "") {
      const next = Number.parseInt(String(override.status), 10);
      if (Number.isInteger(next) && next >= 100 && next <= 599) statusCode = next;
    }
    for (const [name, value] of Object.entries(override.header ?? {})) {
      headers[name] = String(value ?? "");
    }
  }
  return { statusCode, headers };
}

/**
 * Applies `$context.requestOverride.*` from a rendered request template to
 * the outbound integration request.
 *
 * @param {{ headers?: object, querystring?: object, path?: object }} outbound
 * @param {object} [templateContext={}]
 * @returns {{ headers: object, querystring: object, path: object }}
 */
export function applyRequestOverrides(outbound = {}, templateContext = {}) {
  const headers = { ...(outbound.headers ?? {}) };
  const querystring = { ...(outbound.querystring ?? {}) };
  const path = { ...(outbound.path ?? {}) };
  const override = templateContext?.requestOverride;
  if (override && typeof override === "object") {
    for (const [name, value] of Object.entries(override.header ?? {})) headers[name] = String(value ?? "");
    for (const [name, value] of Object.entries(override.querystring ?? {})) querystring[name] = String(value ?? "");
    for (const [name, value] of Object.entries(override.path ?? {})) path[name] = String(value ?? "");
  }
  return { headers, querystring, path };
}
