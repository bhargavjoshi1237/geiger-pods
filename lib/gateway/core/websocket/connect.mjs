/**
 * `$connect` authentication: SIGNED / CUSTOM + API key via
 * `apiKeySelectionExpression` + throttle/quota reuse (S12 §2).
 *
 * `$connect`-only auth: `NONE`/`SIGNED`/`CUSTOM` (JWT is not a WS auth
 * type). A CUSTOM authorizer's context is stored on the connection record
 * and replayed into later MESSAGE events. API keys use
 * `apiKeySelectionExpression` (default `$request.header.x-api-key`).
 *
 * @module lib/gateway/core/websocket/connect
 */

import { GatewayError } from "../errors.mjs";
import { verifySignature } from "../auth/sigv4.mjs";
import { buildMethodArn, credentialPrincipalArn, evaluatePolicy } from "../auth/policy.mjs";
import { normalizeAuthorizer } from "../phases/authorize.mjs";
import { gatherIdentity, runCustomAuth } from "../auth/custom.mjs";
import { hmacForValue, lookupKeyRecord, findCoveringPlan, pepperFrom } from "../usage/api-key.mjs";

const MAX_EXPRESSION_BYTES = 512;

/**
 * Finds the `$connect` route in an artifact.
 *
 * @param {object} artifact
 * @returns {object|null}
 */
export function findConnectRoute(artifact) {
  return (artifact?.routes ?? []).find((route) => route?.routeKey === "$connect") ?? null;
}

/**
 * Reads one `$request.header.<N>` / `$request.querystring.<N>` value.
 *
 * @param {Request} request
 * @param {string|null} expression
 * @returns {string|null}
 */
