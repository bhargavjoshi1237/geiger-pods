/**
 * WebSocket control-plane helpers (S12 §1/§4): API settings validation and
 * the `@connections` control-plane mirror (`pods.connection.manage`).
 *
 * The data-plane registry lives in KV (no Postgres table); this mirror
 * proxies to the runtime via an injected `sender` (tests), a gateway client
 * (`gateway` → control → runtime URL, F38), or returns 410 when no runtime
 * is wired.
 *
 * @module lib/control/websocket
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { resolveApi } from "./apis.mjs";

const MAX_SELECTION_BYTES = 512;
const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);

function checkSelection(value, path) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value || value.length > MAX_SELECTION_BYTES) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${path}: must be a string of 1–512 characters`);
  }
  if (value.includes("__proto__") || value.includes("constructor")) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${path}: invalid expression`);
  }
  return value;
}

void BLOCKED;

/**
 * Validates WebSocket API settings patches.
 *
 * @param {object} input - `routeSelectionExpression`, `apiKeySelectionExpression`.
 * @returns {object} Clean snake_case patch.
 */
export function cleanWebsocketSettings(input) {
  const clean = {};
  if (input.routeSelectionExpression !== undefined) {
    clean.route_selection_expression = checkSelection(input.routeSelectionExpression, "routeSelectionExpression");
  }
  if (input.apiKeySelectionExpression !== undefined) {
    clean.api_key_selection_expression = checkSelection(input.apiKeySelectionExpression, "apiKeySelectionExpression");
  }
  return clean;
}

/**
 * Validates a WebSocket route key (free-form, `$connect`/`$disconnect`/
 * `$default`/custom). `$connect` auth is NONE/SIGNED/CUSTOM; apiKey only
 * on `$connect`.
 *
 * @param {object} input
 */
export function checkWebsocketRoute(input) {
  const key = input.routeKey ?? input.route_key ?? "";
  if (typeof key !== "string" || !key || key.length > 512) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.routeKey: must be a non-empty string of at most 512 characters");
  }
  const auth = input.authorizationType ?? input.authorization_type ?? "NONE";
  if (!["NONE", "SIGNED", "CUSTOM"].includes(auth)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.authorizationType: WebSocket routes support NONE, SIGNED or CUSTOM.");
  }
  if (auth === "CUSTOM" && key !== "$connect") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.authorizationType: WebSocket custom authorizers only apply to $connect.");
  }
  if ((input.apiKeyRequired ?? false) === true && key !== "$connect") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.apiKeyRequired: API keys are only enforced on $connect.");
  }
  return key;
}

async function scopedStage(db, actor, projectId, apiId, stageName) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.connection.manage", { projectId, apiId: api.id });
  if (api.protocol !== "WEBSOCKET") {
    throw new HttpError(400, "capability_unsupported", "Connections are only available on WebSocket APIs.");
  }
  return api;
}

/**
 * Creates a gateway `@connections` sender (F38): control → runtime URL.
 *
 * Signs each request with SigV4 (`execute-api`, `ManageConnections`) so the
 * gateway's `authorizeManageConnections` accepts it, then fetches
 * `{gatewayUrl}/{apiPublicId}/{stage}/@connections/{connectionId}`.
 * Responses map to control-plane results: 2xx → ok, 410 → 410 `gone`,
 * 403 → 403 `forbidden`, 429 → 429, 504 → 504, else 502.
 *
 * @param {{ gatewayUrl: string, apiPublicId: string, stage: string,
 *   accessKeyId: string, secretAccessKey: string, region?: string,
 *   fetchFn?: typeof fetch }} [options={}]
 * @returns {(input: { connectionId: string, method: string, body?: Uint8Array|null, contentType?: string }) => Promise<object>}
 */
