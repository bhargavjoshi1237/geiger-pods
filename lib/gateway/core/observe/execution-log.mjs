/**
 * Execution logs (S10 §4, REST/WS).
 *
 * Per-method/route `loggingLevel` (`OFF | ERROR | INFO`) plus
 * `dataTraceEnabled`, stored in `stages.method_settings` / `route_settings`.
 * Each pipeline phase appends lines through `ctx.trace(level, message)` in
 * the AWS message vocabulary. Redaction always applies, even with data
 * trace on. Bodies are included only when `dataTraceEnabled`, truncated to
 * 1 KB each.
 *
 * @module lib/gateway/core/observe/execution-log
 */

export const LOG_LEVELS = ["OFF", "ERROR", "INFO"];
export const DATA_TRACE_BODY_LIMIT = 1024;

const LEVEL_RANK = { OFF: 0, ERROR: 1, INFO: 2 };

/**
 * Returns true when a line at `lineLevel` should be kept for `configured`.
 *
 * @param {string} configured - `OFF | ERROR | INFO`.
 * @param {string} lineLevel - `ERROR | INFO`.
 * @returns {boolean}
 */
export function levelEnabled(configured, lineLevel) {
  return (LEVEL_RANK[lineLevel] ?? 0) <= (LEVEL_RANK[configured] ?? 0) && (LEVEL_RANK[configured] ?? 0) > 0;
}

const ALWAYS_MASKED_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);

/**
 * Masks a header value for execution logs. `x-api-key` shows the last 4
 * chars; always-masked headers and any `backend_auth`-injected header or
 * resolved-secret value render as `****`.
 *
 * @param {string} name - Header name.
 * @param {string} value - Header value.
 * @param {{ backendAuthHeaders?: Array<string>, secretValues?: Array<string> }} [options={}]
 * @returns {string}
 */
export function maskHeaderValue(name, value, { backendAuthHeaders = [], secretValues = [] } = {}) {
  const lower = String(name ?? "").toLowerCase();
  const text = String(value ?? "");
  if (secretValues.includes(text) && text.length > 0) return "****";
  if (ALWAYS_MASKED_HEADERS.has(lower)) return "****";
  if (lower === "x-api-key") {
    return text.length <= 4 ? "****" : `****${text.slice(-4)}`;
  }
  if (backendAuthHeaders.map((entry) => String(entry).toLowerCase()).includes(lower)) return "****";
  for (const secret of secretValues) {
    if (secret && text.includes(secret)) return "****";
  }
  return text;
}

/**
 * Masks secret-looking values inside free text (query strings, log lines).
 *
 * @param {string} text
 * @param {{ secretValues?: Array<string> }} [options={}]
 * @returns {string}
 */
export function maskSecretsInText(text, { secretValues = [] } = {}) {
  let out = String(text ?? "");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1****");
  out = out.replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)["']?[^"'&\s,}]+["']?/gi, "$1****");
  for (const secret of secretValues) {
    if (secret && out.includes(secret)) out = out.split(secret).join("****");
  }
  return out;
}

/**
 * Formats headers for an execution-log line with redaction applied.
 *
 * @param {Headers|Record<string,string>|Array<[string,string]>} headers
 * @param {{ backendAuthHeaders?: Array<string>, secretValues?: Array<string> }} [options={}]
 * @returns {string} `{name=value, ...}` with values masked.
 */
export function formatMaskedHeaders(headers, options = {}) {
  const entries = [];
  if (typeof headers?.entries === "function" && typeof headers?.get !== "function") {
    // Plain object without Headers API.
  }
  if (typeof headers?.forEach === "function") {
    headers.forEach((value, key) => entries.push([key, value]));
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) entries.push([key, value]);
  } else if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) entries.push([key, value]);
  }
  const masked = {};
  for (const [key, value] of entries) {
    masked[key] = maskHeaderValue(key, Array.isArray(value) ? value.join(",") : value, options);
  }
  return JSON.stringify(masked);
}

/**
 * Truncates a body for data trace (1 KB) with redaction.
 *
 * @param {string|null|undefined} body
 * @param {{ dataTraceEnabled?: boolean, secretValues?: Array<string> }} [options={}]
 * @returns {string|null} Null when data trace is off or there is no body.
 */
