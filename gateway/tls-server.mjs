/**
 * TLS gateway server (S11 §§A3/B).
 *
 * A `node:https` host with per-domain secure contexts (`SNICallback`),
 * per-domain TLS security policies (`minVersion` from `tls-policy.mjs`) and
 * code-verified mTLS (`requestCert: true`, `rejectUnauthorized: false`; the
 * `endpointAccess` phase answers 403 on failure — no request reaches the
 * pipeline beyond phase 3).
 *
 * Real ACME/DNS issuance is out of process (see `lib/control/domains.mjs`
 * and the S11 report): this server terminates with configured PEM material
 * (tests use fixture certs; production loads issued/imported material via
 * the service role, project-scoped at load).
 *
 * Two modes:
 * - `handler(req, res)`: raw HTTPS assertions (TLS policy tests).
 * - `gateway: { artifact, loader?, ports? }`: full pipeline via the shared
 *   engine (mTLS tests). The presented peer cert is attached to
 *   `ctx.mtlsClientCert`; `ctx.tlsVersion` carries the negotiated version.
 *
 * @module gateway/tls-server
 */

import https from "node:https";
import tls from "node:tls";
import { handle, buildContext, runPipeline, createPorts } from "../lib/gateway/core/index.mjs";
import { renderGatewayError } from "../lib/gateway/core/gateway-responses.mjs";
import { secureOptionsFor } from "../lib/gateway/core/edge/tls-policy.mjs";
import { GATEWAY_HEADERS_TIMEOUT_MS, GATEWAY_KEEP_ALIVE_TIMEOUT_MS, GATEWAY_REQUEST_TIMEOUT_MS, armSlowlorisGuard } from "./server.mjs";
import { MemoryKvStore } from "../lib/gateway/state/memory-kv.mjs";

/**
 * Builds an `SNICallback` serving the right cert per domain (S11 §A3).
 *
 * @param {Array<{ servername: string, cert: string, key: string, securityPolicy?: string }>} domains
 * @param {{ cert: string, key: string, securityPolicy?: string }} defaultDomain
 * @returns {(servername: string, callback: Function) => void}
 */
export function buildSniCallback(domains, defaultDomain) {
  const contexts = new Map();
  for (const entry of domains ?? []) {
    const options = { cert: entry.cert, key: entry.key, ...secureOptionsFor(entry.securityPolicy ?? "TLS_1_2") };
    contexts.set(entry.servername.toLowerCase(), tls.createSecureContext(options));
  }
  const fallback = tls.createSecureContext({
    cert: defaultDomain.cert,
    key: defaultDomain.key,
    ...secureOptionsFor(defaultDomain.securityPolicy ?? "TLS_1_2"),
  });
  return (servername, callback) => {
    callback(null, contexts.get(String(servername ?? "").toLowerCase()) ?? fallback);
  };
}

/**
 * Extracts the presented peer certificate as PEM (or null when absent).
 *
 * @param {import("node:tls").TLSSocket} socket
 * @returns {{ pem: string|null, raw: object|null }}
 */
export function peerCertificatePem(socket) {
  try {
    const peer = socket?.getPeerCertificate?.(true) ?? null;
    if (!peer || Object.keys(peer).length === 0) return { pem: null, raw: null };
    return { pem: peer.raw ? `-----BEGIN CERTIFICATE-----\n${peer.raw.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n` : null, raw: peer };
  } catch {
    return { pem: null, raw: null };
  }
}

/**
 * Creates an HTTPS gateway server.
 *
 * @param {{ domains?: Array<object>, defaultDomain: { cert: string, key: string, securityPolicy?: string },
 *   handler?: (req: object, res: object) => Promise<void>|void,
 *   gateway?: { artifact: object, ports?: object }}} [options={}]
 */
