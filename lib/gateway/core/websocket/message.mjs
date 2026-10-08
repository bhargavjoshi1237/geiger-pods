/**
 * Per-message handling: selection → throttle/quota → validation → invoke.
 *
 * Two-way routes (`route_response_selection_expression = $default`) return
 * the integration response frame; one-way routes return null. Failures
 * return the AWS error frames without invoking.
 *
 * @module lib/gateway/core/websocket/message
 */

import { GatewayError } from "../errors.mjs";
import { selectRoute, forbiddenFrame, integrationErrorFrame } from "./selection.mjs";
import { parseMessageBody } from "./selection.mjs";
import { validateWsMessage } from "./validate.mjs";
import { buildMessageEvent, normalizeFunctionResponse } from "./events.mjs";
import { invokeMock } from "../integrations/mock.mjs";

/**
 * Invokes a WS integration for a message. Supports MOCK, HTTP_PROXY/HTTP
 * (via `ports.fetch`) and FUNCTION_PROXY (webhook POST of the S12 event).
 *
 * @param {object} ctx
 * @param {object} integration
 * @param {object} event - S12 proxy event.
 * @param {string} bodyText
 * @returns {Promise<{ status: number, frame: string|null }>}
 */
export async function invokeWsIntegration(ctx, integration, event, bodyText) {
  const type = integration?.type ?? "MOCK";
  const ports = ctx?.ports ?? {};
  const fetchFn = ports.fetch ?? globalThis.fetch;
  if (type === "MOCK") {
    const template = integration?.mockTemplate ?? integration?.mock_template ?? null;
    const out = await invokeMock(ctx, integration, { renderedTemplate: template });
    // Non-2xx MOCK statuses are returned (the `$connect` caller rejects
    // with that status; MESSAGE callers map them to the error frame).
    if (out.status < 200 || out.status >= 300) return { status: out.status, frame: null };
    const payload = out.mockPayload;
    if (payload === null || payload === undefined) return { status: out.status, frame: null };
    if (typeof payload.body === "string") return { status: out.status, frame: payload.body };
    if (typeof payload === "string") return { status: out.status, frame: payload };
    if (typeof payload === "object" && payload !== null && typeof payload.body !== "undefined") {
      return { status: out.status, frame: typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body) };
    }
    return { status: out.status, frame: JSON.stringify(payload) };
  }
  if (type === "FUNCTION_PROXY" || type === "FUNCTION") {
    const fn = integration?.function ?? {};
    const url = fn.url ?? integration?.uri ?? null;
    if (!url) throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
    const timeoutMs = integration?.timeoutMs ?? integration?.timeout_ms ?? 29000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("integration-timeout")), timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal,
        redirect: "manual",
      });
      const text = await response.text();
      if (!response.ok) throw new GatewayError("INTEGRATION_FAILURE", "Internal server error");
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        return { status: 200, frame: text };
      }
      const normalized = normalizeFunctionResponse(parsed);
      // S12: non-2xx function `statusCode` is returned (the `$connect`
      // caller rejects the upgrade with that status; MESSAGE callers
      // treat it as an integration failure).
      if (!normalized.ok) return { status: normalized.status ?? 500, frame: null };
      return { status: normalized.status ?? 200, frame: normalized.frame };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      const message = String(error?.message ?? error);
      if (message === "integration-timeout" || error?.name === "AbortError") {
        throw new GatewayError("INTEGRATION_TIMEOUT", "Endpoint request timed out");
      }
      throw new GatewayError("INTEGRATION_FAILURE", "Internal server error");
    } finally {
      clearTimeout(timer);
    }
  }
  // HTTP_PROXY / HTTP / AWS_SERVICE: POST the raw body.
  const uri = integration?.uri ?? null;
  if (!uri) throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  const timeoutMs = integration?.timeoutMs ?? integration?.timeout_ms ?? 29000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("integration-timeout")), timeoutMs);
  try {
    const response = await fetchFn(uri, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyText,
      signal: controller.signal,
      redirect: "manual",
    });
    const text = await response.text();
    if (!response.ok) throw new GatewayError("INTEGRATION_FAILURE", "Internal server error");
    return { status: response.status, frame: text };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("INTEGRATION_FAILURE", "Internal server error");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Handles one complete message against the artifact.
 *
 * @param {object} options
 * @param {object} options.artifact
 * @param {string|Uint8Array} options.body
 * @param {boolean} [options.isBase64=false]
 * @param {object} options.record - Connection record (authorizer context, ids).
 * @param {object} options.ctxBase - Base pipeline ctx for throttle/quota + ports.
 * @returns {Promise<{ routeKey: string|null, frame: string|null, error: string|null, status: number, messageId: string, requestId: string }>}
 */