export function traceBody(body, { dataTraceEnabled = false, secretValues = [] } = {}) {
  if (!dataTraceEnabled) return null;
  if (body === null || body === undefined || body === "") return null;
  return maskSecretsInText(String(body).slice(0, DATA_TRACE_BODY_LIMIT), { secretValues });
}

/**
 * In-memory execution-log buffer for one request. Phases call
 * `collector.trace(level, message)`; `lines` keeps `{ level, message, ts }`.
 *
 * @param {{ loggingLevel?: string }} [options={}]
 * @returns {{ trace(level: string, message: string): void, lines: Array<{ level: string, message: string, ts: string }>,
 *   forLevel(level: string): Array<{ level: string, message: string }> }}
 */
export function createExecutionLogCollector({ loggingLevel = "INFO" } = {}) {
  const lines = [];
  return {
    lines,
    /**
     * Appends one execution-log line (always stored; level filtering
     * happens at write time so ERROR-only stages keep failures).
     * @param {string} level - `ERROR | INFO`.
     * @param {string} message
     * @param {{ dataTrace?: boolean }} [flags={}] - `dataTrace` marks body
     *   lines so readers without `pods.logs.data` can strip them.
     */
    trace(level, message, flags = {}) {
      lines.push({
        level: String(level ?? "INFO").toUpperCase(),
        message: String(message ?? ""),
        ts: new Date().toISOString(),
        ...(flags?.dataTrace ? { dataTrace: true } : {}),
      });
    },
    /**
     * Returns lines visible at `level` (`OFF` → none).
     * @param {string} level - `OFF | ERROR | INFO`.
     */
    forLevel(level) {
      void loggingLevel;
      return lines.filter((line) => levelEnabled(level, line.level));
    },
  };
}

/**
 * Builds the standard AWS-vocabulary opening lines for a request.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Array<[string, string]>} `[level, message]` pairs.
 */
export function openingLines(ctx) {
  const requestId = ctx?.context?.extendedRequestId ?? ctx?.requestId ?? "";
  return [["INFO", `Extended Request Id: ${requestId}`]];
}

/**
 * Builds the standard AWS-vocabulary transcript for a finished request, in
 * AWS order: extended id → usage-plan verification → method request
 * (path/query/headers/body) → endpoint request (URI/headers/body) → send →
 * received → endpoint response (headers/body) → method response
 * (headers/body) → completion. Bodies appear only with `dataTraceEnabled`
 * (1 KB, redacted) and are flagged `{ dataTrace: true }`.
 *
 * Each entry is `[level, message, flags?]`; convert with {@link toLogLines}.
 *
 * @param {{ extendedRequestId?: string, httpMethod?: string, resourcePath?: string,
 *   path?: object, query?: object, requestHeaders?: object, requestBody?: string|null,
 *   apiKeyId?: string|null, authorizer?: { status?: string|number, latencyMs?: number|null }|null,
 *   cache?: string|null, throttled?: boolean,
 *   endpointUri?: string|null, endpointHeaders?: object|null, endpointBody?: string|null,
 *   integrationLatencyMs?: number|null, integrationStatus?: string|number|null,
 *   responseHeaders?: object|null, responseBody?: string|null, status?: string|number|null,
 *   error?: string|null }} fields
 * @param {{ dataTraceEnabled?: boolean, secretValues?: Array<string>, backendAuthHeaders?: Array<string> }} [options={}]
 * @returns {Array<[string, string, object?]>}
 */
