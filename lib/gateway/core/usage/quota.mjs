/**
 * Quota engine helpers (S08 §5).
 *
 * Counter key: `q:{planId}:{keyId}:{periodStart}`. Periods start at UTC
 * day 00:00, Sunday 00:00 (WEEK) or calendar-month day 1 00:00 (MONTH).
 * `offset` follows AWS: requests subtracted from the limit **in the initial
 * period only** (the period containing `quota.since`, i.e. plan creation or
 * the last quota change). Enforcement is `INCR`: when the result exceeds the
 * effective allowance the phase returns 429 `QUOTA_EXCEEDED`; the increment
 * is kept (AWS counts rejected requests as attempts). Only requests that
 * reach the quota phase consume quota.
 *
 * Adjustments (`extend`/`reset`/`set`, AWS `UpdateUsage`) resolve to an
 * absolute KV allowance override `qa:{planId}:{keyId}:{periodStart}` plus
 * an append-only `quota_adjustments` row (control plane). The runtime reads
 * the override first, then the snapshot delta, then the base limit.
 *
 * KV failure fails closed (429) by default per ADR-4; it fails open only
 * when `project.features.quotaFailOpen` is set (setting `ctx.kvFallback`).
 *
 * Pure ES module: time from `ctx.ports.clock`, storage from `ctx.ports.kv`.
 * The S10 rollup consumes `ctx.usageMetering` (see `buildUsageMeteringEvent`);
 * S08 does not implement the rollup itself.
 *
 * @module lib/gateway/core/usage/quota
 */

/** Quota periods (AWS `DAY` | `WEEK` | `MONTH`). */
export const QUOTA_PERIODS = ["DAY", "WEEK", "MONTH"];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Start of the quota period containing `nowMs`, as epoch ms (UTC).
 * WEEK starts Sunday 00:00 UTC; MONTH starts day 1 00:00 UTC.
 *
 * @param {"DAY"|"WEEK"|"MONTH"} period
 * @param {number} nowMs
 * @returns {number}
 */
