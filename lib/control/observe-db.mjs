/**
 * Supabase implementations of the S10 db port (metrics, logs, traces,
 * alarms, channels, sinks, sampling rules, retention).
 *
 * Route files compose these onto the S02 control db via the `route()`
 * `deps.createControlDb` hook (same pattern as S06 `processing-db.mjs`),
 * so the S02-owned `supabase-db.mjs` stays untouched:
 *
 * ```js
 * import { createControlDb } from "@/lib/control/supabase-db.mjs";
 * import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
 * const deps = { createControlDb: (client, opts) => withObservabilityTables(createControlDb(client, opts), client) };
 * ```
 *
 * @module lib/control/observe-db
 */

import { HttpError } from "./errors.mjs";

function pods(client) {
  return client.schema("pods");
}

function sinceBefore(query, from, to, column) {
  let next = query;
  if (from) next = next.gte(column, from);
  if (to) next = next.lte(column, to);
  return next;
}

/**
 * Mixes S10 table helpers into a control-db object.
 *
 * @param {object} db - The S02 control db.
 * @param {object} client - The caller's Supabase client (RLS).
 * @returns {object} The same `db` with S10 methods attached.
 */
export function withObservabilityTables(db, client) {
  // S10 §8: the S02 `listAudit` drops action/apiId filters; wrap it so the
  // audit-trail UI can filter by action and API (same RLS, same pagination).
  const baseListAudit = db.listAudit?.bind(db);
  async function listAuditExtended({ projectId, filters = {}, limit = 25, cursor = null }) {
    if (!baseListAudit) return { items: [], nextCursor: null };
    const { action = null, apiId = null, ...rest } = filters;
    const page = await baseListAudit({ projectId, filters: rest, limit: limit + (action || apiId ? 100 : 0), cursor });
    const items = (page.items ?? []).filter((row) =>
      (!action || row.action === action) && (!apiId || String(row.api_id ?? "") === String(apiId)));
    return { items: items.slice(0, limit), nextCursor: items.length > limit ? page.nextCursor : page.nextCursor };
  }

  return Object.assign(db, {
    listAudit: listAuditExtended,
    // --- metrics ---
    async upsertMinuteRows(rows) {
      for (const row of rows ?? []) {
        const { data: existing } = await pods(client).from("metrics_minute")
          .select("sum, count, min, max, hist")
          .eq("project_id", row.project_id)
          .eq("api_id", row.api_id)
          .eq("stage", row.stage)
          .eq("dims_hash", row.dims_hash)
          .eq("minute", row.minute)
          .eq("metric", row.metric)
          .maybeSingle();
        if (existing) {
          const merged = {
            sum: (existing.sum ?? 0) + (row.sum ?? 0),
            count: (existing.count ?? 0) + (row.count ?? 0),
            min: existing.min == null ? (row.min ?? null) : (row.min == null ? existing.min : Math.min(existing.min, row.min)),
            max: existing.max == null ? (row.max ?? null) : (row.max == null ? existing.max : Math.max(existing.max, row.max)),
          };
          const { error } = await pods(client).from("metrics_minute").update(merged)
            .eq("project_id", row.project_id).eq("api_id", row.api_id).eq("stage", row.stage)
            .eq("dims_hash", row.dims_hash).eq("minute", row.minute).eq("metric", row.metric);
          if (error) throw new HttpError(500, "internal_error", error.message);
          // Histograms merge element-wise; do it in a second update to stay portable.
          const base = existing.hist ?? [];
          const incoming = row.hist ?? [];
          const size = Math.max(base.length, incoming.length);
          const hist = Array.from({ length: size }, (_, index) => (base[index] ?? 0) + (incoming[index] ?? 0));
          const { error: histError } = await pods(client).from("metrics_minute").update({ hist })
            .eq("project_id", row.project_id).eq("api_id", row.api_id).eq("stage", row.stage)
            .eq("dims_hash", row.dims_hash).eq("minute", row.minute).eq("metric", row.metric);
          if (histError) throw new HttpError(500, "internal_error", histError.message);
        } else {
          const { error } = await pods(client).from("metrics_minute").insert(row);
          if (error) throw new HttpError(500, "internal_error", error.message);
        }
      }
    },

    async queryMinuteRows({ projectId, apiId = null, stage = null, dims = null, metric, from = null, to = null }) {
      let query = pods(client).from("metrics_minute")
        .select("minute, sum, count, min, max, hist, dims")
        .eq("project_id", projectId).eq("metric", metric)
        .order("minute", { ascending: true });
      if (apiId) query = query.eq("api_id", apiId);
      if (stage) query = query.eq("stage", stage);
      query = sinceBefore(query, from, to, "minute");
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return filterDims(data ?? [], dims);
    },

    async queryHourRows({ projectId, apiId = null, stage = null, dims = null, metric, from = null, to = null }) {
      let query = pods(client).from("metrics_hour")
        .select("hour, sum, count, min, max, hist, dims")
        .eq("project_id", projectId).eq("metric", metric)
        .order("hour", { ascending: true });
      if (apiId) query = query.eq("api_id", apiId);
      if (stage) query = query.eq("stage", stage);
      query = sinceBefore(query, from, to, "hour");
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return filterDims(data ?? [], dims).map((row) => ({ ...row, minute: row.hour }));
    },

    async insertHourRows(rows) {
      if (!rows || rows.length === 0) return;
      const { error } = await pods(client).from("metrics_hour").insert(rows);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async deleteMinuteRowsBefore(cutoff) {
      const { error } = await pods(client).from("metrics_minute").delete().lt("minute", cutoff);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async deleteHourRowsBefore(cutoff) {
      const { error } = await pods(client).from("metrics_hour").delete().lt("hour", cutoff);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    // --- access / execution logs ---
    async insertAccessLogs(rows) {
      if (!rows || rows.length === 0) return;
      const { error } = await pods(client).from("access_logs").insert(rows);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async queryAccessLogs({ projectId, apiId = null, stage = null, statusClass = null, route = null, requestId = null, sourceIp = null, from = null, to = null, limit = 25, cursor = null }) {
      let query = pods(client).from("access_logs")
        .select("project_id, api_id, stage, ts, request_id, status, route, source_ip, line, fields")
        .eq("project_id", projectId)
        .order("ts", { ascending: false })
        .limit(limit + 1);
      if (apiId) query = query.eq("api_id", apiId);
      if (stage) query = query.eq("stage", stage);
      if (requestId) query = query.eq("request_id", requestId);
      if (sourceIp) query = query.eq("source_ip", sourceIp);
      if (route) query = query.eq("route", route);
      if (statusClass === "2xx") query = query.gte("status", 200).lt("status", 300);
      if (statusClass === "4xx") query = query.gte("status", 400).lt("status", 500);
      if (statusClass === "5xx") query = query.gte("status", 500).lt("status", 600);
      query = sinceBefore(query, from, to, "ts");
      if (cursor) query = query.lt("ts", cursor);
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      const items = (data ?? []).slice(0, limit);
      return {
        items,
        nextCursor: (data ?? []).length > limit ? items[items.length - 1].ts : null,
      };
    },

    async insertExecutionLogs(rows) {
      if (!rows || rows.length === 0) return;
      const { error } = await pods(client).from("execution_logs").insert(rows);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async queryExecutionLogs({ projectId, requestId }) {
      const { data, error } = await pods(client).from("execution_logs")
        .select("*").eq("project_id", projectId).eq("request_id", requestId)
        .order("ts", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return { items: data ?? [], nextCursor: null };
    },

    async deleteAccessLogsBefore(cutoff, projectId = null) {
      let query = pods(client).from("access_logs").delete().lt("ts", cutoff);
      if (projectId) query = query.eq("project_id", projectId);
      const { error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async deleteExecutionLogsBefore(cutoff, projectId = null) {
      let query = pods(client).from("execution_logs").delete().lt("ts", cutoff);
      if (projectId) query = query.eq("project_id", projectId);
      const { error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    // --- traces ---
    async insertSpans(rows) {
      if (!rows || rows.length === 0) return;
      const { error } = await pods(client).from("trace_spans").insert(rows.map((span) => ({
        project_id: span.projectId ?? span.project_id,
        api_id: span.apiId ?? span.api_id,
        stage: span.stage ?? "",
        trace_id: span.traceId ?? span.trace_id,
        span_id: span.spanId ?? span.span_id,
        request_id: span.requestId ?? span.request_id ?? null,
        ts: span.ts ?? new Date().toISOString(),
        name: span.name ?? "gateway",
        kind: span.kind ?? "server",
        duration_ms: span.durationMs ?? span.duration_ms ?? null,
        attributes: span.attributes ?? {},
      })));
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async querySpansByRequest({ projectId, requestId }) {
      const { data, error } = await pods(client).from("trace_spans")
        .select("*").eq("project_id", projectId).eq("request_id", requestId)
        .order("ts", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return { items: data ?? [], nextCursor: null };
    },

    async querySpansByTrace({ projectId, traceId }) {
      const { data, error } = await pods(client).from("trace_spans")
        .select("*").eq("project_id", projectId).eq("trace_id", traceId)
        .order("ts", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return { items: data ?? [], nextCursor: null };
    },

    async deleteSpansBefore(cutoff) {
      const { error } = await pods(client).from("trace_spans").delete().lt("ts", cutoff);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    // --- alarms ---
    async listAlarms({ projectId }) {
      const { data, error } = await pods(client).from("alarms").select("*")
        .eq("project_id", projectId).order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async listEnabledAlarms() {
      const { data, error } = await pods(client).from("alarms").select("*").eq("enabled", true);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getAlarm({ projectId, id }) {
      const { data, error } = await pods(client).from("alarms").select("*")
        .eq("project_id", projectId).eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async getAlarmByName({ projectId, name }) {
      const { data, error } = await pods(client).from("alarms").select("*")
        .eq("project_id", projectId).eq("name", name).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertAlarm(row) {
      const { data, error } = await pods(client).from("alarms").insert(row).select("*").single();
      if (error) {
        if (error.code === "23505") throw new HttpError(409, "conflict", `An alarm named "${row.name}" already exists.`);
        throw new HttpError(500, "internal_error", error.message);
      }
      return data;
    },

    async updateAlarm({ id, patch }) {
      const { data, error } = await pods(client).from("alarms").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async updateAlarmState({ id, state, reason, stateUpdatedAt }) {
      const { error } = await pods(client).from("alarms")
        .update({ state, state_reason: reason, state_updated_at: stateUpdatedAt }).eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async deleteAlarm({ id }) {
      const { error } = await pods(client).from("alarms").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async listAlarmHistory({ alarmId }) {
      const { data, error } = await pods(client).from("alarm_history").select("*")
        .eq("alarm_id", alarmId).order("created_at", { ascending: false });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async insertAlarmHistory(row) {
      const { error } = await pods(client).from("alarm_history").insert(row);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    // --- channels ---
    async listNotificationChannels({ projectId }) {
      const { data, error } = await pods(client).from("notification_channels").select("*")
        .eq("project_id", projectId).order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getNotificationChannel({ id }) {
      const { data, error } = await pods(client).from("notification_channels").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertNotificationChannel(row) {
      const { data, error } = await pods(client).from("notification_channels").insert(row).select("*").single();
      if (error) {
        if (error.code === "23505") throw new HttpError(409, "conflict", `A channel named "${row.name}" already exists.`);
        throw new HttpError(500, "internal_error", error.message);
      }
      return data;
    },

    async deleteNotificationChannel({ id }) {
      const { error } = await pods(client).from("notification_channels").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    // --- sinks ---
    async listLogSinks({ projectId }) {
      const { data, error } = await pods(client).from("log_sinks").select("*")
        .eq("project_id", projectId).order("created_at", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getLogSink({ projectId, id }) {
      const { data, error } = await pods(client).from("log_sinks").select("*")
        .eq("project_id", projectId).eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async getLogSinkByName({ projectId, name }) {
      const { data, error } = await pods(client).from("log_sinks").select("*")
        .eq("project_id", projectId).eq("name", name).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async insertLogSink(row) {
      const { data, error } = await pods(client).from("log_sinks").insert(row).select("*").single();
      if (error) {
        if (error.code === "23505") throw new HttpError(409, "conflict", `A sink named "${row.name}" already exists.`);
        throw new HttpError(500, "internal_error", error.message);
      }
      return data;
    },

    async updateLogSink({ id, patch }) {
      const { data, error } = await pods(client).from("log_sinks").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteLogSink({ id }) {
      const { error } = await pods(client).from("log_sinks").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    // --- retention / rollup job port ---
    async listMinutesBefore(before, limit = 5000) {
      const { data, error } = await pods(client).from("metrics_minute")
        .select("*").lt("minute", before).order("minute", { ascending: true }).limit(limit);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async listProjectSettings() {
      const { data, error } = await pods(client).from("project_settings")
        .select("project_id, log_retention_days");
      if (error) throw new HttpError(500, "internal_error", error.message);
      return (data ?? []).map((row) => ({ ...row, audit_retention_days: null }));
    },

    async listLogProjectIds() {
      const { data, error } = await pods(client).from("access_logs").select("project_id").limit(1000);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return [...new Set((data ?? []).map((row) => row.project_id))];
    },

    async listLogPartitions() {
      return [];
    },

    async dropTable(name) {
      const { error } = await pods(client).rpc("exec", { sql: `drop table if exists ${name}` }).catch(() => ({ error: null }));
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async deleteAuditBefore(cutoff, projectId = null) {
      let query = pods(client).from("audit_events").delete().lt("created_at", cutoff);
      if (projectId) query = query.eq("project_id", projectId);
      const { error, count } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return count ?? 0;
    },
  });
}

/**
 * Filters rows by an exact dims match (null/empty dims = all).
 *
 * @param {Array<object>} rows
 * @param {Record<string,string>|null} dims
 */
function filterDims(rows, dims) {
  if (!dims || Object.keys(dims).length === 0) return rows;
  return rows.filter((row) => Object.entries(dims).every(([key, value]) => String(row.dims?.[key] ?? "") === String(value)));
}
