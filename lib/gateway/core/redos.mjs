/**
 * ReDoS-safe regex handling (S15 F17, shared).
 *
 * Request-controlled patterns (integration-response `selection_pattern`,
 * WAF regex sets, identity-validation expressions, VTL
 * `replaceAll`/`split`/`matches` args, imported patterns) must be linear:
 * length-capped, no backreferences, no lookaround, and no quantified group
 * whose body contains a quantifier or a top-level alternation. Runtime
 * evaluation additionally bounds input length, and hot patterns (CORS
 * wildcard origins) are precompiled once instead of per request.
 *
 * @module lib/gateway/core/redos
 */

/** Save-time pattern cap for request-controlled regexes (S15 §2). */
export const MAX_SAFE_PATTERN_CHARS = 512;

/** Runtime input cap for request-controlled regex evaluation. */
export const MAX_SAFE_INPUT_CHARS = 100_000;

/**
 * Validates one regex pattern (RE2-safe subset, no ReDoS surface).
 *
 * @param {string} pattern
 * @param {{ maxLength?: number }} [options={}]
 * @returns {string|null} Error message, or null when accepted.
 */
export function validateSafePattern(pattern, { maxLength = MAX_SAFE_PATTERN_CHARS } = {}) {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > maxLength) {
    return `regex patterns must be strings of 1–${maxLength} characters`;
  }
  try {
    void new RegExp(pattern);
  } catch (error) {
    return `invalid regex: ${error.message}`;
  }
  if (/\\[1-9]/.test(pattern)) return "regex backreferences are not allowed";
  if (/\(\?[=!<]/.test(pattern)) return "regex lookaround is not allowed";
  // F49: named capture groups (`(?<name>…)` / `(?P<name>…)`) are not
  // lookaround but still outside the linear subset (backreference-adjacent
  // and RE2-incompatible); reject them explicitly.
  if (/\(\?<(?![=!])/.test(pattern) || /\(\?P</.test(pattern)) {
    return "regex named capture groups are not allowed (RE2 linear subset)";
  }
  // Strip escapes and character classes, then reject quantified groups whose
  // body contains a quantifier, `{n,m}` or a top-level alternation.
  const stripped = String(pattern)
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "C");
  const group = /\(([^()]*)\)[*+?]/g;
  let match;
  while ((match = group.exec(stripped)) !== null) {
    const body = match[1].replace(/^\(\?:/, "");
    if (/[*+{]/.test(body) || body.includes("|")) {
      return `regex "${pattern}" may be catastrophic (nested quantifier); rewrite it linearly`;
    }
  }
  return null;
}

/**
 * Compiles a validated pattern, throwing on anything unsafe.
 *
 * @param {string} pattern
 * @param {string} [flags=""]
 * @param {{ maxLength?: number, maxInputChars?: number }} [options={}]
 * @returns {RegExp}
 * @throws {Error} With `code = "REDOS_UNSAFE_PATTERN"` when rejected.
 */
export function compileSafePattern(pattern, flags = "", { maxLength = MAX_SAFE_PATTERN_CHARS } = {}) {
  const problem = validateSafePattern(pattern, { maxLength });
  if (problem) {
    throw Object.assign(new Error(problem), { code: "REDOS_UNSAFE_PATTERN" });
  }
  return new RegExp(pattern, flags);
}

/**
 * Bounds a runtime evaluation input: over-long inputs fail closed instead of
 * feeding a backtracker.
 *
 * @param {unknown} value
 * @param {{ maxInputChars?: number }} [options={}]
 * @returns {string} The input as a string.
 * @throws {Error} With `code = "REDOS_INPUT_TOO_LONG"` when over budget.
 */
export function boundRegexInput(value, { maxInputChars = MAX_SAFE_INPUT_CHARS } = {}) {
  const text = String(value ?? "");
  if (text.length > maxInputChars) {
    throw Object.assign(new Error(`regex input exceeds ${maxInputChars} characters`), {
      code: "REDOS_INPUT_TOO_LONG",
    });
  }
  return text;
}

/**
 * Precompiled-regex cache for hot per-request patterns (CORS wildcard
 * origins). Compiles once per distinct pattern; evicts oldest past the cap.
 *
 * @param {number} [maxEntries=1000]
 * @returns {{ get(pattern: string, build: () => RegExp): RegExp, size: number }}
 */
export function createPatternCache(maxEntries = 1000) {
  const cache = new Map();
  return {
    get size() {
      return cache.size;
    },
    get(pattern, build) {
      const key = String(pattern);
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const compiled = build();
      cache.set(key, compiled);
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
      return compiled;
    },
  };
}
