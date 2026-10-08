/**
 * `endpointAccess` phase (pipeline row 3 — disabled default endpoint, private
 * API, mTLS verification, IPv4-only enforcement).
 *
 * S11 implementation (replaces the S01 stub, keeping `name` + `run(ctx)`):
 * - Disabled default endpoint: requests arriving via the default
 *   `{apiPublicId}.{domain}` host (or path routing) → 403 `Forbidden` when
 *   `artifact.edge.disableDefaultEndpoint` is set. Custom-domain requests
 *   (`ctx.viaCustomDomain`) always pass this check.
 * - IPv4-only APIs (`edge.ipAddressType === "ipv4"`, the default) reject
 *   IPv6 sources with 403 (AWS behavior for IPv4-only endpoints).
 * - Private APIs (`edge.endpointType === "PRIVATE"`) require connector
 *   ingress (`ctx.viaConnector`, set by the server from the S04 ingress hub
 *   or — tests only — the `x-pods-test-ingress` header when
 *   `ports.allowTestIngress` is set). Otherwise → 403 `Forbidden`.
 * - mTLS (`edge.mtls.truststorePem`): the presented client cert
 *   (`ctx.mtlsClientCert`, or — tests only — `x-pods-test-client-cert` when
 *   `ports.allowTestClientCert` is set) is verified against the truststore;
 *   failures → 403 `Forbidden` with an execution-log reason. Success sets
 *   `$context.identity.clientCert.*`.
 *
 * @module lib/gateway/core/phases/endpoint-access
 */

import { GatewayError } from "../errors.mjs";
import { parseTrustStore } from "../edge/certs.mjs";
import { verifyClientCert, clientCertContext } from "../edge/mtls.mjs";
import { buildMethodArn } from "../auth/policy.mjs";
import { evaluateResourcePolicy, requestContextFromFacts } from "../auth/resource-policy.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "endpointAccess";

/**
 * Returns true for IPv6 textual sources.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isIpv6Source(ip) {
  return String(ip ?? "").includes(":");
}

/**
 * Reassembles a test-double PEM carried in one header line (newlines are
 * illegal in header values, so callers send `encodeURIComponent(pem)`,
 * mirroring how AWS passes the client cert PEM URL-encoded).
 * Single-line (space-flattened) PEMs are still accepted for older callers:
 * the base64 body is re-wrapped at 64 columns.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeTestPem(value) {
  let text = String(value ?? "").trim();
  // URL-encoded first (the header-safe contract): a raw PEM never contains
  // `%`, so decoding only when one is present cannot corrupt plain input.
  if (text.includes("%")) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded !== text) text = decoded.trim();
    } catch {
      // Not valid percent-encoding; fall through to the raw shapes below.
    }
  }
  if (text.includes("\n")) return text;
  const match = text.match(/^(-----BEGIN [^-]+-----)([A-Za-z0-9+/=\s]+)(-----END [^-]+-----)$/);
  if (!match) return text;
  const body = match[2].replace(/\s+/g, "");
  const wrapped = body.replace(/(.{64})/g, "$1\n");
  return `${match[1]}\n${wrapped}\n${match[3]}\n`;
}

/**
 * Enforces private custom-domain isolation (F34): association membership
 * plus the domain network policy, evaluated pre-auth with connector facts.
 *
 * @param {object} ctx - Pipeline context.
 * @throws {GatewayError} `ACCESS_DENIED` when the domain is private and the
 *   ingress is not associated or not allowed by the domain policy.
 */
function enforcePrivateDomain(ctx) {
  const match = ctx?.customDomainMatch ?? null;
  if (!match || typeof match !== "object") return;
  const endpointType = match.endpointType ?? "REGIONAL";
  const policy = match.policy ?? null;
  const associated = Array.isArray(match.associatedConnectorIds) ? match.associatedConnectorIds : [];
  if (endpointType !== "PRIVATE" && policy === null && associated.length === 0) return;
  const connectorId = ctx?.viaConnector ?? null;
  if (!connectorId) throw new GatewayError("ACCESS_DENIED", "Forbidden");
  if (!associated.includes(connectorId)) throw new GatewayError("ACCESS_DENIED", "Forbidden");
  if (policy) {
    const artifact = ctx?.artifact ?? {};
    let path = "/";
    try {
      path = new URL(ctx.request.url).pathname;
    } catch {
      path = "/";
    }
    let secureTransport = false;
    try {
      secureTransport = new URL(ctx.request.url).protocol === "https:";
    } catch {
      secureTransport = false;
    }
    const resource = buildMethodArn({
      region: artifact.region ?? "auto",
      projectId: artifact.projectId ?? "",
      apiPublicId: artifact.apiPublicId ?? artifact.apiId ?? "",
      stage: artifact.stage ?? ctx?.stage ?? "",
      method: String(ctx.request?.method ?? "GET").toUpperCase(),
      resourcePath: path.replace(/^\/+/, "") || "/",
    });
    const { decision } = evaluateResourcePolicy({
      document: policy,
      resource,
      request: requestContextFromFacts({
        sourceIp: ctx?.context?.identity?.sourceIp ?? "",
        userAgent: ctx.request?.headers?.get?.("user-agent") ?? "",
        secureTransport,
        connectorId,
        sourceVpc: ctx?.viaSourceVpc ?? ctx?.context?.identity?.sourceVpc ?? "",
        principalArn: null,
        nowMs: ctx?.ports?.clock?.now?.() ?? Date.now(),
      }),
      principalArn: null,
    });
    if (decision !== "Allow") throw new GatewayError("ACCESS_DENIED", "Forbidden");
  }
}

