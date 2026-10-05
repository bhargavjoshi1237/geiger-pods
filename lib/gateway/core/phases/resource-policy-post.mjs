/**
 * `resourcePolicy:post` phase (pipeline row 10 — resource policy, post-auth).
 *
 * S07 implementation (replaces the S01 no-op stub, keeping the `name` +
 * `run(ctx)` contract). Applies the S07 §7 authorization-flow table via
 * `decidePostAuth`: explicit Deny always wins; `NONE` with a policy needs an
 * Allow; `SIGNED` with an implicit policy falls back to the identity policy
 * verdict; `CUSTOM`/`JWT` need the authorizer's Allow. With no policy, only
 * the authorizer result counts (a deny/401 already threw in `authorize`).
 *
 * @module lib/gateway/core/phases/resource-policy-post
 */

import { GatewayError } from "../errors.mjs";
import { decidePostAuth, evaluateResourcePolicy } from "../auth/resource-policy.mjs";
import { methodArnFor, requestFacts } from "../auth/request.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "resourcePolicy:post";

/**
 * Runs the post-auth resource-policy pass.
 *
 * @param {object} ctx - Pipeline context (`authResult` set by `authorize`).
 * @returns {Promise<undefined>} `undefined` to continue; throws `GatewayError` on deny.
 */
export async function run(ctx) {
  if (ctx?.testInvoke === true || ctx?.artifact?.testInvoke === true) return undefined;
  const document = ctx?.artifact?.settings?.resourcePolicy ?? null;
  // `authorize` records `{ authType, authorized, principalArn,
  // identityDecision }`; default to an anonymous NONE pass when it never ran.
  const authResult = ctx?.authResult ?? { authType: "NONE", authorized: true, principalArn: null, identityDecision: "ImplicitDeny" };
  const authType = authResult.authType ?? "NONE";
  // A deny/401 already threw in `authorize`; reaching here means the
  // authorizer/identity verdict is Allow (NONE carries no verdict).
  const authorizerVerdict = authType === "SIGNED"
    ? ((authResult.identityDecision ?? "ImplicitDeny") === "Allow" ? "Allow" : "Deny")
    : "Allow";
  const methodArn = methodArnFor(ctx);
  const principalArn = authResult.principalArn ?? null;
  const principalTags = authResult.principalTags ?? {};
  let resource = null;
  if (document) {
    const evaluated = evaluateResourcePolicy({
      document,
      resource: methodArn,
      request: requestFacts(ctx, { principalArn, principalTags }),
      principalArn,
    });
    resource = evaluated.decision === "Deny" ? "Deny" : evaluated.decision === "Allow" ? "Allow" : "ImplicitDeny";
  }
  const verdict = decidePostAuth({
    authType,
    resource,
    authorizer: authorizerVerdict,
  });
  if (verdict === "Deny") {
    const who = principalArn ?? authResult.accessKeyId ?? "anonymous";
    ctx.authDenied = { phase: "resourcePolicy:post", methodArn, principal: who };
    throw new GatewayError(
      "ACCESS_DENIED",
      `User: ${who} is not authorized to perform: execute-api:Invoke on resource: ${methodArn}`,
    );
  }
  return undefined;
}
