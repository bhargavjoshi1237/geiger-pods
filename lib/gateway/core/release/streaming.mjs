/**
 * Response streaming (S09 §3): `STREAM` transfer mode for REST `HTTP_PROXY`
 * and `FUNCTION_PROXY`.
 *
 * - Allowed only for those two integration types on REST (compile error
 *   otherwise); incompatible with stage caching for the method, response
 *   compression and response mapping templates (compile errors name the
 *   conflict).
 * - Runtime: headers forwarded immediately (`flushHeaders` in the gateway
 *   host), chunks piped with backpressure, no buffering, no 10 MB cap; the
 *   integration timeout applies only to time-to-first-byte.
 * - Limits (AWS): total ≤ 15 min; idle (no bytes) 5 min for
 *   REGIONAL/PRIVATE, 30 s for EDGE; first 10 MB unthrottled, then
 *   2 MB/s via a token-bucket limiter (`features.streamBandwidthCapBytesPerSec`).
 * - Client disconnect aborts upstream; mid-stream upstream errors terminate
 *   the connection (`integration.error = "stream_aborted"`).
 * - `FUNCTION_PROXY` streaming parses the Lambda event-stream framing: JSON
 *   metadata prelude `{statusCode, headers, cookies}`, 8 NUL bytes, body.
 *
 * @module lib/gateway/core/release/streaming
 */

/** Total stream duration cap: 15 min. */
export const MAX_STREAM_MS = 15 * 60 * 1000;

/** Idle caps: 5 min regional/private, 30 s edge. */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const IDLE_TIMEOUT_EDGE_MS = 30 * 1000;

/** First bytes unthrottled, then capped (AWS). */
export const UNTHROTTLED_BYTES = 10 * 1024 * 1024;
export const DEFAULT_BANDWIDTH_CAP = 2 * 1024 * 1024;

/** Lambda streaming delimiter: 8 NUL bytes after the JSON prelude. */
export const PRELUDE_DELIMITER = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);

/**
 * Validates a `STREAM` transfer mode at compile time.
 *
 * @param {{ protocol: string, integrationType: string, transferMode?: string|null,
 *   hasCacheKeys?: boolean, compression?: number|null, hasResponseTemplates?: boolean }} options
 * @returns {Array<{ path: string, message: string, code: string }>} Errors (empty when ok).
 */
export function validateStreamingConfig({
  protocol,
  integrationType,
  transferMode,
  hasCacheKeys = false,
  compression = null,
  hasResponseTemplates = false,
} = {}) {
  const mode = String(transferMode ?? "BUFFERED").toUpperCase();
  if (mode !== "STREAM") return [];
  const errors = [];
  if (protocol !== "REST") {
    errors.push({ path: "responseTransferMode", message: "response_transfer_mode STREAM is only supported on REST APIs.", code: "capability_unsupported" });
    return errors;
  }
  if (integrationType !== "HTTP_PROXY" && integrationType !== "FUNCTION_PROXY") {
    errors.push({ path: "responseTransferMode", message: "response_transfer_mode STREAM is only supported for HTTP_PROXY and FUNCTION_PROXY integrations.", code: "invalid_config" });
  }
  if (hasCacheKeys) {
    errors.push({ path: "responseTransferMode", message: "response_transfer_mode STREAM is incompatible with stage caching for this method (remove cache_key_parameters or use BUFFERED).", code: "invalid_config" });
  }
  if (compression !== null && compression !== undefined) {
    errors.push({ path: "responseTransferMode", message: "response_transfer_mode STREAM is incompatible with response compression (minimum_compression_size must be unset).", code: "invalid_config" });
  }
  if (hasResponseTemplates) {
    errors.push({ path: "responseTransferMode", message: "response_transfer_mode STREAM is incompatible with response mapping templates.", code: "invalid_config" });
  }
  return errors;
}

