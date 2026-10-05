/**
 * In-memory `KvStore` (tests, single process).
 * Single-threaded map; `tokenBucket` is therefore atomic. Uses the
 * injected clock so tests are deterministic.
 *
 * @module lib/gateway/state/memory-kv
 */

/**
 * @typedef {object} MemoryKvOptions
 * @property {{ now(): number }} [clock] - Defaults to `Date.now`.
 */

/**
 * In-memory implementation of the `KvStore` port.
 */
export class MemoryKvStore {
  /**
   * @param {MemoryKvOptions} [options={}]
   */
  constructor(options = {}) {
    this._clock = options.clock ?? { now: () => Date.now() };
    /** @type {Map<string, { value: string, expiresAt: number | null }>} */
    this._entries = new Map();
    /** @type {Map<string, { tokens: number, ts: number }>} */
    this._buckets = new Map();
    /** @type {Map<string, Set<(message: string) => void>>} */
    this._subscribers = new Map();
  }

  _now() {
    return this._clock.now();
  }

  _isExpired(entry, now) {
    return entry.expiresAt !== null && now >= entry.expiresAt;
  }

  /**
   * @param {string} key
   * @returns {Promise<string | null>}
   */
  async get(key) {
    const entry = this._entries.get(key);
    if (!entry) return null;
    if (this._isExpired(entry, this._now())) {
      this._entries.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * @param {string} key
   * @param {string} value
   * @param {{ ttlMs?: number }} [opts={}]
   * @returns {Promise<void>}
   */
  async set(key, value, opts = {}) {
    const now = this._now();
    this._entries.set(key, {
      value: String(value),
      expiresAt: opts.ttlMs == null ? null : now + opts.ttlMs,
    });
  }

  /**
   * @param {string} key
   * @returns {Promise<void>}
   */
  async del(key) {
    this._entries.delete(key);
  }

  /**
   * Atomically adds `n` to the integer at `key` (missing → 0).
   * Keeps the existing TTL unless `opts.ttlMs` is given.
   * Throws when the stored value is not an integer (mirrors Redis).
   *
   * @param {string} key
   * @param {number} n
   * @param {{ ttlMs?: number }} [opts={}]
   * @returns {Promise<number>}
   */
  async incrBy(key, n, opts = {}) {
    const now = this._now();
    const entry = this._entries.get(key);
    let current = 0;
    let expiresAt = opts.ttlMs == null ? null : now + opts.ttlMs;
    if (entry && !this._isExpired(entry, now)) {
      if (!/^-?\d+$/.test(entry.value)) {
        throw new Error("ERR value is not an integer or out of range");
      }
      current = Number.parseInt(entry.value, 10);
      if (opts.ttlMs == null) expiresAt = entry.expiresAt;
    }
    const next = current + n;
    this._entries.set(key, { value: String(next), expiresAt });
    return next;
  }

  /**
   * Token bucket: `rate` tokens per second, capacity `burst`, deduct `cost`.
   * Buckets start full. Pure function of the injected clock.
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
    const now = this._now();
    const state = this._buckets.get(key) ?? { tokens: burst, ts: now };
    const elapsedSec = Math.max(0, now - state.ts) / 1000;
    let tokens = Math.min(burst, state.tokens + elapsedSec * rate);
    let allowed = false;
    if (tokens >= cost) {
      allowed = true;
      tokens -= cost;
    }
    const remaining = Math.floor(tokens);
    const retryAfterMs = allowed ? 0 : Math.ceil(((cost - tokens) / rate) * 1000);
    this._buckets.set(key, { tokens, ts: now });
    return { allowed, remaining, retryAfterMs };
  }

  /**
   * @param {string} channel
   * @param {string} message
   * @returns {Promise<void>}
   */
  async publish(channel, message) {
    const subs = this._subscribers.get(channel);
    if (!subs || subs.size === 0) return;
    await Promise.allSettled([...subs].map((fn) => fn(message)));
  }

  /**
   * @param {string} channel
   * @param {(message: string) => void} fn
   * @returns {() => void} Unsubscribe function.
   */
  subscribe(channel, fn) {
    let subs = this._subscribers.get(channel);
    if (!subs) {
      subs = new Set();
      this._subscribers.set(channel, subs);
    }
    subs.add(fn);
    return () => {
      subs.delete(fn);
      if (subs.size === 0) this._subscribers.delete(channel);
    };
  }

  /** No-op close for interface parity with the Redis store. */
  async close() {}
}