export async function handleWsMessage({ artifact, body, isBase64 = false, record, ctxBase }) {
  const bodyText = typeof body === "string" ? body : Buffer.from(body).toString(isBase64 ? "base64" : "utf8");
  const parsed = parseMessageBody(bodyText);
  const { routeKey } = selectRoute(artifact, bodyText);
  const messageId = `msg-${Math.random().toString(36).slice(2, 10)}`;
  const requestId = `req-${Math.random().toString(36).slice(2, 10)}`;
  const connectionId = record?.connectionId ?? "";
  if (!routeKey) {
    return { routeKey: null, frame: forbiddenFrame({ connectionId, requestId }), error: "Forbidden", status: 403, messageId, requestId };
  }
  const route = (artifact?.routes ?? []).find((entry) => entry?.routeKey === routeKey) ?? null;
  // Per-message throttle/quota via the shared phases (best-effort reuse).
  if (ctxBase) {
    try {
      const { run: runThrottle } = await import("../phases/throttle.mjs");
      const { run: runQuota } = await import("../phases/quota.mjs");
      const sub = {
        ...ctxBase,
        artifact,
        match: { routeKey, routeId: route?.id ?? null },
        context: { ...(ctxBase.context ?? {}), routeKey },
        usageKey: ctxBase.usageKey ?? (record?.apiKey ? { keyId: record.apiKey.keyId, plan: record.plan ?? null } : undefined),
      };
      if (record?.usageKey) sub.usageKey = record.usageKey;
      await runThrottle(sub);
      await runQuota(sub);
    } catch (error) {
      if (error instanceof GatewayError) {
        return { routeKey, frame: integrationErrorFrame({ connectionId, requestId }), error: error.message, status: error.status ?? 500, messageId, requestId };
      }
      throw error;
    }
  }
  // Model validation (no invoke on failure).
  const validation = validateWsMessage({ route, models: artifact?.models ?? {}, bodyText, parsed });
  if (!validation.ok) {
    return { routeKey, frame: validation.errorFrame, error: "validation", status: 400, messageId, requestId };
  }
  const integration = route?.integrationId ? (artifact?.integrations?.[route.integrationId] ?? null) : null;
  if (!integration) return { routeKey, frame: null, error: null, status: 200, messageId, requestId };
  const twoWay = (route?.routeResponseSelectionExpression ?? route?.route_response_selection_expression ?? null) === "$default";
  const event = buildMessageEvent({
    routeKey,
    stage: artifact?.stage ?? "",
    connectedAt: record?.connectedAt ?? 0,
    requestTimeEpoch: Date.now(),
    requestTime: new Date().toISOString(),
    requestId,
    extendedRequestId: requestId,
    messageId,
    connectionId,
    apiId: artifact?.apiPublicId ?? artifact?.apiId ?? "",
    sourceIp: record?.sourceIp ?? "",
    userAgent: record?.userAgent ?? "",
    authorizer: record?.authorizerContext ?? null,
    body: bodyText,
    isBase64Encoded: isBase64,
  });
  try {
    const invoked = await invokeWsIntegration(ctxBase ?? { ports: {} }, integration, event, bodyText);
    if (invoked.status < 200 || invoked.status >= 300) {
      return { routeKey, frame: integrationErrorFrame({ connectionId, requestId }), error: "integration", status: 500, messageId, requestId };
    }
    if (!twoWay) return { routeKey, frame: null, error: null, status: invoked.status, messageId, requestId };
    return { routeKey, frame: invoked.frame, error: null, status: invoked.status, messageId, requestId };
  } catch {
    return { routeKey, frame: integrationErrorFrame({ connectionId, requestId }), error: "integration", status: 500, messageId, requestId };
  }
}
