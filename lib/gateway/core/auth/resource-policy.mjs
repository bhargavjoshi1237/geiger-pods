/**
 * Resource policy evaluation (S07 §7, REST only).
 *
 * A resource policy is stored on the API draft (`pods.apis.resource_policy`,
 * ≤ 8192 chars serialized) and snapshotted into the S05 deployment artifact
 * at compile time, so edits take effect on the next deployment (AWS
 * semantics). The engine evaluates it in two passes:
 *
 * - Phase 8 (pre-auth): statements that don't depend on the principal. An
 *   explicit Deny → 403 `ACCESS_DENIED`
 *   `"User: anonymous is not authorized to perform: execute-api:Invoke on
 *   resource: {arn}"` **before** invoking any authorizer.
 * - Phase 10 (post-auth): final decision per the §7 table via
 *   {@link decidePostAuth}.
 *
 * Principal matching: `"*"` or `{ "Pods": [credential ARN | "*"] }`; `"AWS"`
 * is accepted as an alias. A statement without `Principal` applies to every
 * principal. Identity-policy evaluation (SigV4 credentials) reuses
 * `auth/policy.mjs` directly.
 *
 * @module lib/gateway/core/auth/resource-policy
 */

import {
  evaluatePolicy,
  normalizeKey,
  validatePolicyDocument,
} from "./policy.mjs";
import { GATEWAY_RESPONSES } from "../gateway-responses.mjs";
import { GatewayError } from "../errors.mjs";

/** Serialized size cap for a resource policy (S07 §3). */
export const MAX_RESOURCE_POLICY_CHARS = 8192;

/**
 * Validates a resource policy document at save time: the shared grammar plus
 * principal-shape checks. Returns `{ errors, warnings }` (both arrays of
 * `{ path, message }`).
 *
 * @param {unknown} document
 * @returns {{ errors: Array<{ path: string, message: string }>, warnings: Array<{ path: string, message: string }> }}
 */
export function validateResourcePolicy(document) {
  const { errors } = validatePolicyDocument(document, { allowPrincipal: true });
  const warnings = [];
  if (errors.length > 0) return { errors, warnings };
  document.Statement.forEach((statement, index) => {
    const prefix = `$.Statement[${index}]`;
    const principal = statement.Principal;
    if (principal === undefined) return;
    if (principal === "*") return;
    if (!principal || typeof principal !== "object" || Array.isArray(principal)) {
      errors.push({ path: `${prefix}.Principal`, message: "Principal must be \"*\" or an object." });
      return;
    }
    const keys = Object.keys(principal);
    if (keys.length === 0) {
      errors.push({ path: `${prefix}.Principal`, message: "Principal must not be empty." });
      return;
    }
    for (const key of keys) {
      if (key !== "Pods" && key !== "AWS") {
        errors.push({ path: `${prefix}.Principal.${key}`, message: `Unsupported principal key "${key}".` });
        continue;
      }
      const values = Array.isArray(principal[key]) ? principal[key] : [principal[key]];
      for (const value of values) {
        if (typeof value !== "string" || value === "") {
          errors.push({ path: `${prefix}.Principal.${key}`, message: "Principal values must be non-empty strings." });
        }
      }
    }
    if (statement.Effect === "Allow" && principal === undefined) {
      warnings.push({ path: prefix, message: "Allow without Principal applies to every caller." });
    }
  });
  return { errors, warnings };
}

/**
 * Normalizes a draft resource policy for the artifact snapshot. Returns
 * `null` when no policy is configured. Throws an `Error` listing the first
 * validation problem when the document is invalid.
 *
 * @param {unknown} policy - Draft `resource_policy` value.
 * @returns {object|null}
 */
export function snapshotResourcePolicy(policy) {
  if (policy === null || policy === undefined) return null;
  const document = typeof policy === "string" ? JSON.parse(policy) : policy;
  const { errors } = validateResourcePolicy(document);
  if (errors.length > 0) {
    throw new Error(`Invalid resource policy (${errors[0].path}: ${errors[0].message}).`);
  }
  return JSON.parse(JSON.stringify(document));
}

/**
 * Builds a principal matcher for `matchPrincipal`: `"*"` and missing
 * `Principal` match everyone; otherwise the credential ARN must equal (or
 * glob-match) one of the listed values.
 *
 * @param {string|null} principalArn - Caller principal ARN (`null` = anonymous).
 * @returns {(principal: unknown) => boolean}
 */
