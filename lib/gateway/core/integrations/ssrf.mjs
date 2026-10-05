/**
 * SSRF guard for `INTERNET` integrations (S04 §3.1).
 *
 * Pure ES module (no Node-only APIs): IP literals are parsed by hand so the
 * engine core stays runnable on any host. Resolution itself is injected — the
 * guard wraps a `lookup(hostname)` function returning address strings, and the
 * same predicate backs the undici `connect.lookup` used at connect time, which
 * prevents DNS rebinding. Private targets require a connector.
 *
 * Blocked: loopback, RFC1918, link-local (incl. `169.254.169.254`), CGNAT
 * `100.64/10`, `0.0.0.0/8`, ULA `fc00::/7`, `fe80::/10`, `::1`, `::/128`,
 * IPv4-mapped forms of any blocked range, and the gateway's own hosts.
 *
 * @module lib/gateway/core/integrations/ssrf
 */

function parseIPv4(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num > 255) return null;
    bytes.push(num);
  }
  return bytes;
}

function parseIPv6(text) {
  let addr = String(text).toLowerCase();
  // Split off an embedded IPv4 tail (e.g. ::ffff:127.0.0.1).
  let tail = [];
  const v4match = addr.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4match) {
    const v4 = parseIPv4(v4match[1]);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    addr = addr.slice(0, addr.length - v4match[0].length);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (half === "") return [];
    return half.split(":").map((group) => {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return NaN;
      return Number.parseInt(group, 16);
    });
  };
  const head = parseHalf(halves[0]);
  if (head.some((group) => Number.isNaN(group))) return null;
  if (halves.length === 1) {
    const groups = [...head, ...tail];
    return groups.length === 8 ? groups : null;
  }
  const end = parseHalf(halves[1]);
  if (end.some((group) => Number.isNaN(group))) return null;
  const missing = 8 - tail.length - head.length - end.length;
  if (missing < 1) return null;
  return [...head, ...new Array(missing).fill(0), ...end, ...tail];
}

