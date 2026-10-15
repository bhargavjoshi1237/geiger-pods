// Playground fake for the v1 API: Metrics, logs, alarms, alarm channels and log sinks.
// Served so far: GET /metrics (series, ?view=dashboard, ?view=overview) over
// the seeded metrics_hour rows, after lib/control/metrics.mjs.

import { fail, routes, table } from "./http.js";
import {
  HISTOGRAM_BUCKETS, METRICS_BY_PROTOCOL, QUERY_STATS, mergeHistograms, percentileFromHistogram, reduceSeries,
} from "../../gateway/core/observe/metrics.mjs";

const QUERY_PERIODS = [60, 300, 3600, 86400];
const ALL_METRICS = new Set([...METRICS_BY_PROTOCOL.REST, ...METRICS_BY_PROTOCOL.HTTP, ...METRICS_BY_PROTOCOL.WEBSOCKET]);
const DAY_MS = 86400 * 1000;
const DASHBOARD_MAX_DAYS = 45;

/** Metric rows in [from, to], by uuid or public API id (like observe-db queryHourRows). */
function metricRows({ metric = null, apiId = null, stage = null, from = null, to = null }) {
  const api = apiId ? table("apis").find((row) => row.id === apiId || row.public_id === apiId) : null;
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) : Infinity;
  return table("metrics_hour").filter((row) => {
    if (metric && row.metric !== metric) return false;
    if (apiId && row.api_id !== api?.id) return false;
    if (stage && row.stage !== stage) return false;
    const ts = Date.parse(row.hour);
    return ts >= fromMs && ts <= toMs;
  });
}