export function readApiKeySelection(request, expression) {
  const expr = typeof expression === "string" && expression ? expression : "$request.header.x-api-key";
  if (expr.length > MAX_EXPRESSION_BYTES) return null;
  const trimmed = expr.trim();
  let match = trimmed.match(/^\$request\.header\.(.+)$/i);
  if (match) {
    const name = match[1].trim();
    if (!name || name === "__proto__" || name === "constructor" || name === "prototype") return null;
    const direct = request.headers.get(name);
    if (direct !== null) return direct;
    for (const [key, value] of request.headers.entries()) {
      if (key.toLowerCase() === name.toLowerCase()) return value;
    }
    return null;
  }
  match = trimmed.match(/^\$request\.querystring\.(.+)$/i);
  if (match) {
    try {
      const value = new URL(request.url).searchParams.get(match[1]);
      return value === null ? null : String(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Builds the CONNECT method ARN for policy evaluation.
 *
 * @param {object} artifact
 * @param {string} stage
 * @returns {string}
 */
export function connectMethodArn(artifact, stage) {
  return buildMethodArn({
    region: artifact?.region ?? "auto",
    projectId: artifact?.projectId ?? "",
    apiPublicId: artifact?.apiPublicId ?? artifact?.apiId ?? "",
    stage: stage ?? artifact?.stage ?? "",
    method: "CONNECT",
    resourcePath: "$connect",
  });
}

/**
 * Authenticates a `$connect` upgrade request.
 *
 * Sets `ctx.authType`, `ctx.authorizer`, `ctx.context.authorizer.*`,
 * `ctx.context.identity.*`, `ctx.usageKey` and returns the authorizer
 * context to persist on the connection record.
 *
 * @param {object} ctx - Pipeline context (`request`, `artifact`, `ports`, `context`).
 * @param {object} route - The `$connect` route (`auth`, `apiKeyRequired`).
 * @returns {Promise<{ authorizerContext: object|null, apiKey: { keyId: string }|null }>}
 * @throws {GatewayError} On auth/api-key failure (caller maps to upgrade status).
 */
export async function authenticateConnect(ctx, route) {
  const artifact = ctx?.artifact ?? {};
  const auth = route?.auth ?? { type: "NONE" };
  const type = auth.type ?? "NONE";
  let authorizerContext = null;

  if (type === "NONE") {
    ctx.authType = "NONE";
    ctx.authResult = { authType: "NONE", authorized: true, principalArn: null, identityDecision: "ImplicitDeny" };
  } else if (type === "CUSTOM") {
    const raw = (artifact.authorizers ?? {})[auth.authorizerId] ?? null;
    if (!raw) throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
    const authorizer = normalizeAuthorizer(raw, "WEBSOCKET");
    const arn = connectMethodArn(artifact, artifact.stage ?? ctx?.stage ?? "");
    ctx.methodArn = arn;
    // Missing identity → 401 without invoking (AWS parity, via runCustomAuth).
    const result = await runCustomAuth({
      authorizer,
      kind: "WS",
      request: ctx.request,
      methodArn: arn,
      resourcePath: "$connect",
      httpMethod: "CONNECT",
      pathParameters: {},
      stageVariables: ctx.stageVariables ?? {},
      context: ctx.context ?? {},
      routeKey: "$connect",
      connectionId: ctx.context?.connectionId ?? null,
      ports: ctx.ports ?? {},
    });
    const extra = {};
    for (const [key, value] of Object.entries(result.context ?? {})) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      extra[key] = typeof value === "string" ? value : String(value);
    }
    ctx.authorizer = { principalId: result.principalId, ...extra };
    ctx.context.authorizer.principalId = result.principalId;
    for (const [key, value] of Object.entries(extra)) ctx.context.authorizer[key] = value;
    if (result.usageIdentifierKey) {
      ctx.authorizer.usageIdentifierKey = result.usageIdentifierKey;
      ctx.context.authorizer.usageIdentifierKey = result.usageIdentifierKey;
      ctx.usageIdentifierKey = result.usageIdentifierKey;
    }
    ctx.authType = "CUSTOM";
    ctx.authResult = { authType: "CUSTOM", authorized: true, principalArn: null, identityDecision: "Allow" };
    authorizerContext = { principalId: result.principalId, ...extra };
    if (result.usageIdentifierKey) authorizerContext.usageIdentifierKey = result.usageIdentifierKey;
  } else if (type === "SIGNED") {
    const lookup = ctx.ports?.signingCredentials ?? null;
    const verified = await verifySignature(ctx.request, {
      region: artifact.region ?? "auto",
      allowAnyRegion: artifact.features?.signedAnyRegion === true,
      lookupSecret: lookup ? async (id) => lookup.resolve(id) : async () => null,
      now: ctx.ports?.clock?.now?.(),
    }).catch((error) => {
      if (error?.type === "MISSING_AUTHENTICATION_TOKEN") throw new GatewayError("MISSING_AUTHENTICATION_TOKEN", "Missing Authentication Token");
      if (error?.type === "EXPIRED_TOKEN") throw new GatewayError("EXPIRED_TOKEN", "Forbidden");
      throw new GatewayError("INVALID_SIGNATURE", error?.message ?? "Forbidden");
    });
    const principalArn = credentialPrincipalArn({ projectId: artifact.projectId ?? "", accessKeyId: verified.accessKeyId });
    ctx.context.identity.accessKey = verified.accessKeyId;
    ctx.context.identity.caller = verified.accessKeyId;
    ctx.context.identity.user = verified.accessKeyId;
    ctx.context.identity.userArn = principalArn;
    let decision = "ImplicitDeny";
    const policies = ctx.ports?.signingPolicies ?? null;
    if (policies) {
      const documents = (await policies.list(verified.accessKeyId)) ?? [];
      const arn = connectMethodArn(artifact, artifact.stage ?? ctx?.stage ?? "");
      for (const document of documents) {
        const { decision: verdict } = evaluatePolicy({
          document,
          action: "execute-api:Invoke",
          resource: arn,
          request: { sourceIp: ctx.context?.identity?.sourceIp ?? "", principalArn, nowMs: ctx.ports?.clock?.now?.() ?? Date.now() },
        });
        if (verdict === "Deny") throw new GatewayError("ACCESS_DENIED", "Forbidden");
        if (verdict === "Allow") decision = "Allow";
      }
    } else {
      decision = "Allow";
    }
    ctx.authType = "SIGNED";
    ctx.authResult = { authType: "SIGNED", authorized: decision === "Allow", principalArn, identityDecision: decision };
    if (decision !== "Allow" && !artifact?.settings?.resourcePolicy) throw new GatewayError("ACCESS_DENIED", "Forbidden");
  } else {
    throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
  }

  // API key on `$connect` only, via `apiKeySelectionExpression`.
  let apiKey = null;
  if (route?.apiKeyRequired === true) {
    const expression = artifact?.settings?.apiKeySelectionExpression
      ?? artifact?.apiKeySelectionExpression
      ?? "$request.header.x-api-key";
    const candidate = readApiKeySelection(ctx.request, expression)
      // AUTHORIZER source falls back to the custom authorizer's key.
      ?? (authorizerContext?.usageIdentifierKey ?? ctx?.authorizer?.usageIdentifierKey ?? null);
    if (!candidate) throw new GatewayError("INVALID_API_KEY", "Forbidden");
    let hmac = null;
    try {
      hmac = hmacForValue(candidate, pepperFrom(ctx));
    } catch {
      throw new GatewayError("INVALID_API_KEY", "Forbidden");
    }
    const record = await lookupKeyRecord(ctx, hmac);
    if (!record || record.enabled === false) throw new GatewayError("INVALID_API_KEY", "Forbidden");
    const plan = findCoveringPlan(record, artifact.apiId, artifact.stage ?? ctx?.stage ?? "");
    if (!plan) throw new GatewayError("INVALID_API_KEY", "Forbidden");
    if (ctx?.context?.identity) {
      ctx.context.identity.apiKey = candidate;
      ctx.context.identity.apiKeyId = record.keyId;
    }
    ctx.usageKey = { keyId: record.keyId, publicId: record.publicId ?? null, plan };
    apiKey = { keyId: record.keyId };
  }

  void gatherIdentity;
  return { authorizerContext, apiKey };
}
