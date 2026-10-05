/**
 * Supabase implementation of the S10 control db port (metrics, logs, traces,
 * alarms, channels, sinks, sampling rules + stage reads/writes).
 *
 * Route handlers build it per request from a user client (RLS enforced) or
 * the service client (internal jobs only); services stay storage-agnostic
 * for tests. The two auth methods mirror `lib/control/supabase-db.mjs`
 * deliberately instead of importing that shared module: S10 may only extend
 * shared files additively (capabilities/registry/screens), so the queries
 * are duplicated here and noted in the S10 report.
 *
 * @module lib/control/observability-store
 */

import { inheritedRole } from "../workspace/access.mjs";
import { HttpError } from "./errors.mjs";

function pods(client) {
  return client.schema("pods");
}

function encodeCursor(ts, id) {
  return Buffer.from(JSON.stringify({ ts, id }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (typeof parsed.ts === "string" && typeof parsed.id === "string") return parsed;
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_input", "Invalid pagination cursor.");
}

/**
 * Creates the S10 store over a Supabase client (user- or service-scoped).
 *
 * @param {object} client - Supabase client.
 */
export function createObservabilityDb(client) {
  return {
    async getInheritedRole({ projectId, userId }) {
      const shared = client.schema("public");
      const [{ data: project, error: projectError }, { data: memberships, error: membershipError }] = await Promise.all([
        shared.from("projects").select("id, organization_id, created_by").eq("id", projectId).maybeSingle(),
        shared.from("organization_users").select("organization, user, role").eq("user", userId),
      ]);
      if (projectError) throw new HttpError(500, "internal_error", projectError.message);
      if (membershipError) throw new HttpError(500, "internal_error", membershipError.message);
      if (!project) return null;
      return inheritedRole(
        { organizationId: project.organization_id ?? null, createdBy: project.created_by ?? null },
        (memberships ?? []).map((row) => ({ organizationId: row.organization, userId: row.user, role: row.role })),
        userId,
      );
    },

    async listRoleBindings({ projectId, userId }) {
      const { data: grants, error: grantsError } = await pods(client)
        .from("role_grants")
        .select("id, role_id, user_id, project_id, scope, status")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .eq("status", "active");
      if (grantsError) throw new HttpError(500, "internal_error", grantsError.message);
      const roleIds = [...new Set((grants ?? []).map((grant) => grant.role_id))];
      let roles = [];
      if (roleIds.length > 0) {
        const { data, error } = await client.schema("public")
          .from("roles")
          .select("id, key, name, permissions")
          .in("id", roleIds)
          .is("deleted_at", null);
        if (error) throw new HttpError(500, "internal_error", error.message);
        roles = (data ?? []).map((row) => ({ id: row.id, key: row.key, name: row.name, permissions: row.permissions ?? [] }));
      }
      return {
        roles,
        grants: (grants ?? []).map((row) => ({
          id: row.id, roleId: row.role_id, userId: row.user_id,
          projectId: row.project_id, scope: row.scope ?? {}, status: row.status ?? "active",
        })),
      };
    },

    async insertAudit(entry) {
      const { error } = await pods(client).rpc("audit", {
        p_project: entry.project_id,
        p_actor: entry.actor_id,
        p_actor_type: entry.actor_type,
        p_action: entry.action,
        p_resource_type: entry.resource_type,
        p_resource_id: entry.resource_id,
        p_api: entry.api_id,
        p_before: entry.before,
        p_after: entry.after,
        p_request_id: entry.request_id,
      });
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async getApiByRef({ projectId, ref }) {
      const { data, error } = await pods(client).from("apis")
        .select("id, project_id, public_id, protocol")
        .eq("project_id", projectId)
        .or(`id.eq.${ref},public_id.eq.${ref}`)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async getStageByName({ apiId, name }) {
      const { data, error } = await pods(client).from("stages").select("*").eq("api_id", apiId).eq("name", name).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async updateStage({ id, patch }) {
      const { data, error } = await pods(client).from("stages").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async upsertMetricsMinute(rows) {
      for (const row of rows ?? []) {
        const { error } = await pods(client).rpc("metrics_minute_add", {
          p_project: row.project_id, p_api: row.api_id, p_stage: row.stage,
          p_dims_hash: row.dims_hash, p_dims: row.dims ?? {}, p_minute: row.minute,
          p_metric: row.metric, p_sum: row.sum ?? 0, p_count: row.count ?? 0,
          p_min: row.min ?? null, p_max: row.max ?? null, p_hist: row.hist ?? [],
        });
        if (error) throw new HttpError(500, "internal_error", error.message);
      }
    },

    async upsertMetricsHour(rows) {
      for (const row of rows ?? []) {
        const { error } = await pods(client).rpc("metrics_hour_add", {
          p_project: row.project_id, p_api: row.api_id, p_stage: row.stage,
          p_dims_hash: row.dims_hash, p_dims: row.dims ?? {}, p_hour: row.hour,
          p_metric: row.metric, p_sum: row.sum ?? 0, p_count: row.count ?? 0,
          p_min: row.min ?? null, p_max: row.max ?? null, p_hist: row.hist ?? [],
        });
        if (error) throw new HttpError(500, "internal_error", error.message);
      }
    },

    async listMetricsMinute({ projectId, apiId = null, stage = null, metric = null, from = null, to = null, limit = 5000 }) {
      let query = pods(client).from("metrics_minute").select("*").eq("project_id", projectId).order("minute", { ascending: true }).limit(limit);
      if (apiId) query = query.eq("api_id", apiId);
      if (stage) query = query.eq("stage", stage);
      if (metric) query = query.eq("metric", metric);
      if (from) query = query.gte("minute", from);
      if (to) query = query.lte("minute", to);
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async listMetricsHour({ projectId, apiId = null, stage = null, metric = null, from = null, to = null, limit = 5000 }) {
      let query = pods(client).from("metrics_hour").select("*").eq("project_id", projectId).order("hour", { ascending: true }).limit(limit);
      if (apiId) query = query.eq("api_id", apiId);
      if (stage) query = query.eq("stage", stage);
      if (metric) query = query.eq("metric", metric);
      if (from) query = query.gte("hour", from);
      if (to) query = query.lte("hour", to);
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async pruneMetrics({ minuteBefore = null, hourBefore = null }) {
      if (minuteBefore) {
        const { error } = await pods(client).from("metrics_minute").delete().lt("minute", minuteBefore);
        if (error) throw new HttpError(500, "internal_error", error.message);
      }
      if (hourBefore) {
        const { error } = await pods(client).from("metrics_hour").delete().lt("hour", hourBefore);
        if (error) throw new HttpError(500, "internal_error", error.message);
      }
    },

    async insertAccessLogBatch(rows) {
      if (!rows || rows.length === 0) return;
      const { error } = await pods(client).from("access_logs").insert(rows);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async listAccessLogs({ projectId, filters = {}, limit = 25, cursor = null }) {
      let query = pods(client).from("access_logs")
        .select("id, project_id, api_id, stage, ts, request_id, status, route, source_ip, line, fields")
        .eq("project_id", projectId)
        .order("ts", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1);
      if (filters.apiId) query = query.eq("api_id", filters.apiId);
      if (filters.stage) query = query.eq("stage", filters.stage);
      if (filters.requestId) query = query.eq("request_id", filters.requestId);
      if (filters.sourceIp) query = query.eq("source_ip", filters.sourceIp);
      if (filters.route) query = query.eq("route", filters.route);
      if (filters.statusClass) {
        const digit = filters.statusClass[0];
        query = query.gte("status", Number(`${digit}00`)).lt("status", Number(`${digit}00`) + 100);
      }
      if (filters.from) query = query.gte("ts", filters.from);
      if (filters.to) query = query.lte("ts", filters.to);
      if (cursor) {
        const decoded = decodeCursor(cursor);
        query = query.lt("ts", decoded.ts);
      }
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      const items = (data ?? []).slice(0, limit);
      const nextCursor = (data ?? []).length > limit
        ? encodeCursor(items[items.length - 1].ts, items[items.length - 1].id)
        : null;
      return { items, nextCursor };
    },

    async insertExecutionLog(row) {
      const { error } = await pods(client).from("execution_logs").insert(row);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async listExecutionLogs({ projectId, filters = {}, limit = 25, cursor = null }) {
      let query = pods(client).from("execution_logs")
        .select("id, project_id, api_id, stage, request_id, ts, level, lines, data_trace")
        .eq("project_id", projectId)
        .order("ts", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1);
      if (filters.apiId) query = query.eq("api_id", filters.apiId);
      if (filters.stage) query = query.eq("stage", filters.stage);
      if (filters.requestId) query = query.eq("request_id", filters.requestId);
      if (filters.from) query = query.gte("ts", filters.from);
      if (filters.to) query = query.lte("ts", filters.to);
      if (cursor) {
        const decoded = decodeCursor(cursor);
        query = query.lt("ts", decoded.ts);
      }
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      const items = (data ?? []).slice(0, limit);
      const nextCursor = (data ?? []).length > limit
        ? encodeCursor(items[items.length - 1].ts, items[items.length - 1].id)
        : null;
      return { items, nextCursor };
    },

    async insertTraceSpans(rows) {
      if (!rows || rows.length === 0) return;
      const { error } = await pods(client).from("trace_spans").insert(rows);
      if (error) throw new HttpError(500, "internal_error", error.message);
    },

    async listTraceSpans({ projectId, requestId = null, traceId = null, limit = 200 }) {
      let query = pods(client).from("trace_spans").select("*").eq("project_id", projectId).order("start_ms", { ascending: true }).limit(limit);
      if (requestId) query = query.eq("request_id", requestId);
      if (traceId) query = query.eq("trace_id", traceId);
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async pruneLogs({ accessBefore = null, executionBefore = null, spansBefore = null }) {
      for (const [table, column, before] of [
        ["access_logs", "ts", accessBefore],
        ["execution_logs", "ts", executionBefore],
        ["trace_spans", "created_at", spansBefore],
      ]) {
        if (!before) continue;
        const { error } = await pods(client).from(table).delete().lt(column, before);
        if (error) throw new HttpError(500, "internal_error", error.message);
      }
    },

    async insertAlarm(row) {
      const { data, error } = await pods(client).from("alarms").insert(row).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async listAlarms({ projectId } = {}) {
      let query = pods(client).from("alarms").select("*").order("created_at", { ascending: false });
      if (projectId) query = query.eq("project_id", projectId);
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async listAllEnabledAlarms() {
      const { data, error } = await pods(client).from("alarms").select("*").eq("enabled", true);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getAlarmById(id) {
      const { data, error } = await pods(client).from("alarms").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async updateAlarm({ id, patch }) {
      const { data, error } = await pods(client).from("alarms").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteAlarm({ id }) {
      const { error } = await pods(client).from("alarms").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return true;
    },

    async updateAlarmState({ id, state, stateReason, stateUpdatedAt, expectedUpdatedAt }) {
      let query = pods(client).from("alarms")
        .update({ state, state_reason: stateReason, state_updated_at: stateUpdatedAt, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (expectedUpdatedAt) query = query.eq("state_updated_at", expectedUpdatedAt);
      const { data, error } = await query.select("*").maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async claimAlarmNotification({ key, entry }) {
      const { data, error } = await pods(client).from("alarm_history")
        .upsert({ ...entry, idempotency_key: key }, { onConflict: "idempotency_key", ignoreDuplicates: true })
        .select("id");
      if (error) throw new HttpError(500, "internal_error", error.message);
      return (data ?? []).length > 0;
    },

    async listAlarmHistory({ alarmId }) {
      const { data, error } = await pods(client).from("alarm_history").select("*").eq("alarm_id", alarmId).order("created_at", { ascending: false });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async insertChannel(row) {
      const { data, error } = await pods(client).from("notification_channels").insert(row).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async listChannels({ projectId } = {}) {
      let query = pods(client).from("notification_channels").select("*").order("created_at", { ascending: false });
      if (projectId) query = query.eq("project_id", projectId);
      const { data, error } = await query;
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async insertSink(row) {
      const { data, error } = await pods(client).from("log_sinks").insert(row).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async listSinks({ projectId }) {
      const { data, error } = await pods(client).from("log_sinks").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async getSinkById(id) {
      const { data, error } = await pods(client).from("log_sinks").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async updateSink({ id, patch }) {
      const { data, error } = await pods(client).from("log_sinks").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteSink({ id }) {
      const { error } = await pods(client).from("log_sinks").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return true;
    },

    async listSamplingRules({ projectId }) {
      const { data, error } = await pods(client).from("sampling_rules").select("*").eq("project_id", projectId).order("priority", { ascending: true });
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data ?? [];
    },

    async insertSamplingRule(row) {
      const { data, error } = await pods(client).from("sampling_rules").insert(row).select("*").single();
      if (error) throw new HttpError(500, "internal_error", error.message);
      return data;
    },

    async deleteSamplingRule({ id }) {
      const { error } = await pods(client).from("sampling_rules").delete().eq("id", id);
      if (error) throw new HttpError(500, "internal_error", error.message);
      return true;
    },
  };
}