export function buildVocabularyTranscript(fields = {}, options = {}) {
  const { dataTraceEnabled = false, secretValues = [], backendAuthHeaders = [] } = options;
  const redactOptions = { secretValues, backendAuthHeaders };
  const lines = [];
  const info = (message, flags) => lines.push(["INFO", message, flags]);
  const requestId = fields.extendedRequestId ?? "";
  info(`Extended Request Id: ${requestId}`);
  if (fields.apiKeyId) {
    info(`Verifying Usage Plan for request: ${requestId}. API Key: ****${String(fields.apiKeyId).slice(-4)}`);
  }
  if (fields.authorizer && (fields.authorizer.status !== undefined || fields.authorizer.latencyMs != null)) {
    const latency = fields.authorizer.latencyMs ?? "";
    info(`Authorizer result: status=${fields.authorizer.status ?? ""}, latency=${latency} ms`);
  }
  if (fields.cache === "hit") info("Cache hit for the request");
  else if (fields.cache === "miss") info("Cache miss for the request");
  if (fields.throttled) info("Request throttled");
  if (fields.httpMethod || fields.resourcePath) {
    info(`Method request path: ${maskSecretsInText(JSON.stringify({ resourcePath: fields.resourcePath ?? "", ...(fields.path ?? {}) }), { secretValues })}`);
  }
  if (fields.query !== undefined && fields.query !== null) {
    info(`Method request query string: ${maskSecretsInText(JSON.stringify(fields.query), { secretValues })}`);
  }
  if (fields.requestHeaders) {
    info(`Method request headers: ${formatMaskedHeaders(fields.requestHeaders, redactOptions)}`);
  }
  const requestBody = traceBody(fields.requestBody, { dataTraceEnabled, secretValues });
  if (requestBody !== null) {
    info(`Method request body before transformations: ${requestBody}`, { dataTrace: true });
  }
  if (fields.endpointUri) {
    info(`Endpoint request URI: ${maskSecretsInText(String(fields.endpointUri), { secretValues })}`);
  }
  if (fields.endpointHeaders) {
    info(`Endpoint request headers: ${formatMaskedHeaders(fields.endpointHeaders, redactOptions)}`);
  }
  const endpointBody = traceBody(fields.endpointBody, { dataTraceEnabled, secretValues });
  if (endpointBody !== null) {
    info(`Endpoint request body after transformations: ${endpointBody}`, { dataTrace: true });
  }
  if (fields.endpointUri) {
    info(`Sending request to ${maskSecretsInText(String(fields.endpointUri), { secretValues })}`);
  }
  info(`Received response. Status: ${fields.integrationStatus ?? fields.status ?? ""}, Integration latency: ${fields.integrationLatencyMs ?? ""} ms`);
  if (fields.responseHeaders) {
    info(`Endpoint response headers: ${formatMaskedHeaders(fields.responseHeaders, redactOptions)}`);
  }
  const responseBody = traceBody(fields.responseBody, { dataTraceEnabled, secretValues });
  if (responseBody !== null) {
    info(`Endpoint response body before transformations: ${responseBody}`, { dataTrace: true });
    info(`Method response body after transformations: ${responseBody}`, { dataTrace: true });
  }
  if (fields.responseHeaders) {
    info(`Method response headers: ${formatMaskedHeaders(fields.responseHeaders, redactOptions)}`);
  }
  if (fields.error) {
    lines.push(["ERROR", maskSecretsInText(String(fields.error), { secretValues })]);
  }
  info("Successfully completed execution");
  info(`Method completed with status: ${fields.status ?? ""}`);
  return lines.map(([level, message, flags]) => (flags ? [level, message, flags] : [level, message]));
}

/**
 * Converts transcript tuples to storable line objects.
 *
 * @param {Array<[string, string, object?]>} pairs
 * @returns {Array<{ level: string, message: string, ts: string }>}
 */
export function toLogLines(pairs) {
  return (pairs ?? []).map(([level, message, flags]) => ({
    level: String(level ?? "INFO").toUpperCase(),
    message: String(message ?? ""),
    ts: new Date().toISOString(),
    ...(flags?.dataTrace ? { dataTrace: true } : {}),
  }));
}
/**
 * Converts a collector buffer to a `pods.execution_logs` row.
 *
 * @param {object} event - S10 §1 request event.
 * @param {Array<{ level: string, message: string, ts?: string }>} lines
 * @param {{ loggingLevel?: string }} [options={}]
 * @returns {object|null} Null when nothing is visible at `loggingLevel`.
 */
export function toExecutionLogRow(event, lines, { loggingLevel = "INFO" } = {}) {
  const visible = (lines ?? []).filter((line) => levelEnabled(loggingLevel, line.level));
  if (visible.length === 0) return null;
  return {
    project_id: String(event?.projectId ?? ""),
    api_id: String(event?.apiId ?? ""),
    stage: String(event?.stage ?? ""),
    request_id: String(event?.requestId ?? ""),
    ts: event?.ts ?? new Date().toISOString(),
    level: loggingLevel,
    lines: visible,
    data_trace: visible.some((line) => line?.dataTrace === true),
  };
}
