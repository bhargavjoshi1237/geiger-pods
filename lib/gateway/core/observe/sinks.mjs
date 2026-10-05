/**
 * Log & event export sinks (S10 §6, Firehose equivalent).
 *
 * - `https`: NDJSON batches ≤ 1 MB or every 5 s, signed `x-pods-signature`
 *   (HMAC-SHA256), retry with backoff for 24 h, then dropped and counted.
 * - `s3`: gzip NDJSON objects `prefix/yyyy/mm/dd/HH/{instance}-{seq}.ndjson.gz`
 *   every 5 min or 64 MB (`putObject` injected; no network in tests).
 * - `createBatchWriter`: generic DB batch writer (1 s / 500 rows) for the
 *   access-log and execution-log writers (§3–§4).
 *
 * All clocks/timers are injectable so tests stay deterministic. A failing
 * sink never blocks its siblings: each sink owns its buffer and schedule.
 *
 * @module lib/gateway/core/observe/sinks
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";

export const HTTPS_MAX_BYTES = 1024 * 1024;
export const HTTPS_FLUSH_INTERVAL_MS = 5000;
export const SINK_MAX_AGE_MS = 24 * 3600 * 1000;
export const S3_MAX_BYTES = 64 * 1024 * 1024;
export const S3_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
export const BATCH_MAX_ROWS = 500;
export const BATCH_INTERVAL_MS = 1000;

/**
 * HMAC-SHA256 hex signature for an NDJSON payload (`x-pods-signature`).
 *
 * @param {string} secret
 * @param {string} body
 * @returns {string}
 */
export function signBody(secret, body) {
  return createHmac("sha256", String(secret ?? "")).update(String(body ?? ""), "utf8").digest("hex");
}

/**
 * Stateless alias for the pre-merge S10 API: `signPayload(body, secret)`.
 * Argument order is `(body, secret)` to match `tests/s10/sinks.test.mjs`;
 * semantics are identical to `signBody(secret, body)` (HMAC-SHA256 hex).
 *
 * @param {string} body - NDJSON payload.
 * @param {string} secret - HMAC secret.
 * @returns {string}
 */
export function signPayload(body, secret) {
  return signBody(secret, body);
}

/**
 * Serializes rows as NDJSON with a trailing newline (empty input → "").
 *
 * @param {Array<object|string>} rows
 * @returns {string}
 */
export function toNdjson(rows) {
  if (!rows || rows.length === 0) return "";
  return rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row ?? {}))).join("\n") + "\n";
}

/**
 * Verifies an `x-pods-signature` value (timing-safe).
 *
 * @param {string} secret
 * @param {string} body
 * @param {string} signature
 * @returns {boolean}
 */
