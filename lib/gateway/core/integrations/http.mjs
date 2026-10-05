/**
 * HTTP / HTTP_PROXY adapter (S04 §3.1).
 *
 * Forwards method, path, query, headers (minus hop-by-hop and `x-pods-*`) and
 * the raw body; never follows redirects (3xx returns as-is); enforces the
 * 10 MB buffered limit; applies `timeout_ms` with `AbortController` and aborts
 * when the client disconnects (`ctx.signal`).
 *
 * @module lib/gateway/core/integrations/http
 */

import { request as undiciRequest } from "undici";
import { GatewayError } from "../errors.mjs";
import { buildOutboundHeaders, sanitizeResponseHeaders } from "./headers.mjs";
import { createGuardedLookup } from "./ssrf.mjs";
import { maybeAppendDefaultPath, renderIntegrationUri } from "./uri.mjs";

/** Buffered response cap: 10 MB (spec §3, adapter rule 4). */
export const MAX_BUFFERED_BYTES = 10 * 1024 * 1024;

/**
 * Pre-flight SSRF check using an injected promise-style lookup.
 * The dispatcher itself re-checks at connect time (rebinding-safe).
 *
 * @param {string} hostname
 * @param {(hostname: string) => Promise<string[]>} lookup
 * @param {{ selfHosts?: string[] }} [opts={}]
 */
export async function assertHostAllowed(hostname, lookup, opts = {}) {
  const guarded = createGuardedLookup(lookup, opts);
  await guarded(hostname);
}

/**
 * Reads a body async-iterable up to `maxBytes`; throws `GatewayError`
 * `DEFAULT_5XX` (mapped per protocol by the dispatcher) when exceeded.
 *
 * @param {AsyncIterable<Uint8Array>} stream
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array>}
 */
export async function readBoundedBody(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      throw new GatewayError("DEFAULT_5XX", "Internal server error", { reason: "response-too-large" });
    }
    chunks.push(bytes);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Invokes an HTTP(S) backend.
 *
 * @param {object} ctx - Pipeline context (`signal`, `request`, `integration` latency fields, `stageVariables`, `pathParams`).
 * @param {object} integration - Integration config (`uri`, `integration_method`, `timeout_ms`, `tls`, `connection_type`).
 * @param {{ method: string, url?: string | null, headers?: Headers | Record<string,string>, body?: Uint8Array | null, queryString?: string }} outbound - Built by S06 `integrationRequest` (url may be null → render from `uri`).
 * @param {object} ports - Injected ports (`log`).
 * @param {{ dispatcher?: object, lookup?: (hostname: string) => Promise<string[]>, selfHosts?: string[], requestFn?: Function, clientCert?: { certPem?: string, keyPem?: string } }} [deps={}] - Test seams.
 * @returns {Promise<{ status: number, headers: Headers, body: Uint8Array | null, latencyMs: number }>}
 */
