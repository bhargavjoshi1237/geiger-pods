/**
 * Access-log formatting (S10 §3).
 *
 * Stage setting `stages.access_log = { enabled, format, destinations }`.
 * The format is a string with `$context.*` variables (≤ 3 KB, AWS). Presets
 * match the AWS console exactly. Validation: the format must contain
 * `$context.requestId` or `$context.extendedRequestId`; unknown variables
 * are rejected with 422 at write time (never at runtime, where they render
 * as `""`).
 *
 * @module lib/gateway/core/observe/access-log
 */

import { HttpError } from "../../../control/errors.mjs";

export const MAX_FORMAT_BYTES = 3 * 1024;

export const PRESETS = {
  CLF: "$context.identity.sourceIp $context.identity.caller $context.identity.user [$context.requestTime] \"$context.httpMethod $context.resourcePath $context.protocol\" $context.status $context.responseLength $context.requestId",
  JSON: "{ \"requestId\":\"$context.requestId\", \"ip\": \"$context.identity.sourceIp\", \"caller\":\"$context.identity.caller\", \"user\":\"$context.identity.user\",\"requestTime\":\"$context.requestTime\", \"httpMethod\":\"$context.httpMethod\",\"resourcePath\":\"$context.resourcePath\", \"status\":\"$context.status\",\"protocol\":\"$context.protocol\", \"responseLength\":\"$context.responseLength\" }",
  XML: "<request id=\"$context.requestId\"><ip>$context.identity.sourceIp</ip><caller>$context.identity.caller</caller><user>$context.identity.user</user><requestTime>$context.requestTime</requestTime><httpMethod>$context.httpMethod</httpMethod><resourcePath>$context.resourcePath</resourcePath><status>$context.status</status><protocol>$context.protocol</protocol><responseLength>$context.responseLength</responseLength></request>",
  CSV: "$context.requestId,$context.identity.sourceIp,$context.identity.caller,$context.identity.user,$context.requestTime,$context.httpMethod,$context.resourcePath,$context.status,$context.protocol,$context.responseLength",
};

/**
 * Variables the access-log format may reference (S01 §4 catalog subset used
 * by the AWS console presets, plus the full list below for validation).
 */
export const KNOWN_VARIABLES = new Set(
  [
    "context.requestId", "context.extendedRequestId", "context.requestTime", "context.requestTimeEpoch",
    "context.accountId", "context.apiId", "context.stage", "context.deploymentId",
    "context.domainName", "context.domainPrefix", "context.httpMethod", "context.path",
    "context.resourcePath", "context.resourceId", "context.routeKey", "context.protocol",
    "context.identity.sourceIp", "context.identity.userAgent", "context.identity.apiKey",
    "context.identity.apiKeyId", "context.identity.caller", "context.identity.user",
    "context.identity.userArn", "context.identity.accessKey",
    "context.authorizer.principalId", "context.authorizer.status", "context.authorizer.latency",
    "context.authorizer.error", "context.authorizer.requestId",
    "context.authenticate.error", "context.authenticate.latency", "context.authenticate.status",
    "context.integration.status", "context.integration.latency", "context.integration.error",
    "context.integration.requestId", "context.integration.integrationStatus",
    "context.integrationLatency", "context.integrationStatus",
    "context.responseLatency", "context.responseLength", "context.status",
    "context.error.message", "context.error.messageString", "context.error.responseType",
    "context.error.validationErrorString",
    "context.waf.error", "context.waf.latency", "context.waf.status",
    "context.wafResponseCode", "context.webaclArn",
    "context.traceId", "context.isCanaryRequest",
    "context.connectionId", "context.connectedAt", "context.eventType",
    "context.messageId", "context.messageDirection",
    "context.customDomain.basePathMatched", "context.customDomain.routingRuleIdMatched",
  ].map((name) => `$${name}`),
);

