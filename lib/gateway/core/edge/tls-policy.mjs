/**
 * TLS security policies (S11 §A3). Profiles map to Node
 * `tls.createSecureContext` options. FIPS variants are out of scope; the UI
 * says so. TLS 1.0/1.1 are never offered.
 *
 * @module lib/gateway/core/edge/tls-policy
 */

import { getCurves } from "node:crypto";

/**
 * Pods TLS profiles with their AWS analogues.
 * @type {Record<string, { aws: string, minVersion: string, ciphers?: Array<string>, groups?: Array<string>, pq?: boolean }>}
 */
export const TLS_POLICIES = {
  TLS_1_2: {
    aws: "TLS_1_2",
    minVersion: "TLSv1.2",
    ciphers: [
      "ECDHE-ECDSA-AES128-GCM-SHA256",
      "ECDHE-RSA-AES128-GCM-SHA256",
      "ECDHE-ECDSA-AES256-GCM-SHA384",
      "ECDHE-RSA-AES256-GCM-SHA384",
      "ECDHE-ECDSA-CHACHA20-POLY1305",
      "ECDHE-RSA-CHACHA20-POLY1305",
    ],
  },
  TLS13_1_2_STRICT: {
    aws: "SecurityPolicy_TLS13_1_2_2021_06",
    minVersion: "TLSv1.2",
    ciphers: [
      "TLS_AES_128_GCM_SHA256",
      "TLS_AES_256_GCM_SHA384",
      "TLS_CHACHA20_POLY1305_SHA256",
      "ECDHE-ECDSA-AES128-GCM-SHA256",
      "ECDHE-RSA-AES128-GCM-SHA256",
    ],
  },
  TLS13_ONLY: {
    aws: "SecurityPolicy_TLS13_1_3_2025_09",
    minVersion: "TLSv1.3",
  },
  TLS13_1_2_PQ: {
    aws: "SecurityPolicy_TLS13_1_2_PQ_2025_09",
    minVersion: "TLSv1.2",
    groups: ["X25519MLKEM768", "X25519", "secp256r1", "secp384r1"],
    pq: true,
  },
};

/**
 * Feature-detects post-quantum group support (S11 §A3): the PQ profile is
 * hidden when the runtime's OpenSSL does not offer `X25519MLKEM768`.
 *
 * @returns {boolean}
 */
export function pqSupported() {
  try {
    return getCurves().includes("X25519MLKEM768");
  } catch {
    return false;
  }
}

/**
 * Lists selectable security policies (PQ hidden without runtime support).
 *
 * @returns {Array<string>}
 */
export function availablePolicies() {
  return Object.keys(TLS_POLICIES).filter((name) => (TLS_POLICIES[name].pq ? pqSupported() : true));
}

const VERSION_ORDER = ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"];

/**
 * Returns true when a negotiated TLS version satisfies a policy.
 *
 * @param {string} policy - Profile name (unknown → TLS_1_2 default, fail closed).
 * @param {string} version - Negotiated version, e.g. `"TLSv1.2"`.
 * @returns {boolean}
 */
export function isTlsVersionAllowed(policy, version) {
  const profile = TLS_POLICIES[policy] ?? TLS_POLICIES.TLS_1_2;
  return VERSION_ORDER.indexOf(version) >= VERSION_ORDER.indexOf(profile.minVersion);
}

/**
 * Builds `tls.createSecureContext` options for a policy.
 *
 * @param {string} policy
 * @returns {{ minVersion: string, ciphers?: string }}
 */
export function secureOptionsFor(policy) {
  const profile = TLS_POLICIES[policy] ?? TLS_POLICIES.TLS_1_2;
  const options = { minVersion: profile.minVersion };
  if (profile.ciphers) options.ciphers = profile.ciphers.join(":");
  return options;
}
