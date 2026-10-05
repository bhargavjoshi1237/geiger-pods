/**
 * HTTP API route matcher (pure, `lib/gateway/core/match/`).
 *
 * AWS priority rules (S03 §3):
 * 1. Full match on route and method (static and `{param}` segments).
 *    Among full matches, a literal segment beats a `{param}` segment at
 *    the same depth, comparing left to right.
 * 2. Match through a greedy `{proxy+}` route. The longest literal prefix wins.
 * 3. `$default` route.
 * At each level, a route with the exact method beats `ANY` for the same
 * path. `ANY` therefore only serves methods with no explicit route there.
 *
 * The path is matched without any stage segment or base path (stripped by
 * S11 before this runs), case-sensitively, on raw segments; captures are
 * URL-decoded after the match. Empty segments (`//`) never match a
 * `{param}`. A greedy param must capture >= 1 segment. No match -> null
 * (the caller renders 404 `{"message":"Not Found"}`).
 *
 * Compile once per artifact with {@link compileHttpRoutes}; matching is a
 * linear scan over pre-parsed entries (300 routes match in microseconds).
 *
 * @module lib/gateway/core/match/http-routes
 */

import {
  RoutePatternError,
  decodeParam,
  parsePathPart,
  splitRequestPath,
} from "./path-parts.mjs";

export { RoutePatternError };

/** HTTP methods allowed in a route key, plus the `ANY` wildcard. */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"];

/**
 * Parses an HTTP route key.
 *
 * @param {string} routeKey `$default` or `<METHOD> <path>`.
 * @returns {{ kind: "default" } | { kind: "route", method: string, segments: Array, path: string }}
 * @throws {RoutePatternError} on any grammar violation.
 */
export function parseHttpRouteKey(routeKey) {
  if (routeKey === "$default") return { kind: "default" };
  if (typeof routeKey !== "string") {
    throw new RoutePatternError(`Invalid route key: expected "<METHOD> <path>" or "$default".`);
  }
  const space = routeKey.indexOf(" ");
  if (space === -1) {
    throw new RoutePatternError(`Invalid route key "${routeKey}": expected "<METHOD> <path>" or "$default".`);
  }
  const method = routeKey.slice(0, space);
  const path = routeKey.slice(space + 1);
  if (!HTTP_METHODS.includes(method)) {
    throw new RoutePatternError(
      `Invalid route key "${routeKey}": unknown method "${method}" (want ${HTTP_METHODS.join(", ")}).`,
    );
  }
  if (!path.startsWith("/")) {
    throw new RoutePatternError(`Invalid route key "${routeKey}": path must start with "/".`);
  }
  const rawParts = path === "/" ? [] : path.slice(1).split("/");
  const segments = rawParts.map(parsePathPart);
  segments.forEach((segment, index) => {
    if (segment.kind === "greedy" && index !== segments.length - 1) {
      throw new RoutePatternError(
        `Invalid route key "${routeKey}": greedy segment "${segment.raw}" must be the last segment.`,
      );
    }
  });
  return { kind: "route", method, segments, path };
}

/**
 * Compiles route rows once per artifact. Throws on the first invalid key
 * (fail closed: a bad draft never becomes a half-working artifact).
 *
 * @param {Array<{ id: string, routeKey: string }>} routes draft/API route rows.
 * @returns {{ entries: Array }} compiled form for {@link matchHttpRoute}.
 */
export function compileHttpRoutes(routes) {
  const entries = [];
  let order = 0;
  for (const route of routes ?? []) {
    const parsed = parseHttpRouteKey(route.routeKey);
    if (parsed.kind === "default") {
      entries.push({
        id: route.id,
        routeKey: route.routeKey,
        method: "ANY",
        segments: [],
        isDefault: true,
        isGreedy: false,
        order: order++,
      });
    } else {
      entries.push({
        id: route.id,
        routeKey: route.routeKey,
        method: parsed.method,
        segments: parsed.segments,
        isDefault: false,
        isGreedy: parsed.segments.some((segment) => segment.kind === "greedy"),
        order: order++,
      });
    }
  }
  return { entries };
}

