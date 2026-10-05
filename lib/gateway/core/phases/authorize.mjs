/**
 * `authorize` phase (pipeline row 9 — NONE / signed / JWT / custom).
 *
 * S07 implementation (replaces the S01 no-op stub, keeping the `name` +
 * `run(ctx)` contract). Reads the matched route/method auth config from
 * the artifact (`routes[].auth`, `resources[].methods[].auth`) via
 * `ctx.match`, plus `artifact.authorizers` (raw draft rows, camelCase or
 * snake_case — normalized here).
 *
 * - `NONE`: no-op.
 * - `JWT`: `verifyJwt`; missing/invalid → 401 `UNAUTHORIZED` (403 only for
 *   scope mismatches). On success sets `$context.authorizer.*` and
 *   `ctx.authorizer` (`principalId = sub`, stringified claims, scopes).
 * - `CUSTOM`: `runCustomAuth` with KV-backed caching; sets the same
 *   context fields plus `usageIdentifierKey` for S08 (`AUTHORIZER` key
 *   source). The `kind` follows the protocol/payload version (REST TOKEN /
 *   REST REQUEST / HTTP 1.0 / HTTP 2.0 / WebSocket `$connect`).
 * - `SIGNED`: `verifySignature` against `ports.signingCredentials`
 *   (`lookupSecret`); sets `$context.identity.*` and evaluates identity
 *   policies from `ports.signingPolicies` (explicit Deny > Allow >
 *   implicit deny). Records `ctx.authResult` for the post-auth policy pass.
 *
 * @module lib/gateway/core/phases/authorize
 */

import { GatewayError } from "../errors.mjs";
import { supports } from "../../capabilities.mjs";
import { claimsForContext, extractJwtToken, verifyJwt } from "../auth/jwt.mjs";
import { runCustomAuth } from "../auth/custom.mjs";
import { verifySignature } from "../auth/sigv4.mjs";
import { buildMethodArn, credentialPrincipalArn, evaluatePolicy } from "../auth/policy.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "authorize";

function requestPath(ctx) {
  if (typeof ctx?.requestPath === "string") return ctx.requestPath;
  try {
    return new URL(ctx.request.url).pathname;
  } catch {
    return "/";
  }
}

function field(row, ...names) {
  for (const fname of names) {
    if (row && Object.hasOwn(row, fname) && row[fname] !== undefined) return row[fname];
  }
  return undefined;
}

function findAuthConfig(ctx) {
  const artifact = ctx?.artifact ?? {};
  const protocol = artifact.protocol ?? "REST";
  if (protocol === "HTTP") {
    const routes = artifact.routes ?? [];
    const route = routes.find((entry) => entry?.id === ctx?.match?.routeId) ?? null;
    if (!route) return { type: "NONE", authorizerId: null, scopes: [] };
    const auth = route.auth ?? {};
    return {
      type: auth.type ?? "NONE",
      authorizerId: auth.authorizerId ?? null,
      scopes: [...(auth.scopes ?? [])],
      routeKey: route.routeKey ?? ctx?.match?.routeKey ?? "",
    };
  }
  if (protocol === "REST") {
    const method = String(ctx.request?.method ?? "GET").toUpperCase();
    for (const resource of artifact.resources ?? []) {
      const entry = resource?.methods?.[method] ?? resource?.methods?.ANY;
      if (!entry) continue;
      if (ctx?.match && resource.id !== ctx.match.resourceId) continue;
      const auth = entry.auth ?? {};
      return {
        type: auth.type ?? "NONE",
        authorizerId: auth.authorizerId ?? null,
        scopes: [...(auth.scopes ?? [])],
        methodId: entry.id ?? null,
      };
    }
    return { type: "NONE", authorizerId: null, scopes: [] };
  }
  return { type: "NONE", authorizerId: null, scopes: [] };
}

function findAuthorizer(ctx, authorizerId) {
  if (!authorizerId) return null;
  const table = ctx?.artifact?.authorizers ?? {};
  if (Array.isArray(table)) return table.find((entry) => String(entry?.id) === String(authorizerId)) ?? null;
  return table[authorizerId] ?? null;
}

/**
 * Normalizes a raw artifact authorizer row (camelCase or snake_case) to
 * the engine shape `runCustomAuth`/`verifyJwt` consume.
 *
 * @param {object} row - Raw authorizer row.
 * @param {string} protocol - API protocol (HTTP default TTL is 0, else 300).
 * @returns {object} Normalized authorizer config.
 */
export function normalizeAuthorizer(row, protocol = "REST") {
  const jwt = field(row, "jwt") ?? {};
  return {
    id: String(field(row, "id") ?? ""),
    name: field(row, "name") ?? "",
    type: field(row, "type") ?? "REQUEST",
    identitySource: field(row, "identitySource", "identity_source") ?? [],
    identityValidationExpression: field(row, "identityValidationExpression", "identity_validation_expression") ?? null,
    jwt: {
      issuer: jwt.issuer,
      audience: jwt.audience ?? jwt.audiences ?? [],
      algorithms: jwt.algorithms ?? ["RS256"],
      clockSkewSec: jwt.clockSkewSec ?? jwt.clock_skew_sec ?? 0,
    },
    function: field(row, "function") ?? {},
    payloadFormatVersion: String(field(row, "payloadFormatVersion", "payload_format_version") ?? "1.0"),
    enableSimpleResponses: field(row, "enableSimpleResponses", "enable_simple_responses") ?? false,
    resultTtlSeconds: field(row, "resultTtlSeconds", "result_ttl_seconds") ?? (protocol === "HTTP" ? 0 : 300),
    timeoutMs: field(row, "timeoutMs", "timeout_ms") ?? 10000,
  };
}

