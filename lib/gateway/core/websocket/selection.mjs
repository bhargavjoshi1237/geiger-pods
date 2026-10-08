/**
 * Route selection and selection-expression evaluation (S12 §1–§2).
 *
 * Expressions: `$request.body.action`, `${request.body.action}` style and
 * `$request.body.foo.bar` paths. Non-JSON bodies, missing paths and unknown
 * keys fall back to `$default`. Prototype-pollution keys are rejected and
 * input sizes are bounded.
 *
 * @module lib/gateway/core/websocket/selection
 */

const MAX_EXPRESSION_BYTES = 512;
const MAX_BODY_BYTES = 128 * 1024;
const BLOCKED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Parses a raw message into JSON when possible (bounded).
 *
 * @param {string|Uint8Array|Buffer|null} body
 * @returns {{ text: string, json: object|null, isJson: boolean }}
 */
export function parseMessageBody(body) {
  const text = typeof body === "string"
    ? body
    : body instanceof Uint8Array || Buffer.isBuffer?.(body)
      ? Buffer.from(body).toString("utf8")
      : String(body ?? "");
  if (text.length === 0 || text.length > MAX_BODY_BYTES) return { text, json: null, isJson: false };
  try {
    const json = JSON.parse(text);
    if (json !== null && typeof json === "object") return { text, json, isJson: true };
    return { text, json: null, isJson: false };
  } catch {
    return { text, json: null, isJson: false };
  }
}

/**
 * Extracts the body path from a selection expression.
 * Returns null when the expression is not a `$request.body.*` form.
 *
 * @param {string|null} expression
 * @returns {Array<string>|null}
 */
export function bodyPathOf(expression) {
  if (typeof expression !== "string") return null;
  if (expression.length > MAX_EXPRESSION_BYTES) return null;
  const trimmed = expression.trim();
  // `${request.body.action}` style.
  let inner = null;
  const wrapped = trimmed.match(/^\$\{(.+)\}$/);
  if (wrapped) inner = wrapped[1].trim();
  else if (trimmed.startsWith("$request.body")) inner = trimmed;
  else if (trimmed.startsWith("request.body")) inner = trimmed;
  else return null;
  const bodyMatch = inner.match(/^(?:\$)?request\.body\.?(.*)$/);
  if (!bodyMatch) return null;
  const rest = (bodyMatch[1] ?? "").trim();
  if (!rest) return [];
  const segments = rest.split(".");
  for (const segment of segments) {
    if (!segment || BLOCKED_SEGMENTS.has(segment)) return null;
    if (segment.length > 128) return null;
  }
  return segments;
}

/**
 * Evaluates a route selection expression against a message.
 *
 * @param {string|null} expression - e.g. `$request.body.action`.
 * @param {{ text: string, json: object|null, isJson: boolean }} parsed
 * @returns {string|null} Selected route key, or null when it does not select.
 */
export function evaluateSelection(expression, parsed) {
  if (typeof expression !== "string" || !expression) return null;
  if (expression.trim() === "$default") return "$default";
  const path = bodyPathOf(expression);
  if (path === null) return null;
  if (!parsed?.isJson || !parsed.json) return null;
  if (path.length === 0) return null;
  let current = parsed.json;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return null;
    if (!Object.hasOwn(current, segment)) return null;
    current = current[segment];
  }
  if (typeof current !== "string" || !current) return null;
  if (current.length > 512) return null;
  if (current.includes("\0")) return null;
  return current;
}

/**
 * Selects the route for a message: expression → key → `$default` fallback.
 *
 * @param {{ routeSelectionExpression?: string|null, routes?: Array<{ routeKey: string }> }} artifact
 * @param {string|Uint8Array} body
 * @returns {{ routeKey: string|null, selected: string|null, matched: boolean }}
 */
export function selectRoute(artifact, body) {
  const routes = artifact?.routes ?? [];
  const byKey = new Map(routes.map((route) => [route.routeKey, route]));
  const parsed = parseMessageBody(body);
  const expression = artifact?.settings?.routeSelectionExpression
    ?? artifact?.routeSelectionExpression
    ?? "$request.body.action";
  const selected = evaluateSelection(expression, parsed);
  if (selected && byKey.has(selected)) return { routeKey: selected, selected, matched: true };
  if (byKey.has("$default")) {
    return { routeKey: "$default", selected, matched: Boolean(selected && selected === "$default") };
  }
  return { routeKey: null, selected, matched: false };
}

/**
 * Builds the Forbidden error frame for a message with no route.
 *
 * @param {{ connectionId: string, requestId: string }} ids
 * @returns {string}
 */
export function forbiddenFrame({ connectionId, requestId }) {
  return JSON.stringify({ message: "Forbidden", connectionId, requestId });
}

/**
 * Builds the generic integration-failure error frame.
 *
 * @param {{ connectionId: string, requestId: string }} ids
 * @returns {string}
 */
export function integrationErrorFrame({ connectionId, requestId }) {
  return JSON.stringify({ message: "Internal server error", connectionId, requestId });
}
