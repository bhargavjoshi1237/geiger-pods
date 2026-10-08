/**
 * Metrics query + rollup services (S10 §2).
 *
 * - `queryMetrics`: `GET /metrics` backing store query. Percentiles come from
 *   merged histograms (`reduceSeries`). Reads need `pods.monitoring.view`;
 *   where RBAC lacks that key (older grants), `pods.logs.view` is accepted as
 *   a fallback — see `requireMonitoringView` and the S10 report.
 * - `rollupMinuteToHour`: pure merge used by the rollup job (minute rows kept
 *   15 days, hour rows 455 days).
 * - `getOverviewCounts`: real 24 h counts (requests, errors, p90) for the
 *   Overview screen. No sample traffic is ever synthesized.
 * - `getDashboard`: current vs previous window totals, a daily series and a
 *   per-API breakdown for the Overview dashboard (`GET /metrics?view=dashboard`).
 *
 * @module lib/control/metrics
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { METRICS_BY_PROTOCOL, QUERY_STATS, reduceSeries, mergeHistograms, percentileFromHistogram, HISTOGRAM_BUCKETS } from "../gateway/core/observe/metrics.mjs";

export const QUERY_PERIODS = [60, 300, 3600, 86400];
export const MINUTE_RETENTION_DAYS = 15;
export const HOUR_RETENTION_DAYS = 455;

const ALL_METRICS = new Set([
  ...METRICS_BY_PROTOCOL.REST,
  ...METRICS_BY_PROTOCOL.HTTP,
  ...METRICS_BY_PROTOCOL.WEBSOCKET,
]);

/**
 * Requires metrics/logs visibility. `pods.monitoring.view` is the primary
 * key; deployments whose grants predate it fall back to `pods.logs.view`.
 *
 * @param {object} db - Control db.
 * @param {object} actor
 * @param {{ projectId: string }} options
 */
export async function requireMonitoringView(db, actor, { projectId }) {
  try {
    await requirePermission(db, actor, "pods.monitoring.view", { projectId });
    return "pods.monitoring.view";
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      await requirePermission(db, actor, "pods.logs.view", { projectId });
      return "pods.logs.view";
    }
    throw error;
  }
}

function checkStat(stat) {
  if (!QUERY_STATS.includes(stat)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.stat: must be one of ${QUERY_STATS.join(", ")}`);
  }
  return stat;
}

function checkPeriod(period) {
  const num = Number(period);
  if (!QUERY_PERIODS.includes(num)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.period: must be one of ${QUERY_PERIODS.join(", ")}`);
  }
  return num;
}

function checkMetric(metric) {
  if (typeof metric !== "string" || !ALL_METRICS.has(metric)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.metric: unknown metric name");
  }
  return metric;
}

function dimsMatch(rowDims, wanted) {
  if (!wanted) return true;
  const entries = Object.entries(wanted);
  if (entries.length === 0) return true;
  const dims = rowDims ?? {};
  return entries.every(([key, value]) => String(dims[key] ?? "") === String(value));
}

async function fetchHourRows(db, args) {
  if (typeof db.listMetricsHour === "function") {
    return (await db.listMetricsHour(args)) ?? [];
  }
  if (typeof db.queryHourRows === "function") {
    return (await db.queryHourRows(args)) ?? [];
  }
  if (typeof db.listMetricsMinute === "function" && args.metric === undefined) {
    return [];
  }
  return [];
}

async function fetchMinuteRows(db, args) {
  if (typeof db.listMetricsMinute === "function") {
    return (await db.listMetricsMinute(args)) ?? [];
  }
  if (typeof db.queryMinuteRows === "function") {
    return (await db.queryMinuteRows(args)) ?? [];
  }
  return [];
}

async function fetchOverviewRows(db, { projectId, from, to }) {
  const rows = [];
  if (typeof db.listMetricsHour === "function") {
    rows.push(...((await db.listMetricsHour({ projectId, from, to })) ?? []));
  } else if (typeof db.queryHourRows === "function") {
    rows.push(...((await db.queryHourRows({ projectId, from, to })) ?? []));
  }
  if (typeof db.listMetricsMinute === "function") {
    rows.push(...((await db.listMetricsMinute({ projectId, from, to })) ?? []));
  } else if (typeof db.queryMinuteRows === "function") {
    rows.push(...((await db.queryMinuteRows({ projectId, from, to })) ?? []));
  }
  // Fake-db fallback: minuteRows/hourRows arrays via listMinutesBefore-style ports.
  if (rows.length === 0 && typeof db.listMinutesBefore === "function" && !from && !to) {
    try {
      rows.push(...((await db.listMinutesBefore(new Date().toISOString(), 5000)) ?? []));
    } catch {
      // Ignore; return what we have.
    }
  }
  return rows;
}