function matchFullSegments(segments, rawSegs) {
  if (segments.length !== rawSegs.length) return null;
  const params = {};
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const raw = rawSegs[index];
    if (segment.kind === "literal") {
      if (segment.value !== raw) return null;
    } else if (segment.kind === "param") {
      if (raw === "") return null;
      params[segment.name] = decodeParam(raw);
    } else {
      return null; // greedy routes never compete in the full-match round
    }
  }
  return params;
}

function matchGreedyPrefix(segments, rawSegs) {
  const prefix = segments.slice(0, -1);
  const greedy = segments[segments.length - 1];
  if (rawSegs.length <= prefix.length) return null; // greedy needs >= 1 segment
  const params = {};
  for (let index = 0; index < prefix.length; index++) {
    const segment = prefix[index];
    const raw = rawSegs[index];
    if (segment.kind === "literal") {
      if (segment.value !== raw) return null;
    } else {
      if (raw === "") return null;
      params[segment.name] = decodeParam(raw);
    }
  }
  params[greedy.name] = rawSegs.slice(prefix.length).map(decodeParam).join("/");
  return params;
}

const KIND_RANK = { literal: 2, param: 1 };

/**
 * Compares two full-match candidates. Returns negative when `a` wins:
 * more literal segments left-to-right, then exact method over `ANY`,
 * then definition order (stable and deterministic).
 */
function compareFull(a, b, method) {
  const segments = a.entry.segments;
  for (let index = 0; index < segments.length; index++) {
    const rank = (KIND_RANK[b.entry.segments[index].kind] ?? 0) - (KIND_RANK[segments[index].kind] ?? 0);
    if (rank !== 0) return rank;
  }
  const exact = (entry) => (entry.method === method ? 0 : 1);
  if (exact(a.entry) !== exact(b.entry)) return exact(a.entry) - exact(b.entry);
  return a.entry.order - b.entry.order;
}

/** Compares two greedy candidates: longest prefix, then specificity, method, order. */
function compareGreedy(a, b, method) {
  if (b.prefixLength !== a.prefixLength) return b.prefixLength - a.prefixLength;
  for (let index = 0; index < a.prefix.length; index++) {
    const rank = (KIND_RANK[b.prefix[index].kind] ?? 0) - (KIND_RANK[a.prefix[index].kind] ?? 0);
    if (rank !== 0) return rank;
  }
  const exact = (entry) => (entry.method === method ? 0 : 1);
  if (exact(a.entry) !== exact(b.entry)) return exact(a.entry) - exact(b.entry);
  return a.entry.order - b.entry.order;
}

/**
 * Matches an HTTP request against compiled routes.
 *
 * @param {{ entries: Array }} compiled from {@link compileHttpRoutes}.
 * @param {string} method request HTTP method (e.g. `"GET"`).
 * @param {string} path request path without stage/base path or query.
 * @returns {{ routeId: string, routeKey: string, pathParameters: Record<string,string> } | null}
 */
export function matchHttpRoute(compiled, method, path) {
  const rawSegs = splitRequestPath(path);
  const entries = compiled?.entries ?? [];

  let best = null;
  for (const entry of entries) {
    if (entry.isDefault || entry.isGreedy) continue;
    if (entry.method !== method && entry.method !== "ANY") continue;
    const pathParameters = matchFullSegments(entry.segments, rawSegs);
    if (pathParameters === null) continue;
    const candidate = { entry, pathParameters };
    if (!best || compareFull(candidate, best, method) < 0) best = candidate;
  }
  if (best) {
    return { routeId: best.entry.id, routeKey: best.entry.routeKey, pathParameters: best.pathParameters };
  }

  let greedy = null;
  for (const entry of entries) {
    if (entry.isDefault || !entry.isGreedy) continue;
    if (entry.method !== method && entry.method !== "ANY") continue;
    const pathParameters = matchGreedyPrefix(entry.segments, rawSegs);
    if (pathParameters === null) continue;
    const candidate = { entry, prefix: entry.segments.slice(0, -1), prefixLength: entry.segments.length - 1, pathParameters };
    if (!greedy || compareGreedy(candidate, greedy, method) < 0) greedy = candidate;
  }
  if (greedy) {
    return { routeId: greedy.entry.id, routeKey: greedy.entry.routeKey, pathParameters: greedy.pathParameters };
  }

  const fallback = entries.find((entry) => entry.isDefault);
  if (fallback) {
    return { routeId: fallback.id, routeKey: fallback.routeKey, pathParameters: {} };
  }
  return null;
}
