/**
 * Throttling engine helpers (S08 §4).
 *
 * Token bucket: `rate` tokens/s refill, `burst` capacity, via the atomic
 * `KvStore.tokenBucket`. Checks run in AWS order and a request must pass
 * **all** applicable buckets — the first failing bucket rejects:
 * 1. usage plan per-key per-method (`tb:plan:{plan}:key:{key}:m:{method}`)
 * 2. usage plan per-key (`tb:plan:{plan}:key:{key}`)
 * 3. stage per-method else stage default (`tb:stage:{stageId}:{method|*}`)
 * 4. project (account) level (`tb:project:{projectId}`), AWS defaults
 *    10000 rps / 5000 burst.
 *
 * Rejection → 429 `THROTTLED`. Rate 0 / burst 0 blocks all traffic (AWS).
 * `features.rateLimitHeaders` (Pods extension, off by default) adds
 * `RateLimit-Limit/Remaining/Reset` and `Retry-After`.
 *
 * KV failure follows `project_settings.throttle_kv_failure`: `open`
 * (default) falls back to a per-instance in-memory bucket at
 * `rate / instanceCount` (instance count from a KV heartbeat, default 1);
 * `closed` returns 429. Fallbacks set `ctx.kvFallback` for S10 metrics.
 *
 * Pure ES module: time comes from `ctx.ports.clock`, storage from
 * `ctx.ports.kv`. No Next.js, Supabase or S07/S10 imports.
 *
 * @module lib/gateway/core/usage/throttle
 */

import { MemoryKvStore } from "../../state/memory-kv.mjs";

/** AWS account-level defaults (spec §4). */
export const PROJECT_THROTTLE_DEFAULTS = { rate: 10000, burst: 5000 };

/** Default `throttle_kv_failure` (spec §4). */
export const THROTTLE_KV_FAILURE_DEFAULT = "open";

/** Local fallback buckets, one store per clock (i.e. per runtime instance). */
const fallbackStores = new WeakMap();

/**
 * @param {object} ctx
 * @returns {MemoryKvStore}
 */
export function fallbackStoreFor(ctx) {
  const clock = ctx?.ports?.clock ?? null;
  if (!clock || (typeof clock !== "object" && typeof clock !== "function")) {
    return new MemoryKvStore({});
  }
  let store = fallbackStores.get(clock);
  if (!store) {
    store = new MemoryKvStore({ clock });
    fallbackStores.set(clock, store);
  }
  return store;
}

/**
 * Method key for per-method buckets: REST `{resourcePath}/{METHOD}`,
 * HTTP/WebSocket the route key.
 *
 * @param {object} ctx
 * @returns {string}
 */
export function methodKeyFor(ctx) {
  const protocol = ctx?.artifact?.protocol ?? "REST";
  if (protocol === "HTTP" || protocol === "WEBSOCKET") {
    return String(ctx?.match?.routeKey ?? ctx?.context?.routeKey ?? "$default");
  }
  const resourcePath = ctx?.match?.resourcePath ?? ctx?.context?.resourcePath ?? "/";
  const method = String(ctx?.request?.method ?? ctx?.match?.httpMethod ?? "GET").toUpperCase();
  return `${resourcePath}/${method}`;
}

/**
 * Normalizes S05 stage throttle settings (`method_settings`,
 * `route_settings`, `default_route_settings`) to `{ method, default }`.
 * REST method settings use `{path}/{METHOD}` keys with a star-slash-star
 * default; HTTP/WS route settings use route keys with `default_route_settings`.
 *
 * Accepted value shapes per entry: `{rate, burst}`,
 * `{rateLimit, burstLimit}`, `{throttlingRateLimit, throttlingBurstLimit}`.
 *
 * @param {object} [stage={}] - `ctx.usage.stage` (host-provided stage row view).
 * @returns {{ method: Record<string, { rate: number, burst: number }>, default: { rate: number, burst: number }|null }}
 */
export function selectStageThrottle(stage = {}) {
  const read = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    const rate = entry.rate ?? entry.rateLimit ?? entry.throttlingRateLimit;
    const burst = entry.burst ?? entry.burstLimit ?? entry.throttlingBurstLimit;
    if (rate === undefined && burst === undefined) return null;
    return { rate: Number(rate), burst: Number(burst) };
  };
  const method = {};
  for (const bag of [stage.methodSettings ?? stage.method_settings, stage.routeSettings ?? stage.route_settings]) {
    if (!bag || typeof bag !== "object") continue;
    for (const [key, entry] of Object.entries(bag)) {
      const normalized = read(entry);
      if (normalized) method[key] = normalized;
    }
  }
  const fallback = stage.default ?? stage.defaultRouteSettings ?? stage.default_route_settings
    ?? stage.defaultMethodSettings ?? stage["*/*"] ?? null;
  return { method, default: read(fallback) };
}

/**
 * Normalizes project (account) throttle settings with AWS defaults.
 *
 * @param {object} [project={}] - `ctx.usage.project`.
 * @returns {{ rate: number, burst: number, kvFailure: string, rateLimitHeaders: boolean, quotaFailOpen: boolean, instanceCount: number }}
 */
export function selectProjectThrottle(project = {}) {
  const rate = project.rate ?? project.throttleRate ?? project.throttle_rate;
  const burst = project.burst ?? project.throttleBurst ?? project.throttle_burst;
  const features = project.features ?? {};
  return {
    rate: rate === undefined ? PROJECT_THROTTLE_DEFAULTS.rate : Number(rate),
    burst: burst === undefined ? PROJECT_THROTTLE_DEFAULTS.burst : Number(burst),
    kvFailure: project.kvFailure ?? project.throttleKvFailure ?? project.throttle_kv_failure
      ?? THROTTLE_KV_FAILURE_DEFAULT,
    rateLimitHeaders: Boolean(features.rateLimitHeaders),
    quotaFailOpen: Boolean(features.quotaFailOpen),
    instanceCount: Number(project.instanceCount ?? 1) || 1,
  };
}

