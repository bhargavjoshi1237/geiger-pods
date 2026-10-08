/**
 * WebSocket model validation (S12 §2 + S06 draft-04).
 *
 * `model_selection_expression` picks the model; failure returns the AWS
 * error frame and skips the integration.
 *
 * @module lib/gateway/core/websocket/validate
 */

import AjvDraft04 from "ajv-draft-04";

const MAX_EXPRESSION_BYTES = 512;

/**
 * Selects the model name for a message.
 *
 * @param {string|null} expression - e.g. `$request.body.model` or `$default`.
 * @param {{ json: object|null, isJson: boolean }} parsed
 * @returns {string|null}
 */
export function selectModel(expression, parsed) {
  if (typeof expression !== "string" || !expression) return null;
  if (expression.length > MAX_EXPRESSION_BYTES) return null;
  const trimmed = expression.trim();
  if (trimmed === "$default") return "$default";
  const match = trimmed.match(/^\$?\{?\$?request\.body\.?([^}]*)\}?$/);
  if (!match) return null;
  const path = (match[1] ?? "").trim().replace(/^[.\s]+|[}\s]+$/g, "");
  if (!path || ["__proto__", "constructor", "prototype"].includes(path)) return null;
  if (!parsed?.isJson || !parsed.json || typeof parsed.json !== "object") return null;
  if (!Object.hasOwn(parsed.json, path)) return null;
  const value = parsed.json[path];
  return typeof value === "string" && value ? value : null;
}

/**
 * Validates a message body against the route's models.
 *
 * @param {{ route?: object, models?: Record<string, { schema: object }>, bodyText: string, parsed: object }} input
 * @returns {{ ok: boolean, errorFrame: string|null, model: string|null }}
 */
export function validateWsMessage({ route = {}, models = {}, bodyText = "", parsed = null } = {}) {
  const requestModels = route?.requestModels ?? route?.request_models ?? {};
  const names = Object.values(requestModels).filter((name) => typeof name === "string" && name);
  if (names.length === 0) return { ok: true, errorFrame: null, model: null };
  const expression = route?.modelSelectionExpression ?? route?.model_selection_expression ?? "$default";
  let selected = selectModel(expression, parsed);
  if (!selected || selected === "$default") selected = names[0] ?? null;
  if (!selected) return { ok: true, errorFrame: null, model: null };
  const entry = models[selected];
  if (!entry) return { ok: true, errorFrame: null, model: selected };
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { ok: false, errorFrame: JSON.stringify({ message: "Could not parse request body into json" }), model: selected };
  }
  try {
    const ajv = new AjvDraft04({ allErrors: true, strict: false });
    const validate = ajv.compile(entry.schema ?? {});
    if (!validate(body)) {
      const detail = (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`.trim()).join("; ").slice(0, 500);
      return { ok: false, errorFrame: JSON.stringify({ message: `Could not validate request body: ${detail}` }), model: selected };
    }
  } catch {
    return { ok: false, errorFrame: JSON.stringify({ message: "Could not validate request body" }), model: selected };
  }
  return { ok: true, errorFrame: null, model: selected };
}
