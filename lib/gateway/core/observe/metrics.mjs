/**
 * Metrics aggregation (S10 §2).
 *
 * Per-protocol metric catalog, per-minute in-memory aggregation (counts, sums
 * and a fixed log-scale latency histogram: 64 buckets, 1 ms–60 s, mergeable),
 * dimension handling (`ApiId`, `Stage`, `{stage}/Canary` for canary traffic,
 * plus `Resource`+`Method` / `Route` when detailed metrics are on), and
 * percentile estimation from merged histograms.
 *
 * @module lib/gateway/core/observe/metrics
 */

/** Metric names per protocol (plus Pods extras, recorded for every protocol). */
export const METRICS_BY_PROTOCOL = {
  REST: ["Count", "4XXError", "5XXError", "Latency", "IntegrationLatency", "CacheHitCount", "CacheMissCount"],
  HTTP: ["Count", "4xx", "5xx", "Latency", "IntegrationLatency", "DataProcessed"],
  WEBSOCKET: ["ConnectCount", "MessageCount", "IntegrationError", "ClientError", "ExecutionError", "IntegrationLatency"],
};

/** Pods extras recorded alongside the AWS metrics. */
export const EXTRA_METRICS = [
  "ThrottleCount",
  "QuotaRejectCount",
  "AuthorizerLatency",
  "KvFallbackCount",
  "DroppedEvents",
  "CacheStoreSkipped",
];

export const HISTOGRAM_BUCKETS = 64;
export const HISTOGRAM_MIN_MS = 1;
export const HISTOGRAM_MAX_MS = 60000;

/**
 * Log-scale bucket index for a latency value (clamped to [0, 63]).
 *
 * @param {number} ms
 * @returns {number}
 */
export function bucketFor(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < HISTOGRAM_MIN_MS) return 0;
  if (value >= HISTOGRAM_MAX_MS) return HISTOGRAM_BUCKETS - 1;
  const ratio = Math.log(value / HISTOGRAM_MIN_MS) / Math.log(HISTOGRAM_MAX_MS / HISTOGRAM_MIN_MS);
  return Math.min(HISTOGRAM_BUCKETS - 1, Math.floor(ratio * HISTOGRAM_BUCKETS));
}

/** Lower bound (ms) of a bucket. */
export function bucketLowerBound(index) {
  if (index <= 0) return 0;
  if (index >= HISTOGRAM_BUCKETS - 1) return HISTOGRAM_MAX_MS;
  return HISTOGRAM_MIN_MS * ((HISTOGRAM_MAX_MS / HISTOGRAM_MIN_MS) ** (index / HISTOGRAM_BUCKETS));
}

/** Upper bound (ms) of a bucket. */
export function bucketUpperBound(index) {
  if (index < 0) return HISTOGRAM_MIN_MS;
  if (index >= HISTOGRAM_BUCKETS - 1) return Infinity;
  return bucketLowerBound(index + 1);
}

/**
 * Estimates a percentile from a histogram (midpoint of the selected bucket).
 *
 * @param {Array<number>} hist - 64-bucket counts.
 * @param {number} p - Percentile in (0, 100], e.g. 50/90/99.
 * @returns {number|null} Estimated ms, or null when empty.
 */
export function percentileFromHistogram(hist, p) {
  const total = (hist ?? []).reduce((sum, count) => sum + (count ?? 0), 0);
  if (total === 0) return null;
  const rank = Math.ceil((p / 100) * total);
  let seen = 0;
  for (let index = 0; index < (hist ?? []).length; index += 1) {
    seen += hist[index] ?? 0;
    if (seen >= rank) return (bucketLowerBound(index) + Math.min(bucketUpperBound(index), HISTOGRAM_MAX_MS)) / 2;
  }
  return HISTOGRAM_MAX_MS;
}

/**
 * Merges histogram arrays by addition (used to combine instances/minutes).
 *
 * @param {Array<number>} a
 * @param {Array<number>} b
 * @returns {Array<number>}
 */
export function mergeHistograms(a, b) {
  const out = new Array(HISTOGRAM_BUCKETS).fill(0);
  for (let index = 0; index < HISTOGRAM_BUCKETS; index += 1) {
    out[index] = (a?.[index] ?? 0) + (b?.[index] ?? 0);
  }
  return out;
}

/**
 * Builds the dimension set for an event. `Stage` becomes `{stage}/Canary`
 * for canary traffic. Detailed dims are added only when enabled for the
 * route/method.
 *
 * @param {object} event - S10 §1 request event.
 * @param {{ detailed?: boolean }} [options={}]
 * @returns {Record<string, string>}
 */