/**
 * Enforces endpoint access: disabled default endpoint, IPv4-only, private
 * API ingress, and mTLS verification.
 *
 * @param {object} ctx - Pipeline context (`request`, `artifact`, `context`, `ports`).
 * @returns {Promise<undefined>} `undefined` on pass; throws `GatewayError` otherwise.
 */
export async function run(ctx) {
  const edge = ctx?.artifact?.edge ?? {};
  const context = ctx?.context ?? {};

  // Disabled default endpoint (takes effect on the next deployment, AWS parity:
  // the compiled artifact carries the flag).
  if (edge.disableDefaultEndpoint === true && !ctx?.viaCustomDomain && ctx?.viaDefaultEndpoint !== false) {
    throw new GatewayError("ACCESS_DENIED", "Forbidden");
  }

  // IPv4-only endpoints reject IPv6 sources.
  const ipAddressType = edge.ipAddressType ?? "ipv4";
  const sourceIp = context.identity?.sourceIp ?? "";
  if (ipAddressType === "ipv4" && isIpv6Source(sourceIp)) {
    throw new GatewayError("ACCESS_DENIED", "Forbidden");
  }

  // Private APIs require connector ingress.
  if ((edge.endpointType ?? "REGIONAL") === "PRIVATE") {
    let connectorId = ctx?.viaConnector ?? null;
    // Test hatch, impossible in production (F36; also forced off by both
    // gateway hosts at construction).
    if (!connectorId && ctx?.ports?.allowTestIngress === true && process.env.NODE_ENV !== "production") {
      const header = ctx?.request?.headers?.get?.("x-pods-test-ingress") ?? "";
      if (header.trim()) connectorId = header.trim();
    }
    if (!connectorId) {
      throw new GatewayError("ACCESS_DENIED", "Forbidden");
    }
    ctx.viaConnector = connectorId;
    if (context.identity) {
      context.identity.sourceVpce = connectorId;
    }
  }

  // F34: private custom-domain enforcement. When the request arrived via a
  // PRIVATE custom domain, the ingress connector must be associated to that
  // domain (fail closed), and the domain's network policy must explicitly
  // Allow. User principals are unknown pre-auth; the API resource policy
  // covers them post-auth.
  enforcePrivateDomain(ctx);

  // mTLS verification (REST + HTTP).
  const mtls = edge.mtls ?? null;
  if (mtls && (mtls.truststorePem || mtls.truststoreRef)) {
    let leafPem = ctx?.mtlsClientCert?.pem ?? ctx?.mtlsClientCert ?? null;
    // Test hatch, impossible in production (F36).
    if (!leafPem && ctx?.ports?.allowTestClientCert === true && process.env.NODE_ENV !== "production") {
      const header = ctx?.request?.headers?.get?.("x-pods-test-client-cert") ?? "";
      if (header.trim()) leafPem = normalizeTestPem(header);
    }
    let truststore;
    try {
      truststore = parseTrustStore(mtls.truststorePem);
    } catch {
      throw new GatewayError("ACCESS_DENIED", "Forbidden");
    }
    const verdict = verifyClientCert(
      { leafPem, chainPems: ctx?.mtlsClientCert?.chain ?? [] },
      truststore,
      { crlPem: mtls.crlPem ?? null, now: ctx?.ports?.clock?.now?.() ?? Date.now() },
    );
    if (!verdict.ok) {
      try {
        ctx?.trace?.("error", verdict.reason ?? "Access denied. Reason: Client cert invalid.");
      } catch {
        // Tracing never blocks.
      }
      throw new GatewayError("ACCESS_DENIED", "Forbidden");
    }
    if (context.identity) {
      context.identity.clientCert = clientCertContext(verdict.cert);
    }
  }
  return undefined;
}
