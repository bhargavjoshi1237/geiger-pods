/**
 * Integration dispatcher (S04 §3): `invoke(ctx, integration, outbound, ports)`.
 *
 * Dispatches on `type` (`HTTP_PROXY`, `HTTP`, `MOCK`, `FUNCTION_PROXY`,
 * `FUNCTION`, `AWS_SERVICE`); `connection_type: "CONNECTOR"` routes HTTP
 * integrations through the connector hub. Every adapter must apply
 * `timeout_ms`, never follow redirects, and enforce the 10 MB buffered cap.
 *
 * Error mapping (spec §3.6):
 * - timeout → REST 504 `INTEGRATION_TIMEOUT` / HTTP 503 / WS error frame detail
 * - network/TLS → REST 504 `INTEGRATION_FAILURE` / HTTP 500
 * - malformed function-proxy response / function error (proxy) → REST 502 / HTTP 500
 * - config error → 500 `API_CONFIGURATION_ERROR`
 * - buffered response > 10 MB → REST 502 / HTTP 500
 *
 * @module lib/gateway/core/integrations/index
 */

import { GatewayError } from "../errors.mjs";
import { applyBackendAuth } from "./backend-auth.mjs";
import { invokeHttp, MAX_BUFFERED_BYTES } from "./http.mjs";
import { invokeMock } from "./mock.mjs";
import { invokeFunction, selectCustomResponse } from "./function.mjs";
import { buildRestAwsRequest, buildSubtypeRequest } from "./aws.mjs";
import { signRequest } from "../auth/sigv4.mjs";

export { MAX_BUFFERED_BYTES };

function protocolOf(ctx) {
  return ctx.artifact?.protocol ?? ctx.protocol ?? "REST";
}

/**
 * Maps an adapter failure to the per-protocol gateway error (spec §3.6).
 *
 * The S01 catalog has no 502/503 entries, so cases that need wire statuses
 * beyond the catalog (HTTP 503/500, REST 502) carry an explicit `statusCode`
 * override on the returned error. The `invoke` phase renders those overrides;
 * `type` still drives `$context` and `x-pods-error-type`.
 *
 * @param {unknown} error
 * @param {string} protocol - `REST` | `HTTP` | `WEBSOCKET`.
 * @returns {GatewayError}
 */
export function mapInvocationError(error, protocol) {
  const refine = (type, message, statusCode, extra = {}) => {
    const refined = new GatewayError(type, message, extra);
    refined.statusCode = statusCode;
    return refined;
  };
  if (error instanceof GatewayError) {
    if (error.type === "INTEGRATION_TIMEOUT") {
      if (protocol === "HTTP") {
        return refine("INTEGRATION_TIMEOUT", "Service Unavailable", 503);
      }
      return error;
    }
    if (error.type === "DEFAULT_5XX" && error.extra?.reason === "response-too-large") {
      if (protocol === "HTTP") return refine("INTEGRATION_FAILURE", "Internal Server Error", 500);
      return refine("DEFAULT_5XX", "Internal server error", 502, error.extra);
    }
    if (error.type === "DEFAULT_5XX" && (error.extra?.reason === "malformed-function-response" || error.extra?.reason === "function-error")) {
      if (protocol === "HTTP") return refine("INTEGRATION_FAILURE", "Internal Server Error", 500);
      if (protocol === "REST") return refine("DEFAULT_5XX", "Internal server error", 502, error.extra);
      return error;
    }
    if (error.type === "INTEGRATION_FAILURE" && protocol === "HTTP") {
      return refine("INTEGRATION_FAILURE", "Internal Server Error", 500, error.extra);
    }
    return error;
  }
  if (error?.code === "PODS_SSRF_BLOCKED") {
    return new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  }
  if (error?.code === "target-not-allowed" || error?.code === "no-agents") {
    if (protocol === "HTTP") return refine("INTEGRATION_FAILURE", "Internal Server Error", 500);
    return new GatewayError("INTEGRATION_FAILURE", "Internal server error");
  }
  if (protocol === "HTTP") return refine("INTEGRATION_FAILURE", "Internal Server Error", 500);
  return new GatewayError("INTEGRATION_FAILURE", "Internal server error");
}

function recordIntegration(ctx, { status, latencyMs, error, requestId }) {
  const started = Date.now() - (latencyMs ?? 0);
  ctx.integration = { status: status ?? "", latency: latencyMs ?? 0, error: error ?? "", requestId: requestId ?? ctx.requestId ?? "" };
  if (ctx.context) {
    ctx.context.integration = {
      status: status === undefined || status === null ? "" : String(status),
      latency: latencyMs === undefined || latencyMs === null ? "" : String(latencyMs),
      error: error ?? "",
      requestId: requestId ?? ctx.requestId ?? ctx.context.requestId ?? "",
      integrationStatus: status === undefined || status === null ? "" : String(status),
    };
    ctx.context.integrationLatency = ctx.context.integration.latency;
    ctx.context.integrationStatus = ctx.context.integration.integrationStatus;
  }
  return started;
}