export function dimensionsFor(event, { detailed = false } = {}) {
  const stage = event?.canary ? `${event?.stage ?? ""}/Canary` : String(event?.stage ?? "");
  const dims = { ApiId: String(event?.apiPublicId ?? event?.apiId ?? ""), Stage: stage };
  if (detailed) {
    if (event?.resourcePath) dims.Resource = String(event.resourcePath);
    if (event?.routeKey) dims.Route = String(event.routeKey);
    if (event?.httpMethod) dims.Method = String(event.httpMethod);
  }
  return dims;
}

/**
 * Stable hash for a dimension set (for `dims_hash`).
 *
 * @param {Record<string, string>} dims
 * @returns {string}
 */
export function hashDims(dims) {
  return Object.keys(dims ?? {}).sort().map((key) => `${key}=${dims[key]}`).join("|");
}

/**
 * Truncates a Date/ms to the minute (UTC).
 *
 * @param {string|number|Date} ts
 * @returns {string} ISO minute, e.g. `2026-10-05T12:34:00.000Z`.
 */
export function minuteOf(ts) {
  const date = ts instanceof Date ? ts : new Date(ts);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function newCell() {
  return { sum: 0, count: 0, min: Infinity, max: -Infinity, hist: new Array(HISTOGRAM_BUCKETS).fill(0) };
}

/**
 * In-memory per-minute aggregator. One instance per runtime; `flush()`
 * returns upsert-ready rows for `pods.metrics_minute` and resets.
 *
 * @returns {{ record(event: object): void, flush(): Array<object>, size: number }}
 */
export function createMetricsAggregator() {
  /** @type {Map<string, { sum: number, count: number, min: number, max: number, hist: Array<number> }>} */
  const cells = new Map();

  function cellFor(key) {
    let cell = cells.get(key);
    if (!cell) {
      cell = newCell();
      cells.set(key, cell);
    }
    return cell;
  }

  function addSample({ projectId, apiId, stage, dims, minute, metric, value = 1, latencyMs = null }) {
    const dimsHash = hashDims(dims);
    const key = [projectId, apiId, stage, dimsHash, minute, metric].join("\u0000");
    const cell = cellFor(key);
    cell.sum += value;
    cell.count += 1;
    cell.min = Math.min(cell.min, value);
    cell.max = Math.max(cell.max, value);
    if (latencyMs !== null && latencyMs !== undefined) {
      cell.hist[bucketFor(latencyMs)] += 1;
    }
    return { projectId, apiId, stage, dims, dimsHash, minute, metric };
  }

  return {
    get size() {
      return cells.size;
    },
    /**
     * Records one request event as its protocol + extra metric samples.
     * @param {object} event - S10 §1 request event.
     */
    record(event) {
      if (!event || event.testInvoke) return;
      const projectId = String(event.projectId ?? "");
      const apiId = String(event.apiId ?? "");
      const canary = Boolean(event.canary);
      const stage = canary ? `${event.stage ?? ""}/Canary` : String(event.stage ?? "");
      const dims = dimensionsFor(event, { detailed: Boolean(event.detailedMetrics) });
      const minute = minuteOf(event.ts ?? Date.now());
      const protocol = String(event.protocol ?? "REST").toUpperCase();
      const status = Number(event.status);
      const latencyMs = event.latencyMs ?? null;
      const integrationLatencyMs = event.integrationLatencyMs ?? null;

      const emit = (metric, value = 1, sampleLatency = null) =>
        addSample({ projectId, apiId, stage, dims, minute, metric, value, latencyMs: sampleLatency });

      if (protocol === "HTTP") {
        emit("Count");
        if (status >= 400 && status < 500) emit("4xx");
        if (status >= 500) emit("5xx");
        if (latencyMs !== null) emit("Latency", latencyMs, latencyMs);
        if (integrationLatencyMs !== null) emit("IntegrationLatency", integrationLatencyMs, integrationLatencyMs);
        if (event.requestBytes != null || event.responseBytes != null) {
          emit("DataProcessed", (event.requestBytes ?? 0) + (event.responseBytes ?? 0));
        }
      } else if (protocol === "WEBSOCKET") {
        if (event.eventType === "$connect") emit("ConnectCount");
        else emit("MessageCount");
        if (status >= 400 && status < 500) emit("ClientError");
        if (status >= 500) emit("ExecutionError");
        if (event.integrationError) emit("IntegrationError");
        if (integrationLatencyMs !== null) emit("IntegrationLatency", integrationLatencyMs, integrationLatencyMs);
      } else {
        emit("Count");
        if (status >= 400 && status < 500) emit("4XXError");
        if (status >= 500) emit("5XXError");
        if (latencyMs !== null) emit("Latency", latencyMs, latencyMs);
        if (integrationLatencyMs !== null) emit("IntegrationLatency", integrationLatencyMs, integrationLatencyMs);
        if (event.cache === "hit") emit("CacheHitCount");
        if (event.cache === "miss") emit("CacheMissCount");
      }
      if (event.throttled) emit("ThrottleCount");
      if (event.quotaRejected) emit("QuotaRejectCount");
      if (event.authorizerLatencyMs != null) emit("AuthorizerLatency", event.authorizerLatencyMs, event.authorizerLatencyMs);
      if (event.kvFallback) emit("KvFallbackCount");
      if (event.cacheStoreSkipped) emit("CacheStoreSkipped");
      if (event.droppedEvents) emit("DroppedEvents", event.droppedEvents);
    },
    /**
     * Drains all cells as `pods.metrics_minute` upsert rows and resets.
     * @returns {Array<{ project_id: string, api_id: string, stage: string, dims_hash: string,
     *   dims: object, minute: string, metric: string, sum: number, count: number,
     *   min: number|null, max: number|null, hist: Array<number> }>}
     */
    flush() {
      const rows = [];
      for (const [key, cell] of cells.entries()) {
        const [projectId, apiId, stage, dimsHash, minute, metric] = key.split(" ");
        const dims = {};
        for (const part of String(dimsHash).split("|")) {
          const separator = part.indexOf("=");
          if (separator > 0) dims[part.slice(0, separator)] = part.slice(separator + 1);
        }
        rows.push({
          project_id: projectId,
          api_id: apiId,
          stage,
          dims_hash: dimsHash,
          dims,
          minute,
          metric,
          sum: cell.sum,
          count: cell.count,
          min: cell.min === Infinity ? null : cell.min,
          max: cell.max === -Infinity ? null : cell.max,
          hist: [...cell.hist],
        });
      }
      cells.clear();
      return rows;
    },
  };
}

/** Statistics supported by the query API. */
export const QUERY_STATS = ["Sum", "Average", "Minimum", "Maximum", "SampleCount", "p50", "p90", "p95", "p99"];

/**
 * Reduces merged minute rows to one series value per timestamp.
 *
 * @param {Array<{ ts: string, sum: number, count: number, min: number|null, max: number|null, hist?: Array<number> }>} points
 * @param {string} stat - One of QUERY_STATS.
 * @param {number} [period=60] - Bucket seconds (points are re-bucketed by ts).
 * @returns {Array<{ ts: string, value: number|null }>}
 */
export function reduceSeries(points, stat = "Sum", period = 60) {
  const buckets = new Map();
  for (const point of points ?? []) {
    const bucket = Math.floor(new Date(point.ts).getTime() / (period * 1000)) * period * 1000;
    let cell = buckets.get(bucket);
    if (!cell) {
      cell = { sum: 0, count: 0, min: Infinity, max: -Infinity, hist: new Array(HISTOGRAM_BUCKETS).fill(0) };
      buckets.set(bucket, cell);
    }
    cell.sum += point.sum ?? 0;
    cell.count += point.count ?? 0;
    if (point.min !== null && point.min !== undefined) cell.min = Math.min(cell.min, point.min);
    if (point.max !== null && point.max !== undefined) cell.max = Math.max(cell.max, point.max);
    if (point.hist) cell.hist = mergeHistograms(cell.hist, point.hist);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, cell]) => {
      let value = null;
      if (stat === "Sum") value = cell.sum;
      else if (stat === "Average") value = cell.count === 0 ? null : cell.sum / cell.count;
      else if (stat === "Minimum") value = cell.min === Infinity ? null : cell.min;
      else if (stat === "Maximum") value = cell.max === -Infinity ? null : cell.max;
      else if (stat === "SampleCount") value = cell.count;
      else if (stat === "p50") value = percentileFromHistogram(cell.hist, 50);
      else if (stat === "p90") value = percentileFromHistogram(cell.hist, 90);
      else if (stat === "p95") value = percentileFromHistogram(cell.hist, 95);
      else if (stat === "p99") value = percentileFromHistogram(cell.hist, 99);
      return { ts: new Date(ts).toISOString(), value };
    });
}