/**
 * Parses the Lambda/webhook streaming prelude: JSON metadata, 8 NUL bytes,
 * then body bytes.
 *
 * @param {Uint8Array|Buffer} buffer
 * @returns {{ statusCode: number, headers: Record<string,string>, cookies: Array<string>, body: Uint8Array }}
 * @throws {Error} When the delimiter is missing or the prelude is not JSON.
 */
export function parseLambdaStreamPrelude(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const delimiter = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);
  const at = bytes.indexOf(delimiter);
  if (at < 0) {
    throw new Error("Lambda streaming prelude is missing the 8-NUL delimiter.");
  }
  let prelude;
  try {
    prelude = JSON.parse(bytes.subarray(0, at).toString("utf8"));
  } catch {
    throw new Error("Lambda streaming prelude is not valid JSON.");
  }
  return {
    statusCode: Number.isInteger(prelude.statusCode) ? prelude.statusCode : 200,
    headers: { ...(prelude.headers ?? {}) },
    cookies: [...(prelude.cookies ?? [])],
    body: new Uint8Array(bytes.subarray(at + delimiter.length)),
  };
}

/**
 * Token-bucket byte limiter: the first `unthrottledBytes` pass immediately;
 * afterwards throughput is capped at `capBytesPerSec`.
 *
 * Uses the injected clock so tests are deterministic: `take(n, nowMs)`
 * returns the milliseconds to wait before sending `n` bytes (0 = send now)
 * and records the virtual send time.
 */
export class ByteLimiter {
  /**
   * @param {{ capBytesPerSec?: number, unthrottledBytes?: number, clock?: { now(): number } }} [options={}]
   */
  constructor({ capBytesPerSec = DEFAULT_BANDWIDTH_CAP, unthrottledBytes = UNTHROTTLED_BYTES, clock = null } = {}) {
    this.cap = capBytesPerSec;
    this.free = unthrottledBytes;
    this.clock = clock ?? { now: () => Date.now() };
    this._tokens = capBytesPerSec;
    this._last = null;
    this._sent = 0;
  }

  /**
   * How long to wait before sending `n` bytes at `nowMs`.
   *
   * @param {number} n
   * @param {number} [nowMs]
   * @returns {number} Wait ms (0 = send immediately).
   */
  take(n, nowMs = this.clock.now()) {
    if (this._last === null) this._last = nowMs;
    const elapsed = Math.max(0, nowMs - this._last) / 1000;
    this._tokens = Math.min(this.cap, this._tokens + elapsed * this.cap);
    this._last = nowMs;
    let remaining = n;
    if (this._sent < this.free) {
      const freeLeft = this.free - this._sent;
      const covered = Math.min(freeLeft, remaining);
      this._sent += covered;
      remaining -= covered;
    }
    if (remaining <= 0) return 0;
    this._sent += remaining;
    if (this._tokens >= remaining) {
      this._tokens -= remaining;
      return 0;
    }
    const deficit = remaining - this._tokens;
    this._tokens = 0;
    return Math.ceil((deficit / this.cap) * 1000);
  }
}

/**
 * Resolves streaming limits for a request.
 *
 * @param {object} [opts={}]
 * @returns {{ maxMs: number, idleMs: number, cap: number }}
 */
export function streamingLimits({ artifact = {}, integration = {}, ctx = {} } = {}) {
  const features = artifact.features ?? {};
  // S11: the endpoint type lives in the compiled `edge` snapshot (S05 deploy
  // wiring); older fixtures may carry it top-level — both are honored.
  const endpointType = String(artifact.edge?.endpointType ?? artifact.endpointType ?? artifact.settings?.endpointType ?? "REGIONAL").toUpperCase();
  const edge = endpointType === "EDGE";
  const idleOverride = Number(
    ctx.streamIdleTimeoutMs ?? integration.streamIdleTimeoutMs ?? features.streamIdleTimeoutMs ?? NaN,
  );
  return {
    maxMs: MAX_STREAM_MS,
    idleMs: Number.isFinite(idleOverride) ? idleOverride : (edge ? IDLE_TIMEOUT_EDGE_MS : IDLE_TIMEOUT_MS),
    cap: Number(features.streamBandwidthCapBytesPerSec ?? DEFAULT_BANDWIDTH_CAP),
  };
}