/**
 * Invokes an integration and returns the normalized backend result.
 *
 * @param {object} ctx - Pipeline context.
 * @param {object} integration - Integration config (`type`, `connection_type`, …).
 * @param {{ method: string, url?: string | null, headers?: Headers | Record<string,string>, body?: Uint8Array | null, queryString?: string, renderedTemplate?: string | null }} outbound - Built by S06 `integrationRequest`.
 * @param {object} ports - Injected ports (`secrets`, `fetch`, `kv`, `connectorHub`, `log`).
 * @param {object} [deps={}] - Test seams forwarded to adapters.
 * @returns {Promise<{ status: number, headers: Headers, body: Uint8Array | null, latencyMs: number, mockPayload?: unknown, functionError?: unknown }>}
 */
export async function invoke(ctx, integration, outbound, ports, deps = {}) {
  const started = Date.now();
  const protocol = protocolOf(ctx);
  const fail = (error) => {
    const mapped = mapInvocationError(error, protocol);
    recordIntegration(ctx, { status: null, latencyMs: Date.now() - started, error: mapped.type, requestId: ctx.requestId });
    throw mapped;
  };

  try {
    if ((integration.connection_type ?? "INTERNET") === "CONNECTOR") {
      const hub = ports.connectorHub ?? deps.connectorHub;
      if (!hub) throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
      if (!integration.connector_id) throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
      const { maybeAppendDefaultPath, renderIntegrationUri } = await import("./uri.mjs");
      let url = outbound?.url ?? renderIntegrationUri(integration.uri, {
        pathParams: ctx.pathParams ?? {},
        greedyParams: ctx.greedyParams ?? [],
        stageVariables: ctx.stageVariables ?? {},
        requestPathParams: ctx.requestPathParams ?? {},
      });
      // Same HTTP-API path rules as direct integrations (§3.1): the
      // pre-render template decides the ANY-proxy append, not the rendered URL.
      url = maybeAppendDefaultPath(url, {
        protocol,
        routeKey: ctx.routeKey,
        requestPath: ctx.requestPath ?? new URL(ctx.request.url).pathname,
        stage: ctx.artifact?.stage ?? ctx.stage,
        uriTemplate: integration.uri ?? null,
      });
      const authed = integration.backend_auth
        ? await applyBackendAuth({ headers: outbound?.headers, url }, integration.backend_auth, ports, { method: outbound?.method ?? "GET" })
        : { headers: outbound?.headers, url, tlsMaterial: null, oauth: null };
      const wire = {
        method: outbound?.method ?? integration.integration_method ?? ctx.request.method,
        url: authed.url,
        headers: authed.headers,
        body: outbound?.body ?? null,
      };
      const wireOpts = { timeoutMs: integration.timeout_ms ?? 29000, connectorTargets: deps.connectorTargets };
      const result = await hub.invoke(integration.connector_id, wire, wireOpts);
      if (authed?.oauth && result.status === 401) {
        // Same one-refresh-and-retry as direct integrations (§5).
        await authed.oauth.refreshOnce();
        const retry = await hub.invoke(integration.connector_id, {
          ...wire,
          headers: authed.headers,
        }, wireOpts);
        recordIntegration(ctx, { status: retry.status, latencyMs: Date.now() - started, error: "", requestId: ctx.requestId });
        return { ...retry, latencyMs: Date.now() - started };
      }
      recordIntegration(ctx, { status: result.status, latencyMs: Date.now() - started, error: "", requestId: ctx.requestId });
      return { ...result, latencyMs: Date.now() - started };
    }

    switch (integration.type) {
      case "HTTP_PROXY":
      case "HTTP": {
        // Query credential injection rewrites the URL, so it needs a URL to
        // work on: render the template now when S06 left no built URL.
        let preUrl = outbound?.url ?? null;
        if (!preUrl && integration.backend_auth?.type === "query") {
          const { renderIntegrationUri } = await import("./uri.mjs");
          preUrl = renderIntegrationUri(integration.uri, {
            pathParams: ctx.pathParams ?? {},
            greedyParams: ctx.greedyParams ?? [],
            stageVariables: ctx.stageVariables ?? {},
            requestPathParams: ctx.requestPathParams ?? {},
          });
        }
        const authed = integration.backend_auth
          ? await applyBackendAuth(
            { headers: outbound?.headers ?? ctx.request.headers, url: preUrl },
            integration.backend_auth,
            ports,
            { method: outbound?.method ?? ctx.request.method },
          )
          : null;
        // When backend auth rewrote the URL (query auth) keep it; otherwise
        // let the HTTP adapter render from the integration URI.
        const effective = authed && outbound?.url === undefined && authed.url
          ? { ...outbound, headers: authed.headers, url: authed.url || undefined }
          : { ...outbound, headers: authed?.headers ?? outbound?.headers };
        if (authed?.url && !outbound?.url) effective.url = authed.url;
        const result = await invokeHttp(ctx, integration, effective, ports, {
          ...deps,
          clientCert: authed?.tlsMaterial ?? deps.clientCert,
        });
        if (authed?.oauth && result.status === 401) {
          await authed.oauth.refreshOnce();
          const retry = await invokeHttp(ctx, integration, { ...effective, headers: authed.headers }, ports, {
            ...deps,
            clientCert: authed?.tlsMaterial ?? deps.clientCert,
          });
          recordIntegration(ctx, { status: retry.status, latencyMs: Date.now() - started, error: "", requestId: ctx.requestId });
          return { ...retry, latencyMs: Date.now() - started };
        }
        recordIntegration(ctx, { status: result.status, latencyMs: Date.now() - started, error: "", requestId: ctx.requestId });
        return { ...result, latencyMs: Date.now() - started };
      }
      case "MOCK": {
        const result = await invokeMock(ctx, integration, outbound);
        recordIntegration(ctx, { status: result.status, latencyMs: result.latencyMs, error: "", requestId: ctx.requestId });
        return result;
      }
      case "FUNCTION_PROXY": {
        const result = await invokeFunction(ctx, integration, outbound, ports, deps);
        recordIntegration(ctx, { status: result.status, latencyMs: result.latencyMs, error: "", requestId: ctx.requestId });
        return result;
      }
      case "FUNCTION": {
        try {
          const result = await invokeFunction(ctx, integration, { ...outbound, renderedTemplate: outbound?.renderedTemplate ?? null }, ports, deps);
          recordIntegration(ctx, { status: result.status, latencyMs: result.latencyMs, error: "", requestId: ctx.requestId });
          return result;
        } catch (error) {
          if (error instanceof GatewayError && error.extra?.reason === "function-error") {
            const responses = integration.integration_responses ?? deps.integrationResponses ?? [];
            const selected = selectCustomResponse(error.functionError ?? error.extra?.functionError ?? {}, responses);
            if (selected) {
              recordIntegration(ctx, { status: selected.status_code, latencyMs: Date.now() - started, error: "", requestId: ctx.requestId });
              return {
                status: selected.status_code,
                headers: new Headers({ "content-type": "application/json" }),
                body: new TextEncoder().encode(JSON.stringify(error.functionError ?? {})),
                latencyMs: Date.now() - started,
                functionError: error.functionError,
              };
            }
          }
          throw error;
        }
      }
      case "AWS_SERVICE": {
        const result = await invokeAws(ctx, integration, outbound, ports, deps);
        recordIntegration(ctx, { status: result.status, latencyMs: result.latencyMs, error: "", requestId: ctx.requestId });
        return result;
      }
      default:
        throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
    }
  } catch (error) {
    if (error instanceof GatewayError && ctx.integration?.error) throw error;
    throw fail(error);
  }
}