export function verifySignature(secret, body, signature) {
  try {
    const expected = Buffer.from(signBody(secret, body), "hex");
    const actual = Buffer.from(String(signature ?? ""), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * Creates an https NDJSON sink. `enqueue` never throws and never does I/O;
 * `flush` sends at most one batch when due.
 *
 * @param {{ url: string, secret: string, fetchImpl?: typeof fetch,
 *   clock?: { now(): number }, maxBytes?: number, flushIntervalMs?: number,
 *   maxAgeMs?: number, baseRetryMs?: number, maxRetryMs?: number }} options
 */
export function createHttpsSink({
  url,
  secret,
  fetchImpl = globalThis.fetch,
  clock = { now: () => Date.now() },
  maxBytes = HTTPS_MAX_BYTES,
  flushIntervalMs = HTTPS_FLUSH_INTERVAL_MS,
  maxAgeMs = SINK_MAX_AGE_MS,
  baseRetryMs = 1000,
  maxRetryMs = 300000,
} = {}) {
  const buffer = [];
  let bufferBytes = 0;
  let lastFlushAt = 0;
  let failures = 0;
  let nextAttemptAt = 0;
  let dropped = 0;
  let delivered = 0;
  let lastError = null;

  function enqueue(entry) {
    try {
      const line = typeof entry === "string" ? entry : JSON.stringify(entry ?? {});
      const size = Buffer.byteLength(line, "utf8") + 1;
      buffer.push({ line, size, at: clock.now() });
      bufferBytes += size;
    } catch {
      // Enqueue must never throw.
    }
  }

  function takeBatch() {
    const lines = [];
    let bytes = 0;
    while (buffer.length > 0 && bytes + buffer[0].size <= maxBytes) {
      const entry = buffer.shift();
      bufferBytes -= entry.size;
      lines.push(entry);
      bytes += entry.size;
    }
    // A single oversized line still ships alone (never wedges the queue).
    if (lines.length === 0 && buffer.length > 0) {
      const entry = buffer.shift();
      bufferBytes -= entry.size;
      lines.push(entry);
    }
    return lines;
  }

  /**
   * Sends one batch. Failures back off exponentially (retried on a later
   * `flush`); entries older than 24 h are dropped and counted. Explicit
   * flushes always attempt delivery; use `flushIfDue` for timer-driven calls.
   */
  async function flush({ force = false, now = clock.now() } = {}) {
    if (buffer.length === 0) return { delivered: 0, dropped: 0 };
    if (!force && now < nextAttemptAt) return { delivered: 0, dropped: 0 };
    // Expire entries past the 24 h retry window before sending.
    let expired = 0;
    while (buffer.length > 0 && now - buffer[0].at > maxAgeMs) {
      const entry = buffer.shift();
      bufferBytes -= entry.size;
      expired += 1;
    }
    dropped += expired;
    if (buffer.length === 0) {
      lastFlushAt = now;
      return { delivered: 0, dropped: expired };
    }
    const batch = takeBatch();
    const body = batch.map((entry) => entry.line).join("\n");
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-ndjson",
          "x-pods-signature": signBody(secret, body),
        },
        body,
      });
      if (!response || response.ok !== true) {
        throw new Error(`sink delivery failed${response?.status ? ` (status ${response.status})` : ""}`);
      }
      failures = 0;
      nextAttemptAt = 0;
      lastError = null;
      lastFlushAt = now;
      delivered += batch.length;
      return { delivered: batch.length, dropped: expired };
    } catch (error) {
      // Requeue at the front, preserving order, and back off.
      for (let index = batch.length - 1; index >= 0; index -= 1) {
        buffer.unshift(batch[index]);
        bufferBytes += batch[index].size;
      }
      failures += 1;
      lastError = error?.message ?? String(error);
      lastFlushAt = now;
      nextAttemptAt = now + Math.min(maxRetryMs, baseRetryMs * 2 ** Math.min(failures - 1, 10));
      return { delivered: 0, dropped: expired };
    }
  }

  const sink = {
    enqueue,
    flush,
    /**
     * Timer-driven flush: only sends when the interval elapsed or the
     * buffer reached `maxBytes`.
     */
    async flushIfDue({ now = clock.now() } = {}) {
      if (buffer.length === 0) return { delivered: 0, dropped: 0 };
      if (now < nextAttemptAt) return { delivered: 0, dropped: 0 };
      if (now - lastFlushAt < flushIntervalMs && bufferBytes < maxBytes) {
        return { delivered: 0, dropped: 0 };
      }
      return flush({ force: true, now });
    },
    get pending() { return buffer.length; },
    get dropped() { return dropped; },
    get delivered() { return delivered; },
    get lastError() { return lastError; },
    get nextAttemptAt() { return nextAttemptAt; },
    get clock() { return clock; },
  };
  // Test hook: deterministic clock travel without rebuilding the sink.
  sink.clock.advance = (ms) => {
    const current = clock.now();
    sink.clock.now = () => current + ms;
  };
  return sink;
}

/**
 * Creates an S3-compatible sink: gzip NDJSON objects every 5 min or 64 MB.
 *
 * @param {{ putObject(object: { key: string, body: Buffer, contentType: string, contentEncoding: string }): Promise<unknown>,
 *   prefix?: string, instanceId?: string, clock?: { now(): number },
 *   flushIntervalMs?: number, maxBytes?: number }} options
 */
