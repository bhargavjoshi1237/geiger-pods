/**
 * `match` phase (pipeline row 5 — route/resource+method, path params, greedy).
 *
 * S03 implementation (replaces the S01 no-op stub, keeping the `name` +
 * `run(ctx)` contract). Reads the compiled deployment artifact:
 * - HTTP: `artifact.httpRoutes` (`[{ id, routeKey }]`); no match throws
 *   `RESOURCE_NOT_FOUND` (404 `{"message":"Not Found"}`).
 * - REST: `artifact.restResources` + `artifact.restMethods`; a matched
 *   resource without a method, or no resource at all, throws
 *   `MISSING_AUTHENTICATION_TOKEN` (403), or `RESOURCE_NOT_FOUND` (404)
 *   when `artifact.missingRouteBehavior === "not_found"`.
 * - WEBSOCKET (or anything else): no-op, owned by S12.
 *
 * On a match the phase records `ctx.match` (`{ routeId|resourceId, ... }`),
 * `ctx.pathParameters`, and the `$context` routing fields (`routeKey`,
 * `resourcePath`, `resourceId`), then returns `undefined` so the pipeline
 * continues. Compiled tries are cached per artifact in a `WeakMap`, so
 * artifacts compiled once (S05) match in microseconds.
 *
 * @module lib/gateway/core/phases/match
 */

import { GatewayError } from "../errors.mjs";
import { compileHttpRoutes, matchHttpRoute } from "../match/http-routes.mjs";
import { compileRestResources, matchRestResource } from "../match/rest-resources.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "match";

const httpCache = new WeakMap();
const restCache = new WeakMap();

function httpCompiled(artifact) {
  let compiled = httpCache.get(artifact);
  if (!compiled) {
    compiled = compileHttpRoutes(artifact.httpRoutes ?? []);
    httpCache.set(artifact, compiled);
  }
  return compiled;
}

function restCompiled(artifact, restResources, restMethods) {
  let compiled = restCache.get(artifact);
  if (!compiled) {
    compiled = compileRestResources(
      restResources ?? artifact.restResources ?? [],
      restMethods ?? artifact.restMethods ?? [],
    );
    restCache.set(artifact, compiled);
  }
  return compiled;
}

/**
 * Flattens S05 `resources[].methods` into S03 `restMethods` rows.
 *
 * @param {Array} resources
 * @returns {Array<{ id: string, resourceId: string, httpMethod: string }>}
 */
function methodsFromResources(resources) {
  const out = [];
  for (const resource of resources ?? []) {
    for (const [httpMethod, method] of Object.entries(resource.methods ?? {})) {
      out.push({ id: method?.id ?? `${resource.id}:${httpMethod}`, resourceId: resource.id, httpMethod });
    }
  }
  return out;
}

/**
 * Compiles HTTP routes with per-artifact caching. `httpRoutes` is the
 * normalized list so both S03 and S05 artifact shapes share the cache.
 */
function compileForHttp(artifact, httpRoutes) {
  let compiled = httpCache.get(artifact);
  if (!compiled) {
    compiled = compileHttpRoutes(httpRoutes ?? artifact.httpRoutes ?? []);
    httpCache.set(artifact, compiled);
  }
  return compiled;
}

function requestPath(ctx) {
  if (typeof ctx?.requestPath === "string") return ctx.requestPath;
  if (typeof ctx?.basePathStripped === "string") return ctx.basePathStripped;
  return new URL(ctx.request.url).pathname;
}

/**
 * Matches the request against the artifact's routes/resources.
 *
 * S05 additive: prefers `ctx.requestPath`/`ctx.basePathStripped` (set by
 * `resolveEndpoint`/the gateway server) so stage prefixes never reach the
 * matchers; falls back to the request URL for direct `handle()` callers.
 * Also accepts the S05 artifact shape (`routes`/`resources` + `methods`)
 * in addition to the S03 engine shape (`httpRoutes`/`restResources`).
 *
 * @param {object} ctx - Pipeline context (`request`, `artifact`, `context`).
 * @returns {Promise<undefined>} `undefined` on a match; throws `GatewayError` otherwise.
 */
export async function run(ctx) {
  const artifact = ctx?.artifact ?? {};
  const protocol = artifact.protocol ?? "REST";
  // S05 artifacts carry `routes`/`resources`; S03 engine tests use the flat
  // `httpRoutes`/`restResources`/`restMethods` fields. Support both.
  const httpRoutes = artifact.httpRoutes ?? (artifact.routes ?? []).map((route) => ({
    id: route.id,
    routeKey: route.routeKey ?? route.route_key,
  }));
  const restResources = artifact.restResources ?? (artifact.resources ?? []).map((resource) => ({
    id: resource.id,
    path: resource.path,
  }));
  const restMethods = artifact.restMethods ?? methodsFromResources(artifact.resources ?? []);

  if (protocol === "HTTP") {
    const compiled = compileForHttp(artifact, httpRoutes);
    const found = matchHttpRoute(compiled, ctx.request.method, requestPath(ctx));
    if (!found) throw new GatewayError("RESOURCE_NOT_FOUND", "Not Found");
    ctx.match = found;
    ctx.pathParameters = found.pathParameters;
    ctx.context.routeKey = found.routeKey;
    ctx.context.resourcePath = found.routeKey.includes(" ") ? found.routeKey.split(" ").slice(1).join(" ") : found.routeKey;
    ctx.context.resourceId = found.routeId;
    return undefined;
  }

  if (protocol === "REST") {
    const found = matchRestResource(restCompiled(artifact, restResources, restMethods), ctx.request.method, requestPath(ctx));
    const notFound = artifact.missingRouteBehavior === "not_found";
    if (!found || !found.methodId) {
      if (notFound) throw new GatewayError("RESOURCE_NOT_FOUND", "Not Found");
      throw new GatewayError("MISSING_AUTHENTICATION_TOKEN", "Missing Authentication Token");
    }
    ctx.match = found;
    ctx.pathParameters = found.pathParameters;
    ctx.context.routeKey = `${ctx.request.method} ${found.resourcePath}`;
    ctx.context.resourcePath = found.resourcePath;
    ctx.context.resourceId = found.resourceId;
    return undefined;
  }

  return undefined;
}
