/**
 * Observability barrel + `ctx.trace` attachment (S10).
 *
 * Every other phase calls `ctx.trace(level, message)`. This module defines
 * it and attaches it early: `ensureTrace(ctx)` makes `ctx.trace` a no-op-safe
 * function backed by an execution-log collector buffer (`ctx.traceLines`).
 * `lib/gateway/core/context.mjs` (S01) calls it in `buildContext` — the
 * smallest possible edit there — so `ctx.trace` always exists.
 *
 * @module lib/gateway/core/observe/index
 */

export { buildRequestEvent, createEventSink, EVENT_QUEUE_CAPACITY } from "./event.mjs";
export {
  METRICS_BY_PROTOCOL, EXTRA_METRICS, HISTOGRAM_BUCKETS, bucketFor,
  percentileFromHistogram, mergeHistograms, dimensionsFor, hashDims,
  minuteOf, createMetricsAggregator, QUERY_STATS, reduceSeries,
} from "./metrics.mjs";
export { PRESETS, validateAccessLogFormat, renderAccessLog, toAccessLogRow, variablesInFormat } from "./access-log.mjs";
export {
  levelEnabled, maskHeaderValue, maskSecretsInText, formatMaskedHeaders,
  traceBody, createExecutionLogCollector, openingLines, toExecutionLogRow,
} from "./execution-log.mjs";
export {
  parseTraceparent, buildTraceparent, traceparentFromAmzn, newSpanId, newTraceId,
  resolveInboundTrace, matchGlob, decideSampling, defaultSamplingRules,
  createSpan, endSpan, spansToOtlp, exportSpansOtlp,
} from "./tracing.mjs";
export {
  signBody, verifySignature, createHttpsSink, createS3Sink, createBatchWriter,
  signPayload, toNdjson, batchRows, retryDelayMs, shouldRetry,
  deliverHttpsBatch, s3KeyFor, encodeS3Batch, createSinkOutbox,
  HTTPS_MAX_BYTES, HTTPS_FLUSH_INTERVAL_MS, SINK_MAX_AGE_MS, S3_MAX_BYTES, S3_FLUSH_INTERVAL_MS,
  BATCH_MAX_ROWS, BATCH_INTERVAL_MS,
} from "./sinks.mjs";
export { isBreaching, evaluateAlarm, applyTransition } from "./alarm-eval.mjs";

import { createExecutionLogCollector } from "./execution-log.mjs";

/**
 * Ensures `ctx.trace(level, message)` exists (no-op-safe). Attaches a
 * collector buffer at `ctx.traceLines` for the emit phase.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {object} The same `ctx`.
 */
export function ensureTrace(ctx) {
  if (!ctx || typeof ctx !== "object") return ctx;
  if (typeof ctx.trace !== "function") {
    const collector = createExecutionLogCollector();
    ctx.traceCollector = collector;
    ctx.traceLines = collector.lines;
    ctx.trace = (level, message) => {
      try {
        collector.trace(level, message);
      } catch {
        // Tracing must never break request handling.
      }
    };
  } else if (!ctx.traceLines) {
    ctx.traceLines = [];
  }
  return ctx;
}
