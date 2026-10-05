/**
 * Canonical JSON for deployment artifacts (S05 §1).
 *
 * Sorted keys, no whitespace, UTF-8. The same draft always gives the same
 * bytes, so the digest is deterministic.
 *
 * @module lib/gateway/artifact/canonical
 */

/**
 * Returns true for plain objects (not arrays, not null).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively sorts object keys. Arrays keep their order; Maps are
 * converted to plain objects sorted by key (used only for debug snapshots,
 * never for digests over live tries).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Map) {
    const entries = [...value.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    const out = {};
    for (const [key, entry] of entries) out[String(key)] = sortKeys(entry);
    return out;
  }
  if (value instanceof Uint8Array) return Array.from(value);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical JSON: sorted keys, no whitespace.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}