export function createTlsGatewayServer({ domains = [], defaultDomain, handler = null, gateway = null } = {}) {
  if (!defaultDomain?.cert || !defaultDomain?.key) {
    throw new TypeError("createTlsGatewayServer requires defaultDomain { cert, key }.");
  }
  // The strictest policy among served domains bounds the handshake floor:
  // Node enforces minVersion per *context*, so build the server floor from
  // the maximum and let SNICallback contexts enforce their own.
  const policies = [defaultDomain, ...domains].map((entry) => entry.securityPolicy ?? "TLS_1_2");
  const floor = policies.includes("TLS13_ONLY") && policies.every((policy) => policy === "TLS13_ONLY")
    ? "TLSv1.3"
    : "TLSv1.2";
  const needsClientCert = (gateway?.artifact?.edge?.mtls || domains.some((entry) => entry.mtls));
  const server = https.createServer({
    SNICallback: buildSniCallback(domains, defaultDomain),
    cert: defaultDomain.cert,
    key: defaultDomain.key,
    minVersion: floor,
    requestCert: Boolean(needsClientCert),
    rejectUnauthorized: false,
  }, async (req, res) => {
    try {
      if (handler) {
        await handler(req, res);
        return;
      }
      if (gateway?.artifact) {
        const peer = peerCertificatePem(req.socket);
        // F36: test-only hatches are impossible in production.
        const prod = process.env.NODE_ENV === "production";
        const ports = createPorts({
          kv: gateway.ports?.kv ?? new MemoryKvStore({}),
          fetch: gateway.ports?.fetch ?? globalThis.fetch,
          secrets: gateway.ports?.secrets ?? { async resolve() { throw new Error("No secret resolver configured."); } },
          events: gateway.ports?.events ?? { emit() {} },
          clock: gateway.ports?.clock ?? { now: () => Date.now() },
          log: gateway.ports?.log ?? (() => {}),
          allowTestClientCert: prod ? false : (gateway.ports?.allowTestClientCert ?? false),
          allowTestIngress: prod ? false : (gateway.ports?.allowTestIngress ?? false),
        });
        const host = req.headers.host ?? "";
        const url = `https://${host}${req.url ?? "/"}`;
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
          else headers.append(key, value);
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const webRequest = new Request(url, {
          method: req.method,
          headers,
          body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
        });
        const ctx = buildContext(webRequest, { ...gateway.artifact, domainName: host.split(":")[0] }, ports);
        ctx.ports = ports;
        ctx.requestPath = new URL(webRequest.url).pathname;
        ctx.basePathStripped = ctx.requestPath;
        ctx.stage = gateway.artifact.stage ?? "$default";
        ctx.tlsVersion = req.socket?.getProtocol?.() ?? null;
        if (peer.pem) ctx.mtlsClientCert = { pem: peer.pem, raw: peer.raw };
        const response = await runPipeline(ctx);
        const outHeaders = Object.fromEntries(response.headers.entries());
        const subject = ctx?.context?.identity?.clientCert?.subjectDN ?? "";
        if (subject) outHeaders["x-pods-client-cert-subject"] = subject;
        res.writeHead(response.status, outHeaders);
        const text = await response.text();
        res.end(text);
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Internal server error" }));
    } catch {
      try {
        const error = renderGatewayError({ type: "DEFAULT_5XX", message: "Internal server error" }, {});
        res.writeHead(error.status, Object.fromEntries(error.headers.entries()));
        res.end(await error.text());
      } catch {
        try {
          res.destroy();
        } catch {
          // Last resort.
        }
      }
    }
  });

  let url = null;
  // S15 §2 host bounds + Slowloris guard, same as the plain gateway host.
  server.headersTimeout = GATEWAY_HEADERS_TIMEOUT_MS;
  server.requestTimeout = GATEWAY_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = GATEWAY_KEEP_ALIVE_TIMEOUT_MS;
  armSlowlorisGuard(server);
  return {
    server,
    get url() {
      return url;
    },
    async start(port = 0, host = process.env.PODS_LISTEN_HOST ?? "127.0.0.1") {
      const target = port === 0 ? 0 : (port || Number(process.env.PORT ?? 4443));
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(target, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      const bound = typeof address?.address === "string" ? address.address : host;
      const display = bound === "0.0.0.0" || bound === "::" ? "127.0.0.1" : bound.includes(":") ? `[${bound}]` : bound;
      url = host === "127.0.0.1" ? `https://127.0.0.1:${address.port}` : `https://${display}:${address.port}`;
      return address.port;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

void handle;
