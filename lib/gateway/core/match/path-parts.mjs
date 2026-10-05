/**
 * Shared path-segment parsing for the S03 route matchers.
 *
 * Segment grammar (same for REST resources and HTTP route paths):
 * - literal: `^[A-Za-z0-9._~:@!$&'()*,;=-]+$` (or `""`, from `//`/trailing `/`)
 * - `{name}`: single-segment parameter (never matches an empty segment)
 * - `{name+}`: greedy parameter, last segment only, captures >= 1 segment
 *
 * Matching is always done on the raw (still-encoded) segments; captured
 * values are URL-decoded after the match, so an encoded slash (`%2F`)
 * stays inside a single parameter.
 *
 * @module lib/gateway/core/match/path-parts
 */

/** Thrown when a route key or resource path breaks the segment grammar. */
export class RoutePatternError extends Error {
  /**
   * @param {string} message human-readable reason.
   */
  constructor(message) {
    super(message);
    this.name = "RoutePatternError";
    this.code = "invalid_route_key";
  }
}

const LITERAL_RE = /^[A-Za-z0-9._~:@!$&'()*,;=-]+$/;
const VARIABLE_RE = /^\{([A-Za-z_][A-Za-z0-9_.-]*)(\+)?\}$/;

/**
 * Parses one path segment.
 *
 * @param {string} part raw segment text (without slashes).
 * @returns {{ kind: "literal", value: string, raw: string } | { kind: "param" | "greedy", name: string, raw: string }}
 * @throws {RoutePatternError} when the part is neither a valid literal nor a valid variable.
 */
export function parsePathPart(part) {
  const variable = VARIABLE_RE.exec(part);
  if (variable) {
    return variable[2] === "+"
      ? { kind: "greedy", name: variable[1], raw: part }
      : { kind: "param", name: variable[1], raw: part };
  }
  if (part !== "" && !LITERAL_RE.test(part)) {
    throw new RoutePatternError(
      `Invalid path part "${part}": use a literal, "{name}" or a trailing "{name+}".`,
    );
  }
  return { kind: "literal", value: part, raw: part };
}

/**
 * Splits a request path into raw segments. `/` becomes `[]`;
 * `/pets/` becomes `["pets", ""]` (callers decide trailing-slash policy).
 *
 * @param {string} path URL pathname (no query string).
 * @returns {string[]}
 */
export function splitRequestPath(path) {
  const clean = String(path ?? "");
  const withoutLeading = clean.startsWith("/") ? clean.slice(1) : clean;
  if (withoutLeading === "") return [];
  return withoutLeading.split("/");
}

/**
 * URL-decodes one captured parameter value. Malformed escapes fall back
 * to the raw text rather than failing the whole match.
 *
 * @param {string} value raw captured segment.
 * @returns {string}
 */
export function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