export function createGatewayConnectionsSender({
  gatewayUrl,
  apiPublicId,
  stage,
  accessKeyId,
  secretAccessKey,
  region = "auto",
  fetchFn = null,
} = {}) {
  if (!gatewayUrl || !apiPublicId || !stage || !accessKeyId || !secretAccessKey) {
    throw new TypeError("createGatewayConnectionsSender requires gatewayUrl, apiPublicId, stage, accessKeyId and secretAccessKey.");
  }
  const base = String(gatewayUrl).replace(/\/+$/, "");
  const fetchImpl = fetchFn ?? globalThis.fetch;
  return async ({ connectionId, method, body = null, contentType = "application/json" }) => {
    const { signRequest } = await import("../gateway/core/auth/sigv4.mjs");
    const url = `${base}/${encodeURIComponent(apiPublicId)}/${encodeURIComponent(stage)}/@connections/${encodeURIComponent(connectionId)}`;
    const bodyText = body && body.byteLength > 0 ? Buffer.from(body).toString("utf8") : "";
    const signed = await signRequest({
      method,
      url,
      headers: method === "POST" && body ? { "content-type": contentType } : {},
      body: method === "POST" ? bodyText : "",
      service: "execute-api",
      region,
      accessKeyId,
      secretAccessKey,
      timestamp: Date.now(),
    });
    const response = await fetchImpl(signed.url, {
      method,
      headers: signed.headers,
      body: method === "POST" && body && body.byteLength > 0 ? Buffer.from(body) : undefined,
      redirect: "manual",
    });
    if (response.status === 410) throw new HttpError(410, "gone", "Connection does not exist.");
    if (response.status === 403) throw new HttpError(403, "forbidden", "Not authorized to manage this connection.");
    if (response.status === 429) throw new HttpError(429, "throttled", "Too Many Requests");
    if (response.status === 504) throw new HttpError(504, "timeout", "Endpoint request timed out");
    if (response.status >= 200 && response.status < 300) {
      const text = await response.text().catch(() => "");
      if (!text) return { status: response.status };
      try {
        return { status: response.status, body: JSON.parse(text) };
      } catch {
        return { status: response.status, body: text };
      }
    }
    throw new HttpError(502, "gateway_error", `Gateway answered ${response.status}.`);
  };
}

/**
 * Control-plane mirror for `@connections` (S12 §4). `sender` is
 * `async ({ stage, connectionId, method, body, contentType }) → Response-ish`.
 * `gateway` is an F38 client config for `createGatewayConnectionsSender`
 * (`{ gatewayUrl, apiPublicId?, stage?, accessKeyId, secretAccessKey, ... }`;
 * `apiPublicId` defaults to the resolved API's public id, `stage` to the
 * request stage). When neither is wired the mirror 410s (preserved).
 *
 * @param {object} db
 * @param {object} actor
 * @param {object} input
 */
export async function manageConnection(db, actor, { projectId, apiId, stage, connectionId, method, body = null, contentType = "application/json", sender = null, gateway = null }) {
  const api = await scopedStage(db, actor, projectId, apiId, stage);
  if (!connectionId || typeof connectionId !== "string" || connectionId.length > 128) {
    throw new HttpError(404, "not_found", "Connection does not exist.");
  }
  if (body && body.byteLength > 128 * 1024) {
    throw new HttpError(413, "too_large", "Request Too Long");
  }
  if (typeof sender === "function") {
    return sender({ stage, connectionId, method, body, contentType });
  }
  if (gateway && gateway.gatewayUrl && gateway.accessKeyId && gateway.secretAccessKey) {
    const send = createGatewayConnectionsSender({
      gatewayUrl: gateway.gatewayUrl,
      apiPublicId: gateway.apiPublicId ?? api.public_id ?? api.publicId ?? api.id,
      stage: gateway.stage ?? stage,
      accessKeyId: gateway.accessKeyId,
      secretAccessKey: gateway.secretAccessKey,
      region: gateway.region,
      fetchFn: gateway.fetchFn ?? null,
    });
    return send({ connectionId, method, body, contentType });
  }
  throw new HttpError(410, "gone", "Connection does not exist.");
}
