/**
 * Redis `KvStore` (production; any Redis-protocol server, e.g. Upstash
 * via the Vercel Marketplace). Connection string env: `PODS_KV_URL`.
 * Built on the official `redis` npm package. `tokenBucket` and `incrBy`
 * run as Lua scripts so they stay atomic.
 *
 * @module lib/gateway/state/redis-kv
 */

import { createClient } from "redis";

const TOKEN_BUCKET_LUA = `
local tokens = tonumber(redis.call('HMGET', KEYS[1], 'tokens', 'ts')[1])
local ts = tonumber(redis.call('HMGET', KEYS[1], 'tokens', 'ts')[2])
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
if tokens == nil then tokens = burst end
if ts == nil then ts = nowMs end
local elapsed = math.max(0, nowMs - ts) / 1000
tokens = math.min(burst, tokens + elapsed * rate)
local allowed = 0
if tokens >= cost then allowed = 1; tokens = tokens - cost end
local remaining = math.floor(tokens)
local retryAfterMs = 0
if allowed == 0 then retryAfterMs = math.ceil((cost - tokens) / rate * 1000) end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', nowMs)
local ttl = math.ceil(burst / rate * 1000) + 60000
redis.call('PEXPIRE', KEYS[1], ttl)
return {allowed, remaining, retryAfterMs}
`;

const INCR_BY_LUA = `
local cur = redis.call('GET', KEYS[1])
local keep = redis.call('PTTL', KEYS[1])
local n = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local val = 0
if cur ~= false and cur ~= nil then
  if string.match(cur, '^-?%d+$') == nil then
    return redis.error_reply('ERR value is not an integer or out of range')
  end
  val = tonumber(cur)
end
val = val + n
redis.call('SET', KEYS[1], tostring(val))
if ttl ~= nil and ttl > 0 then
  redis.call('PEXPIRE', KEYS[1], ttl)
elseif ttl ~= nil and ttl == 0 then
  redis.call('DEL', KEYS[1])
elseif keep ~= nil and keep > 0 then
  redis.call('PEXPIRE', KEYS[1], keep)
end
return val
`;

/**
 * @typedef {object} RedisKvOptions
 * @property {{ now(): number }} [clock] - Timestamp source for token buckets. Defaults to `Date.now`.
 */

/**
 * Redis implementation of the `KvStore` port.
 * Call {@link RedisKvStore.connect} (or use `kvFromEnv`) before use.
 */
export class RedisKvStore {
  /**
   * @param {string} url - Redis connection string (`PODS_KV_URL`).
   * @param {RedisKvOptions} [options={}]
   */
  constructor(url, options = {}) {
    if (!url) throw new TypeError("RedisKvStore requires a connection URL");
    this._url = url;
    this._clock = options.clock ?? { now: () => Date.now() };
    this._client = null;
    /** @type {Map<string, { client: import("redis").RedisClientType, handlers: Set<(message: string) => void> }>} */
    this._subscriptions = new Map();
  }

  /** Connects the underlying client (idempotent) and verifies with PING. */
  async connect() {
    if (this._client) return this._client;
    this._client = createClient({ url: this._url });
    this._client.on("error", () => {});
    await this._client.connect();
    await this._client.ping();
    return this._client;
  }

  _require() {
    if (!this._client) throw new Error("RedisKvStore is not connected; call connect() first");
    return this._client;
  }

  /**
   * @param {string} key
   * @returns {Promise<string | null>}
   */
  async get(key) {
    return this._require().get(key);
  }

  /**
   * @param {string} key
   * @param {string} value
   * @param {{ ttlMs?: number }} [opts={}]
   * @returns {Promise<void>}
   */
  async set(key, value, opts = {}) {
    const client = this._require();
    if (opts.ttlMs == null) {
      await client.set(key, String(value));
    } else {
      await client.set(key, String(value), { PX: opts.ttlMs });
    }
  }

  /**
   * @param {string} key
   * @returns {Promise<void>}
   */
  async del(key) {
    await this._require().del(key);
  }

  /**
   * @param {string} key
   * @param {number} n
   * @param {{ ttlMs?: number }} [opts={}]
   * @returns {Promise<number>}
   */
  async incrBy(key, n, opts = {}) {
    const ttl = opts.ttlMs ?? -1;
    const out = await this._require().eval(INCR_BY_LUA, {
      keys: [key],
      arguments: [String(n), String(ttl)],
    });
    return typeof out === "number" ? out : Number(out);
  }

  /**
   * Atomic token bucket (`rate` tokens/sec, capacity `burst`, deduct `cost`).
   * Buckets start full; idle bucket keys expire automatically.
   *
   * @param {string} key
   * @param {{ rate: number, burst: number, cost?: number }} opts
   * @returns {Promise<{ allowed: boolean, remaining: number, retryAfterMs: number }>}
   */
  async tokenBucket(key, opts) {
    const { rate, burst, cost = 1 } = opts ?? {};
    if (!(rate > 0) || !(burst > 0) || !(cost > 0)) {
      throw new TypeError("tokenBucket requires positive rate, burst and cost");
    }
    const nowMs = this._clock.now();
    const out = await this._require().eval(TOKEN_BUCKET_LUA, {
      keys: [key],
      arguments: [String(rate), String(burst), String(cost), String(nowMs)],
    });
    const [allowed, remaining, retryAfterMs] = out.map(Number);
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }

  /**
   * @param {string} channel
   * @param {string} message
   * @returns {Promise<void>}
   */
  async publish(channel, message) {
    await this._require().publish(channel, message);
  }

  /**
   * Subscribes `fn` to `channel`. A dedicated subscriber connection is
   * shared per channel with local fan-out.
   *
   * @param {string} channel
   * @param {(message: string) => void} fn
   * @returns {Promise<() => Promise<void>>} Async unsubscribe function.
   */
  async subscribe(channel, fn) {
    const client = this._require();
    let sub = this._subscriptions.get(channel);
    if (!sub) {
      const subscriber = client.duplicate();
      subscriber.on("error", () => {});
      await subscriber.connect();
      const handlers = new Set();
      await subscriber.subscribe(channel, (message) => {
        for (const handler of [...handlers]) {
          try {
            handler(message);
          } catch {
            // Subscriber callbacks must never break fan-out.
          }
        }
      });
      sub = { client: subscriber, handlers };
      this._subscriptions.set(channel, sub);
    }
    sub.handlers.add(fn);
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      sub.handlers.delete(fn);
      if (sub.handlers.size === 0) {
        this._subscriptions.delete(channel);
        try {
          await sub.client.unsubscribe(channel);
        } finally {
          await sub.client.quit().catch(() => {});
        }
      }
    };
  }

  /** Quits subscriber connections, then the main client. */
  async close() {
    for (const [channel, sub] of [...this._subscriptions]) {
      this._subscriptions.delete(channel);
      try {
        await sub.client.unsubscribe(channel);
      } catch {
        // Closing: ignore per-channel errors.
      }
      await sub.client.quit().catch(() => {});
    }
    if (this._client) {
      const client = this._client;
      this._client = null;
      await client.quit().catch(() => {});
    }
  }
}
