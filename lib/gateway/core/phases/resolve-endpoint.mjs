/**
 * `resolveEndpoint` phase (pipeline row 2 — host → domain/default endpoint → API + stage).
 * S05 implementation (S11 adds custom domains, private endpoints, mTLS).
 * The gateway server already resolved host → artifact via `gateway/loader.mjs`
 * and set `artifact.stage`, `ctx.requestPath`/`ctx.basePathStripped`.
 * This phase handles the engine-only path (`handle(request, artifact)`):
 * it strips a leading `/{stage}` prefix when present so `match` sees the
 * resource path, and records `ctx.stage`/`ctx.requestPath` for downstream
 * phases. Unknown stages are rejected by the loader (REST 403, HTTP 404);
 * this phase never invents a stage.
 *
 * @module lib/gateway/core/phases/resolve-endpoint
 */

import { GatewayError } from "../errors.mjs";
import { applyCustomDomainMatch, resolveCustomDomain } from "../edge/host-resolve.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "resolveEndpoint";

/**
 * Strips the stage prefix when the request path carries it.
 *
 * - `$default` stages serve without a prefix (no stripping).
 * - When `ctx.requestPath`/`ctx.basePathStripped` is already set by the
 *   server, it wins (no double-strip).
 * - Otherwise, when `artifact.stage` is set and the URL path starts with
 *   `/{stage}` or equals `/{stage}`, the prefix is stripped for matching
 *   while `$context.path` keeps the full path (set at context build).
 *
 * @param {object} ctx - Pipeline context (`request`, `artifact`, `context`).
 * @returns {Promise<undefined>}
 */
export async function run(ctx) {
  // --- S11: custom-domain resolution (additive; S05 behavior below is
  // unchanged when no custom-domain match or config is present). ---
  if (ctx?.customDomainMatch) {
    applyCustomDomainMatch(ctx, ctx.customDomainMatch);
    return undefined;
  }
  const domainConfig = ctx?.artifact?.domainConfig ?? null;
  if (domainConfig) {
    const host = ctx?.request?.headers?.get?.("host")
      ?? new URL(ctx.request.url).hostname;
    const pathname = new URL(ctx.request.url).pathname;
    const headers = {};
    for (const [key, value] of ctx.request.headers.entries()) headers[key.toLowerCase()] = value;
    const resolved = resolveCustomDomain({
      host,
      path: pathname,
      headers,
      domain: domainConfig.domain,
      mappings: domainConfig.mappings ?? [],
      rules: domainConfig.rules ?? [],
    });
    if (resolved.error === "notFound") {
      throw new GatewayError("RESOURCE_NOT_FOUND", "Not Found");
    }
    if (resolved.error) {
      throw new GatewayError("ACCESS_DENIED", "Forbidden");
    }
    const protocol = ctx?.artifact?.protocol ?? "REST";
    if ((resolved.apiId ?? "") !== "" && resolved.apiId !== (ctx.artifact.apiPublicId ?? ctx.artifact.apiId ?? "")) {
      throw new GatewayError(
        protocol === "HTTP" ? "RESOURCE_NOT_FOUND" : "ACCESS_DENIED",
        protocol === "HTTP" ? "Not Found" : "Forbidden",
      );
    }
    applyCustomDomainMatch(ctx, {
      ...resolved,
      domainName: String(host).split(":")[0].toLowerCase(),
    });
    return undefined;
  }
  const artifact = ctx?.artifact ?? {};
  const stage = ctx?.stage ?? artifact.stage ?? "";
  if (!stage || stage === "$default") {
    ctx.stage = stage || ctx.stage || "";
    if (ctx.requestPath === undefined && ctx.basePathStripped !== undefined) {
      ctx.requestPath = ctx.basePathStripped;
    } else if (ctx.requestPath === undefined) {
      ctx.requestPath = new URL(ctx.request.url).pathname;
    }
    return undefined;
  }
  if (ctx.requestPath !== undefined || ctx.basePathStripped !== undefined) {
    ctx.requestPath = ctx.requestPath ?? ctx.basePathStripped;
    ctx.stage = stage;
    return undefined;
  }
  const pathname = new URL(ctx.request.url).pathname;
  const prefix = `/${stage}`;
  if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
    const stripped = pathname.slice(prefix.length) || "/";
    ctx.requestPath = stripped.startsWith("/") ? stripped : `/${stripped}`;
    ctx.basePathStripped = ctx.requestPath;
    ctx.stage = stage;
    return undefined;
  }
  // No stage prefix on the URL: leave the path as-is for direct `handle()`
  // callers (S03 tests) and for `$default`-style invocations. The loader
  // produces unknown-stage 403/404 before the engine runs.
  ctx.requestPath = pathname;
  ctx.stage = stage;
  void GatewayError;
  return undefined;
}
