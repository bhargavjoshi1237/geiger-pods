/**
 * `throttle` phase (pipeline row 12 — project → plan/key → stage/route/method).
 *
 * S08 implementation (replaces the S01 no-op stub, keeping the exported
 * `name` and `run(ctx)` contract). Runs `resolveThrottleChecks` (AWS order:
 * plan-method → plan → stage method/default → project) and rejects at the
 * first failing bucket with 429 `THROTTLED` (`{"message":"Too Many Requests"}`).
 * Rate 0 / burst 0 blocks all traffic. KV failure follows
 * `throttle_kv_failure` (`open` → local fallback + `ctx.kvFallback` for S10;
 * `closed` → 429). The Pods extension `features.rateLimitHeaders` (off by
 * default) renders the rejection with `RateLimit-*`/`Retry-After` headers.
 *
 * @module lib/gateway/core/phases/throttle
 */

import { GatewayError } from "../errors.mjs";
import { renderGatewayError } from "../gateway-responses.mjs";
import { resolveThrottleChecks, runThrottleChecks } from "../usage/throttle.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "throttle";

/**
 * Enforces throttling for the request.
 *
 * @param {object} ctx - Pipeline context (`artifact`, `usage`, `usageKey`, `ports`, ...).
 * @returns {Promise<Response|undefined>} The 429 response when
 *   `features.rateLimitHeaders` is on; otherwise `undefined` on pass.
 * @throws {GatewayError} `THROTTLED` when a bucket rejects.
 */
export async function run(ctx) {
  if (ctx?.testInvoke === true || ctx?.artifact?.testInvoke === true) return undefined;
  const { checks, project } = resolveThrottleChecks(ctx);
  const outcome = await runThrottleChecks(ctx, checks, project);
  if (outcome.allowed) return undefined;
  if (outcome.fallback || project.kvFailure === "closed") ctx.kvFallback = ctx.kvFallback ?? outcome.fallback;
  ctx.throttled = true;
  if (project.rateLimitHeaders) {
    const retryAfterSec = Math.max(Math.ceil((outcome.retryAfterMs ?? 0) / 1000), 1);
    const limit = outcome.check ? `${outcome.check.rate};w=1` : "0;w=1";
    const error = new GatewayError("THROTTLED", "Too Many Requests");
    const response = renderGatewayError(error, ctx);
    const withHeaders = new Response(response.body, response);
    withHeaders.headers.set("Retry-After", String(retryAfterSec));
    withHeaders.headers.set("RateLimit-Limit", limit);
    withHeaders.headers.set("RateLimit-Remaining", String(Math.max(outcome.remaining ?? 0, 0)));
    withHeaders.headers.set("RateLimit-Reset", String(retryAfterSec));
    return withHeaders;
  }
  throw new GatewayError("THROTTLED", "Too Many Requests");
}
