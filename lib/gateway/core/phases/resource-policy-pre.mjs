/**
 * `resourcePolicy:pre` phase (pipeline row 8 — resource policy, pre-auth).
 *
 * S07 implementation (replaces the S01 no-op stub, keeping the `name` +
 * `run(ctx)` contract). Evaluates the artifact's snapshotted resource policy
 * as an anonymous caller: an explicit Deny → 403 `ACCESS_DENIED`
 * (`User: anonymous is not authorized to perform: execute-api:Invoke on
 * resource: {arn}`) **before** any authorizer runs. Anything else continues
 * to `authorize`.
 *
 * @module lib/gateway/core/phases/resource-policy-pre
 */

import { GatewayError } from "../errors.mjs";
import { evaluateResourcePolicy } from "../auth/resource-policy.mjs";
import { methodArnFor, requestFacts } from "../auth/request.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "resourcePolicy:pre";

/**
 * Runs the pre-auth resource-policy pass.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<undefined>} `undefined` to continue; throws `GatewayError` on explicit deny.
 */
export async function run(ctx) {
  if (ctx?.testInvoke === true || ctx?.artifact?.testInvoke === true) return undefined;
  const document = ctx?.artifact?.settings?.resourcePolicy ?? null;
  if (!document) return undefined;
  const methodArn = methodArnFor(ctx);
  const { decision } = evaluateResourcePolicy({
    document,
    resource: methodArn,
    request: requestFacts(ctx),
    principalArn: null,
  });
  if (decision === "Deny") {
    ctx.authDenied = { phase: "resourcePolicy:pre", methodArn };
    throw new GatewayError(
      "ACCESS_DENIED",
      `User: anonymous is not authorized to perform: execute-api:Invoke on resource: ${methodArn}`,
    );
  }
  return undefined;
}
