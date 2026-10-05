/**
 * `quota` phase (pipeline row 13).
 *
 * S08 implementation (replaces the S01 no-op stub, keeping the exported
 * `name` and `run(ctx)` contract). No-op unless `ctx.usageKey.plan` carries
 * a quota. Otherwise `INCR`s `q:{plan}:{key}:{periodStart}` (TTL to the
 * period end) and rejects with 429 `QUOTA_EXCEEDED`
 * (`{"message":"Limit Exceeded"}`) when the count exceeds the effective
 * allowance (limit − offset in the initial period only + adjustments). The
 * increment is kept. KV failure fails closed (429) by default, open only
 * with `features.quotaFailOpen` (setting `ctx.kvFallback` for S10).
 * Records `ctx.quotaUsage` for the S10 rollup export.
 *
 * @module lib/gateway/core/phases/quota
 */

import { GatewayError } from "../errors.mjs";
import {
  effectiveAllowance,
  periodEndMs,
  periodStartFor,
  quotaAllowanceKey,
  quotaCounterKey,
} from "../usage/quota.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "quota";

/**
 * Enforces the usage-plan quota for the request.
 *
 * @param {object} ctx - Pipeline context (`usageKey`, `usage`, `ports`, ...).
 * @returns {Promise<undefined>} `undefined` when no quota applies or the quota allows.
 * @throws {GatewayError} `QUOTA_EXCEEDED` when the quota is exhausted (or KV is down and quotas fail closed).
 */
export async function run(ctx) {
  const plan = ctx?.usageKey?.plan ?? null;
  const keyId = ctx?.usageKey?.keyId ?? null;
  const quota = plan?.quota ?? null;
  if (!plan || !keyId || !quota || quota.limit === undefined) return undefined;
  const now = ctx?.ports?.clock?.now?.() ?? Date.now();
  const periodStart = periodStartFor(quota.period, now);
  const counterKey = quotaCounterKey(plan.planId, keyId, periodStart);
  const kv = ctx?.ports?.kv;
  let used;
  try {
    used = await kv.incrBy(counterKey, 1, { ttlMs: Math.max(periodEndMs(quota.period, periodStart) - now, 1000) });
  } catch {
    const failOpen = Boolean(ctx?.usage?.project?.features?.quotaFailOpen);
    if (!failOpen) throw new GatewayError("QUOTA_EXCEEDED", "Limit Exceeded");
    ctx.kvFallback = true;
    return undefined;
  }
  let override = null;
  try {
    const raw = await kv.get(quotaAllowanceKey(plan.planId, keyId, periodStart));
    override = raw === null || raw === undefined ? null : Number(raw);
  } catch {
    override = null;
  }
  const allowance = effectiveAllowance(plan, periodStart, override);
  ctx.quotaUsage = { planId: plan.planId, keyId, periodStart, used, allowance };
  if (used > allowance) {
    ctx.quotaRejected = true;
    throw new GatewayError("QUOTA_EXCEEDED", "Limit Exceeded");
  }
  return undefined;
}