/**
 * Invokes an `AWS_SERVICE` integration: builds the (subtype or generic)
 * request, SigV4-signs it with the secret's credentials, and sends it.
 */
export async function invokeAws(ctx, integration, outbound, ports, deps = {}) {
  const started = Date.now();
  const aws = integration.aws ?? {};
  const region = aws.region;
  if (!region) throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  const credentials = aws.roleSecretRef && ports.secrets
    ? (await ports.secrets.resolve(aws.roleSecretRef))?.value ?? null
    : null;
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
  }
  const unsigned = aws.subtype
    ? buildSubtypeRequest(aws.subtype, outbound?.awsParams ?? aws.parameters ?? {}, { region })
    : buildRestAwsRequest({ ...aws, region });
  const signed = await signRequest({
    method: unsigned.method,
    url: unsigned.url,
    headers: unsigned.headers,
    body: unsigned.body ?? "",
    service: unsigned.service,
    region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  });
  const timeoutMs = integration.timeout_ms ?? 29000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("integration-timeout")), timeoutMs);
  try {
    const fetchFn = deps.fetchFn ?? ports.fetch ?? globalThis.fetch;
    const response = await fetchFn(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: unsigned.method === "GET" ? undefined : (unsigned.body ?? ""),
      signal: controller.signal,
      // Never follow redirects (adapter contract §3.3): a 3xx is returned as-is.
      redirect: "manual",
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BUFFERED_BYTES) {
      throw new GatewayError("DEFAULT_5XX", "Internal server error", { reason: "response-too-large" });
    }
    return { status: response.status, headers: new Headers(response.headers), body: bytes, latencyMs: Date.now() - started };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (String(error?.message) === "integration-timeout" || error?.name === "AbortError") {
      throw new GatewayError("INTEGRATION_TIMEOUT", "Endpoint request timed out");
    }
    throw new GatewayError("INTEGRATION_FAILURE", "Internal server error");
  } finally {
    clearTimeout(timer);
  }
}