/**
 * Extracts `$context.*` variable references from a format string.
 *
 * @param {string} format
 * @returns {Array<string>}
 */
export function variablesInFormat(format) {
  const out = [];
  const pattern = /\$context(?:\.[A-Za-z0-9_]+)+/g;
  let match = pattern.exec(String(format ?? ""));
  while (match) {
    out.push(match[0]);
    match = pattern.exec(String(format ?? ""));
  }
  return [...new Set(out)];
}

/**
 * Validates an access-log format (write path; throws HttpError 422/413).
 *
 * @param {string} format
 * @returns {{ variables: Array<string> }} The referenced variables.
 * @throws {import("../../../control/errors.mjs").HttpError} 422/413.
 */
export function validateAccessLogFormat(format) {
  if (typeof format !== "string" || format.length === 0) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.format: must be a non-empty string");
  }
  if (Buffer.byteLength(format, "utf8") > MAX_FORMAT_BYTES) {
    throw new HttpError(413, "body_too_large", "Access-log format exceeds the 3 KB limit.");
  }
  const variables = variablesInFormat(format);
  const hasId = variables.some((name) =>
    name === "$context.requestId" || name === "$context.extendedRequestId");
  if (!hasId) {
    throw new HttpError(422, "invalid_input", "Access-log format must contain $context.requestId or $context.extendedRequestId.");
  }
  const unknown = variables.filter((name) => {
    if (KNOWN_VARIABLES.has(name)) return false;
    // Allow deeper authorizer/claim paths (e.g. $context.authorizer.claims.sub).
    return !(
      name.startsWith("$context.authorizer.claims.") ||
      name.startsWith("$context.authorizer.")
    );
  });
  if (unknown.length > 0) {
    throw new HttpError(422, "invalid_input", `Unknown $context variable in access-log format: ${unknown[0]}`, { errors: unknown });
  }
  return { variables };
}

function lookupPath(root, segments) {
  let current = root;
  for (const segment of segments) {
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") return undefined;
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Renders one access-log line for a finished request.
 * Unknown variables render as `""` (validation happens at write time).
 *
 * @param {string} format - Validated format string.
 * @param {object} ctx - Pipeline context (with `context`).
 * @returns {string}
 */
export function renderAccessLog(format, ctx) {
  const root = { context: ctx?.context ?? {} };
  // Lazily quote error.messageString so late-set errors stay consistent.
  const message = lookupPath(root, ["context", "error", "message"]);
  const messageString = JSON.stringify(typeof message === "string" ? message : "");
  return String(format ?? "").replace(/\$context(?:\.[A-Za-z0-9_]+)+/g, (name) => {
    if (name === "$context.error.messageString") return messageString;
    const value = lookupPath(root, name.slice(1).split("."));
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  });
}

/**
 * Splits a rendered line into searchable fields for `pods.access_logs`.
 *
 * @param {object} event - S10 §1 request event.
 * @param {string} line - Rendered access-log line.
 * @returns {{ project_id: string, api_id: string, stage: string, ts: string,
 *   request_id: string, status: number|null, route: string|null,
 *   source_ip: string|null, line: string, fields: object }}
 */
export function toAccessLogRow(event, line) {
  return {
    project_id: String(event?.projectId ?? ""),
    api_id: String(event?.apiId ?? ""),
    stage: String(event?.stage ?? ""),
    ts: event?.ts ?? new Date().toISOString(),
    request_id: String(event?.requestId ?? ""),
    status: event?.status ?? null,
    route: event?.routeKey || event?.resourcePath || null,
    source_ip: event?.sourceIp || null,
    line: String(line ?? ""),
    fields: {
      extendedRequestId: event?.extendedRequestId ?? null,
      httpMethod: event?.httpMethod ?? null,
      canary: Boolean(event?.canary),
      latencyMs: event?.latencyMs ?? null,
      traceId: event?.traceId ?? null,
    },
  };
}
