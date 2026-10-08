/**
 * Certificate helpers (S11 §§A2/B): truststore parsing, imported-certificate
 * validation.
 *
 * Limits: truststore bundles hold ≤ 1000 certs and ≤ 1 MB (public data).
 * Imported certificates are validated for key match, domain coverage (SAN or
 * CN, one-level wildcards), expiry and chain linkage.
 *
 * @module lib/gateway/core/edge/certs
 */

import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";

/** Maximum PEM bytes in a truststore bundle (1 MB). */
export const MAX_TRUSTSTORE_BYTES = 1024 * 1024;

/** Maximum certificates in a truststore bundle. */
export const MAX_TRUSTSTORE_CERTS = 1000;

/** Warn when a truststore member expires within this window (30 days). */
export const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Splits a PEM bundle into its `CERTIFICATE` blocks.
 *
 * @param {string} pem
 * @returns {Array<string>}
 */
export function splitPemBundle(pem) {
  const blocks = String(pem ?? "").match(/-----BEGIN CERTIFICATE-----[^-]*-----END CERTIFICATE-----/g);
  return blocks ?? [];
}

/**
 * Parses a truststore PEM bundle into cert infos + AWS-style warnings.
 *
 * @param {string} pemBundle
 * @param {{ now?: number }} [options={}]
 * @returns {{ certs: Array<object>, warnings: Array<string> }}
 * @throws {Error} When the bundle is oversized or unparsable.
 */
export function parseTrustStore(pemBundle, { now = Date.now() } = {}) {
  const text = String(pemBundle ?? "");
  if (text.length > MAX_TRUSTSTORE_BYTES) {
    throw new Error("Truststore bundle exceeds 1 MB.");
  }
  const blocks = splitPemBundle(text);
  if (blocks.length === 0) throw new Error("Truststore bundle contains no certificates.");
  if (blocks.length > MAX_TRUSTSTORE_CERTS) {
    throw new Error("Truststore bundle exceeds 1000 certificates.");
  }
  const certs = [];
  const warnings = [];
  for (const block of blocks) {
    let parsed;
    try {
      parsed = new X509Certificate(block);
    } catch {
      throw new Error("Truststore bundle contains an unparsable certificate.");
    }
    const notBefore = Date.parse(parsed.validFrom);
    const notAfter = Date.parse(parsed.validTo);
    certs.push({
      pem: block,
      subject: parsed.subject,
      issuer: parsed.issuer,
      serialNumber: parsed.serialNumber,
      notBefore: new Date(notBefore).toISOString(),
      notAfter: new Date(notAfter).toISOString(),
    });
    if (Number.isFinite(notAfter) && notAfter <= now) {
      warnings.push(`certificate ${parsed.subject} expired on ${new Date(notAfter).toISOString()}`);
    } else if (Number.isFinite(notAfter) && notAfter - now < EXPIRY_WARNING_MS) {
      warnings.push(`certificate ${parsed.subject} expires on ${new Date(notAfter).toISOString()}`);
    }
  }
  return { certs, warnings };
}

/**
 * Extracts DNS names from a certificate (SAN `DNS:` entries, else CN).
 *
 * @param {X509Certificate} cert
 * @returns {Array<string>} Lowercase DNS names.
 */
export function certDnsNames(cert) {
  const names = [];
  for (const entry of String(cert.subjectAltName ?? "").split(",").map((part) => part.trim())) {
    const match = entry.match(/^DNS:(.+)$/i);
    if (match) names.push(match[1].toLowerCase());
  }
  if (names.length === 0) {
    const cn = String(cert.subject ?? "").match(/CN=([^,\n]+)/)?.[1]?.trim().toLowerCase();
    if (cn) names.push(cn);
  }
  return names;
}

/**
 * Returns true when a DNS name covers a domain (exact or one-level wildcard).
 *
 * @param {string} pattern - Cert name (`example.com` or `*.example.com`).
 * @param {string} domainName
 * @returns {boolean}
 */