export function createS3Sink({
  putObject,
  prefix = "logs",
  instanceId = "i-local",
  clock = { now: () => Date.now() },
  flushIntervalMs = S3_FLUSH_INTERVAL_MS,
  maxBytes = S3_MAX_BYTES,
} = {}) {
  const buffer = [];
  let bufferBytes = 0;
  let lastFlushAt = clock.now();
  let seq = 0;
  let objects = 0;

  function keyFor(now) {
    const date = new Date(now);
    const pad = (value) => String(value).padStart(2, "0");
    const day = `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${pad(date.getUTCHours())}`;
    return `${prefix}/${day}/${instanceId}-${seq}.ndjson.gz`;
  }

  function enqueue(entry) {
    try {
      const line = typeof entry === "string" ? entry : JSON.stringify(entry ?? {});
      buffer.push(line);
      bufferBytes += Buffer.byteLength(line, "utf8") + 1;
    } catch {
      // Never throws.
    }
  }

  async function flush({ force = false, now = clock.now() } = {}) {
    void force;
    if (buffer.length === 0) return { objects: 0, lines: 0 };
    const body = gzipSync(buffer.join("\n"), { level: 6 });
    const key = keyFor(now);
    seq += 1;
    await putObject({ key, body, contentType: "application/x-ndjson", contentEncoding: "gzip" });
    const lines = buffer.length;
    buffer.length = 0;
    bufferBytes = 0;
    lastFlushAt = now;
    objects += 1;
    return { objects: 1, lines };
  }

  /**
   * Timer-driven flush: only sends when the interval elapsed or the
   * buffer reached `maxBytes`.
   */
  async function flushIfDue({ now = clock.now() } = {}) {
    if (buffer.length === 0) return { objects: 0, lines: 0 };
    if (now - lastFlushAt < flushIntervalMs && bufferBytes < maxBytes) {
      return { objects: 0, lines: 0 };
    }
    return flush({ now });
  }

  return {
    enqueue,
    flush,
    flushIfDue,
    get pending() { return buffer.length; },
    get objects() { return objects; },
  };
}

/**
 * Generic DB batch writer: buffers rows and inserts every 1 s or 500 rows.
 *
 * @param {{ insert(rows: Array<object>): Promise<unknown>, maxRows?: number, intervalMs?: number }} options
 */
export function createBatchWriter({ insert, maxRows = BATCH_MAX_ROWS, intervalMs = BATCH_INTERVAL_MS } = {}) {
  const buffer = [];
  let timer = null;

  async function flush() {
    if (buffer.length === 0) return { inserted: 0 };
    const rows = buffer.splice(0, buffer.length);
    await insert(rows);
    return { inserted: rows.length };
  }

  function append(row) {
    buffer.push(row);
    if (buffer.length >= maxRows) {
      const rows = buffer.splice(0, buffer.length);
      Promise.resolve()
        .then(() => insert(rows))
        .catch(() => {
          // Requeue on failure; the next flush retries. Never throws.
          for (let index = rows.length - 1; index >= 0; index -= 1) buffer.unshift(rows[index]);
        });
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      flush().catch(() => {});
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    append,
    flush,
    start,
    stop,
    get pending() { return buffer.length; },
  };
}

/**
 * Annotates rows with their NDJSON byte size (pre-merge S10 helper).
 * Returns one entry per input row: `{ row, line, bytes }`.
 *
 * @param {Array<object|string>} rows
 * @returns {Array<{ row: unknown, line: string, bytes: number }>}
 */
export function batchRows(rows) {
  return (rows ?? []).map((row) => {
    const line = typeof row === "string" ? row : JSON.stringify(row ?? {});
    return { row, line, bytes: Buffer.byteLength(line, "utf8") + 1 };
  });
}

/**
 * Exponential-backoff delay for sink retries, capped at 5 minutes.
 *
 * @param {number} attempt - 1-based attempt number.
 * @param {(() => number)|number} [rand=Math.random] - Jitter source in [0,1).
 * @returns {number} Delay in ms.
 */
export function retryDelayMs(attempt, rand = Math.random) {
  const jitter = typeof rand === "function" ? rand() : Number(rand);
  const base = 1000 * 2 ** Math.max(0, Number(attempt ?? 1) - 1);
  const observed = base * (0.5 + 0.5 * (Number.isFinite(jitter) ? jitter : 0.5));
  return Math.min(5 * 60 * 1000, Math.floor(observed));
}

/**
 * Whether a failed sink batch should be retried (24 h retry window).
 *
 * @param {{ firstAttemptAt: number, attempts?: number, now?: number }} options
 * @returns {boolean}
 */
export function shouldRetry({ firstAttemptAt, attempts = 0, now = Date.now() } = {}) {
  void attempts;
  return Number(now) - Number(firstAttemptAt ?? now) < SINK_MAX_AGE_MS;
}

/**
 * Sends one NDJSON batch to an `https` sink (single-shot, ≤1 MB per POST).
 * Splits oversized payloads into ≤1 MB chunks sent sequentially.
 *
 * @param {{ url: string, secret: string, rows: Array<object|string>,
 *   fetchImpl?: typeof fetch, maxBytes?: number }} options
 * @returns {Promise<{ ok: boolean, status: number, delivered: number }>}
 */
export function deliverHttpsBatch({
  url,
  secret,
  rows,
  fetchImpl = globalThis.fetch,
  maxBytes = HTTPS_MAX_BYTES,
} = {}) {
  const lines = (rows ?? []).map((row) => (typeof row === "string" ? row : JSON.stringify(row ?? {})));
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (current.length > 0 && currentBytes + size > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) return Promise.resolve({ ok: true, status: 200, delivered: 0 });

  return (async () => {
    let status = 200;
    let delivered = 0;
    for (const chunk of chunks) {
      const body = chunk.join("\n") + "\n";
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-ndjson",
          "x-pods-signature": signBody(secret, body),
        },
        body,
      });
      if (!response || response.ok !== true) {
        throw new Error(`sink delivery failed${response?.status ? ` (status ${response.status})` : ""}`);
      }
      status = response.status ?? 200;
      delivered += chunk.length;
    }
    return { ok: true, status, delivered };
  })();
}