/**
 * Queries merged metric series. Hour rows cover whole hours; minute rows fill
 * the partial edges. Returns `{ series: [{ ts, value }] }`.
 */
export async function queryMetrics(db, actor, {
  projectId, metric, apiId = null, stage = null, dims = null,
  stat = "Sum", period = 60, from = null, to = null,
}) {
  await requireMonitoringView(db, actor, { projectId });
  checkMetric(metric);
  checkStat(stat);
  const periodSec = checkPeriod(period);
  const windows = [];
  windows.push(...(await fetchHourRows(db, { projectId, apiId, stage, metric, from, to })) ?? []);
  windows.push(...(await fetchMinuteRows(db, { projectId, apiId, stage, metric, from, to })) ?? []);
  const points = windows
    .filter((row) => (!apiId || String(row.api_id ?? row.apiId ?? "") === String(apiId)))
    .filter((row) => (!stage || String(row.stage ?? "") === String(stage)))
    .filter((row) => dimsMatch(row.dims, dims))
    .map((row) => ({
      ts: row.minute ?? row.hour ?? row.ts,
      sum: row.sum ?? 0,
      count: row.count ?? 0,
      min: row.min ?? null,
      max: row.max ?? null,
      hist: row.hist ?? null,
    }))
    .filter((point) => point.ts);
  return { series: reduceSeries(points, stat, periodSec) };
}

/**
 * Merges per-minute rows into per-hour rows (pure; used by the rollup job
 * and its tests). Sums/counts add; min/max fold; histograms merge.
 *
 * @param {Array<object>} minuteRows - `pods.metrics_minute` rows.
 * @returns {Array<object>} `pods.metrics_hour` rows.
 */
export function rollupMinuteToHour(minuteRows) {
  const cells = new Map();
  for (const row of minuteRows ?? []) {
    const hour = new Date(row.minute);
    hour.setUTCMinutes(0, 0, 0);
    const key = [row.project_id, row.api_id, row.stage, row.dims_hash, hour.toISOString(), row.metric].join("\u0000");
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        project_id: row.project_id, api_id: row.api_id, stage: row.stage,
        dims_hash: row.dims_hash, dims: row.dims ?? {}, hour: hour.toISOString(),
        metric: row.metric, sum: 0, count: 0, min: Infinity, max: -Infinity,
        hist: new Array(HISTOGRAM_BUCKETS).fill(0),
      };
      cells.set(key, cell);
    }
    cell.sum += row.sum ?? 0;
    cell.count += row.count ?? 0;
    if (row.min !== null && row.min !== undefined) cell.min = Math.min(cell.min, row.min);
    if (row.max !== null && row.max !== undefined) cell.max = Math.max(cell.max, row.max);
    if (row.hist) cell.hist = mergeHistograms(cell.hist, row.hist);
  }
  return [...cells.values()].map((cell) => ({
    ...cell,
    min: cell.min === Infinity ? null : cell.min,
    max: cell.max === -Infinity ? null : cell.max,
  }));
}

/**
 * ISO cutoff for retention pruning (`nowMs - days`).
 *
 * @param {{ days: number, nowMs?: number }} options
 * @returns {string}
 */
export function pruneCutoff({ days, nowMs = Date.now() }) {
  return new Date(nowMs - days * 86400 * 1000).toISOString();
}

/**
 * Real 24 h counts for the Overview screen: requests, errors (4xx+5xx across
 * protocols), and p90 latency. Returns zeros — never sample data — when empty.
 */
