/**
 * Request event builder + bounded in-memory event sink (S10 §1).
 *
 * Phase 20 builds one event per request **after** the response completes and
 * fans it out via `queueMicrotask`/`setImmediate`, never on the response path.
 * The sink is a bounded queue (10 000 events): when full it drops the oldest
 * and increments `droppedEvents`. Each consumer fails independently.
 *
 * @module lib/gateway/core/observe/event
 */

export const EVENT_QUEUE_CAPACITY = 10000;

/**
 * Builds the S10 §1 request event from a finished pipeline context.
 *
 * @param {object} ctx - Pipeline context (with `context`, `request`, `artifact`).
 * @param {Response|null} response - Final response (may be null in tests).
 * @param {{ latencyMs?: number|null, integrationLatencyMs?: number|null, authorizerLatencyMs?: number|null,
 *   requestBytes?: number|null, responseBytes?: number|null }} [timings={}]
 * @returns {Record<string, unknown>} The request event.
 */
export function buildRequestEvent(ctx, response, timings = {}) {
  const c = ctx?.context ?? {};
  const artifact = ctx?.artifact ?? {};
  const status = response?.status ?? (c.status !== "" && c.status != null ? Number(c.status) : null);
  const canary = c.isCanaryRequest === true || c.isCanaryRequest === "true";
  const stage = String(c.stage ?? artifact.stage ?? ctx?.stage ?? "");
  return {
    ts: new Date(ctx?.startTime ?? Date.now()).toISOString(),
    requestId: ctx?.requestId ?? c.requestId ?? "",
    extendedRequestId: c.extendedRequestId ?? "",
    projectId: artifact.projectId ?? artifact.accountId ?? c.accountId ?? "",
    apiId: artifact.apiId ?? c.apiId ?? "",
    apiPublicId: ctx?.apiPublicId ?? artifact.apiPublicId ?? "",
    protocol: artifact.protocol ?? c.protocol ?? "",
    stage,
    canary,
    deploymentId: artifact.deploymentId ?? c.deploymentId ?? null,
    routeKey: c.routeKey ?? "",
    resourcePath: c.resourcePath ?? "",
    httpMethod: c.httpMethod ?? ctx?.request?.method ?? "GET",
    status,
    errorType: c.error?.responseType ?? null,
    latencyMs: timings.latencyMs ?? null,
    integrationLatencyMs: timings.integrationLatencyMs ?? null,
    authorizerLatencyMs: timings.authorizerLatencyMs ?? null,
    requestBytes: timings.requestBytes ?? null,
    responseBytes: timings.responseBytes ?? null,
    cache: ctx?.cacheOutcome ?? null,
    apiKeyId: c.identity?.apiKeyId ?? null,
    principalId: c.authorizer?.principalId ?? null,
    sourceIp: c.identity?.sourceIp ?? "",
    userAgent: c.identity?.userAgent ?? "",
    throttled: Boolean(ctx?.throttled),
    quotaRejected: Boolean(ctx?.quotaRejected),
    wafAction: ctx?.wafAction ?? null,
    domainName: c.domainName ?? "",
    traceId: c.traceId ?? null,
    kvFallback: Boolean(ctx?.kvFallback),
    connectionId: c.connectionId || undefined,
    eventType: c.eventType || undefined,
  };
}

/**
 * Creates a bounded in-memory event sink (the S01 `EventSink` port).
 * `emit` never throws and never blocks: slow consumers run on their own
 * tick via `setImmediate`/`queueMicrotask`.
 *
 * @param {{ capacity?: number, consumers?: Array<(event: object) => unknown>,
 *   onDrop?: (dropped: number) => void }} [options={}]
 * @returns {{ emit(event: object): void, subscribe(fn: (event: object) => unknown): () => void,
 *   queue: Array<object>, droppedEvents: number, flush(): Promise<void> }}
 */
export function createEventSink({ capacity = EVENT_QUEUE_CAPACITY, consumers = [], onDrop = null } = {}) {
  const queue = [];
  const subs = [...consumers];
  let droppedEvents = 0;

  function dispatch(event) {
    for (const fn of subs) {
      try {
        const out = fn(event);
        if (out && typeof out.catch === "function") out.catch(() => {});
      } catch {
        // Each consumer fails independently; the sink never throws.
      }
    }
  }

  const sink = {
    queue,
    get droppedEvents() {
      return droppedEvents;
    },
    /**
     * Enqueues one event and fans out off the caller's tick. Never throws.
     * @param {object} event
     */
    emit(event) {
      try {
        if (queue.length >= capacity) {
          queue.shift();
          droppedEvents += 1;
          try {
            onDrop?.(droppedEvents);
          } catch {
            // Ignore listener errors.
          }
        }
        queue.push(event);
        if (typeof setImmediate === "function") setImmediate(() => dispatch(event));
        else queueMicrotask(() => dispatch(event));
      } catch {
        // Emit must never break the response path.
      }
    },
    /**
     * Adds a consumer. Returns an unsubscribe function.
     * @param {(event: object) => unknown} fn
     * @returns {() => void}
     */
    subscribe(fn) {
      subs.push(fn);
      return () => {
        const index = subs.indexOf(fn);
        if (index >= 0) subs.splice(index, 1);
      };
    },
    /** Runs all consumers inline (tests only). */
    async flush() {
      for (const event of [...queue]) dispatch(event);
    },
  };
  return sink;
}
