/**
 * Outbound/inbound header handling for HTTP integrations (S04 §3.1).
 *
 * REST HTTP_PROXY passes the method, all headers except hop-by-hop, the query
 * string and the raw body. Gateway-reserved inbound `x-pods-*` headers are
 * stripped so clients cannot spoof request ids; upstream headers that collide
 * with gateway-reserved response headers are renamed to `x-pods-remapped-*`
 * (AWS does the same with `x-amzn-Remapped-*`).
 *
 * @module lib/gateway/core/integrations/headers
 */

/** Hop-by-hop headers, never forwarded to the backend. */
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Response headers owned by the gateway; upstream collisions are renamed. */
export const RESERVED_RESPONSE_HEADERS = new Set([
  "x-pods-request-id",
  "x-pods-error-type",
  "date",
  "server",
]);

/**
 * Builds the outbound header set for a backend request.
 *
 * @param {Headers | Record<string,string|string[]> | Array<[string,string]>} inbound - Client headers.
 * @param {{ backendUrl: string | URL, clientIp?: string, protocol?: string, traceparent?: string | null }} opts
 * @returns {Headers}
 */
export function buildOutboundHeaders(inbound, opts) {
  const backend = opts.backendUrl instanceof URL ? opts.backendUrl : new URL(opts.backendUrl);
  const source = inbound instanceof Headers
    ? [...inbound.entries()]
    : Array.isArray(inbound)
      ? inbound
      : Object.entries(inbound ?? {}).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((entry) => [name, String(entry)]));
  const out = new Headers();
  for (const [name, value] of source) {
    const lower = String(name).toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith("x-pods-")) continue;
    if (lower === "host" || lower === "content-length") continue;
    out.append(name, String(value));
  }
  out.set("host", backend.host);
  const prior = source
    .filter(([name]) => String(name).toLowerCase() === "x-forwarded-for")
    .flatMap(([, value]) => String(value).split(",").map((part) => part.trim()).filter(Boolean));
  const clientIp = String(opts.clientIp ?? "").trim();
  const chain = [...prior, ...(clientIp && !prior.includes(clientIp) ? [clientIp] : [])];
  if (chain.length > 0) out.set("x-forwarded-for", chain.join(", "));
  out.set("x-forwarded-proto", backend.protocol.replace(":", ""));
  if (backend.port) out.set("x-forwarded-port", backend.port);
  if (opts.protocol === "HTTP") {
    const forwarded = `for=${clientIp || "unknown"};proto=${backend.protocol.replace(":", "")};host=${backend.host}`;
    out.set("forwarded", forwarded);
  }
  if (opts.traceparent && !out.has("traceparent")) out.set("traceparent", opts.traceparent);
  return out;
}

/**
 * Sanitizes upstream response headers: strips hop-by-hop headers and renames
 * gateway-reserved collisions to `x-pods-remapped-<name>`.
 *
 * @param {Headers | Record<string,string> | Array<[string,string]>} upstream
 * @returns {Headers}
 */
export function sanitizeResponseHeaders(upstream) {
  const entries = upstream instanceof Headers
    ? [...upstream.entries()]
    : Array.isArray(upstream) ? upstream : Object.entries(upstream ?? {});
  const out = new Headers();
  for (const [name, value] of entries) {
    const lower = String(name).toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (RESERVED_RESPONSE_HEADERS.has(lower)) {
      out.set(`x-pods-remapped-${lower}`, String(value));
      continue;
    }
    out.append(name, String(value));
  }
  return out;
}
