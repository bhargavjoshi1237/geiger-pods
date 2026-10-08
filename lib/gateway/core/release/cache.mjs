/**
 * Stage cache keying, TTL, budgets and encryption (S09 §2).
 *
 * REST-only (`cache` capability). Pure helpers shared by the `cacheLookup`
 * phase (row 15) and the `methodResponse` store path (row 19).
 *
 * Key: `sha256(stageId | flushEpoch | namespace or resourceId | METHOD |
 * resourcePath | selected key parameters)`. Header names are
 * case-insensitive; query params not listed are ignored (AWS). For proxy
 * resources `{proxy}` is always part of the key. D4: caller identity is
 * appended by default unless `features.cacheSharedAcrossPrincipals`.
 *
 * @module lib/gateway/core/release/cache
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AWS cache sizes (GB) Pods accepts. */
export const CACHE_SIZES_GB = [0.5, 1.6, 6.1, 13.5, 28.4, 58.2, 118, 237];

/** Per-stage byte budgets (Pods-specific; larger sizes → env cap). */
export const SIZE_BUDGETS = {
  "0.5": 64 * 1024 * 1024,
  "1.6": 256 * 1024 * 1024,
  "6.1": 1024 * 1024 * 1024,
};

/** Max bytes for the larger sizes (overridable via `PODS_CACHE_MAX_BYTES`). */
export function maxCacheBytes() {
  const raw = Number(process.env.PODS_CACHE_MAX_BYTES ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  return 1024 * 1024 * 1024;
}

/**
 * Budget for a cache size label.
 *
 * @param {string|number|null} size
 * @returns {number}
 */
export function budgetForSize(size) {
  const key = String(size ?? "");
  if (Object.hasOwn(SIZE_BUDGETS, key)) return SIZE_BUDGETS[key];
  if (CACHE_SIZES_GB.map(String).includes(key)) return maxCacheBytes();
  return maxCacheBytes();
}

/** Single cache item limit (AWS): 1 MiB. */
export const MAX_ITEM_BYTES = 1024 * 1024;

/** Default TTL seconds (AWS). */
export const DEFAULT_TTL_S = 300;

/** Max TTL seconds (AWS 0–3600). */
export const MAX_TTL_S = 3600;

/**
 * Stage cache settings for the current request. Mutable stage settings
 * travel on `ctx.stageCache` / `ctx.stageSettings.cache` (set by the runtime
 * loader/tests); the compiled artifact may carry a snapshot at
 * `artifact.stageCache` for `handle()` unit tests.
 *
 * @param {object} ctx
 * @returns {{ enabled: boolean, size: string|number|null, defaultTtl: number, encrypted: boolean, requireAuth: boolean, strategy: string, methodSettings: Record<string,object> }}
 */
export function stageCacheOf(ctx) {
  const raw = ctx?.stageCache
    ?? ctx?.stageSettings?.cache
    ?? ctx?.artifact?.stageCache
    ?? null;
  if (!raw) {
    // S05 shape fallback: flat stage columns on the artifact.
    const enabled = Boolean(ctx?.artifact?.cacheClusterEnabled ?? ctx?.artifact?.cache_cluster_enabled ?? false);
    if (!enabled) return { enabled: false, size: null, defaultTtl: DEFAULT_TTL_S, encrypted: false, requireAuth: true, strategy: "SUCCEED_WITH_RESPONSE_HEADER", methodSettings: {} };
  }
  if (!raw || typeof raw !== "object") {
    return { enabled: false, size: null, defaultTtl: DEFAULT_TTL_S, encrypted: false, requireAuth: true, strategy: "SUCCEED_WITH_RESPONSE_HEADER", methodSettings: {} };
  }
  const enabled = Boolean(raw.enabled ?? raw.cache_cluster_enabled ?? raw.cacheClusterEnabled ?? false);
  return {
    enabled,
    size: raw.size ?? raw.cache_cluster_size ?? raw.cacheClusterSize ?? null,
    defaultTtl: Number.isFinite(Number(raw.defaultTtl ?? raw.default_ttl ?? DEFAULT_TTL_S))
      ? Number(raw.defaultTtl ?? raw.default_ttl ?? DEFAULT_TTL_S)
      : DEFAULT_TTL_S,
    encrypted: Boolean(raw.encrypted ?? raw.cacheDataEncrypted ?? raw.cache_data_encrypted ?? false),
    requireAuth: (raw.requireAuth ?? raw.requireAuthorizationForCacheControl ?? true) !== false,
    strategy: String(raw.strategy ?? raw.unauthorizedCacheControlHeaderStrategy ?? "SUCCEED_WITH_RESPONSE_HEADER"),
    methodSettings: raw.methodSettings ?? raw.method_settings ?? {},
  };
}

/**
 * Method cache config for `resourcePath` + `METHOD`.
 *
 * @param {object} stageCache - From `stageCacheOf`.
 * @param {{ resourcePath: string, method: string }} options
 * @returns {{ cachingEnabled: boolean, ttl: number, encrypted: boolean, requireAuth: boolean, strategy: string }}
 */
export function methodCacheConfig(stageCache, { resourcePath, method } = {}) {
  const table = stageCache?.methodSettings ?? {};
  const key = `${resourcePath ?? ""}/${String(method ?? "GET").toUpperCase()}`;
  const entry = table[key] ?? table["*/*"] ?? {};
  const get = (camel, snake, fallback) => entry[camel] ?? entry[snake] ?? fallback;
  const cachingEnabled = get("cachingEnabled", "caching_enabled", null);
  // AWS: only GET cached by default; other methods need explicit override.
  const isGet = String(method ?? "GET").toUpperCase() === "GET";
  const enabled = cachingEnabled !== null && cachingEnabled !== undefined
    ? Boolean(cachingEnabled)
    : isGet;
  const ttlRaw = Number(get("cacheTtlInSeconds", "cache_ttl_in_seconds", stageCache?.defaultTtl ?? DEFAULT_TTL_S));
  const ttl = Number.isFinite(ttlRaw) ? Math.min(Math.max(Math.trunc(ttlRaw), 0), MAX_TTL_S) : DEFAULT_TTL_S;
  return {
    cachingEnabled: enabled,
    ttl,
    encrypted: Boolean(get("cacheDataEncrypted", "cache_data_encrypted", stageCache?.encrypted ?? false)),
    requireAuth: get("requireAuthorizationForCacheControl", "require_authorization_for_cache_control", stageCache?.requireAuth ?? true) !== false,
    strategy: String(get("unauthorizedCacheControlHeaderStrategy", "unauthorized_cache_control_header_strategy", stageCache?.strategy ?? "SUCCEED_WITH_RESPONSE_HEADER")),
  };
}

/**
 * Splits `integration.cache_key_parameters` entries into query/header/path
 * selectors. Entries look like `method.request.querystring.page`.
 *
 * @param {Array<string>} [entries=[]]
 * @returns {{ query: Array<string>, headers: Array<string>, paths: Array<string> }}
 */
export function parseCacheKeyParams(entries = []) {
  const query = [];
  const headers = [];
  const paths = [];
  for (const entry of entries ?? []) {
    const text = String(entry ?? "");
    const lower = text.toLowerCase();
    if (lower.startsWith("method.request.querystring.")) {
      query.push(text.slice("method.request.querystring.".length));
    } else if (lower.startsWith("method.request.header.")) {
      headers.push(text.slice("method.request.header.".length).toLowerCase());
    } else if (lower.startsWith("method.request.path.")) {
      paths.push(text.slice("method.request.path.".length));
    }
  }
  return { query, headers, paths };
}

/**
 * Caller identity for D4 partitioning: principalId, access key, JWT sub, or
 * API key id (first non-empty wins).
 *
 * @param {object} ctx
 * @returns {string}
 */
export function callerIdentityOf(ctx) {
  const c = ctx?.context ?? {};
  const candidates = [
    c.authorizer?.principalId,
    ctx?.authorizer?.principalId,
    c.identity?.accessKey,
    c.identity?.caller,
    c.identity?.apiKeyId,
    ctx?.usageKey?.keyId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return "";
}

/**
 * Builds the cache key for this request.
 *
 * @param {object} ctx
 * @param {{ method: string, resourcePath: string, resourceId: string, integration?: object, stageId?: string, epoch?: string|number }} options
 * @returns {string} Hex sha256.
 */
export function cacheKeyFor(ctx, { method, resourcePath, resourceId, integration = {}, stageId, epoch = 0 } = {}) {
  const url = new URL(ctx.request.url);
  const keyParams = Array.isArray(integration.cache_key_parameters ?? integration.cacheKeyParameters)
    ? (integration.cache_key_parameters ?? integration.cacheKeyParameters)
    : [];
  const { query, headers, paths } = parseCacheKeyParams(keyParams);
  const parts = [
    `stage:${stageId ?? ctx?.artifact?.stage ?? ""}`,
    `epoch:${epoch ?? 0}`,
    `ns:${integration.cache_namespace ?? integration.cacheNamespace ?? resourceId ?? ""}`,
    `m:${String(method).toUpperCase()}`,
    `p:${resourcePath ?? ""}`,
  ];
  const selectedQuery = {};
  for (const name of query) {
    const values = url.searchParams.getAll(name);
    if (values.length > 0) selectedQuery[name] = values.join(",");
  }
  parts.push(`q:${JSON.stringify(selectedQuery)}`);
  const headerBag = {};
  try {
    for (const [name, value] of ctx.request.headers.entries()) {
      headerBag[name.toLowerCase()] = headerBag[name.toLowerCase()] === undefined ? value : `${headerBag[name.toLowerCase()]},${value}`;
    }
  } catch {
    // Ignore unreadable headers.
  }
  const selectedHeaders = {};
  for (const name of headers) {
    if (headerBag[name] !== undefined) selectedHeaders[name] = headerBag[name];
  }
  parts.push(`h:${JSON.stringify(selectedHeaders)}`);
  const pathParams = ctx?.pathParameters ?? ctx?.pathParams ?? {};
  const selectedPath = {};
  for (const name of paths) {
    if (pathParams[name] !== undefined) selectedPath[name] = String(pathParams[name]);
  }
  // Proxy `{proxy}` / `{proxy+}` is always part of the key.
  for (const [name, value] of Object.entries(pathParams)) {
    if (name.toLowerCase() === "proxy" && selectedPath[name] === undefined) {
      selectedPath[name] = String(value);
    }
  }
  if (String(resourcePath ?? "").includes("{proxy")) {
    parts.push(`proxy:${String(pathParams.proxy ?? pathParams["proxy+"] ?? "")}`);
  }
  parts.push(`pp:${JSON.stringify(selectedPath)}`);
  const shared = Boolean(ctx?.artifact?.features?.cacheSharedAcrossPrincipals ?? false);
  if (!shared) {
    parts.push(`id:${callerIdentityOf(ctx)}`);
  }
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

/**
 * Whether this response may be stored: only 200, ≤1 MiB, no Set-Cookie, no
 * backend `Cache-Control: no-store|private`, never streamed.
 *
 * @param {{ status: number, headers: Headers|Record<string,string>, bodyLength: number, streamed?: boolean }} options
 * @returns {boolean}
 */
export function shouldStore({ status, headers, bodyLength, streamed = false } = {}) {
  if (streamed) return false;
  if (status !== 200) return false;
  if ((bodyLength ?? 0) > MAX_ITEM_BYTES) return false;
  const get = (name) => {
    try {
      if (typeof headers?.get === "function") return headers.get(name);
      const bag = headers ?? {};
      for (const [key, value] of Object.entries(bag)) {
        if (key.toLowerCase() === name.toLowerCase()) return value;
      }
      return null;
    } catch {
      return null;
    }
  };
  if (get("set-cookie") !== null) return false;
  const control = String(get("cache-control") ?? "").toLowerCase();
  if (control.includes("no-store") || control.includes("private")) return false;
  return true;
}

/**
 * Derives the stage encryption key (32 bytes). Production uses a vault DEK;
 * the engine derives a deterministic key so unit tests stay pure (control
 * plane stores a per-stage secret and passes it via `ports.cacheDek` when
 * available — see `dekForStage`).
 *
 * @param {{ projectId?: string, stageId?: string }} options
 * @returns {Buffer}
 */
export function deriveStageKey({ projectId = "", stageId = "" } = {}) {
  return createHash("sha256").update(`cache-dek:${projectId}:${stageId}`, "utf8").digest();
}

/**
 * Resolves the stage DEK: explicit `ports.cacheDek`/`ctx.cacheDek` wins,
 * then the vault ref `cache-dek:<stageId>`, then the derived key.
 *
 * The resolution source is reported so callers can tell a configured DEK
 * from the deterministic fallback: it is returned and also recorded on
 * `ctx.cacheDekSource` (`"explicit" | "vault" | "derived"`).
 *
 * @param {object} ctx
 * @param {string} stageId
 * @returns {Promise<{ key: Buffer, source: "explicit"|"vault"|"derived" }>}
 */
export async function resolveStageDek(ctx, stageId) {
  const ports = ctx?.ports ?? {};
  const candidate = ports.cacheDek ?? ctx?.cacheDek ?? null;
  if (candidate) {
    if (Buffer.isBuffer(candidate)) return setDekSource(ctx, { key: candidate, source: "explicit" });
    if (candidate instanceof Uint8Array) return setDekSource(ctx, { key: Buffer.from(candidate), source: "explicit" });
    if (typeof candidate === "string" && candidate.length >= 8) {
      return setDekSource(ctx, { key: createHash("sha256").update(candidate, "utf8").digest(), source: "explicit" });
    }
  }
  // Vault path (S02): `ports.secrets.resolve("cache-dek:<stage>")` when the
  // runtime wires it. `ensureStageCacheDek` (lib/control/stage-cache.mjs)
  // provisions that secret; the gateway injects the material via
  // `ports.cacheDek` (same precedence as above).
  try {
    if (ports.secrets && typeof ports.secrets.resolve === "function" && ctx?.artifact?.projectId) {
      const raw = await ports.secrets.resolve(`cache-dek:${stageId}`);
      if (typeof raw === "string" && raw.length > 0) {
        return setDekSource(ctx, { key: createHash("sha256").update(raw, "utf8").digest(), source: "vault" });
      }
    }
  } catch {
    // Fall through to the derived key.
  }
  return setDekSource(ctx, { key: deriveStageKey({ projectId: ctx?.artifact?.projectId ?? "", stageId }), source: "derived" });
}

function setDekSource(ctx, resolved) {
  try {
    if (ctx && typeof ctx === "object") ctx.cacheDekSource = resolved.source;
  } catch {
    // Observability never breaks the data path.
  }
  return resolved;
}

/**
 * Whether a derived-DEK fallback must be loud (F29): explicit strict mode
 * (`ports.cacheDekRequired` / `ctx.cacheDekRequired`) or a production
 * runtime. Everywhere else the fallback stays silent so unit tests and
 * non-prod environments keep working without a vault.
 *
 * @param {object} ctx
 * @returns {boolean}
 */
export function isDekStrict(ctx) {
  if (ctx?.ports?.cacheDekRequired === true || ctx?.cacheDekRequired === true) return true;
  try {
    return process.env.NODE_ENV === "production";
  } catch {
    return false;
  }
}

/**
 * Reports a derived-DEK fallback: log + metric event + `ctx.cacheDekFallback`
 * (F29: production must never fall back silently). Logging/metrics failures
 * are swallowed; the caller still receives the derived key so the data
 * plane never fails closed on cache encryption.
 *
 * `ports.log` convention (console-like, all optional): `warn(message,
 * fields)` / `error(message, fields)`, or a single function called as
 * `log(level, message, fields)`.
 *
 * @param {object} ctx
 * @param {string} stageId
 */
export function reportDekFallback(ctx, stageId) {
  const ports = ctx?.ports ?? {};
  const detail = {
    stageId: String(stageId ?? ""),
    projectId: ctx?.artifact?.projectId ?? null,
    source: "derived",
  };
  try {
    const log = ports.log ?? null;
    if (log && typeof log.warn === "function") log.warn("cache-dek-fallback", detail);
    else if (log && typeof log.error === "function") log.error("cache-dek-fallback", detail);
    else if (typeof log === "function") log("warn", "cache-dek-fallback", detail);
  } catch {
    // Logging never breaks the data path.
  }
  try {
    const at = typeof ports.clock?.now === "function" ? ports.clock.now() : Date.now();
    ports.events?.emit?.({ type: "cache_dek_fallback", at, ...detail });
  } catch {
    // Metrics never break the data path.
  }
  try {
    if (ctx && typeof ctx === "object") ctx.cacheDekFallback = true;
  } catch {
    // Best-effort.
  }
}

/**
 * Resolves the stage DEK: explicit `ports.cacheDek`/`ctx.cacheDek` wins,
 * otherwise the derived key.
 *
 * @param {object} ctx
 * @param {string} stageId
 * @returns {Promise<Buffer>}
 */
export async function dekForStage(ctx, stageId) {
  const resolved = await resolveStageDek(ctx, stageId);
  if (resolved.source === "derived" && isDekStrict(ctx)) reportDekFallback(ctx, stageId);
  return resolved.key;
}

/**
 * Encrypts a cache body with AES-256-GCM (`iv|ciphertext|tag`, base64).
 *
 * @param {Uint8Array} plaintext
 * @param {Buffer} key - 32 bytes.
 * @returns {string}
 */
export function encryptBody(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/**
 * Decrypts `encryptBody` output.
 *
 * @param {string} payload - Base64 `iv|ciphertext|tag`.
 * @param {Buffer} key - 32 bytes.
 * @returns {Uint8Array}
 */
export function decryptBody(payload, key) {
  const raw = Buffer.from(String(payload), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

/**
 * KV key for a cache entry.
 *
 * @param {string} stageId
 * @param {string} keyHex
 * @returns {string}
 */
export function entryKvKey(stageId, keyHex) {
  return `cache:entry:${stageId}:${keyHex}`;
}

/**
 * KV key for the flush epoch (O(1) invalidation).
 *
 * @param {string} stageId
 * @returns {string}
 */
export function epochKvKey(stageId) {
  return `cache:epoch:${stageId}`;
}

/**
 * KV key for the per-stage byte counter (budget enforcement).
 *
 * @param {string} stageId
 * @returns {string}
 */
export function bytesKvKey(stageId) {
  return `cache:bytes:${stageId}`;
}

// ---------------------------------------------------------------------------
// Approximate LRU eviction (S09 §2, F30).
//
// The store path (`methodResponse`, phase 19) skips stores past the budget
// (`CacheStoreSkipped`). These helpers add approximate LRU on top: each
// store/hit records `{ key, bytes, lastAccess }` in a bounded KV registry
// (`cache:lru:<stageId>`, newest 512 entries win), and `evictForStore`
// selects oldest-first victims so a store fits instead of skipping.
// Pure selection (`evictForStore`) is unit-tested; the two phase call sites
// (`storeInCache` records stores + evicts, `cacheLookup` records hits) are
// owned by the pipeline and pick these helpers up without signature changes.
// ---------------------------------------------------------------------------

/** Max tracked entries per stage (newest wins; what makes it approximate). */
export const LRU_REGISTRY_MAX = 512;

/**
 * KV key for the per-stage recency registry.
 *
 * @param {string} stageId
 * @returns {string}
 */
export function lruKvKey(stageId) {
  return `cache:lru:${stageId}`;
}

function cleanRegistry(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.k !== "string" || entry.k === "" || entry.k.length > 256) continue;
    const bytes = Number(entry.b);
    const at = Number(entry.t);
    if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(at)) continue;
    out.push({ k: entry.k, b: Math.trunc(bytes), t: at });
  }
  return out;
}

/**
 * Loads the recency registry (never throws; corrupt entries are dropped).
 *
 * @param {object} kv
 * @param {string} stageId
 * @returns {Promise<Array<{ k: string, b: number, t: number }>>}
 */
export async function loadLruRegistry(kv, stageId) {
  try {
    const raw = await kv.get(lruKvKey(stageId));
    if (!raw) return [];
    return cleanRegistry(JSON.parse(String(raw)));
  } catch {
    return [];
  }
}

/**
 * Persists the registry, keeping the newest `LRU_REGISTRY_MAX` entries.
 *
 * @param {object} kv
 * @param {string} stageId
 * @param {Array<{ k: string, b: number, t: number }>} entries
 * @param {{ ttlMs?: number }} [options={}]
 * @returns {Promise<Array<{ k: string, b: number, t: number }>>} The stored entries.
 */
export async function saveLruRegistry(kv, stageId, entries, { ttlMs = MAX_TTL_S * 1000 } = {}) {
  const bounded = [...cleanRegistry(entries)].sort((a, b) => b.t - a.t).slice(0, LRU_REGISTRY_MAX);
  try {
    await kv.set(lruKvKey(stageId), JSON.stringify(bounded), ttlMs > 0 ? { ttlMs } : {});
  } catch {
    // Recency is best-effort; the cache works without it.
  }
  return bounded;
}

/**
 * Records a store in the recency registry (insert or refresh).
 *
 * @param {object} kv
 * @param {{ stageId: string, keyHex: string, bytes: number, now?: number, ttlMs?: number }} options
 * @returns {Promise<Array<{ k: string, b: number, t: number }>>}
 */
export async function noteCacheStore(kv, { stageId, keyHex, bytes, now = Date.now(), ttlMs } = {}) {
  if (!kv || typeof kv.get !== "function" || typeof keyHex !== "string" || keyHex === "") return [];
  const at = Number(now);
  const size = Number(bytes);
  const registry = await loadLruRegistry(kv, stageId);
  registry.push({
    k: keyHex,
    b: Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0,
    t: Number.isFinite(at) ? at : Date.now(),
  });
  const merged = [];
  const seen = new Set();
  for (let index = registry.length - 1; index >= 0; index -= 1) {
    const entry = registry[index];
    if (seen.has(entry.k)) continue;
    seen.add(entry.k);
    merged.unshift(entry);
  }
  return saveLruRegistry(kv, stageId, merged, ttlMs === undefined ? {} : { ttlMs });
}

/**
 * Refreshes an entry's recency on a cache hit.
 *
 * @param {object} kv
 * @param {{ stageId: string, keyHex: string, now?: number }} options
 * @returns {Promise<Array<{ k: string, b: number, t: number }>>}
 */
export async function noteCacheHit(kv, { stageId, keyHex, now = Date.now() } = {}) {
  if (!kv || typeof kv.get !== "function" || typeof keyHex !== "string" || keyHex === "") return [];
  const at = Number(now);
  const registry = await loadLruRegistry(kv, stageId);
  const entry = registry.find((row) => row.k === keyHex);
  if (entry) {
    entry.t = Number.isFinite(at) ? at : Date.now();
  } else {
    // The registry may have bounded the entry out; re-track it (bytes
    // unknown on the hit path — the byte counter stays authoritative).
    registry.push({ k: keyHex, b: 0, t: Number.isFinite(at) ? at : Date.now() });
  }
  return saveLruRegistry(kv, stageId, registry);
}

/**
 * Selects oldest-first victims so `neededBytes` fits `budget` (pure).
 *
 * Returns `{ evicted, remainingBytes, fits }`. When the store already fits,
 * nothing is evicted; when the item alone exceeds the budget, `fits` is
 * false and nothing is evicted (the caller keeps the skip behavior).
 *
 * @param {Array<{ k: string, b: number, t: number }>} entries
 * @param {{ budget: number, neededBytes: number }} options
 * @returns {{ evicted: Array<string>, remainingBytes: number, fits: boolean }}
 */
export function evictForStore(entries, { budget, neededBytes } = {}) {
  const list = cleanRegistry(entries);
  const cap = Number(budget);
  const need = Number(neededBytes);
  const used = list.reduce((sum, entry) => sum + entry.b, 0);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(need) || need <= 0) {
    return { evicted: [], remainingBytes: used, fits: false };
  }
  if (need > cap) return { evicted: [], remainingBytes: used, fits: false };
  if (used + need <= cap) return { evicted: [], remainingBytes: used, fits: true };
  const ordered = [...list].sort((a, b) => a.t - b.t);
  const evicted = [];
  let remaining = used;
  for (const entry of ordered) {
    evicted.push(entry.k);
    remaining -= entry.b;
    if (remaining + need <= cap) break;
  }
  return { evicted, remainingBytes: remaining, fits: remaining + need <= cap };
}