function methodArnFor(ctx) {
  const artifact = ctx?.artifact ?? {};
  const path = requestPath(ctx).replace(/^\/+/, "");
  return buildMethodArn({
    // Region is an explicit artifact field (default "auto" = PODS_REGION);
    // the engine core never reads process.env (Node-only API).
    region: artifact.region ?? "auto",
    projectId: artifact.projectId ?? "",
    apiPublicId: artifact.apiPublicId ?? artifact.apiId ?? "",
    stage: artifact.stage ?? "",
    method: String(ctx.request.method).toUpperCase(),
    resourcePath: path || "/",
  });
}

function setAuthorizerContext(ctx, { principalId, claims = {}, scopes = "", extra = {} }) {
  ctx.authorizer = { principalId, claims, scopes, ...extra };
  ctx.context.authorizer.principalId = principalId;
  ctx.context.authorizer.claims = claims;
  ctx.context.authorizer.scopes = scopes;
  for (const [key, value] of Object.entries(extra)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    ctx.context.authorizer[key] = value;
  }
}

/**
 * Authorizes the request per the matched route/method config.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<undefined>} `undefined` on success; throws `GatewayError` otherwise.
 */
export async function run(ctx) {
  // S05 test invoke bypasses authorization (AWS parity): a `testInvoke`
  // context never 401/403 here; the engine still exercises mappings,
  // templates and the integration.
  if (ctx?.testInvoke === true || ctx?.artifact?.testInvoke === true) {
    ctx.authType = "NONE";
    ctx.authResult = { authType: "NONE", authorized: true, principalArn: null, identityDecision: "Allow", testInvoke: true };
    return undefined;
  }
  const started = ctx?.ports?.clock?.now?.() ?? Date.now();
  const auth = findAuthConfig(ctx);
  ctx.authType = auth.type ?? "NONE";
  const latency = () => String((ctx?.ports?.clock?.now?.() ?? Date.now()) - started);
  if (!auth.type || auth.type === "NONE") {
    ctx.authResult = { authType: "NONE", authorized: true, principalArn: null, identityDecision: "ImplicitDeny" };
    return undefined;
  }
  const arn = methodArnFor(ctx);
  ctx.methodArn = arn;
  try {
    if (auth.type === "JWT") {
      if (!supports(ctx.artifact?.protocol ?? "REST", "auth.jwt")) {
        throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
      }
      const raw = findAuthorizer(ctx, auth.authorizerId);
      if (!raw) throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
      const authorizer = normalizeAuthorizer(raw, ctx.artifact?.protocol ?? "REST");
      const token = extractJwtToken(authorizer, {
        request: ctx.request,
        stageVariables: ctx.stageVariables ?? {},
        context: ctx.context ?? {},
        pathParameters: ctx.pathParameters ?? {},
      });
      const result = await verifyJwt({
        token,
        authorizer: authorizer.jwt,
        ports: { fetch: ctx.ports?.fetch, kv: ctx.ports?.kv, clock: ctx.ports?.clock },
        requiredScopes: auth.scopes?.length > 0 ? auth.scopes : [],
      });
      setAuthorizerContext(ctx, {
        principalId: result.principalId,
        claims: claimsForContext(result.claims),
        scopes: result.scopes.join(" "),
      });
      ctx.context.authenticate.status = "200";
      ctx.authResult = { authType: "JWT", authorized: true, principalArn: null, identityDecision: "Allow" };
      ctx.context.authorizer.latency = latency();
      return undefined;
    }
    if (auth.type === "CUSTOM") {
      if (!supports(ctx.artifact?.protocol ?? "REST", "auth.custom")) {
        throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
      }
      const raw = findAuthorizer(ctx, auth.authorizerId);
      if (!raw) throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
      const protocol = ctx.artifact?.protocol ?? "REST";
      const authorizer = normalizeAuthorizer(raw, protocol);
      // TOKEN events are REST-only; HTTP authorizers always receive REQUEST
      // events (payload 1.0 or 2.0), WebSocket $connect a CONNECT event.
      const kind = protocol === "WEBSOCKET" ? "WS"
        : protocol === "HTTP" && authorizer.payloadFormatVersion === "2.0" ? "HTTP20"
        : protocol === "HTTP" ? "HTTP10"
        : authorizer.type === "TOKEN" ? "TOKEN"
        : "REQUEST";
      const result = await runCustomAuth({
        authorizer,
        kind,
        request: ctx.request,
        methodArn: arn,
        resourcePath: ctx.context?.resourcePath ?? "",
        httpMethod: String(ctx.request.method).toUpperCase(),
        pathParameters: ctx.pathParameters ?? {},
        stageVariables: ctx.stageVariables ?? {},
        context: ctx.context ?? {},
        routeKey: auth.routeKey ?? ctx.context?.routeKey ?? "",
        connectionId: ctx.context?.connectionId || null,
        ports: ctx.ports ?? {},
      });
      const extra = {};
      for (const [key, value] of Object.entries(result.context ?? {})) {
        extra[key] = typeof value === "string" ? value : String(value);
      }
      setAuthorizerContext(ctx, { principalId: result.principalId, extra });
      if (result.usageIdentifierKey) {
        // S08 `AUTHORIZER` key-source contract: S08 reads
        // `ctx.authorizer.usageIdentifierKey` (falling back to
        // `ctx.context.authorizer.usageIdentifierKey`).
        ctx.authorizer.usageIdentifierKey = result.usageIdentifierKey;
        ctx.context.authorizer.usageIdentifierKey = result.usageIdentifierKey;
        // Historic top-level placement asserted by the S07 acceptance test.
        ctx.usageIdentifierKey = result.usageIdentifierKey;
      }
      ctx.authResult = { authType: "CUSTOM", authorized: true, principalArn: null, identityDecision: "Allow" };
      ctx.context.authorizer.latency = latency();
      return undefined;
    }
    if (auth.type === "SIGNED") {
      if (!supports(ctx.artifact?.protocol ?? "REST", "auth.signed")) {
        throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
      }
      const lookup = ctx.ports?.signingCredentials ?? null;
      const verified = await verifySignature(ctx.request, {
        region: ctx.artifact?.region ?? "auto",
        allowAnyRegion: ctx.artifact?.features?.signedAnyRegion === true,
        lookupSecret: lookup
          ? async (accessKeyId) => lookup.resolve(accessKeyId)
          : async () => null,
        now: ctx.ports?.clock?.now?.(),
      }).catch((error) => {
        if (error?.type === "MISSING_AUTHENTICATION_TOKEN") throw new GatewayError("MISSING_AUTHENTICATION_TOKEN", "Missing Authentication Token");
        if (error?.type === "EXPIRED_TOKEN") throw new GatewayError("EXPIRED_TOKEN", "Forbidden");
        throw new GatewayError("INVALID_SIGNATURE", error?.message ?? "Forbidden");
      });
      const principalArn = credentialPrincipalArn({
        projectId: ctx.artifact?.projectId ?? "",
        accessKeyId: verified.accessKeyId,
      });
      ctx.context.identity.accessKey = verified.accessKeyId;
      ctx.context.identity.caller = verified.accessKeyId;
      ctx.context.identity.user = verified.accessKeyId;
      ctx.context.identity.userArn = principalArn;
      let identityDecision = "ImplicitDeny";
      const policies = ctx.ports?.signingPolicies ?? null;
      if (policies) {
        // IAM semantics (§6): explicit Deny > Allow > implicit deny. A
        // credential with no identity policies is an implicit deny.
        const documents = (await policies.list(verified.accessKeyId)) ?? [];
        const request = {
          sourceIp: ctx.context?.identity?.sourceIp ?? "",
          userAgent: ctx.request.headers.get("user-agent") ?? "",
          secureTransport: (() => {
            try {
              return new URL(ctx.request.url).protocol === "https:";
            } catch {
              return false;
            }
          })(),
          principalArn,
          nowMs: ctx.ports?.clock?.now?.() ?? Date.now(),
        };
        for (const document of documents) {
          const { decision } = evaluatePolicy({ document, action: "execute-api:Invoke", resource: arn, request });
          if (decision === "Deny") throw new GatewayError("ACCESS_DENIED", "Forbidden");
          if (decision === "Allow") identityDecision = "Allow";
        }
      } else {
        // No policy port wired (tests, minimal artifacts): a valid
        // signature is sufficient.
        identityDecision = "Allow";
      }
      ctx.authResult = { authType: "SIGNED", authorized: identityDecision === "Allow", principalArn, identityDecision };
      // With a resource policy, an implicit identity verdict is decided by
      // `resourcePolicy:post` (§7: resource Allow → Allow, else Deny).
      // Without one, only the identity verdict counts.
      if (identityDecision !== "Allow" && !ctx.artifact?.settings?.resourcePolicy) {
        throw new GatewayError("ACCESS_DENIED", "Forbidden");
      }
      return undefined;
    }
    throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
  } catch (error) {
    ctx.context.authorizer.latency = latency();
    if (error instanceof GatewayError) {
      ctx.authResult = { authType: auth.type, authorized: false, failureType: error.type, failureMessage: error.message, principalArn: null, identityDecision: "ImplicitDeny" };
      throw error;
    }
    if (error?.type && typeof error.type === "string") {
      const type = error.type;
      ctx.authResult = { authType: auth.type, authorized: false, failureType: type, failureMessage: error.message, principalArn: null, identityDecision: "ImplicitDeny" };
      throw new GatewayError(type, error.message);
    }
    throw new GatewayError("AUTHORIZER_FAILURE", "Internal server error");
  }
}
