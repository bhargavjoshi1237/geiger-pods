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
  const clean = cleanAccessFilters(filters);
  const take = parseLimit(limit);
  if (typeof db.listAccessLogs === "function") {
    return db.listAccessLogs({ projectId, filters: clean, limit: take, cursor });
  }
  if (typeof db.queryAccessLogs === "function") {
    return db.queryAccessLogs({
      projectId,
      apiId: clean.apiId ?? null,
      stage: clean.stage ?? null,
      statusClass: clean.statusClass ?? null,
      route: clean.route ?? null,
      requestId: clean.requestId ?? null,
      sourceIp: clean.sourceIp ?? null,
      from: clean.from ?? null,
      to: clean.to ?? null,
      limit: take,
      cursor,
    });
  }
  return { items: [], nextCursor: null };
}

/** Lists execution-log rows (newest first); strips data-trace bodies without permission. */
export async function listExecutionLogs(db, actor, { projectId, filters = {}, limit = 25, cursor = null }) {
  await requireMonitoringView(db, actor, { projectId });
  const take = parseLimit(limit);
  let page;
  if (typeof db.listExecutionLogs === "function") {
    page = await db.listExecutionLogs({ projectId, filters, limit: take, cursor });
  } else if (typeof db.queryExecutionLogs === "function") {
    page = await db.queryExecutionLogs({ projectId, requestId: filters?.requestId ?? null });
  } else {
    page = { items: [], nextCursor: null };
  }
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
 * `pods.logs.data`). Body-transformation vocabulary lines are redacted even
 * when they are not flagged `dataTrace` (S10 §4 always-redact rule); other
 * vocabulary lines are untouched.
 *
 * @param {Array<{ level: string, message: string }>} lines
 */
export function stripDataTrace(lines) {
  return (lines ?? []).map((line) => {
    if (line?.dataTrace === true) {
      return { ...line, message: "[data trace hidden: request pods.logs.data to view bodies]" };
    }
    const message = typeof line?.message === "string" ? line.message : "";
    if (/body (before|after) transformations:/i.test(message)) {
      return { ...line, message: message.replace(/:.*$/s, ": [redacted]") };
    }
    return line;
  });
}

async function fetchAccessPage(db, { projectId, requestId }) {
  if (typeof db.listAccessLogs === "function") {
    return db.listAccessLogs({ projectId, filters: { requestId }, limit: 1 });
  }
  if (typeof db.queryAccessLogs === "function") {
    return db.queryAccessLogs({ projectId, requestId, limit: 1 });
  }
  return { items: [] };
}

async function fetchExecutionPage(db, { projectId, requestId }) {
  if (typeof db.listExecutionLogs === "function") {
    return db.listExecutionLogs({ projectId, filters: { requestId }, limit: 1 });
  }
  if (typeof db.queryExecutionLogs === "function") {
    return db.queryExecutionLogs({ projectId, requestId });
  }
  return { items: [] };
}

async function fetchSpans(db, { projectId, requestId }) {
  if (typeof db.listTraceSpans === "function") {
    return (await db.listTraceSpans({ projectId, requestId })) ?? [];
  }
  if (typeof db.querySpansByRequest === "function") {
    const page = await db.querySpansByRequest({ projectId, requestId });
    return page?.items ?? [];
  }
  return [];
}

/**
 * Request detail drawer: access line + execution log (if any) + trace
 * waterfall (if sampled). Bodies are included only with `pods.logs.data`.
 * Returns `{ access, execution[], spans, bodiesRedacted }` (the S10 test
 * contract); `dataTraceHidden` is kept as an alias for route compatibility.
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
    fetchAccessPage(db, { projectId, requestId }),
    fetchExecutionPage(db, { projectId, requestId }),
    fetchSpans(db, { projectId, requestId }),
  ]);
  const rows = (execPage.items ?? execPage ?? []);
  const items = (Array.isArray(rows) ? rows : []).map((row) => {
    if (canSeeData) return row;
    return { ...row, lines: stripDataTrace(row.lines ?? row.execution?.lines ?? []) };
  });
  const first = (execPage.items ?? [])[0] ?? (Array.isArray(execPage) ? execPage[0] : null) ?? null;
  return {
    access: accessPage.items?.[0] ?? null,
    execution: items,
    spans: spans ?? [],
    bodiesRedacted: !canSeeData,
    dataTraceHidden: Boolean(first?.data_trace) && !canSeeData,
  };
}

/**
 * Validates + writes stage logging/observability settings (Stage → Logs &
 * tracing sub-tab). Delegates validation to `stage-observability` so the
 * two surfaces stay consistent; returns the raw updated stage row
 * (`access_log`, `tracing_enabled`, …) as the S10 tests expect.
 */
export async function updateStageLogging(db, actor, { projectId, apiId, stageName, input, requestId = null }) {
  const { checkObservabilityInput } = await import("./stage-observability.mjs");
  const { resolveApi } = await import("./apis.mjs");
  const { audit } = await import("./audit.mjs");
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.stage.write", { projectId, apiId: api.id });
  const current = await db.getStageByName({ apiId: api.id, name: stageName });
  if (!current) throw new HttpError(404, "not_found", "Stage does not exist.");
  let patch;
  try {
    patch = await checkObservabilityInput(db, input ?? {});
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new HttpError(422, "invalid_input", error.message);
    }
    throw error;
  }
  if (Object.keys(patch ?? {}).length === 0) return current;
  const before = { access_log: current.access_log ?? null, tracing_enabled: current.tracing_enabled ?? false };
  const next = await db.updateStage({ id: current.id, patch: { ...patch, version: (current.version ?? 1) + 1 } });
  await audit(db, actor, {
    action: "stage.logging.update", resourceType: "stage", resourceId: current.id,
    projectId, apiId: api.id, before, after: { access_log: next.access_log ?? null, tracing_enabled: next.tracing_enabled ?? false }, requestId,
  }).catch(() => {});
  return next;
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