function parseDims(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to comma-separated key=value pairs.
  }
  const out = {};
  for (const part of String(value).split(",")) {
    const separator = part.indexOf("=");
    if (separator > 0) out[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return out;
}

function dimsMatch(rowDims, wanted) {
  if (!wanted) return true;
  return Object.entries(wanted).every(([key, value]) => String(rowDims?.[key] ?? "") === String(value));
}

// lib/control/metrics.mjs queryMetrics().
function queryMetrics(query) {
  const { metric, apiId = null, stage = null, from = null, to = null } = query;
  const stat = query.stat ?? "Sum";
  const period = Number(query.period ?? 300);
  if (typeof metric !== "string" || !ALL_METRICS.has(metric)) fail(422, "invalid_input", "Invalid request: $.metric: unknown metric name");
  if (!QUERY_STATS.includes(stat)) fail(422, "invalid_input", `Invalid request: $.stat: must be one of ${QUERY_STATS.join(", ")}`);
  if (!QUERY_PERIODS.includes(period)) fail(422, "invalid_input", `Invalid request: $.period: must be one of ${QUERY_PERIODS.join(", ")}`);
  const dims = parseDims(query.dims);
  const points = metricRows({ metric, apiId, stage, from, to })
    .filter((row) => dimsMatch(row.dims, dims))
    .map((row) => ({ ts: row.hour, sum: row.sum ?? 0, count: row.count ?? 0, min: row.min ?? null, max: row.max ?? null, hist: row.hist ?? null }));
  return { series: reduceSeries(points, stat, period) };
}

// lib/control/metrics.mjs getOverviewCounts() (last 24 h, whole project).
function overviewCounts() {
  const now = Date.now();
  const rows = metricRows({ from: new Date(now - DAY_MS).toISOString(), to: new Date(now).toISOString() });
  let requests = 0;
  let errors = 0;
  let latency = new Array(HISTOGRAM_BUCKETS).fill(0);
  for (const row of rows) {
    if (["Count", "ConnectCount", "MessageCount"].includes(row.metric)) requests += row.count ?? 0;
    if (["4XXError", "4xx", "5XXError", "5xx", "ClientError", "ExecutionError"].includes(row.metric)) errors += row.count ?? 0;
    if (row.metric === "Latency" && row.hist) latency = mergeHistograms(latency, row.hist);
  }
  return { requests, errors, p90LatencyMs: percentileFromHistogram(latency, 90) };
}

const DASHBOARD_FAMILIES = {
  requests: ["Count", "ConnectCount", "MessageCount"],
  errors4xx: ["4XXError", "4xx", "ClientError"],
  errors5xx: ["5XXError", "5xx", "ExecutionError"],
  throttled: ["ThrottleCount", "QuotaRejectCount"],
  cacheHits: ["CacheHitCount"],
  cacheMisses: ["CacheMissCount"],
  latency: ["Latency"],
};
const FAMILY_OF = new Map(Object.entries(DASHBOARD_FAMILIES).flatMap(([family, metrics]) => metrics.map((metric) => [metric, family])));

function emptyTotals() {
  return { requests: 0, errors4xx: 0, errors5xx: 0, throttled: 0, cacheHits: 0, cacheMisses: 0, hist: new Array(HISTOGRAM_BUCKETS).fill(0) };
}

function emptyDaily(days, fromMs) {
  return Array.from({ length: days }, (_, index) => ({ day: new Date(fromMs + index * DAY_MS).toISOString(), requests: 0, errors: 0, throttled: 0 }));
}

function addToTotals(totals, family, row) {
  if (family === "latency") {
    if (row.hist) totals.hist = mergeHistograms(totals.hist, row.hist);
  } else {
    totals[family] += row.count ?? 0;
  }
}

function addToDaily(daily, family, row, index) {
  const cell = daily[index];
  if (!cell) return;
  if (family === "requests") cell.requests += row.count ?? 0;
  else if (family === "errors4xx" || family === "errors5xx") cell.errors += row.count ?? 0;
  else if (family === "throttled") cell.throttled += row.count ?? 0;
}

function finishTotals({ hist, ...counts }) {
  return { ...counts, p90LatencyMs: percentileFromHistogram(hist, 90) };
}

// lib/control/metrics.mjs getDashboard().
function dashboard(query) {
  const span = Number(query.days ?? 14);
  if (!Number.isInteger(span) || span < 1 || span > DASHBOARD_MAX_DAYS) {
    fail(422, "invalid_input", `Invalid request: $.days: must be an integer from 1 to ${DASHBOARD_MAX_DAYS}`);
  }
  const nowMs = Date.now();
  const fromMs = Math.floor(nowMs / DAY_MS) * DAY_MS - (span - 1) * DAY_MS;
  const previousFromMs = fromMs - span * DAY_MS;
  const to = new Date(nowMs).toISOString();

  const current = emptyTotals();
  const previous = emptyTotals();
  const daily = emptyDaily(span, fromMs);
  const apis = new Map();
  for (const row of metricRows({ from: new Date(previousFromMs).toISOString(), to })) {
    const family = FAMILY_OF.get(row.metric);
    if (!family) continue;
    const ts = Date.parse(row.hour);
    if (ts < fromMs) {
      addToTotals(previous, family, row);
      continue;
    }
    const index = Math.floor((ts - fromMs) / DAY_MS);
    addToTotals(current, family, row);
    addToDaily(daily, family, row, index);
    let entry = apis.get(row.api_id);
    if (!entry) {
      entry = { totals: emptyTotals(), daily: emptyDaily(span, fromMs) };
      apis.set(row.api_id, entry);
    }
    addToTotals(entry.totals, family, row);
    addToDaily(entry.daily, family, row, index);
  }

  return {
    days: span,
    from: new Date(fromMs).toISOString(),
    to,
    current: finishTotals(current),
    previous: finishTotals(previous),
    daily,
    apis: [...apis.entries()]
      .map(([apiId, entry]) => ({ apiId, ...finishTotals(entry.totals), daily: entry.daily }))
      .sort((a, b) => b.requests - a.requests),
  };
}

export const monitoringRoutes = routes([
  ["GET", "/metrics", ({ query }) => {
    if (query.view === "dashboard") return dashboard(query);
    if (query.view === "overview") return overviewCounts();
    return queryMetrics(query);
  }],
]);