function v6ToBigInt(groups) {
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

function inCidrV4(bytes, baseBytes, bits) {
  const toInt = (parts) => (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
  const addr = toInt(bytes);
  const base = toInt(baseBytes);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((addr & mask) >>> 0) === ((base & mask) >>> 0);
}

function inCidrV6(value, base, bits) {
  if (bits === 0) return true;
  const shift = 128n - BigInt(bits);
  return (value >> shift) === (base >> shift);
}

/** Blocked IPv4 ranges as [base-bytes, prefix-bits]. */
const BLOCKED_V4 = [
  [[0, 0, 0, 0], 8], // "this network" (0.0.0.0/8)
  [[10, 0, 0, 0], 8], // RFC1918
  [[100, 64, 0, 0], 10], // CGNAT shared space
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local (incl. cloud metadata)
  [[172, 16, 0, 0], 12], // RFC1918
  [[192, 168, 0, 0], 16], // RFC1918
];

/** Blocked IPv6 ranges as [base-groups, prefix-bits]. */
const BLOCKED_V6 = [
  [[0, 0, 0, 0, 0, 0, 0, 0], 128], // unspecified ::
  [[0, 0, 0, 0, 0, 0, 0, 1], 128], // loopback ::1
  [[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7], // unique local fc00::/7
  [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10], // link-local fe80::/10
];

/**
 * Returns true when an IP literal is blocked for INTERNET integrations.
 * IPv4-mapped IPv6 forms (e.g. `::ffff:127.0.0.1`) are unwrapped and judged
 * by their embedded IPv4 address. Non-literals return false (they are judged
 * after resolution). `allowLoopback` (tests only, via `PODS_ALLOW_LOOPBACK=1`
 * or an explicit opt) permits `127.0.0.0/8` and `::1`; every other range
 * stays blocked.
 *
 * @param {string} ip - IP literal, with or without brackets.
 * @param {{ allowLoopback?: boolean }} [opts={}]
 * @returns {boolean}
 */
export function isBlockedIp(ip, opts = {}) {
  const text = String(ip ?? "").trim().replace(/^\[|\]$/g, "");
  if (!text) return true;
  const v4 = parseIPv4(text);
  if (v4) {
    if (opts.allowLoopback && inCidrV4(v4, [127, 0, 0, 0], 8)) return false;
    return BLOCKED_V4.some(([base, bits]) => inCidrV4(v4, base, bits));
  }
  const v6 = parseIPv6(text);
  if (!v6) return false;
  // IPv4-mapped ::ffff:0:0/96 — judge the embedded v4 address.
  if (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0xffff) {
    const embedded = [(v6[6] >> 8) & 0xff, v6[6] & 0xff, (v6[7] >> 8) & 0xff, v6[7] & 0xff];
    return BLOCKED_V4.some(([base, bits]) => inCidrV4(embedded, base, bits));
  }
  const value = v6ToBigInt(v6);
  if (opts.allowLoopback && value === 1n) return false;
  return BLOCKED_V6.some(([base, bits]) => inCidrV6(value, v6ToBigInt(base), bits));
}

/**
 * Classifies a hostname without resolving it: IP literals are judged directly.
 *
 * @param {string} hostname
 * @param {{ allowLoopback?: boolean }} [opts={}]
 * @returns {"blocked" | "literal-allowed" | "needs-resolution"}
 */
export function classifyHost(hostname, opts = {}) {
  const text = String(hostname ?? "").trim().replace(/^\[|\]$/g, "");
  if (!text) return "blocked";
  if (parseIPv4(text)) return isBlockedIp(text, opts) ? "blocked" : "literal-allowed";
  if (text.includes(":") && parseIPv6(text)) return isBlockedIp(text, opts) ? "blocked" : "literal-allowed";
  return "needs-resolution";
}

/**
 * Checks resolved addresses for a hostname against the guard.
 *
 * @param {string} hostname
 * @param {string[]} addresses - Resolved IP literals.
 * @param {{ selfHosts?: string[], allowLoopback?: boolean }} [opts={}]
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkResolvedAddresses(hostname, addresses, opts = {}) {
  const selfHosts = new Set((opts.selfHosts ?? []).map((host) => String(host).toLowerCase()));
  if (selfHosts.has(String(hostname).toLowerCase())) {
    return { allowed: false, reason: "gateway-self" };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { allowed: false, reason: "unresolvable" };
  }
  for (const address of addresses) {
    if (isBlockedIp(address, opts)) return { allowed: false, reason: `blocked-address:${address}` };
  }
  return { allowed: true };
}

/**
 * Wraps a `lookup(hostname) => Promise<string[]>` resolver with the SSRF guard.
 * Rejects with an `Error` whose `code` is `PODS_SSRF_BLOCKED` when blocked.
 *
 * @param {(hostname: string) => Promise<string[]>} lookup - Underlying resolver.
 * @param {{ selfHosts?: string[], allowLoopback?: boolean }} [opts={}]
 * @returns {(hostname: string) => Promise<string[]>}
 */
export function createGuardedLookup(lookup, opts = {}) {
  return async function guardedLookup(hostname) {
    const verdict = classifyHost(hostname, opts);
    if (verdict === "blocked") {
      throw Object.assign(new Error(`SSRF guard blocked host "${hostname}".`), { code: "PODS_SSRF_BLOCKED" });
    }
    if (verdict === "literal-allowed") return [String(hostname)];
    const addresses = await lookup(hostname);
    const check = checkResolvedAddresses(hostname, addresses, opts);
    if (!check.allowed) {
      throw Object.assign(new Error(`SSRF guard blocked host "${hostname}" (${check.reason}).`), {
        code: "PODS_SSRF_BLOCKED",
        reason: check.reason,
      });
    }
    return addresses;
  };
}

/**
 * Adapts a promise-style guarded lookup to the `dns.lookup(hostname, options, callback)`
 * shape undici `connect.lookup` expects, so every connection re-resolves and
 * re-checks (DNS-rebinding safe).
 *
 * @param {(hostname: string) => Promise<string[]>} guardedLookup
 * @returns {(hostname: string, options: unknown, callback: Function) => void}
 */
export function toConnectLookup(guardedLookup) {
  return function connectLookup(hostname, options, callback) {
    const done = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : (options ?? {});
    guardedLookup(String(hostname)).then(
      (addresses) => {
        const address = addresses[0];
        if (!address) {
          done(Object.assign(new Error(`No addresses for "${hostname}".`), { code: "ENOTFOUND" }));
          return;
        }
        const family = address.includes(":") ? 6 : 4;
        if (opts && typeof opts === "object" && opts.all) {
          done(null, addresses.map((entry) => ({ address: entry, family: entry.includes(":") ? 6 : 4 })));
        } else {
          done(null, address, family);
        }
      },
      (error) => done(error),
    );
  };
}