/**
 * Resolves the ordered throttle checks for one request (spec §4 order).
 * Plan checks need `ctx.usageKey.plan`; the stage check needs
 * `ctx.usage.stage`; the project check always applies (AWS defaults).
 *
 * @param {object} ctx - Pipeline context (`artifact`, `match`, `usage`, `usageKey`).
 * @returns {{ checks: Array<{ scope: string, key: string, rate: number, burst: number }>, project: object, methodKey: string }}
 */
export function resolveThrottleChecks(ctx) {
  const artifact = ctx?.artifact ?? {};
  const projectId = artifact.projectId ?? artifact.accountId ?? ctx?.context?.accountId ?? "";
  const methodKey = methodKeyFor(ctx);
  const checks = [];
  const plan = ctx?.usageKey?.plan ?? null;
  const keyId = ctx?.usageKey?.keyId ?? null;

  const readThrottle = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    const rate = entry.rate ?? entry.rateLimit;
    const burst = entry.burst ?? entry.burstLimit;
    if (rate === undefined && burst === undefined) return null;
    return { rate: Number(rate), burst: Number(burst) };
  };

  if (plan && keyId) {
    const perMethod = plan.methodThrottles?.[methodKey]
      ?? plan.method_throttles?.[methodKey] ?? null;
    const methodThrottle = readThrottle(perMethod);
    if (methodThrottle) {
      checks.push({
        scope: "plan-method",
        key: `tb:plan:${plan.planId}:key:${keyId}:m:${methodKey}`,
        ...methodThrottle,
      });
    }
    const planThrottle = readThrottle(plan.throttle);
    if (planThrottle) {
      checks.push({
        scope: "plan",
        key: `tb:plan:${plan.planId}:key:${keyId}`,
        ...planThrottle,
      });
    }
  }

  const stage = selectStageThrottle(ctx?.usage?.stage ?? {});
  const stageThrottle = stage.method[methodKey] ?? stage.default;
  if (stageThrottle) {
    const stageId = ctx?.usage?.stage?.id ?? ctx?.usage?.stage?.stageId
      ?? `${artifact.apiId ?? ""}:${artifact.stage ?? ""}`;
    const methodSegment = stage.method[methodKey] ? methodKey : "*";
    checks.push({
      scope: "stage",
      key: `tb:stage:${stageId}:${methodSegment}`,
      ...stageThrottle,
    });
  }

  const project = selectProjectThrottle(ctx?.usage?.project ?? {});
  checks.push({
    scope: "project",
    key: `tb:project:${projectId}`,
    rate: project.rate,
    burst: project.burst,
  });
  return { checks, project, methodKey };
}

/**
 * Runs one bucket check. Rate 0 / burst 0 blocks all traffic without
 * touching KV (AWS: a throttled-to-zero route returns 429).
 *
 * @param {{ get: Function, tokenBucket: Function }} kv
 * @param {{ scope: string, key: string, rate: number, burst: number }} check
 * @returns {Promise<{ allowed: boolean, remaining: number, retryAfterMs: number }>}
 */
export async function runThrottleBucket(kv, check) {
  if (!(check.rate > 0) || !(check.burst > 0)) {
    return { allowed: false, remaining: 0, retryAfterMs: 1000 };
  }
  return kv.tokenBucket(check.key, { rate: check.rate, burst: check.burst, cost: 1 });
}

/**
 * Runs the ordered checks: every bucket must allow; the first rejection
 * wins. On KV failure, `open` uses the per-instance fallback bucket
 * (setting `ctx.kvFallback = true` for S10) and `closed` rejects.
 *
 * @param {object} ctx - Pipeline context (mutated: `kvFallback`, `throttled`).
 * @param {Array<{ scope: string, key: string, rate: number, burst: number }>} checks
 * @param {object} project - `selectProjectThrottle` view.
 * @returns {Promise<{ allowed: boolean, check: object|null, remaining: number, retryAfterMs: number, fallback: boolean }>}
 */
export async function runThrottleChecks(ctx, checks, project) {
  const kv = ctx?.ports?.kv;
  for (const check of checks) {
    let outcome;
    try {
      outcome = await runThrottleBucket(kv, check);
    } catch {
      if (project.kvFailure === "closed") {
        return { allowed: false, check, remaining: 0, retryAfterMs: 1000, fallback: false };
      }
      const fallback = fallbackStoreFor(ctx);
      const rate = Math.max(check.rate / project.instanceCount, 0.001);
      try {
        outcome = check.rate > 0 && check.burst > 0
          ? await fallback.tokenBucket(`local:${check.key}`, { rate, burst: check.burst, cost: 1 })
          : { allowed: false, remaining: 0, retryAfterMs: 1000 };
      } catch {
        outcome = { allowed: true, remaining: 0, retryAfterMs: 0 };
      }
      ctx.kvFallback = true;
      if (!outcome.allowed) {
        return { allowed: false, check, remaining: outcome.remaining ?? 0, retryAfterMs: outcome.retryAfterMs ?? 0, fallback: true };
      }
      continue;
    }
    if (!outcome.allowed) {
      return { allowed: false, check, remaining: outcome.remaining ?? 0, retryAfterMs: outcome.retryAfterMs ?? 0, fallback: false };
    }
  }
  return { allowed: true, check: null, remaining: 0, retryAfterMs: 0, fallback: Boolean(ctx?.kvFallback) };
}