export function dnsNameCovers(pattern, domainName) {
  const wanted = String(domainName ?? "").toLowerCase();
  const candidate = String(pattern ?? "").toLowerCase();
  if (candidate === wanted) return true;
  // Wildcard cert names (imported) cover one label — never the apex itself.
  if (candidate.startsWith("*.")) {
    const parent = candidate.slice(2);
    if (parent.includes("*")) return false;
    if (wanted.endsWith(`.${parent}`)) {
      const labels = wanted.slice(0, -(parent.length + 1));
      if (labels && !labels.includes(".")) return true;
    }
  }
  // A wildcard *domain* needs a wildcard (or parent-exact, rejected below).
  if (wanted.startsWith("*.")) return false;
  return false;
}

/**
 * Compares a private key against a certificate's public key.
 *
 * @param {string} privateKeyPem
 * @param {X509Certificate} cert
 * @returns {boolean}
 */
export function privateKeyMatchesCert(privateKeyPem, cert) {
  try {
    const privateKey = createPrivateKey(String(privateKeyPem));
    const derived = createPublicKey(privateKey);
    // `cert.publicKey` is already a public KeyObject on Node ≥ 22 (re-wrapping
    // it with `createPublicKey` throws); export both SPKI DERs directly.
    return derived.export({ type: "spki", format: "der" }).equals(cert.publicKey.export({ type: "spki", format: "der" }));
  } catch {
    return false;
  }
}

/**
 * Validates an imported certificate (S11 §A2): key match, domain coverage,
 * expiry and chain linkage.
 *
 * Chain-to-public-root is a warning (not an error): private/test chains are
 * legitimate imports, and production root membership is enforced at issuance
 * monitoring instead.
 *
 * @param {{ certificateChainPem: string, privateKeyPem: string, domainName: string, now?: number }} options
 * @returns {{ errors: Array<string>, warnings: Array<string> }}
 */
export function validateImportedCert({ certificateChainPem, privateKeyPem, domainName, now = Date.now() }) {
  const errors = [];
  const warnings = [];
  const blocks = splitPemBundle(certificateChainPem);
  if (blocks.length === 0) {
    return { errors: ["certificate chain contains no certificates"], warnings };
  }
  let leaf;
  try {
    leaf = new X509Certificate(blocks[0]);
  } catch {
    return { errors: ["certificate chain is unparsable"], warnings };
  }
  if (!privateKeyPem || !privateKeyMatchesCert(privateKeyPem, leaf)) {
    errors.push("the private key does not match the certificate");
  }
  const names = certDnsNames(leaf);
  const wanted = String(domainName ?? "").toLowerCase();
  const covered = names.some((name) => dnsNameCovers(name, wanted));
  if (!covered) {
    errors.push(`the certificate does not cover ${wanted || "(empty domain)"} (SAN: ${names.join(", ") || "none"})`);
  }
  // A wildcard domain needs a wildcard certificate (imported; §A2).
  if (wanted.startsWith("*.") && !names.some((name) => name.startsWith("*."))) {
    errors.push("wildcard domains require a wildcard certificate (or a DNS provider adapter for managed issuance)");
  }
  const notAfter = Date.parse(leaf.validTo);
  if (!Number.isFinite(notAfter) || notAfter <= now) {
    errors.push("the certificate is expired");
  } else if (notAfter - now < EXPIRY_WARNING_MS) {
    warnings.push(`the certificate expires on ${new Date(notAfter).toISOString()}`);
  }
  // Chain linkage: each issuer must equal the next subject.
  let chain = [];
  try {
    chain = blocks.map((block) => new X509Certificate(block));
  } catch {
    errors.push("an intermediate certificate is unparsable");
    return { errors, warnings };
  }
  for (let index = 0; index + 1 < chain.length; index += 1) {
    if (chain[index].issuer !== chain[index + 1].subject) {
      errors.push(`chain linkage broken between certificate ${index} and ${index + 1}`);
      break;
    }
  }
  return { errors, warnings };
}