export function periodStartFor(period, nowMs) {
  const date = new Date(Number(nowMs));
  if (period === "WEEK") {
    const day = date.getUTCDay();
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return start - day * DAY_MS;
  }
  if (period === "MONTH") {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Exclusive end of the period starting at `periodStart` (epoch ms, UTC).
 *
 * @param {"DAY"|"WEEK"|"MONTH"} period
 * @param {number} periodStart
 * @returns {number}
 */
export function periodEndMs(period, periodStart) {
  if (period === "WEEK") return periodStart + 7 * DAY_MS;
  if (period === "MONTH") {
    const date = new Date(periodStart);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return periodStart + DAY_MS;
}

/**
 * Formats a period start as `YYYY-MM-DD` (UTC) for counter keys and the
 * AWS `GetUsage` shape.
 *
 * @param {number} periodStart
 * @returns {string}
 */
export function formatPeriodDay(periodStart) {
  return new Date(periodStart).toISOString().slice(0, 10);
}

/**
 * Live counter key `q:{planId}:{keyId}:{periodStart}`.
 *
 * @param {string} planId
 * @param {string} keyId
 * @param {number} periodStart
 * @returns {string}
 */
export function quotaCounterKey(planId, keyId, periodStart) {
  return `q:${planId}:${keyId}:${periodStart}`;
}

/**
 * Absolute allowance override key `qa:{planId}:{keyId}:{periodStart}`.
 *
 * @param {string} planId
 * @param {string} keyId
 * @param {number} periodStart
 * @returns {string}
 */
export function quotaAllowanceKey(planId, keyId, periodStart) {
  return `qa:${planId}:${keyId}:${periodStart}`;
}

/**
 * Base allowance for a period: `limit` minus `offset` in the initial
 * period only (the period containing `quota.since`).
 *
 * @param {{ limit: number, offset?: number, period: string, since?: number|null }} quota
 * @param {number} periodStart
 * @returns {number}
 */
export function baseAllowance(quota, periodStart) {
  const limit = Number(quota?.limit ?? 0);
  const offset = Number(quota?.offset ?? 0) || 0;
  if (offset > 0 && quota?.since !== undefined && quota?.since !== null) {
    const initial = periodStartFor(quota.period, Number(quota.since));
    if (initial === periodStart) return Math.max(limit - offset, 0);
  }
  return limit;
}

/**
 * Effective allowance: KV override wins, else base (+ snapshot delta).
 *
 * @param {{ quota: object, adjustmentsDelta?: number }} plan - Plan quota view.
 * @param {number} periodStart
 * @param {number|null} override - Parsed `qa:` value, or null.
 * @returns {number}
 */
export function effectiveAllowance(plan, periodStart, override) {
  if (override !== null && override !== undefined && Number.isFinite(Number(override))) {
    return Math.max(Number(override), 0);
  }
  const delta = Number(plan?.adjustmentsDelta ?? 0) || 0;
  return Math.max(baseAllowance(plan?.quota ?? {}, periodStart) + delta, 0);
}

/**
 * Applies an `UpdateUsage` operation to `(used, allowance)`:
 * - `extend`: allowance grows by `value` (10 more requests go through).
 * - `reset`: remaining is restored to the full limit (`allowance = used + limit`).
 * - `set`: remaining becomes `value` (`allowance = used + value`).
 *
 * @param {"extend"|"reset"|"set"} op
 * @param {number} value - Non-negative integer (ignored for `reset`).
 * @param {{ used: number, allowance: number, limit: number }} state
 * @returns {number} The new absolute allowance (for the `qa:` override).
 */
export function applyQuotaAdjustment(op, value, state) {
  const used = Math.max(Number(state?.used ?? 0), 0);
  const allowance = Math.max(Number(state?.allowance ?? 0), 0);
  const limit = Math.max(Number(state?.limit ?? 0), 0);
  if (op === "extend") {
    const delta = Number(value);
    if (!Number.isInteger(delta) || delta < 0) throw new Error("extend requires a non-negative integer value.");
    return allowance + delta;
  }
  if (op === "reset") return used + limit;
  if (op === "set") {
    const remaining = Number(value);
    if (!Number.isInteger(remaining) || remaining < 0) throw new Error("set requires a non-negative integer value.");
    return used + remaining;
  }
  throw new Error(`Unknown usage operation "${op}" (expected extend|reset|set).`);
}

/**
 * Validates a plan quota value object. Returns the normalized form.
 *
 * @param {unknown} quota
 * @returns {{ limit: number, offset: number, period: string }}
 * @throws {Error}
 */
export function assertValidQuota(quota) {
  if (!quota || typeof quota !== "object") throw new Error("quota must be an object.");
  const { limit, offset = 0, period } = quota;
  if (!Number.isInteger(limit) || limit < 0) throw new Error("quota.limit must be a non-negative integer.");
  if (!Number.isInteger(offset) || offset < 0) throw new Error("quota.offset must be a non-negative integer.");
  if (!QUOTA_PERIODS.includes(period)) throw new Error("quota.period must be one of DAY|WEEK|MONTH.");
  return { limit, offset, period };
}

/**
 * Parses an AWS `GetUsage` date (`YYYY-MM-DD`) to UTC epoch ms.
 *
 * @param {string} day
 * @returns {number}
 * @throws {Error}
 */
export function parseUsageDay(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`Invalid usage date "${day}" (expected YYYY-MM-DD).`);
  }
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid usage date "${day}" (expected YYYY-MM-DD).`);
  return ms;
}

/**
 * Formats the AWS `GetUsage` shape: per-key daily `[used, remaining]` pairs.
 *
 * @param {{ usagePlanId: string, startDate: string, endDate: string, series: Record<string, Array<[number, number]>>, position?: string|null }} input
 * @returns {{ usagePlanId: string, startDate: string, endDate: string, items: Record<string, Array<[number, number]>>, position: string|null }}
 */
export function formatUsage({ usagePlanId, startDate, endDate, series, position = null }) {
  return { usagePlanId, startDate, endDate, items: { ...(series ?? {}) }, position: position ?? null };
}

/**
 * Builds the S10 usage-metering export from a finished quota check.
 * S10's rollup aggregates these into `usage_daily`; S08 only exports.
 *
 * @param {object} ctx - Pipeline context (`usageKey`, `artifact`, `quotaUsage`).
 * @returns {Record<string, unknown>|null}
 */
export function buildUsageMeteringEvent(ctx) {
  const metering = ctx?.quotaUsage;
  if (!metering) return null;
  return {
    type: "usage",
    projectId: ctx?.artifact?.projectId ?? ctx?.context?.accountId ?? "",
    apiId: ctx?.artifact?.apiId ?? "",
    stage: ctx?.artifact?.stage ?? "",
    planId: metering.planId ?? ctx?.usageKey?.plan?.planId ?? null,
    keyId: metering.keyId ?? ctx?.usageKey?.keyId ?? null,
    periodStart: metering.periodStart ?? null,
    used: metering.used ?? null,
    throttled: Boolean(ctx?.throttled),
    quotaRejected: Boolean(ctx?.quotaRejected),
  };
}
