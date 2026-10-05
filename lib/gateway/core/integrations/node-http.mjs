/**
 * Node networking for HTTP integrations (S04 §3.1).
 *
 * Kept in this separate module so `http.mjs` stays free of Node-only imports:
 * default DNS resolution (`node:dns`) and the undici dispatcher with the SSRF
 * `connect.lookup` guard and backend TLS options live here. Tests inject fakes
 * through `invoke` deps instead of touching this module.
 *
 * @module lib/gateway/core/integrations/node-http
 */

import { lookup as dnsLookup } from "node:dns";
import { Agent } from "undici";
import { createGuardedLookup, toConnectLookup } from "./ssrf.mjs";

/**
 * Default resolver: all addresses for a hostname.
 *
 * @param {string} hostname
 * @returns {Promise<string[]>}
 */
export function nodeLookup(hostname) {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map((entry) => entry.address));
    });
  });
}

/**
 * Builds an undici dispatcher whose connections re-resolve and re-check DNS
 * (rebinding-safe) and whose TLS honors the integration options.
 *
 * @param {{ lookup?: (hostname: string) => Promise<string[]>, selfHosts?: string[], allowLoopback?: boolean, tls?: { insecureSkipVerification?: boolean, serverNameToVerify?: string | null, certPem?: string | null, keyPem?: string | null }, connectTimeoutMs?: number }} [opts={}]
 * @returns {import("undici").Agent}
 */
export function createHttpDispatcher(opts = {}) {
  const tls = opts.tls ?? {};
  const guarded = createGuardedLookup(opts.lookup ?? nodeLookup, {
    selfHosts: opts.selfHosts ?? [],
    allowLoopback: opts.allowLoopback ?? false,
  });
  const connect = { lookup: toConnectLookup(guarded) };
  if (tls.insecureSkipVerification) connect.rejectUnauthorized = false;
  if (tls.serverNameToVerify) connect.servername = tls.serverNameToVerify;
  if (tls.certPem) connect.cert = tls.certPem;
  if (tls.keyPem) connect.key = tls.keyPem;
  return new Agent({ connect });
}