export async function getOverviewCounts(db, actor, { projectId, hours = 24, nowMs = Date.now() }) {
  await requireMonitoringView(db, actor, { projectId });
  const to = new Date(nowMs).toISOString();
  const from = new Date(nowMs - hours * 3600 * 1000).toISOString();
  const rows = (await fetchOverviewRows(db, { projectId, from, to }))
    .filter((row) => (row.project_id ?? row.projectId ?? projectId) === projectId);
  const isCount = (name) => ["Count", "ConnectCount", "MessageCount"].includes(name);
  const isError = (name) => ["4XXError", "4xx", "5XXError", "5xx", "ClientError", "ExecutionError"].includes(name);
  let requests = 0;
  let errors = 0;
  let latencyHist = new Array(HISTOGRAM_BUCKETS).fill(0);
  for (const row of rows) {
    if (isCount(row.metric)) requests += row.count ?? 0;
    if (isError(row.metric)) errors += row.count ?? 0;
    if (row.metric === "Latency" && row.hist) latencyHist = mergeHistograms(latencyHist, row.hist);
  }
  const { percentileFromHistogram } = await import("../gateway/core/observe/metrics.mjs");
  return { requests, errors, p90LatencyMs: percentileFromHistogram(latencyHist, 90) };
}

/**
 * Overview alias expected by `GET /metrics?view=overview`.
 */
export const queryOverviewCounts = getOverviewCounts;

const DAY_MS = 86400 * 1000;
export const DASHBOARD_MAX_DAYS = 45;

/** Metric families the dashboard folds the protocol-specific names into. */
const DASHBOARD_FAMILIES = {
  requests: ["Count", "ConnectCount", "MessageCount"],
  errors4xx: ["4XXError", "4xx", "ClientError"],
  errors5xx: ["5XXError", "5xx", "ExecutionError"],
  throttled: ["ThrottleCount", "QuotaRejectCount"],
  cacheHits: ["CacheHitCount"],
  cacheMisses: ["CacheMissCount"],
  latency: ["Latency"],
};

function dashboardTotals() {
  return {
    requests: 0, errors4xx: 0, errors5xx: 0, throttled: 0, cacheHits: 0, cacheMisses: 0,
    hist: new Array(HISTOGRAM_BUCKETS).fill(0),
  };
}

function dashboardDaily(days, fromMs) {
  return Array.from({ length: days }, (_, index) => ({
    day: new Date(fromMs + index * DAY_MS).toISOString(), requests: 0, errors: 0, throttled: 0,
  }));
}

function addToTotals(totals, family, row) {
  if (family === "latency") {
    if (row.hist) totals.hist = mergeHistograms(totals.hist, row.hist);
    return;
  }
  totals[family] += row.count ?? 0;
}

function addToDaily(daily, family, row, index) {
  const cell = daily[index];
  if (!cell) return;
  const count = row.count ?? 0;
  if (family === "requests") cell.requests += count;
  else if (family === "errors4xx" || family === "errors5xx") cell.errors += count;
  else if (family === "throttled") cell.throttled += count;
}

function finishTotals({ hist, ...counts }) {
  return { ...counts, p90LatencyMs: percentileFromHistogram(hist, 90) };
}

/**
 * Project dashboard for the Overview screen: totals for the current window
 * (the last `days` UTC days, today included) and the window before it, the
 * current window as a daily series, and a per-API breakdown. Protocol
 * variants fold into one family (e.g. REST `4XXError`, HTTP `4xx`, WebSocket
 * `ClientError`). Real rows only; an idle project returns zeros.
 *
 * @param {object} db - Control db.
 * @param {object} actor
 * @param {{ projectId: string, days?: number, nowMs?: number }} options
 */