export function principalMatcher(principalArn) {
  return (principal) => {
    if (principal === undefined || principal === "*") return true;
    if (!principal || typeof principal !== "object") return false;
    const values = [...(Array.isArray(principal.Pods) ? principal.Pods : principal.Pods !== undefined ? [principal.Pods] : []),
      ...(Array.isArray(principal.AWS) ? principal.AWS : principal.AWS !== undefined ? [principal.AWS] : [])];
    if (values.length === 0) return false;
    if (values.some((value) => value === "*")) return true;
    if (principalArn == null) return false;
    return values.some((value) => principalArnMatches(String(value), String(principalArn)));
  };
}

function principalArnMatches(pattern, arn) {
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") regex += ".*";
    else if (char === "?") regex += ".";
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${regex}$`, "s").test(arn);
}

/**
 * Evaluates a resource policy for one action/resource.
 *
 * @param {{ document: object|null, action?: string, resource: string, request?: object, principalArn?: string|null }} input
 * @returns {{ decision: "Allow" | "Deny" | "ImplicitDeny", matched: Array<object> }}
 */
export function evaluateResourcePolicy({ document, action = "execute-api:Invoke", resource, request = {}, principalArn = null } = {}) {
  if (!document) return { decision: "ImplicitDeny", matched: [] };
  return evaluatePolicy({
    document,
    action,
    resource,
    request,
    matchPrincipal: principalMatcher(principalArn),
  });
}

/**
 * Final allow/deny per the S07 §7 authorization-flow table.
 *
 * @param {{ authType: "NONE" | "SIGNED" | "CUSTOM" | "JWT", resource: "Allow" | "Deny" | "ImplicitDeny" | null, authorizer: "Allow" | "Deny" }} input
 * `resource` is the resource-policy verdict (`null` = no policy configured);
 * `authorizer` is the authorizer/identity verdict (`"Deny"` covers Deny and
 * 401; for `NONE` it is ignored).
 * @returns {"Allow" | "Deny"}
 */
export function decidePostAuth({ authType, resource = null, authorizer = "Allow" } = {}) {
  if (resource === "Deny") return "Deny";
  if (authType === "NONE") {
    if (resource === null) return "Allow";
    return resource === "Allow" ? "Allow" : "Deny";
  }
  if (authType === "SIGNED") {
    if (resource === "Allow") return "Allow";
    if (resource === null) return authorizer === "Allow" ? "Allow" : "Deny";
    // Implicit with a policy: the identity policy decides.
    return authorizer === "Allow" ? "Allow" : "Deny";
  }
  // CUSTOM / JWT: Allow+Allow → Allow; Implicit+Allow → Allow; Deny/401 → Deny.
  if (authorizer !== "Allow") return "Deny";
  return "Allow";
}

/**
 * Builds the `PolicyRequestContext` for condition evaluation from pipeline
 * facts. `nowMs` comes from the injected clock.
 *
 * @param {{ sourceIp?: string, userAgent?: string, referer?: string, connectorId?: string, sourceVpc?: string, secureTransport?: boolean, principalArn?: string|null, principalTags?: Record<string,string>, nowMs?: number }} facts
 * @returns {object}
 */
export function requestContextFromFacts({
  sourceIp = "",
  userAgent = "",
  referer = "",
  connectorId = "",
  sourceVpc = "",
  secureTransport = false,
  principalArn = null,
  principalTags = {},
  nowMs = Date.now(),
} = {}) {
  return {
    sourceIp, userAgent, referer, connectorId, sourceVpc, secureTransport,
    principalArn, principalTags, nowMs,
  };
}

export { normalizeKey };

/**
 * Reads the resource policy snapshot out of an artifact. The compile step
 * (S05) snapshots `settings.resourcePolicy` into the artifact, so edits
 * take effect on the next deployment (AWS semantics).
 *
 * @param {object} [artifact={}]
 * @returns {object|null}
 */
export function policyFromArtifact(artifact = {}) {
  return artifact?.settings?.resourcePolicy ?? artifact?.resourcePolicy ?? null;
}

function headerOf(request, name) {
  try {
    return request?.headers?.get?.(name) ?? "";
  } catch {
    return "";
  }
}

function factsFromCtx(ctx, principalArn = null) {
  const request = ctx?.request;
  const identity = ctx?.context?.identity ?? {};
  let secureTransport = false;
  try {
    secureTransport = new URL(request?.url ?? "").protocol === "https:";
  } catch {
    secureTransport = false;
  }
  return requestContextFromFacts({
    sourceIp: identity.sourceIp ?? "",
    userAgent: headerOf(request, "user-agent") || identity.userAgent || "",
    referer: headerOf(request, "referer"),
    secureTransport,
    principalArn: principalArn ?? null,
    nowMs: ctx?.ports?.clock?.now?.() ?? ctx?.startTime ?? Date.now(),
  });
}

/**
 * Builds the flat condition bag (`{ "aws:SourceIp": "…" }`) for one
 * request. Used by the policy simulator and by tests; the engine itself
 * evaluates `PolicyRequestContext` facts via {@link factsFromCtx}.
 *
 * @param {object} ctx - Pipeline context (`request`, `context.identity`).
 * @param {string|null} [principalArn=null]
 * @returns {Record<string, string>}
 */
export function policyConditionContext(ctx, principalArn = null) {
  const facts = factsFromCtx(ctx, principalArn);
  const bag = {
    "aws:SourceIp": facts.sourceIp,
    "aws:UserAgent": facts.userAgent,
    "aws:Referer": facts.referer,
    "aws:SecureTransport": facts.secureTransport ? "true" : "false",
    "aws:CurrentTime": new Date(facts.nowMs).toISOString(),
    "aws:EpochTime": String(Math.floor(facts.nowMs / 1000)),
  };
  if (facts.connectorId) bag["aws:SourceVpce"] = facts.connectorId;
  if (facts.sourceVpc) bag["aws:SourceVpc"] = facts.sourceVpc;
  if (facts.principalArn) bag["aws:PrincipalArn"] = facts.principalArn;
  return bag;
}

/**
 * Pre-auth resource-policy pass (pipeline row 8). Evaluates statements that
 * don't depend on the principal (anonymous caller): an explicit Deny throws
 * 403 `ACCESS_DENIED` before any authorizer runs. Statements naming a
 * specific principal are skipped until the post-auth pass.
 *
 * @param {object} ctx - Pipeline context.
 * @param {string} methodArn - Current method/route ARN.
 * @returns {undefined} `undefined` when no pre-auth deny applies.
 * @throws {GatewayError} `ACCESS_DENIED` on an explicit pre-auth deny.
 */
export function evaluatePreAuth(ctx, methodArn) {
  const policy = policyFromArtifact(ctx?.artifact);
  if (!policy) return undefined;
  const { decision } = evaluateResourcePolicy({
    document: policy,
    resource: methodArn,
    request: factsFromCtx(ctx, null),
    principalArn: null,
  });
  if (decision === "Deny") {
    throw new GatewayError(
      "ACCESS_DENIED",
      `User: anonymous is not authorized to perform: execute-api:Invoke on resource: ${methodArn}`,
    );
  }
  return undefined;
}

/**
 * Post-auth resource-policy pass (pipeline row 10). Applies the S07 §7
 * authorization-flow table via {@link decidePostAuth}. A CUSTOM/JWT
 * authorizer failure is re-thrown with its own type (401 `UNAUTHORIZED`,
 * 500 `AUTHORIZER_*`); with no policy configured this is a no-op.
 *
 * @param {object} ctx - Pipeline context.
 * @param {string} methodArn - Current method/route ARN.
 * @param {{ authType?: string, authorized?: boolean, failureType?: string, failureMessage?: string, principalArn?: string|null, identityDecision?: string }} [authResult={}]
 * @returns {undefined} `undefined` when the call is allowed.
 * @throws {GatewayError} `ACCESS_DENIED` (or the authorizer failure) on deny.
 */
export function evaluatePostAuth(ctx, methodArn, authResult = {}) {
  const authType = authResult.authType ?? ctx?.authType ?? "NONE";
  if (!authResult.authorized && (authType === "CUSTOM" || authType === "JWT")) {
    const type = Object.hasOwn(GATEWAY_RESPONSES, authResult.failureType)
      ? authResult.failureType
      : "AUTHORIZER_FAILURE";
    throw new GatewayError(type, authResult.failureMessage ?? "Unauthorized");
  }
  const policy = policyFromArtifact(ctx?.artifact);
  if (!policy) return undefined;
  const principalArn = authResult.principalArn ?? null;
  const { decision } = evaluateResourcePolicy({
    document: policy,
    resource: methodArn,
    request: factsFromCtx(ctx, principalArn),
    principalArn,
  });
  const final = decidePostAuth({
    authType,
    resource: decision,
    authorizer: authResult.authorized ? "Allow" : "Deny",
  });
  if (final === "Deny") {
    throw new GatewayError("ACCESS_DENIED", "User is not authorized to access this resource");
  }
  return undefined;
}
