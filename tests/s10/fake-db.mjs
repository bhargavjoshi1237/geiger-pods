/**
 * In-memory fake of the S10 control db port (telemetry + alarms + sinks +
 * stages/apis refs for the logging settings). Mirrors the unique indexes the
 * Postgres migration enforces.
 */

import { randomUUID } from "node:crypto";

function stamp(seq) {
  return new Date(Date.UTC(2026, 9, 9, 0, 0, 0, seq % 60)).toISOString();
}

export function createFakeDb(options = {}) {
  const { roles = {} } = options;
  let seq = 0;
  const nextStamp = () => {
    seq += 1;
    return stamp(seq);
  };
  const apis = new Map();
  const stages = new Map();
  const minuteRows = [];
  const hourRows = [];
  const accessLogs = [];
  const executionLogs = [];
  const spans = [];
  const alarms = new Map();
  const alarmHistory = [];
  const channels = new Map();
  const sinks = new Map();
  const auditRows = [];
  const secrets = new Map();

  function matchDims(row, dims) {
    if (!dims || Object.keys(dims).length === 0) return true;
    return Object.entries(dims).every(([key, value]) => String(row.dims?.[key] ?? "") === String(value));
  }

  return {
    _maps: { apis, stages, alarms, channels, sinks },
    _rows: { minuteRows, hourRows, accessLogs, executionLogs, spans, alarmHistory, auditRows },

    async getInheritedRole({ userId }) {
      return roles[userId] ?? null;
    },
    async listRoleBindings() {
      return { roles: [], grants: [] };
    },
    async insertAudit(entry) {
      auditRows.push({ id: randomUUID(), created_at: nextStamp(), ...entry });
    },
    async listAudit({ projectId, filters = {}, limit = 25 }) {
      let items = auditRows.filter((row) => row.project_id === projectId);
      if (filters.resourceType) items = items.filter((row) => row.resource_type === filters.resourceType);
      if (filters.resourceId) items = items.filter((row) => row.resource_id === filters.resourceId);
      if (filters.actor) items = items.filter((row) => row.actor_id === filters.actor);
      if (filters.action) items = items.filter((row) => row.action === filters.action);
      if (filters.apiId) items = items.filter((row) => String(row.api_id ?? "") === String(filters.apiId));
      if (filters.from) items = items.filter((row) => row.created_at >= filters.from);
      if (filters.to) items = items.filter((row) => row.created_at <= filters.to);
      return { items: items.slice(-limit).reverse(), nextCursor: null };
    },

    // --- apis / stages refs ---
    async insertApi(row) {
      const full = { id: randomUUID(), version: 1, created_at: nextStamp(), ...row };
      apis.set(full.id, full);
      return { ...full };
    },
    async getApiByRef({ projectId, ref }) {
      for (const row of apis.values()) {
        if (row.project_id !== projectId) continue;
        if (row.id === ref || row.public_id === ref) return { ...row };
      }
      return null;
    },
    async insertStage(row) {
      const full = {
        id: randomUUID(), version: 1, created_at: nextStamp(), access_log: null,
        method_settings: {}, route_settings: {}, tracing_enabled: false, ...row,
      };
      stages.set(full.id, full);
      return { ...full };
    },
    async getStageByName({ apiId, name }) {
      for (const row of stages.values()) {
        if (row.api_id === apiId && row.name === name) return { ...row };
      }
      return null;
    },
    async updateStage({ id, patch }) {
      const row = stages.get(id);
      if (!row) throw new Error("Stage does not exist.");
      const next = { ...row, ...patch };
      stages.set(id, next);
      return { ...next };
    },

    // --- metrics ---
    async upsertMinuteRows(rows) {
      for (const row of rows ?? []) minuteRows.push({ ...row });
    },
    async queryMinuteRows({ projectId, apiId = null, stage = null, dims = null, metric, from = null, to = null }) {
      return minuteRows.filter((row) =>
        row.project_id === projectId && row.metric === metric &&
        (!apiId || row.api_id === apiId) && (!stage || row.stage === stage) &&
        (!from || row.minute >= from) && (!to || row.minute <= to) && matchDims(row, dims));
    },
    async queryHourRows({ projectId, apiId = null, stage = null, dims = null, metric, from = null, to = null }) {
      return hourRows.filter((row) =>
        row.project_id === projectId && row.metric === metric &&
        (!apiId || row.api_id === apiId) && (!stage || row.stage === stage) &&
        (!from || row.hour >= from) && (!to || row.hour <= to) && matchDims(row, dims))
        .map((row) => ({ ...row, minute: row.hour }));
    },
    async insertHourRows(rows) {
      for (const row of rows ?? []) hourRows.push({ ...row });
    },
    async listMinutesBefore(before, limit = 5000) {
      return minuteRows.filter((row) => row.minute < before).slice(0, limit).map((row) => ({ ...row }));
    },
    async deleteMinuteRowsBefore(cutoff) {
      const before = minuteRows.length;
      for (let index = minuteRows.length - 1; index >= 0; index -= 1) {
        if (minuteRows[index].minute < cutoff) minuteRows.splice(index, 1);
      }
      return before - minuteRows.length;
    },
    async deleteHourRowsBefore(cutoff) {
      const before = hourRows.length;
      for (let index = hourRows.length - 1; index >= 0; index -= 1) {
        if (hourRows[index].hour < cutoff) hourRows.splice(index, 1);
      }
      return before - hourRows.length;
    },

    // --- logs ---
    async insertAccessLogs(rows) {
      for (const row of rows ?? []) accessLogs.push({ ...row });
    },
    async queryAccessLogs({ projectId, apiId = null, stage = null, statusClass = null, route = null, requestId = null, sourceIp = null, from = null, to = null, limit = 25 }) {
      let items = accessLogs.filter((row) => row.project_id === projectId);
      if (apiId) items = items.filter((row) => row.api_id === apiId);
      if (stage) items = items.filter((row) => row.stage === stage);
      if (requestId) items = items.filter((row) => row.request_id === requestId);
      if (sourceIp) items = items.filter((row) => row.source_ip === sourceIp);
      if (route) items = items.filter((row) => row.route === route);
      if (statusClass === "4xx") items = items.filter((row) => row.status >= 400 && row.status < 500);
      if (statusClass === "5xx") items = items.filter((row) => row.status >= 500);
      if (statusClass === "2xx") items = items.filter((row) => row.status >= 200 && row.status < 300);
      if (from) items = items.filter((row) => row.ts >= from);
      if (to) items = items.filter((row) => row.ts <= to);
      return { items: items.slice(0, limit), nextCursor: null };
    },
    async insertExecutionLogs(rows) {
      for (const row of rows ?? []) executionLogs.push({ ...row });
    },
    async queryExecutionLogs({ projectId, requestId }) {
      return { items: executionLogs.filter((row) => row.project_id === projectId && row.request_id === requestId), nextCursor: null };
    },
    async deleteAccessLogsBefore(cutoff) {
      const before = accessLogs.length;
      for (let index = accessLogs.length - 1; index >= 0; index -= 1) {
        if (accessLogs[index].ts < cutoff) accessLogs.splice(index, 1);
      }
      return before - accessLogs.length;
    },
    async deleteExecutionLogsBefore(cutoff) {
      const before = executionLogs.length;
      for (let index = executionLogs.length - 1; index >= 0; index -= 1) {
        if (executionLogs[index].ts < cutoff) executionLogs.splice(index, 1);
      }
      return before - executionLogs.length;
    },

    // --- traces ---
    async insertSpans(rows) {
      for (const span of rows ?? []) spans.push({ ...span });
    },
    async querySpansByRequest({ projectId, requestId }) {
      const rid = (span) => span.requestId ?? span.request_id;
      return { items: spans.filter((span) => (span.projectId ?? span.project_id) === projectId && rid(span) === requestId), nextCursor: null };
    },
    async deleteSpansBefore(cutoff) {
      const before = spans.length;
      for (let index = spans.length - 1; index >= 0; index -= 1) {
        if ((spans[index].ts ?? "") < cutoff) spans.splice(index, 1);
      }
      return before - spans.length;
    },

    // --- alarms ---
    async listAlarms({ projectId }) {
      return [...alarms.values()].filter((row) => row.project_id === projectId).map((row) => ({ ...row }));
    },
    async listEnabledAlarms() {
      return [...alarms.values()].filter((row) => row.enabled !== false).map((row) => ({ ...row }));
    },
    async getAlarm({ projectId, id }) {
      const row = alarms.get(id);
      if (!row || (projectId && row.project_id !== projectId)) return null;
      return { ...row };
    },
    async getAlarmByName({ projectId, name }) {
      for (const row of alarms.values()) {
        if (row.project_id === projectId && row.name === name) return { ...row };
      }
      return null;
    },
    async insertAlarm(row) {
      for (const existing of alarms.values()) {
        if (existing.project_id === row.project_id && existing.name === row.name) {
          const error = new Error("conflict");
          error.code = "23505";
          throw error;
        }
      }
      const full = {
        id: randomUUID(), version: 1, created_at: nextStamp(), statistic: "Sum",
        period_sec: 300, evaluation_periods: 1, datapoints_to_alarm: null,
        comparison: ">", threshold: 0, treat_missing_data: "missing",
        actions: { ok: [], alarm: [], insufficientData: [] }, state: "INSUFFICIENT_DATA",
        state_reason: "No data yet.", state_updated_at: nextStamp(), enabled: true, ...row,
      };
      alarms.set(full.id, full);
      return { ...full };
    },
    async updateAlarm({ id, patch }) {
      const row = alarms.get(id);
      if (!row) throw new Error("Alarm does not exist.");
      const next = { ...row, ...patch };
      alarms.set(id, next);
      return { ...next };
    },
    async updateAlarmState({ id, state, reason, stateUpdatedAt }) {
      const row = alarms.get(id);
      if (!row) throw new Error("Alarm does not exist.");
      alarms.set(id, { ...row, state, state_reason: reason, state_updated_at: stateUpdatedAt });
    },
    async deleteAlarm({ id }) {
      alarms.delete(id);
    },
    async listAlarmHistory({ alarmId }) {
      return alarmHistory.filter((row) => row.alarm_id === alarmId).map((row) => ({ ...row }));
    },
    async insertAlarmHistory(row) {
      const full = { id: randomUUID(), created_at: nextStamp(), ...row };
      alarmHistory.push(full);
      return { ...full };
    },

    // --- channels ---
    async listNotificationChannels({ projectId }) {
      return [...channels.values()].filter((row) => row.project_id === projectId).map((row) => ({ ...row }));
    },
    async getNotificationChannel({ id }) {
      return channels.get(id) ? { ...channels.get(id) } : null;
    },
    async insertNotificationChannel(row) {
      const full = { id: randomUUID(), version: 1, created_at: nextStamp(), ...row };
      channels.set(full.id, full);
      return { ...full };
    },
    async deleteNotificationChannel({ id }) {
      channels.delete(id);
    },

    // --- sinks ---
    async listLogSinks({ projectId }) {
      return [...sinks.values()].filter((row) => row.project_id === projectId).map((row) => ({ ...row }));
    },
    async getLogSink({ projectId, id }) {
      const row = sinks.get(id);
      if (!row || (projectId && row.project_id !== projectId)) return null;
      return { ...row };
    },
    async getLogSinkByName({ projectId, name }) {
      for (const row of sinks.values()) {
        if (row.project_id === projectId && row.name === name) return { ...row };
      }
      return null;
    },
    async insertLogSink(row) {
      const full = { id: randomUUID(), version: 1, created_at: nextStamp(), status: "active", last_delivery_at: null, last_error: null, ...row };
      sinks.set(full.id, full);
      return { ...full };
    },
    async updateLogSink({ id, patch }) {
      const row = sinks.get(id);
      if (!row) throw new Error("Sink does not exist.");
      const next = { ...row, ...patch };
      sinks.set(id, next);
      return { ...next };
    },
    async deleteLogSink({ id }) {
      sinks.delete(id);
    },
    async resolveSecretRef(ref) {
      if (secrets.has(ref)) return secrets.get(ref);
      throw new Error("Unknown secret ref.");
    },
    seedSecret(ref, value) {
      secrets.set(ref, value);
    },

    // --- retention port ---
    async listProjectSettings() {
      return [{ project_id: "p1", log_retention_days: 30, audit_retention_days: null }];
    },
    async listLogProjectIds() {
      return [...new Set(accessLogs.map((row) => row.project_id))];
    },
    async listLogPartitions() {
      return [];
    },
    async dropTable() {},
    async deleteAuditBefore() {
      return 0;
    },
  };
}
