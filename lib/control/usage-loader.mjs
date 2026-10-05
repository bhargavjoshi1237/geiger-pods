/**
 * Runtime usage loader (S05 loader style) for S08.
 *
 * Key/plan/stage-throttle changes must NOT need a redeploy (spec §3): the
 * gateway resolves keys through this loader, which read-throughs to the
 * control db on KV miss and caches in the shared KV (`apikey:{hmac}` for
 * 60 s, plus `stagecfg:`/`projcfg:` config caches). Mutations publish
 * `pods:usage-changed`; the loader subscribes and invalidates, so typical
 * propagation is ≤ 5 s with a 60 s TTL worst case (spec §6).
 *
 * Plumbing: `createPorts` only forwards known fields, so the loader rides
 * on the KV object via {@link attachUsage} (`ctx.ports.kv.usage`; the
 * api-key phase also accepts `ctx.ports.usage`). Two gateway servers
 * sharing one `MemoryKvStore` (or Redis via `PODS_KV_URL`) therefore
 * enforce the same buckets with no extra wiring in `gateway/server.mjs`.
 *
 * Records are built with `buildKeyRecord` (the exact snapshot shape the
 * engine phases consume). `db` port methods used: `getApiKeyByHmac`,
 * `getApiKeyById`, `listPlansForKey`, `getPlanById`, `listPlanStages`,
 * `listQuotaAdjustments`, `getStageByName`, `getProjectSettings`.
 *
 * @module lib/control/usage-loader
 */

import { kvFromEnv } from "../gateway/state/kv.mjs";
import { apiKeyCacheKey } from "../gateway/core/usage/api-key.mjs";
import { buildKeyRecord } from "./api-keys.mjs";

/** KV TTL for key lookups (60 s, spec §3). */
export const USAGE_CACHE_TTL_MS = 60_000;

/** KV TTL for stage/project config caches (same SLO). */
export const USAGE_CONFIG_TTL_MS = 60_000;

/** Lazy shared KV for management routes (memory when no `PODS_KV_URL`). */
let kvPromise = null;

/**
 * Returns the process-wide usage KV (connects on first use).
 *
 * @returns {Promise<object>} `KvStore`.
 */
export function kvSingleton() {
  if (!kvPromise) {
    kvPromise = import("../gateway/state/kv.mjs").then(({ kvFromEnv: fromEnv }) => fromEnv(process.env));
  }
  return kvPromise;
}

void kvFromEnv;

function safeParse(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

function asRecord(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.keyId !== "string") return null;
  if (!Array.isArray(value.plans)) return null;
  return value;
}

/**
 * Creates the runtime usage loader.
 *
 * @param {object} options
 * @param {object} options.db - Control db port (methods listed above).
 * @param {object} options.kv - Shared `KvStore`.
 * @param {{ now(): number }} [options.clock] - Injected clock.
 * @returns {{ loadKeyRecord(hmacHex: string): Promise<object|null>,
 *   loadRequestUsage(input: object): Promise<object>, close(): Promise<void> }}
 */
