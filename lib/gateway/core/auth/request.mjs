/**
 * Shared request helpers for the S07 phases (pre-auth, authorize, post-auth).
 *
 * `routeAuthFor(ctx)` resolves the matched method/route to its `{ type,
 * authorizerId, scopes }` auth config plus the authorizer definition from the
 * artifact. `methodArnFor(ctx)` builds the Pods method ARN
 * (`arn:pods:execute-api:{region}:{projectId}:{apiPublicId}/{stage}/{METHOD}/{path}`).
 * `requestFacts(ctx)` builds the condition-evaluation facts (IP, user agent,
 * transport, clock) from the pipeline context.
 *
 * Artifact shapes: S05 `routes[]`/`resources[].methods` carry `auth`; the
 * S03 engine shape (`httpRoutes`/`restResources`) has no auth and resolves to
 * `NONE`.
 *
 * @module lib/gateway/core/auth/request
 */

import { buildMethodArn } from "./policy.mjs";

/** No-auth fallback. */
export const NO_AUTH = { type: "NONE", authorizerId: null, scopes: [] };

function artifactAuth(artifact, authorizerId) {
  const table = artifact?.authorizers ?? {};
  if (!authorizerId) return null;
  if (Array.isArray(table)) return table.find((entry) => String(entry?.id) === String(authorizerId)) ?? null;
  return table[String(authorizerId)] ?? null;
}

/**
 * Resolves the authorization config for the matched method/route.
 *
 * @param {object} ctx - Pipeline context (`request`, `artifact`, `match`).
 * @returns {{ auth: { type: string, authorizerId: string|null, scopes: Array<string> }, authorizer: object|null, resourcePath: string, httpMethod: string, routeKey: string }}
 */
export function routeAuthFor(ctx) {
  const artifact = ctx?.artifact ?? {};
  const protocol = artifact.protocol ?? "REST";
  const match = ctx?.match ?? {};
  const requestMethod = String(ctx?.request?.method ?? "GET").toUpperCase();

  if (protocol === "HTTP") {
    const routes = artifact.routes ?? [];
    const found = routes.find((route) => String(route?.id) === String(match.routeId))
      ?? routes.find((route) => route?.routeKey === match.routeKey)
      ?? null;
    const auth = found?.auth ?? { ...NO_AUTH };
    const routeKey = match.routeKey ?? found?.routeKey ?? "$default";
    let httpMethod = requestMethod;
    let resourcePath = "";
    if (routeKey !== "$default") {
      const space = routeKey.indexOf(" ");
      httpMethod = (space > 0 ? routeKey.slice(0, space) : requestMethod).toUpperCase();
      resourcePath = (space > 0 ? routeKey.slice(space + 1) : "").replace(/^\/+/, "");
    } else {
      resourcePath = requestPath(ctx).replace(/^\/+/, "");
    }
    return {
      auth: { type: auth.type ?? "NONE", authorizerId: auth.authorizerId ?? null, scopes: [...(auth.scopes ?? [])] },
      authorizer: artifactAuth(artifact, auth.authorizerId),
      resourcePath, httpMethod, routeKey,
    };
  }

  if (protocol === "REST") {
    const resources = artifact.resources ?? [];
    const resource = resources.find((entry) => String(entry?.id) === String(match.resourceId)) ?? null;
    const methods = resource?.methods ?? {};
    const entry = methods[requestMethod] ?? methods.ANY ?? methods[match.httpMethod] ?? null;
    const auth = entry?.auth ?? { ...NO_AUTH };
    // The method ARN carries the concrete request path (S07 §2 example:
    // `.../prod/GET/pets/42`), not the resource template.
    const resourcePath = requestPath(ctx).replace(/^\/+/, "");
    return {
      auth: { type: auth.type ?? "NONE", authorizerId: auth.authorizerId ?? null, scopes: [...(auth.scopes ?? [])] },
      authorizer: artifactAuth(artifact, entry?.auth?.authorizerId ?? auth.authorizerId),
      resourcePath, httpMethod: match.httpMethod ?? requestMethod, routeKey: `${requestMethod} ${resource?.path ?? ""}`,
    };
  }

  // WEBSOCKET (S12 owns matching): only the $connect authorizer applies.
  const routes = artifact.routes ?? [];
  const connect = routes.find((route) => route?.routeKey === "$connect") ?? null;
  const auth = connect?.auth ?? { ...NO_AUTH };
  return {
    auth: { type: auth.type ?? "NONE", authorizerId: auth.authorizerId ?? null, scopes: [...(auth.scopes ?? [])] },
    authorizer: artifactAuth(artifact, auth.authorizerId),
    resourcePath: "$connect", httpMethod: requestMethod, routeKey: "$connect",
  };
}

function requestPath(ctx) {
  if (typeof ctx?.requestPath === "string") return ctx.requestPath;
  if (typeof ctx?.basePathStripped === "string") return ctx.basePathStripped;
  try {
    return new URL(ctx.request.url).pathname;
  } catch {
    return "/";
  }
}

/**
 * Builds the Pods method ARN for the current request.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {string}
 */
export function methodArnFor(ctx) {
  const artifact = ctx?.artifact ?? {};
  const resolved = routeAuthFor(ctx);
  return buildMethodArn({
    region: artifact.region ?? "auto",
    projectId: artifact.projectId ?? "",
    apiPublicId: artifact.apiPublicId ?? "",
    stage: artifact.stage ?? "",
    method: resolved.httpMethod,
    resourcePath: resolved.resourcePath,
  });
}

/**
 * Builds condition-evaluation facts from the pipeline context.
 *
 * @param {object} ctx - Pipeline context.
 * @param {{ principalArn?: string|null, principalTags?: Record<string,string> }} [identity={}]
 * @returns {object} `PolicyRequestContext`.
 */
export function requestFacts(ctx, { principalArn = null, principalTags = {} } = {}) {
  const url = (() => {
    try {
      return new URL(ctx.request.url);
    } catch {
      return null;
    }
  })();
  const headers = ctx?.request?.headers;
  const getHeader = (name) => {
    try {
      if (headers && typeof headers.get === "function") return headers.get(name);
      return headers?.[name] ?? null;
    } catch {
      return null;
    }
  };
  return {
    sourceIp: ctx?.context?.identity?.sourceIp ?? "",
    userAgent: getHeader("user-agent") ?? ctx?.context?.identity?.userAgent ?? "",
    referer: getHeader("referer") ?? "",
    connectorId: "",
    sourceVpc: "",
    secureTransport: url ? url.protocol === "https:" : false,
    principalArn,
    principalTags: { ...(principalTags ?? {}) },
    nowMs: ctx?.ports?.clock?.now?.() ?? Date.now(),
  };
}
