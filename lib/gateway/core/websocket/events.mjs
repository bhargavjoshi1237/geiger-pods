/**
 * WebSocket FUNCTION_PROXY event builders (S12 §3).
 *
 * `$connect` events carry headers/query; MESSAGE events carry the raw body
 * plus the `$connect` authorizer context; `$disconnect` carries the close
 * code/reason. Responses are `{statusCode, body}` or a plain body.
 *
 * @module lib/gateway/core/websocket/events
 */

/**
 * @param {object} input
 * @returns {object} CONNECT proxy event.
 */
export function buildConnectEvent({
  routeKey = "$connect",
  stage = "",
  connectedAt = 0,
  requestTimeEpoch = 0,
  requestTime = "",
  requestId = "",
  extendedRequestId = "",
  connectionId = "",
  apiId = "",
  domainName = "",
  sourceIp = "",
  userAgent = "",
  headers = {},
  multiValueHeaders = {},
  queryStringParameters = null,
  multiValueQueryStringParameters = null,
  authorizer = null,
}) {
  return {
    headers,
    multiValueHeaders,
    queryStringParameters,
    multiValueQueryStringParameters,
    requestContext: {
      routeKey,
      eventType: "CONNECT",
      extendedRequestId,
      requestTime,
      stage,
      connectedAt,
      requestTimeEpoch,
      identity: { sourceIp, userAgent },
      requestId,
      domainName,
      connectionId,
      apiId,
      ...(authorizer ? { authorizer } : {}),
    },
  };
}

/**
 * @param {object} input
 * @returns {object} MESSAGE proxy event.
 */
export function buildMessageEvent({
  routeKey = "$default",
  stage = "",
  connectedAt = 0,
  requestTimeEpoch = 0,
  requestTime = "",
  requestId = "",
  extendedRequestId = "",
  messageId = "",
  connectionId = "",
  apiId = "",
  domainName = "",
  sourceIp = "",
  userAgent = "",
  authorizer = null,
  body = "",
  isBase64Encoded = false,
}) {
  return {
    requestContext: {
      routeKey,
      eventType: "MESSAGE",
      messageId,
      extendedRequestId,
      requestTime,
      messageDirection: "IN",
      stage,
      connectedAt,
      requestTimeEpoch,
      identity: { sourceIp, userAgent },
      requestId,
      domainName,
      connectionId,
      apiId,
      ...(authorizer ? { authorizer } : {}),
    },
    body,
    isBase64Encoded,
  };
}

/**
 * @param {object} input
 * @returns {object} DISCONNECT proxy event.
 */
export function buildDisconnectEvent({
  stage = "",
  connectedAt = 0,
  requestTimeEpoch = 0,
  requestTime = "",
  requestId = "",
  extendedRequestId = "",
  connectionId = "",
  apiId = "",
  domainName = "",
  sourceIp = "",
  userAgent = "",
  authorizer = null,
  disconnectStatusCode = 1000,
  disconnectReason = "",
}) {
  return {
    requestContext: {
      routeKey: "$disconnect",
      eventType: "DISCONNECT",
      extendedRequestId,
      requestTime,
      stage,
      connectedAt,
      requestTimeEpoch,
      identity: { sourceIp, userAgent },
      requestId,
      domainName,
      connectionId,
      apiId,
      ...(authorizer ? { authorizer } : {}),
    },
    disconnectStatusCode,
    disconnectReason,
  };
}

/**
 * Normalizes a two-way function response to a frame string.
 * `{statusCode, body}` or a plain body; non-2xx → null (caller rejects).
 *
 * @param {unknown} parsed - JSON-parsed function output.
 * @returns {{ ok: boolean, status: number|null, frame: string|null }}
 */
export function normalizeFunctionResponse(parsed) {
  if (parsed === null || parsed === undefined) return { ok: true, status: 200, frame: null };
  if (typeof parsed === "string") return { ok: true, status: 200, frame: parsed };
  if (typeof parsed === "object" && !Array.isArray(parsed)) {
    if (Object.hasOwn(parsed, "statusCode")) {
      const status = Number(parsed.statusCode);
      if (!Number.isInteger(status)) return { ok: false, status: null, frame: null };
      if (status < 200 || status >= 300) return { ok: false, status, frame: null };
      const body = parsed.body ?? "";
      const frame = typeof body === "string" ? body : JSON.stringify(body);
      return { ok: true, status, frame: frame ?? "" };
    }
    return { ok: true, status: 200, frame: JSON.stringify(parsed) };
  }
  return { ok: true, status: 200, frame: String(parsed) };
}