export async function getDashboard(db, actor, { projectId, days = 14, nowMs = Date.now() }) {
  await requireMonitoringView(db, actor, { projectId });
  const span = Number(days);
  if (!Number.isInteger(span) || span < 1 || span > DASHBOARD_MAX_DAYS) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.days: must be an integer from 1 to ${DASHBOARD_MAX_DAYS}`);
  }
  const fromMs = Math.floor(nowMs / DAY_MS) * DAY_MS - (span - 1) * DAY_MS;
  const previousFromMs = fromMs - span * DAY_MS;
  const range = { projectId, from: new Date(previousFromMs).toISOString(), to: new Date(nowMs).toISOString() };

  const families = new Map(Object.entries(DASHBOARD_FAMILIES).flatMap(([family, metrics]) => metrics.map((metric) => [metric, family])));
  const batches = await Promise.all([...families.keys()].map(async (metric) => {
    const [hours, minutes] = await Promise.all([
      fetchHourRows(db, { ...range, metric }),
      fetchMinuteRows(db, { ...range, metric }),
    ]);
    return [...hours, ...minutes].map((row) => ({ ...row, metric }));
  }));

  const current = dashboardTotals();
  const previous = dashboardTotals();
  const daily = dashboardDaily(span, fromMs);
  const apis = new Map();
  for (const row of batches.flat()) {
    const ts = new Date(row.minute ?? row.hour ?? row.ts).getTime();
    if (!Number.isFinite(ts) || ts < previousFromMs || ts > nowMs) continue;
    const family = families.get(row.metric);
    if (ts < fromMs) {
      addToTotals(previous, family, row);
      continue;
    }
    const index = Math.floor((ts - fromMs) / DAY_MS);
    addToTotals(current, family, row);
    addToDaily(daily, family, row, index);
    const apiId = String(row.api_id ?? row.apiId ?? "");
    if (!apiId) continue;
    let entry = apis.get(apiId);
    if (!entry) {
      entry = { totals: dashboardTotals(), daily: dashboardDaily(span, fromMs) };
      apis.set(apiId, entry);
    }
    addToTotals(entry.totals, family, row);
    addToDaily(entry.daily, family, row, index);
  }

  return {
    days: span,
    from: new Date(fromMs).toISOString(),
    to: range.to,
    current: finishTotals(current),
    previous: finishTotals(previous),
    daily,
    apis: [...apis.entries()]
      .map(([apiId, entry]) => ({ apiId, ...finishTotals(entry.totals), daily: entry.daily }))
      .sort((a, b) => b.requests - a.requests),
  };
}

/**
 * Merges two per-minute cells (Postgres upsert path + tests).
 *
 * @param {{ sum?: number, count?: number, min?: number|null, max?: number|null, hist?: Array<number> }} a
 * @param {{ sum?: number, count?: number, min?: number|null, max?: number|null, hist?: Array<number> }} b
 * @returns {{ sum: number, count: number, min: number|null, max: number|null, hist: Array<number> }}
 */
export function mergeMinuteRow(a = {}, b = {}) {
  const minCandidates = [a.min, b.min].filter((value) => value !== null && value !== undefined);
  const maxCandidates = [a.max, b.max].filter((value) => value !== null && value !== undefined);
  return {
    sum: (a.sum ?? 0) + (b.sum ?? 0),
    count: (a.count ?? 0) + (b.count ?? 0),
    min: minCandidates.length > 0 ? Math.min(...minCandidates) : null,
    max: maxCandidates.length > 0 ? Math.max(...maxCandidates) : null,
    hist: mergeHistograms(a.hist ?? new Array(HISTOGRAM_BUCKETS).fill(0), b.hist ?? new Array(HISTOGRAM_BUCKETS).fill(0)),
  };
}

/**
 * Rolls one hour of minute rows into a single `metrics_hour` row.
 * Returns `null` when there is nothing to roll (tests + job guard).
 *
 * @param {Array<object>} rows - Minute rows sharing project/api/stage/dims/metric.
 * @param {string} hourIso - Hour bucket ISO (any ms within the hour accepted).
 * @returns {object|null}
 */
export function rollupToHour(rows, hourIso) {
  if (!rows || rows.length === 0) return null;
  const hour = new Date(hourIso);
  hour.setUTCMinutes(0, 0, 0);
  const first = rows[0];
  let merged = {
    sum: 0,
    count: 0,
    min: null,
    max: null,
    hist: new Array(HISTOGRAM_BUCKETS).fill(0),
  };
  for (const row of rows) {
    merged = mergeMinuteRow(merged, {
      sum: row.sum ?? 0,
      count: row.count ?? 0,
      min: row.min ?? null,
      max: row.max ?? null,
      hist: row.hist ?? new Array(HISTOGRAM_BUCKETS).fill(0),
    });
  }
  return {
    project_id: first.project_id,
    api_id: first.api_id,
    stage: first.stage,
    dims_hash: first.dims_hash,
    dims: first.dims ?? {},
    hour: hour.toISOString(),
    metric: first.metric,
    ...merged,
  };
}