export function createUsageLoader({ db, kv, clock = null } = {}) {
  if (!db) throw new TypeError("createUsageLoader requires db.");
  if (!kv) throw new TypeError("createUsageLoader requires kv.");
  const now = () => (clock?.now?.() ?? Date.now());
  /** Cache keys written through this loader (for `all` invalidation). */
  const tracked = new Set();
  let unsubscribe = null;

  const track = (key) => {
    tracked.add(key);
    if (tracked.size > 5000) {
      const oldest = tracked.values().next().value;
      tracked.delete(oldest);
    }
  };

  async function handleInvalidation(message) {
    let event = null;
    try {
      event = JSON.parse(String(message));
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    try {
      const hmacs = event.hmacs ?? (event.hmac ? [event.hmac] : null);
      if (Array.isArray(hmacs)) {
        for (const hex of hmacs) {
          const key = apiKeyCacheKey(String(hex));
          tracked.delete(key);
          await kv.del(key).catch(() => {});
        }
        if (!event.stageThrottle && !event.project && event.all !== true) return;
      }
      if (event.stageThrottle) {
        const { apiId, stage } = event.stageThrottle;
        const key = `stagecfg:${apiId}:${stage}`;
        tracked.delete(key);
        await kv.del(key).catch(() => {});
      }
      if (event.project) {
        const key = `projcfg:${event.project}`;
        tracked.delete(key);
        await kv.del(key).catch(() => {});
      }
      if (event.all === true || event.planId !== undefined) {
        // Plan changes touch many keys: drop every key entry this loader
        // cached (control also warms the affected keys right away).
        for (const key of [...tracked]) {
          if (key.startsWith("apikey:")) {
            tracked.delete(key);
            await kv.del(key).catch(() => {});
          }
        }
      }
    } catch {
      // TTL still propagates.
    }
  }

  if (typeof kv.subscribe === "function") {
    try {
      const maybe = kv.subscribe("pods:usage-changed", (message) => {
        handleInvalidation(message).catch(() => {});
      });
      if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
      unsubscribe = maybe;
    } catch {
      // Best-effort only.
    }
  }

  /**
   * Key record by HMAC: KV cache → db read-through (`buildKeyRecord`).
   * Misses are cached too, so unknown-key floods don't hit the db.
   */
  async function loadKeyRecord(hmacHex) {
    const cacheKey = apiKeyCacheKey(String(hmacHex));
    const raw = await kv.get(cacheKey).catch(() => null);
    if (raw !== null && raw !== undefined) {
      const parsed = safeParse(raw);
      if (parsed && parsed.found === false) return null;
      const record = asRecord(parsed?.record ?? parsed);
      if (record) {
        track(cacheKey);
        return record;
      }
    }
    const row = await db.getApiKeyByHmac(String(hmacHex)).catch(() => null);
    if (!row) {
      await kv.set(cacheKey, JSON.stringify({ found: false }), { ttlMs: USAGE_CACHE_TTL_MS }).catch(() => {});
      track(cacheKey);
      return null;
    }
    const record = await buildKeyRecord(db, row.id ?? row.keyId, { now });
    await kv.set(cacheKey, JSON.stringify({ found: true, record }), { ttlMs: USAGE_CACHE_TTL_MS }).catch(() => {});
    track(cacheKey);
    return record.enabled === false ? { ...record } : record;
  }

  /**
   * Per-request project/stage throttle config for `ctx.usage`
   * (KV-cached, no redeploy needed).
   */
  async function loadRequestUsage({ apiId = "", stage = "", projectId = "" } = {}) {
    const out = {};
    const projKey = `projcfg:${projectId}`;
    const projRaw = await kv.get(projKey).catch(() => null);
    let project = projRaw !== null && projRaw !== undefined ? safeParse(projRaw)?.record ?? null : null;
    if (!project) {
      const row = await db.getProjectSettings(projectId).catch(() => null);
      project = {
        rate: row?.throttle_rate ?? row?.throttleRate,
        burst: row?.throttle_burst ?? row?.throttleBurst,
        throttleKvFailure: row?.throttle_kv_failure ?? row?.throttleKvFailure ?? "open",
        features: row?.features ?? {},
        instanceCount: row?.features?.instanceCount ?? 1,
      };
      await kv.set(projKey, JSON.stringify({ record: project }), { ttlMs: USAGE_CONFIG_TTL_MS }).catch(() => {});
    }
    track(projKey);
    out.project = project;

    if (apiId && stage) {
      const stageKey = `stagecfg:${apiId}:${stage}`;
      const stageRaw = await kv.get(stageKey).catch(() => null);
      let stageCfg = stageRaw !== null && stageRaw !== undefined ? safeParse(stageRaw)?.record ?? null : null;
      if (!stageCfg) {
        const row = await db.getStageByName({ apiId, stage }).catch(() => null)
          ?? await db.getStageByName({ apiId, name: stage }).catch(() => null);
        stageCfg = row
          ? {
            id: row.id ?? `${apiId}:${stage}`,
            methodSettings: row.method_settings ?? row.methodSettings ?? {},
            routeSettings: row.route_settings ?? row.routeSettings ?? {},
            defaultRouteSettings: row.default_route_settings ?? row.defaultRouteSettings ?? {},
          }
          : null;
        await kv.set(stageKey, JSON.stringify({ record: stageCfg }), { ttlMs: USAGE_CONFIG_TTL_MS }).catch(() => {});
      }
      track(stageKey);
      if (stageCfg) out.stage = stageCfg;
    }
    return out;
  }

  async function close() {
    tracked.clear();
    try {
      if (typeof unsubscribe === "function") await unsubscribe();
      else if (unsubscribe && typeof unsubscribe.then === "function") {
        const unsub = await unsubscribe;
        if (typeof unsub === "function") await unsub();
      }
    } catch {
      // Best-effort.
    }
  }

  return { loadKeyRecord, loadRequestUsage, close };
}

/**
 * Attaches a usage loader to a `KvStore` so it survives port plumbing that
 * only forwards known fields. Phases read
 * `ctx.ports.usage ?? ctx.ports.kv?.usage`.
 *
 * @param {object} kv - Shared `KvStore`.
 * @param {object} [options={}] - `createUsageLoader` options minus `kv`.
 * @returns {object} The store with a `.usage` loader attached.
 */
export function attachUsage(kv, options = {}) {
  if (!kv) throw new TypeError("attachUsage requires kv.");
  const loader = createUsageLoader({ kv, ...options });
  return new Proxy(kv, {
    get(target, property, receiver) {
      if (property === "usage") return loader;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
