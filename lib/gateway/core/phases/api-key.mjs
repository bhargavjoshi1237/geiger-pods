/**
 * `apiKey` phase (pipeline row 11 — required key, enabled, plan for this stage).
 *
 * S08 implementation (replaces the S01 no-op stub, keeping the exported
 * `name` and `run(ctx)` contract). Applies when the matched method/route
 * requires a key (REST `apiKeyRequired`, WebSocket `$connect`; HTTP APIs
 * never require keys — capability `usage.apiKeys` is REST + WebSocket only):
 * 1. Read the candidate from its source (`HEADER` → `x-api-key`,
 *    `AUTHORIZER` → custom authorizer `usageIdentifierKey`, S07).
 *    Missing → 403 `INVALID_API_KEY` (`{"message":"Forbidden"}`).
 * 2. Look up by `value_hmac` (KV `apikey:{hmac}`, 60 s, pub/sub
 *    invalidated). Unknown or disabled → 403.
 * 3. Require a plan covering `{api, stage}`. None → 403.
 * 4. Set `$context.identity.apiKey` / `apiKeyId` and `ctx.usageKey` for the
 *    throttle/quota phases. Key and plan changes need no redeploy.
 *
 * @module lib/gateway/core/phases/api-key
 */

import { supports } from "../../capabilities.mjs";
import { GatewayError } from "../errors.mjs";
import {
  apiKeyRequiredFor,
  extractCandidateKey,
  findCoveringPlan,
  hmacForValue,
  lookupKeyRecord,
  pepperFrom,
} from "../usage/api-key.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "apiKey";

/**
 * Enforces the API-key requirement for the matched method/route.
 *
 * @param {object} ctx - Pipeline context (`request`, `artifact`, `ports`, `usage`, ...).
 * @returns {Promise<undefined>} `undefined` when no key is required or the key checks pass.
 * @throws {GatewayError} `INVALID_API_KEY` (403 `Forbidden`) on any key failure.
 */
export async function run(ctx) {
  if (ctx?.testInvoke === true || ctx?.artifact?.testInvoke === true) return undefined;
  if (!apiKeyRequiredFor(ctx)) return undefined;
  const protocol = ctx?.artifact?.protocol ?? "REST";
  if (!supports(protocol, "usage.apiKeys")) return undefined;
  const candidate = extractCandidateKey(ctx);
  if (!candidate) throw new GatewayError("INVALID_API_KEY", "Forbidden");
  let hmac;
  try {
    hmac = hmacForValue(candidate, pepperFrom(ctx));
  } catch {
    throw new GatewayError("INVALID_API_KEY", "Forbidden");
  }
  const record = await lookupKeyRecord(ctx, hmac);
  if (!record || record.enabled === false) {
    throw new GatewayError("INVALID_API_KEY", "Forbidden");
  }
  const artifact = ctx?.artifact ?? {};
  const plan = findCoveringPlan(record, artifact.apiId, artifact.stage);
  if (!plan) throw new GatewayError("INVALID_API_KEY", "Forbidden");
  if (ctx?.context?.identity) {
    ctx.context.identity.apiKey = candidate;
    ctx.context.identity.apiKeyId = record.keyId;
  }
  ctx.usageKey = { keyId: record.keyId, publicId: record.publicId ?? null, plan };
  return undefined;
}