/**
 * Streams a private-connector upstream without buffering (S09 §3 + S15 F23).
 *
 * The connector hub resolves response-head first (TTFB under `timeoutMs`),
 * then body frames stream through a `ReadableStream` with the same idle cap,
 * total cap and bandwidth cap as `invokeHttpStream`. Client disconnect
 * (`ctx.signal` or stream cancel) closes the tunnel stream immediately.
 * Memory stays bounded by the in-flight window — the 10 MB buffered path is
 * never used here.
 *
 * @param {object} ctx - Pipeline context.
 * @param {{ hub: object, connectorId: string, wire: { method: string, url: string, headers?: Headers|Record<string,string>, body?: Uint8Array|null }, timeoutMs?: number, idleMs?: number, maxMs?: number, cap?: number, connectorTargets?: string[] }} options
 * @returns {Promise<{ response: Response, latencyMs: number, ttfbMs: number }>}
 */
export async function invokeConnectorStream(ctx, { hub, connectorId, wire, timeoutMs = 29000, idleMs = IDLE_TIMEOUT_MS, maxMs = MAX_STREAM_MS, cap = DEFAULT_BANDWIDTH_CAP, connectorTargets } = {}) {
  const started = Date.now();
  const upstream = new AbortController();
  const onClientAbort = () => {
    try {
      upstream.abort(new Error("client-abort"));
    } catch {
      // Best-effort.
    }
  };
  ctx?.signal?.addEventListener?.("abort", onClientAbort, { once: true });
  const queue = [];
  let headResult = null;
  let headError = null;
  let ended = false;
  let streamFailed = null;
  const notify = () => {
    try {
      queue.notify?.();
    } catch {
      // Best-effort.
    }
  };
  const ttfbTimer = setTimeout(() => {
    if (!headResult && !headError) {
      headError = Object.assign(new Error("Endpoint request timed out"), { code: "integration-timeout" });
      try {
        upstream.abort(headError);
      } catch {
        // Best-effort.
      }
      notify();
    }
  }, Math.max(1, timeoutMs));
  if (typeof ttfbTimer.unref === "function") ttfbTimer.unref();
  const hubPromise = hub.invokeStream(connectorId, wire, {
    timeoutMs: Math.max(timeoutMs, maxMs),
    connectorTargets,
    signal: upstream.signal,
    onResponseHead: (head) => {
      headResult = head;
      clearTimeout(ttfbTimer);
      notify();
    },
    onChunk: (chunk) => {
      queue.push(Buffer.from(chunk));
      notify();
    },
  }).then(
    () => {
      ended = true;
      notify();
    },
    (error) => {
      streamFailed = error;
      if (!headResult && !headError) {
        headError = error;
        clearTimeout(ttfbTimer);
      }
      notify();
    },
  );
  void hubPromise.catch(() => {});
  // Wait for response-head (or its failure) before answering.
  try {
    while (!headResult && !headError && !upstream.signal.aborted) {
      await new Promise((resolve) => {
        queue.notify = resolve;
        if (headResult || headError || ended || streamFailed || upstream.signal.aborted) resolve();
        else setTimeout(resolve, 25);
      });
    }
  } finally {
    queue.notify = null;
  }
  if (upstream.signal.aborted && !headResult) {
    clearTimeout(ttfbTimer);
    ctx?.signal?.removeEventListener?.("abort", onClientAbort);
    throw headError ?? streamFailed ?? new Error("client-abort");
  }
  if (headError || !headResult) {
    clearTimeout(ttfbTimer);
    ctx?.signal?.removeEventListener?.("abort", onClientAbort);
    throw headError ?? new Error("Connector stream closed without head frame.");
  }
  clearTimeout(ttfbTimer);
  const ttfbMs = Date.now() - started;
  const outHeaders = new Headers();
  try {
    for (const [name, value] of headResult.headers?.entries?.() ?? []) {
      if (name.toLowerCase() === "content-length") continue;
      try {
        outHeaders.append(name, value);
      } catch {
        // Skip illegal values.
      }
    }
  } catch {
    // Forward without headers rather than failing.
  }
  const limiter = new ByteLimiter({ capBytesPerSec: cap });
  const deadline = started + maxMs;
  const stream = new ReadableStream({
    async start(controller) {
      let lastByteAt = Date.now();
      try {
        for (;;) {
          if (Date.now() > deadline || upstream.signal.aborted) break;
          const chunk = queue.shift() ?? null;
          if (chunk) {
            lastByteAt = Date.now();
            const waitMs = limiter.take(chunk.byteLength);
            if (waitMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, Math.max(0, deadline - Date.now()))));
            }
            controller.enqueue(chunk);
            continue;
          }
          if (ended) break;
          if (streamFailed) throw streamFailed;
          const idleLeft = idleMs - (Date.now() - lastByteAt);
          if (idleLeft <= 0) break;
          const remaining = Math.max(0, deadline - Date.now());
          await new Promise((resolve) => setTimeout(resolve, Math.min(25, idleLeft, remaining || 25)));
        }
        controller.close();
      } catch (error) {
        try {
          if (ctx?.context?.integration) ctx.context.integration.error = "stream_aborted";
        } catch {
          // Context is best-effort mid-stream.
        }
        try {
          controller.error(error);
        } catch {
          try {
            controller.close();
          } catch {
            // Last resort.
          }
        }
      } finally {
        try {
          upstream.abort(new Error("stream-done"));
        } catch {
          // Best-effort.
        }
        ctx?.signal?.removeEventListener?.("abort", onClientAbort);
      }
    },
    async cancel() {
      try {
        upstream.abort(new Error("client-abort"));
      } catch {
        // Best-effort.
      }
      ctx?.signal?.removeEventListener?.("abort", onClientAbort);
    },
  });
  return {
    response: new Response(stream, { status: headResult.status, headers: outHeaders }),
    latencyMs: Date.now() - started,
    ttfbMs,
  };
}