export async function invokeHttp(ctx, integration, outbound, ports, deps = {}) {
  const started = Date.now();
  const timeoutMs = integration.timeout_ms ?? 29000;
  let rendered = outbound?.url ?? null;
  if (!rendered) {
    rendered = renderIntegrationUri(integration.uri, {
      pathParams: ctx.pathParams ?? {},
      greedyParams: ctx.greedyParams ?? [],
      stageVariables: ctx.stageVariables ?? {},
      requestPathParams: ctx.requestPathParams ?? {},
    });
  }
  rendered = maybeAppendDefaultPath(rendered, {
    protocol: ctx.artifact?.protocol ?? ctx.protocol,
    routeKey: ctx.routeKey,
    requestPath: ctx.requestPath ?? new URL(ctx.request.url).pathname,
    stage: ctx.artifact?.stage ?? ctx.stage,
    // The ANY-proxy no-append check (§3.1) runs against the pre-render
    // template: a rendered URL never carries placeholders, so it cannot
    // answer whether the template had `{proxy}`.
    uriTemplate: integration.uri ?? null,
  });

  const url = new URL(rendered);
  if (outbound?.queryString) {
    const incoming = new URLSearchParams(outbound.queryString);
    for (const [name, value] of incoming) url.searchParams.append(name, value);
  } else if (!outbound?.url) {
    // Rendered from the integration URI template (no S06-built URL): pass the
    // client query string through (REST HTTP_PROXY parity). When the caller
    // supplied a full URL it already carries its query.
    const clientQuery = new URL(ctx.request.url).search;
    if (clientQuery.length > 1) {
      const incoming = new URLSearchParams(clientQuery.slice(1));
      for (const [name, value] of incoming) url.searchParams.append(name, value);
    }
  }

  const connectionType = integration.connection_type ?? "INTERNET";
  if (connectionType === "CONNECTOR") {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error", {
      reason: "connector-without-hub",
    });
  }
  // Test-only loopback escape hatch: real deployments always enforce the guard.
  // F4: in production (`NODE_ENV=production`) loopback is never allowed, even
  // when the artifact carries `allowLoopback` or the env is set (startup also
  // refuses `PODS_ALLOW_LOOPBACK`; this is defense in depth).
  const allowLoopback = process.env.NODE_ENV === "production"
    ? false
    : (integration.allowLoopback === true || process.env.PODS_ALLOW_LOOPBACK === "1");
  const guardOpts = { selfHosts: deps.selfHosts, allowLoopback };
  if (deps.lookup) await assertHostAllowed(url.hostname, deps.lookup, guardOpts);

  const headers = buildOutboundHeaders(outbound?.headers ?? ctx.request.headers, {
    backendUrl: url,
    clientIp: ctx.context?.identity?.sourceIp ?? "",
    protocol: ctx.artifact?.protocol ?? ctx.protocol,
    traceparent: ctx.request.headers.get?.("traceparent") ?? null,
  });

  const method = String(outbound?.method ?? integration.integration_method ?? ctx.request.method ?? "GET").toUpperCase();
  const effectiveMethod = method === "ANY" || integration.integration_method === "ANY" && !outbound?.method
    ? String(ctx.request.method ?? "GET").toUpperCase()
    : method;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("integration-timeout")), timeoutMs);
  const onClientAbort = () => controller.abort(new Error("client-abort"));
  ctx.signal?.addEventListener?.("abort", onClientAbort, { once: true });

  try {
    const requestFn = deps.requestFn ?? undiciRequest;
    const tls = {
      insecureSkipVerification: integration.tls?.insecureSkipVerification ?? false,
      serverNameToVerify: integration.tls?.serverNameToVerify ?? null,
      certPem: deps.clientCert?.certPem ?? integration.tls?.clientCertPem ?? null,
      keyPem: deps.clientCert?.keyPem ?? integration.tls?.clientKeyPem ?? null,
    };
    let dispatcher = deps.dispatcher ?? null;
    let ownedDispatcher = null;
    if (!dispatcher) {
      // Default path: a guarded dispatcher so every connection re-resolves
      // and re-checks DNS (rebinding-safe) with the integration TLS options.
      const { createHttpDispatcher, nodeLookup } = await import("./node-http.mjs");
      if (!deps.lookup) {
        // No injected resolver: pre-flight with the real DNS so SSRF blocks
        // surface as PODS_SSRF_BLOCKED (API_CONFIGURATION_ERROR) instead of
        // a wrapped connect failure (INTEGRATION_FAILURE). IP literals never
        // touch DNS; the connect-time guard still re-checks every connection.
        await assertHostAllowed(url.hostname, nodeLookup, guardOpts);
      }
      ownedDispatcher = createHttpDispatcher({ lookup: deps.lookup, tls, ...guardOpts });
      dispatcher = ownedDispatcher;
    }
    const response = await requestFn(url.toString(), {
      method: effectiveMethod === "ANY" ? String(ctx.request.method ?? "GET").toUpperCase() : effectiveMethod,
      headers: Object.fromEntries(headers.entries()),
      body: outbound?.body ?? null,
      signal: controller.signal,
      maxRedirections: 0,
      dispatcher,
    });
    const body = await readBoundedBody(response.body, MAX_BUFFERED_BYTES);
    const latencyMs = Date.now() - started;
    await ownedDispatcher?.close?.()?.catch?.(() => {});
    return {
      status: response.statusCode,
      headers: sanitizeResponseHeaders(response.headers),
      body,
      latencyMs,
    };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    const message = String(error?.message ?? error);
    if (message === "integration-timeout" || error?.name === "AbortError" || error?.code === "UND_ERR_ABORTED") {
      const clientGone = ctx.signal?.aborted;
      throw Object.assign(new GatewayError("INTEGRATION_TIMEOUT", "Endpoint request timed out"), {
        clientAborted: Boolean(clientGone),
      });
    }
    if (error?.code === "PODS_SSRF_BLOCKED") throw error;
    throw Object.assign(
      new GatewayError("INTEGRATION_FAILURE", "Internal server error"),
      { causeMessage: message },
    );
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener?.("abort", onClientAbort);
  }
}
