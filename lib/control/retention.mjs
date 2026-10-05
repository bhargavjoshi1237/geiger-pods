/**
 * Retention + rollup job logic (S10 §2–§3).
 *
 * - Minute rows live 15 days; a job rolls hours older than the current hour
 *   up to `pods.metrics_hour` (kept 455 days).
 * - Access/execution log retention is `project_settings.log_retention_days`
 *   (drops daily partitions / rows older than the cutoff); trace spans live
 *   7 days; audit rows live forever unless `auditRetentionDays` (≥ 90) is set.
 *
 * Pure helpers (partition naming, cutoffs) are tested without a database.
 *
 * @module lib/control/retention
 */

import { MINUTE_RETENTION_DAYS, HOUR_RETENTION_DAYS, rollupToHour } from "./metrics.mjs";

export const TRACE_RETENTION_DAYS = 7;
export const DEFAULT_LOG_RETENTION_DAYS = 30;

function pad2(value) {
  return String(value).padStart(2, "0");
}

/**
 * Daily partition name for a log table: `<table>_yyyy_mm_dd` (UTC).
 *
 * @param {string} table - Base table (`access_logs` / `execution_logs`).
 * @param {Date} date
 * @returns {string}
 */
export function partitionNameFor(table, date) {
  return `${table}_${date.getUTCFullYear()}_${pad2(date.getUTCMonth() + 1)}_${pad2(date.getUTCDate())}`;
}

/**
 * Partition names (from `existing`) older than `before` (day granularity).
 *
 * @param {string} table - Base table.
 * @param {Date} before - Drop partitions strictly before this day.
 * @param {Array<string>} existing - Known partition table names.
 * @returns {Array<string>}
 */
export function partitionsOlderThan(table, before, existing) {
  const prefix = `${table}_`;
  const cutoff = Date.UTC(before.getUTCFullYear(), before.getUTCMonth(), before.getUTCDate());
  return (existing ?? []).filter((name) => {
    if (!name.startsWith(prefix)) return false;
    const match = /^(\d{4})_(\d{2})_(\d{2})$/.exec(name.slice(prefix.length));
    if (!match) return false;
    const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return day < cutoff;
  });
}

/**
 * Rolls minute rows older than the current hour into `metrics_hour`.
 *
 * @param {object} db - Control db (S10 port + `listMinutesBefore(before, limit)`).
 * @param {{ now?: Date }} [options={}]
 * @returns {Promise<{ hours: number, minutes: number }>}
 */
export async function runRollup(db, { now = new Date() } = {}) {
  const hourStart = new Date(now);
  hourStart.setUTCMinutes(0, 0, 0);
  const before = hourStart.toISOString();
  const minutes = await db.listMinutesBefore(before, 5000);
  const groups = new Map();
  for (const row of minutes) {
    const hour = new Date(row.minute);
    hour.setUTCMinutes(0, 0, 0);
    const key = JSON.stringify([row.project_id, row.api_id, row.stage, row.dims_hash, hour.toISOString(), row.metric]);
    if (!groups.has(key)) groups.set(key, { hour: hour.toISOString(), rows: [] });
    groups.get(key).rows.push(row);
  }
  const hours = [];
  for (const { hour, rows } of groups.values()) {
    const rolled = rollupToHour(rows, hour);
    if (rolled) hours.push(rolled);
  }
  if (hours.length > 0) await db.insertHourRows(hours);
  if (minutes.length > 0) await db.deleteMinuteRowsBefore(before);
  return { hours: hours.length, minutes: minutes.length };
}

/**
 * Drops expired telemetry.
 *
 * @param {object} db - Control db (S10 port + `listProjectSettings()`,
 *   `listLogPartitions()`, `dropTable(name)`, `deleteAuditBefore(cutoff)`).
 * @param {{ now?: Date }} [options={}]
 * @returns {Promise<Record<string, number>>} Deleted counts per area.
 */
export async function runRetention(db, { now = new Date() } = {}) {
  const summary = { metricsMinute: 0, metricsHour: 0, accessLogs: 0, executionLogs: 0, spans: 0, audit: 0, partitions: 0 };
  const add = async (key, work) => {
    const value = await work.catch(() => 0);
    summary[key] += Number(value) || 0;
  };
  const minuteCutoff = new Date(now.getTime() - MINUTE_RETENTION_DAYS * 86400 * 1000).toISOString();
  const hourCutoff = new Date(now.getTime() - HOUR_RETENTION_DAYS * 86400 * 1000).toISOString();
  const spanCutoff = new Date(now.getTime() - TRACE_RETENTION_DAYS * 86400 * 1000).toISOString();
  await add("metricsMinute", db.deleteMinuteRowsBefore(minuteCutoff));
  await add("metricsHour", db.deleteHourRowsBefore(hourCutoff));
  await add("spans", db.deleteSpansBefore(spanCutoff));

  const settings = await db.listProjectSettings().catch(() => []);
  const perProject = new Map(settings.map((row) => [row.project_id, row]));
  const projectIds = await db.listLogProjectIds().catch(() => [...perProject.keys()]);
  for (const projectId of projectIds) {
    const retentionDays = perProject.get(projectId)?.log_retention_days ?? DEFAULT_LOG_RETENTION_DAYS;
    const cutoff = new Date(now.getTime() - retentionDays * 86400 * 1000).toISOString();
    await add("accessLogs", db.deleteAccessLogsBefore(cutoff, projectId).catch(() => 0));
    await add("executionLogs", db.deleteExecutionLogsBefore(cutoff, projectId).catch(() => 0));
    const retention = perProject.get(projectId)?.audit_retention_days ?? null;
    if (retention !== null && retention !== undefined) {
      const auditCutoff = new Date(now.getTime() - retention * 86400 * 1000).toISOString();
      await add("audit", db.deleteAuditBefore(auditCutoff, projectId).catch(() => 0));
    }
  }
  // Partitioned production tables: drop whole day partitions when present.
  const existing = await db.listLogPartitions().catch(() => []);
  for (const table of ["access_logs", "execution_logs"]) {
    const oldestKept = new Date(now.getTime() - DEFAULT_LOG_RETENTION_DAYS * 86400 * 1000);
    for (const name of partitionsOlderThan(table, oldestKept, existing)) {
      await db.dropTable(`pods.${name}`).catch(() => {});
      summary.partitions += 1;
    }
  }
  return summary;
}