/**
 * Streams an HTTP upstream without buffering (S09 §3 runtime).
 *
 * The integration timeout applies only to time-to-first-byte; afterwards the
 * idle cap (no bytes) and the 15 min total cap apply. After the first 10 MB,
 * throughput is capped via `ByteLimiter`. Client disconnect (`ctx.signal` or
 * stream cancel) aborts the upstream immediately. Mid-stream upstream errors
 * terminate the connection and are logged as `stream_aborted`.
 *
 * @param {object} ctx - Pipeline context.
 * @param {{ url: string, method?: string, headers?: Headers|Record<string,string>, body?: Uint8Array|null }} outbound
 * @param {{ ports?: object, timeoutMs?: number, idleMs?: number, maxMs?: number, cap?: number }} [options={}]
 * @returns {Promise<{ response: Response, latencyMs: number, ttfbMs: number }>}
 */
export async function invokeHttpStream(ctx, outbound, { ports = {}, timeoutMs = 29000, idleMs = IDLE_TIMEOUT_MS, maxMs = MAX_STREAM_MS, cap = DEFAULT_BANDWIDTH_CAP } = {}) {
  const started = Date.now();
  const fetchFn = ports.fetch ?? globalThis.fetch;
  const upstream = new AbortController();
  const onClientAbort = () => {
    try {
      upstream.abort(new Error("client-abort"));
    } catch {
      // Best-effort.
    }
  };
  ctx?.signal?.addEventListener?.("abort", onClientAbort, { once: true });
  const ttfbTimer = setTimeout(() => {
    try {
      upstream.abort(new Error("integration-timeout"));
    } catch {
      // Best-effort.
    }
  }, Math.max(1, timeoutMs));
  let upstreamResponse;
  try {
    const headers = {};
    try {
      const source = outbound?.headers ?? ctx.request.headers;
      for (const [name, value] of (source?.entries?.() ?? [])) headers[name] = value;
    } catch {
      // Send without headers rather than failing.
    }
    upstreamResponse = await fetchFn(outbound.url, {
      method: outbound.method ?? "GET",
      headers,
      body: outbound.body ?? undefined,
      signal: upstream.signal,
      redirect: "manual",
    });
  } catch (error) {
    clearTimeout(ttfbTimer);
    ctx?.signal?.removeEventListener?.("abort", onClientAbort);
    throw error;
  }
  clearTimeout(ttfbTimer);
  const ttfbMs = Date.now() - started;
  const outHeaders = new Headers();
  try {
    for (const [name, value] of upstreamResponse.headers.entries()) {
      if (name.toLowerCase() === "content-length") continue;
      try {
        outHeaders.append(name, value);
      } catch {
        // Skip illegal values.
      }
    }
  } catch {
    // Forward without headers rather than failing.
  }
  const limiter = new ByteLimiter({ capBytesPerSec: cap });
  const deadline = started + maxMs;
  let reader = null;
  try {
    reader = upstreamResponse.body?.getReader?.() ?? null;
  } catch {
    reader = null;
  }
  if (!reader) {
    ctx?.signal?.removeEventListener?.("abort", onClientAbort);
    return {
      response: new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: outHeaders }),
      latencyMs: Date.now() - started,
      ttfbMs,
    };
  }
  const stream = new ReadableStream({
    async start(controller) {
      let lastByteAt = Date.now();
      let onAbort = null;
      const abortedPromise = new Promise((resolve) => {
        onAbort = () => resolve("aborted");
        if (upstream.signal.aborted) resolve("aborted");
        else upstream.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        for (;;) {
          if (Date.now() > deadline) break;
          if (upstream.signal.aborted) break;
          const remaining = Math.max(0, deadline - Date.now());
          const idleLeft = idleMs - (Date.now() - lastByteAt);
          if (idleLeft <= 0) break;
          const readPromise = reader.read();
          let timeoutId = null;
          const timeoutPromise = new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve(null), Math.min(idleLeft, remaining));
          });
          const next = await Promise.race([readPromise, timeoutPromise, abortedPromise]);
          if (timeoutId !== null) clearTimeout(timeoutId);
          if (next === null || next === "aborted") break;
          const { done, value } = next ?? {};
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          lastByteAt = Date.now();
          const waitMs = limiter.take(value.byteLength);
          if (waitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, Math.max(0, deadline - Date.now()))));
          }
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        try {
          if (ctx?.context?.integration) ctx.context.integration.error = "stream_aborted";
        } catch {
          // Context is best-effort mid-stream.
        }
        try {
          controller.error(error);
        } catch {
          try {
            controller.close();
          } catch {
            // Last resort.
          }
        }
      } finally {
        try {
          upstream.signal.removeEventListener("abort", onAbort);
        } catch {
          // Best-effort.
        }
        // Release the upstream socket back to the pool (or close it): without
        // this the fetch stays checked out and the process lingers.
        try {
          await reader.cancel();
        } catch {
          // Already consumed or aborted.
        }
        try {
          reader.releaseLock();
        } catch {
          // Best-effort.
        }
        ctx?.signal?.removeEventListener?.("abort", onClientAbort);
      }
    },
    async cancel() {
      try {
        upstream.abort(new Error("client-abort"));
      } catch {
        // Best-effort.
      }
      try {
        await reader.cancel();
      } catch {
        // Best-effort.
      }
      ctx?.signal?.removeEventListener?.("abort", onClientAbort);
    },
  });
  return {
    response: new Response(stream, { status: upstreamResponse.status, headers: outHeaders }),
    latencyMs: Date.now() - started,
    ttfbMs,
  };
}
