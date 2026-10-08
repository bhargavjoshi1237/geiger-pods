/**
 * Mutual-TLS verification (S11 Part B, REST + HTTP).
 *
 * The TLS server completes the handshake with `requestCert: true` and
 * `rejectUnauthorized: false`; verification happens here, in code: a cert
 * must be present, the chain must build to the truststore, it must be within
 * validity, and (when a CRL is set) it must not be revoked. Failures return
 * HTTP 403 with an execution-log reason — no request reaches the pipeline
 * beyond phase 3.
 *
 * @module lib/gateway/core/edge/mtls
 */

import { X509Certificate } from "node:crypto";
import { splitPemBundle } from "./certs.mjs";

/**
 * Parses revoked serials from a CRL bundle (Pods extension): accepted as a
 * PEM bundle of revoked certificates, or a plain serial list (one uppercase
 * hex serial per line, as `openssl x509 -noout -serial` prints).
 *
 * @param {string|null} crlPem
 * @returns {Set<string>} Uppercase hex serials without colons.
 */
export function parseRevokedSerials(crlPem) {
  const revoked = new Set();
  const text = String(crlPem ?? "");
  if (!text.trim()) return revoked;
  for (const block of splitPemBundle(text)) {
    try {
      revoked.add(new X509Certificate(block).serialNumber.replace(/:/g, "").toUpperCase());
    } catch {
      // Ignore unparsable blocks; the serial list below still applies.
    }
  }
  for (const line of text.split("\n")) {
    const serial = line.trim().replace(/^serial=/i, "").replace(/:/g, "").toUpperCase();
    if (/^[0-9A-F]{2,}$/.test(serial)) revoked.add(serial);
  }
  return revoked;
}

/**
 * Verifies a presented client certificate against a truststore.
 *
 * @param {{ leafPem?: string|null, chainPems?: Array<string> }} presented
 * @param {{ certs: Array<{ subject: string, serialNumber: string }> }} truststore - Parsed via `parseTrustStore`.
 * @param {{ crlPem?: string|null, now?: number }} [options={}]
 * @returns {{ ok: boolean, reason?: string, cert?: { pem: string, subjectDN: string, issuerDN: string,
 *   serialNumber: string, notBefore: string, notAfter: string } }}
 */
export function verifyClientCert(presented, truststore, { crlPem = null, now = Date.now() } = {}) {
  const leafPem = presented?.leafPem ?? null;
  if (!leafPem) {
    return { ok: false, reason: "Access denied. Reason: Client cert not present." };
  }
  let leaf;
  try {
    leaf = new X509Certificate(leafPem);
  } catch {
    return { ok: false, reason: "Access denied. Reason: Client cert is unparsable." };
  }
  const notBefore = Date.parse(leaf.validFrom);
  const notAfter = Date.parse(leaf.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notBefore > now || notAfter <= now) {
    return { ok: false, reason: "Access denied. Reason: Client cert expired or not yet valid." };
  }
  // Chain builds to the truststore: the leaf issuer must equal a truststore
  // subject (direct), or link through the presented intermediates.
  const subjects = new Set((truststore?.certs ?? []).map((entry) => entry.subject));
  let issuer = leaf.issuer;
  let builds = subjects.has(issuer);
  if (!builds) {
    for (const block of presented?.chainPems ?? []) {
      try {
        const intermediate = new X509Certificate(block);
        if (intermediate.subject === issuer) {
          issuer = intermediate.issuer;
          if (subjects.has(issuer)) {
            builds = true;
            break;
          }
        }
      } catch {
        // Skip unparsable intermediates.
      }
    }
  }
  if (!builds) {
    return { ok: false, reason: "Access denied. Reason: Client cert chain does not build to the truststore." };
  }
  const serial = leaf.serialNumber.replace(/:/g, "").toUpperCase();
  if (parseRevokedSerials(crlPem).has(serial)) {
    return { ok: false, reason: "Access denied. Reason: Client cert revoked." };
  }
  return {
    ok: true,
    cert: {
      pem: leafPem,
      subjectDN: leaf.subject,
      issuerDN: leaf.issuer,
      serialNumber: leaf.serialNumber,
      notBefore: new Date(notBefore).toISOString(),
      notAfter: new Date(notAfter).toISOString(),
    },
  };
}

/**
 * Maps a verified cert to `$context.identity.clientCert`.
 *
 * @param {{ pem: string, subjectDN: string, issuerDN: string, serialNumber: string, notBefore: string, notAfter: string }|null} cert
 * @returns {{ clientCertPem: string, subjectDN: string, issuerDN: string, serialNumber: string, validity: { notBefore: string, notAfter: string } }}
 */
export function clientCertContext(cert) {
  if (!cert) {
    return { clientCertPem: "", subjectDN: "", issuerDN: "", serialNumber: "", validity: { notBefore: "", notAfter: "" } };
  }
  return {
    clientCertPem: cert.pem,
    subjectDN: cert.subjectDN,
    issuerDN: cert.issuerDN,
    serialNumber: cert.serialNumber,
    validity: { notBefore: cert.notBefore, notAfter: cert.notAfter },
  };
}
