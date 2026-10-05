/**
 * Access/execution/trace log query services (S10 §3–§5) + audit CSV export (§8).
 *
 * - Access-log search (time, stage, status class, route, request id, source
 *   IP) and request detail combining the access line, execution log and trace
 *   waterfall. Data-trace bodies are stripped without `pods.logs.data`.
 * - `partitionsToDrop` is the pure retention helper (daily-partitioned
 *   storage; the job drops partitions older than `log_retention_days`).
 * - `exportAuditCsv` renders filtered audit rows (§8) with the S02 redaction
 *   already applied at write time.
 *
 * @module lib/control/logs
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { requireMonitoringView } from "./metrics.mjs";

export const LOG_LIMIT_DEFAULT = 25;
export const LOG_LIMIT_MAX = 100;

/**
 * Requires data-trace visibility (request/response bodies).
 */
export async function requireLogsData(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.logs.data", { projectId });
}

function parseLimit(limit) {
  return Math.min(Math.max(Number(limit) || LOG_LIMIT_DEFAULT, 1), LOG_LIMIT_MAX);
}

function cleanAccessFilters(filters = {}) {
  const clean = {};
  if (filters.apiId) clean.apiId = String(filters.apiId);
  if (filters.stage) clean.stage = String(filters.stage);
  if (filters.statusClass) {
    if (!/^[245]xx$/.test(filters.statusClass)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.statusClass: must be one of 2xx, 4xx, 5xx");
    }
    clean.statusClass = filters.statusClass;
  }
  if (filters.route) clean.route = String(filters.route);
  if (filters.requestId) clean.requestId = String(filters.requestId);
  if (filters.sourceIp) clean.sourceIp = String(filters.sourceIp);
  if (filters.from) clean.from = String(filters.from);
  if (filters.to) clean.to = String(filters.to);
  return clean;
}

/** Lists access-log lines (newest first). */
export async function listAccessLogs(db, actor, { projectId, filters = {}, limit = 25, cursor = null }) {
  await requireMonitoringView(db, actor, { projectId });
  return db.listAccessLogs({ projectId, filters: cleanAccessFilters(filters), limit: parseLimit(limit), cursor });
}

/** Lists execution-log rows (newest first); strips data-trace bodies without permission. */
export async function listExecutionLogs(db, actor, { projectId, filters = {}, limit = 25, cursor = null }) {
  await requireMonitoringView(db, actor, { projectId });
  const page = await db.listExecutionLogs({ projectId, filters, limit: parseLimit(limit), cursor });
  let canSeeData = true;
  try {
    await requireLogsData(db, actor, { projectId });
  } catch {
    canSeeData = false;
  }
  if (canSeeData) return page;
  return {
    ...page,
    items: (page.items ?? []).map((row) => ({ ...row, lines: stripDataTrace(row.lines ?? []) })),
  };
}

/**
 * Replaces data-trace body lines with a placeholder (readers without
 * `pods.logs.data`). Non-body vocabulary lines are untouched.
 *
 * @param {Array<{ level: string, message: string }>} lines
 */
export function stripDataTrace(lines) {
  return (lines ?? []).map((line) => {
    if (line?.dataTrace === true) {
      return { ...line, message: "[data trace hidden: request pods.logs.data to view bodies]" };
    }
    return line;
  });
}

/**
 * Request detail drawer: access line + execution log (if any) + trace
 * waterfall (if sampled). Bodies are included only with `pods.logs.data`.
 */
export async function getRequestDetail(db, actor, { projectId, requestId }) {
  await requireMonitoringView(db, actor, { projectId });
  if (!requestId) throw new HttpError(422, "invalid_input", "Invalid request: $.requestId is required");
  let canSeeData = true;
  try {
    await requireLogsData(db, actor, { projectId });
  } catch {
    canSeeData = false;
  }
  const [accessPage, execPage, spans] = await Promise.all([
    db.listAccessLogs({ projectId, filters: { requestId }, limit: 1 }),
    typeof db.listExecutionLogs === "function"
      ? db.listExecutionLogs({ projectId, filters: { requestId }, limit: 1 })
      : { items: [] },
    typeof db.listTraceSpans === "function" ? db.listTraceSpans({ projectId, requestId }) : [],
  ]);
  const execution = execPage.items?.[0] ?? null;
  return {
    access: accessPage.items?.[0] ?? null,
    execution: execution && !canSeeData
      ? { ...execution, lines: stripDataTrace(execution.lines ?? []) }
      : execution,
    spans: spans ?? [],
    dataTraceHidden: Boolean(execution?.data_trace) && !canSeeData,
  };
}

/**
 * Pure retention helper: which daily partitions (`<table>_YYYY_MM_DD`) are
 * strictly older than the cutoff. The job drops exactly these.
 *
 * @param {{ partitions: Array<string>, tableFor?: (name: string) => string,
 *   todayUtc?: string, retentionDays?: number }} options
 * @returns {Array<string>}
 */
export function partitionsToDrop({ partitions = [], tableFor = (name) => name, todayUtc = null, retentionDays = 30 }) {
  const today = todayUtc ?? new Date().toISOString().slice(0, 10);
  const cutoff = new Date(`${today}T00:00:00.000Z`).getTime() - retentionDays * 86400 * 1000;
  void tableFor;
  return partitions.filter((name) => {
    const match = /(\d{4})_(\d{2})_(\d{2})$/.exec(String(name));
    if (!match) return false;
    const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return day < cutoff;
  });
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Renders audit rows as CSV (§8 export). Diffs are already redacted by S02.
 *
 * @param {Array<object>} rows - Audit event rows (snake_case columns).
 * @returns {string}
 */
export function exportAuditCsv(rows) {
  const header = "id,created_at,actor_id,action,resource_type,resource_id,api_id,before,after";
  const lines = (rows ?? []).map((row) => [
    row.id, row.created_at, row.actor_id, row.action, row.resource_type,
    row.resource_id, row.api_id,
    row.before == null ? "" : JSON.stringify(row.before),
    row.after == null ? "" : JSON.stringify(row.after),
  ].map(csvCell).join(","));
  return [header, ...lines].join("\n");
}