/**
 * S3 object key for a gzipped NDJSON batch.
 *
 * @param {{ prefix?: string, now?: Date|number|string, instance?: string, seq?: number }} options
 * @returns {string}
 */
export function s3KeyFor({ prefix = "logs", now = new Date(), instance = "i-local", seq = 0 } = {}) {
  const date = now instanceof Date ? now : new Date(now);
  const pad = (value) => String(value).padStart(2, "0");
  return `${prefix}/${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${pad(date.getUTCHours())}/${instance}-${seq}.ndjson.gz`;
}

/**
 * Encodes rows as a gzipped NDJSON S3 object.
 *
 * @param {Array<object|string>} rows
 * @param {{ prefix?: string, now?: Date|number|string, instance?: string, seq?: number }} [options={}]
 * @returns {{ key: string, count: number, bytes: Buffer }}
 */
export function encodeS3Batch(rows, { prefix = "logs", now = new Date(), instance = "i-local", seq = 0 } = {}) {
  const body = toNdjson(rows ?? []);
  return { key: s3KeyFor({ prefix, now, instance, seq }), count: (rows ?? []).length, bytes: gzipSync(body) };
}

/**
 * Creates a sink outbox: per-sink retry queues with exponential backoff
 * (24 h window, then dropped). A failing sink never blocks siblings.
 */
export function createSinkOutbox({ now = () => Date.now() } = {}) {
  const pending = [];
  let sequence = 0;

  function enqueue({ sinkId, kind = "https", payload = null }) {
    const at = now();
    const entry = {
      sinkId,
      kind,
      payload,
      attempts: 0,
      firstAttemptAt: at,
      nextAttemptAt: at,
      seq: sequence++,
    };
    pending.push(entry);
    return entry;
  }

  function due(at = now()) {
    return pending
      .filter((entry) => entry.nextAttemptAt <= at)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.seq - b.seq)
      .map((entry) => ({ ...entry }));
  }

  function removeMatching(entry) {
    const index = pending.findIndex(
      (queued) => queued.sinkId === entry.sinkId && queued.seq === entry.seq,
    );
    if (index >= 0) {
      pending.splice(index, 1);
      return true;
    }
    const fallback = pending.findIndex((queued) => queued.sinkId === entry.sinkId);
    if (fallback >= 0) pending.splice(fallback, 1);
    return fallback >= 0;
  }

  function settled(entry, ok, at = now()) {
    if (ok) {
      removeMatching(entry);
      return { outcome: "delivered" };
    }
    const attempts = Number(entry?.attempts ?? 0) + 1;
    const firstAttemptAt = entry?.firstAttemptAt ?? at;
    if (!shouldRetry({ firstAttemptAt, attempts, now: at })) {
      removeMatching(entry);
      return { outcome: "dropped" };
    }
    const delay = retryDelayMs(attempts, () => 0.5);
    const queued = pending.find(
      (item) => item.sinkId === entry.sinkId && item.seq === entry.seq,
    ) ?? pending.find((item) => item.sinkId === entry.sinkId);
    if (queued) {
      queued.attempts = attempts;
      queued.firstAttemptAt = firstAttemptAt;
      queued.nextAttemptAt = at + delay;
    }
    return { outcome: "retrying", nextAttemptAt: at + delay };
  }

  return {
    enqueue,
    due,
    settled,
    get pending() { return pending.length; },
  };
}
