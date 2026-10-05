/**
 * Alarms + notification channels services (S10 §7).
 *
 * - `pods.alarms`: M-of-N over `metrics_minute`, `treat_missing_data`,
 *   per-transition `pods.alarm_history` with the idempotency key
 *   `alarmId:stateUpdatedAt` so notifications go out exactly once.
 * - `pods.notification_channels`: `webhook | slack_webhook | email` (email is
 *   hidden without a suite mailer).
 * - `runAlarmEvaluation`: the minute evaluator used by the internal job and
 *   its tests. `fetchMinute` returns the last-N period values for an alarm;
 *   `notify` delivers to a channel. Both are injected (no network in tests).
 *
 * Mutations need `pods.alarm.write`; reads need monitoring visibility.
 *
 * @module lib/control/alarms
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { COMPARISONS, TREAT_MISSING_DATA, evaluateAlarm, transitionKey } from "../gateway/core/observe/alarms.mjs";

export const CHANNEL_TYPES = ["webhook", "slack_webhook", "email"];

function toAlarmView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? "",
    metric: row.metric,
    dimensions: row.dimensions ?? {},
    statistic: row.statistic ?? "Average",
    periodSec: row.period_sec,
    evaluationPeriods: row.evaluation_periods,
    datapointsToAlarm: row.datapoints_to_alarm,
    comparison: row.comparison,
    threshold: row.threshold,
    treatMissingData: row.treat_missing_data ?? "missing",
    actions: row.actions ?? { ok: [], alarm: [], insufficientData: [] },
    state: row.state ?? "INSUFFICIENT_DATA",
    stateReason: row.state_reason ?? "",
    stateUpdatedAt: row.state_updated_at ?? null,
    enabled: row.enabled ?? true,
  };
}

function toChannelView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    type: row.type,
    config: row.type === "webhook" || row.type === "slack_webhook" ? { url: row.config?.url ?? "" } : {},
  };
}

function checkAlarmInput(input = {}, { partial = false } = {}) {
  const out = {};
  if (input.name !== undefined || !partial) {
    if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > 128) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
    }
    out.name = input.name;
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string" || input.description.length > 1024) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.description: must be a string of at most 1024 characters");
    }
    out.description = input.description;
  }
  if (input.metric !== undefined || !partial) {
    if (typeof input.metric !== "string" || input.metric.length === 0) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.metric: must be a non-empty metric name");
    }
    out.metric = input.metric;
  }
  if (input.dimensions !== undefined) {
    if (typeof input.dimensions !== "object" || input.dimensions === null || Array.isArray(input.dimensions)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.dimensions: must be an object");
    }
    out.dimensions = input.dimensions;
  }
  if (input.statistic !== undefined) {
    const stats = ["Sum", "Average", "Minimum", "Maximum", "SampleCount", "p50", "p90", "p95", "p99"];
    if (!stats.includes(input.statistic)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.statistic: must be one of ${stats.join(", ")}`);
    }
    out.statistic = input.statistic;
  }
  if (input.periodSec !== undefined || !partial) {
    if (!Number.isInteger(input.periodSec) || input.periodSec < 60 || input.periodSec % 60 !== 0) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.periodSec: must be a multiple of 60 seconds");
    }
    out.period_sec = input.periodSec;
  }
  const evaluationPeriods = input.evaluationPeriods ?? null;
  const datapointsToAlarm = input.datapointsToAlarm ?? null;
  if (evaluationPeriods !== null || !partial) {
    if (!Number.isInteger(evaluationPeriods) || evaluationPeriods < 1 || evaluationPeriods > 60) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.evaluationPeriods: must be an integer 1–60");
    }
    out.evaluation_periods = evaluationPeriods;
  }
  if (datapointsToAlarm !== null || !partial) {
    if (!Number.isInteger(datapointsToAlarm) || datapointsToAlarm < 1) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.datapointsToAlarm: must be a positive integer");
    }
    out.datapoints_to_alarm = datapointsToAlarm;
  }
  const periods = out.evaluation_periods ?? null;
  const points = out.datapoints_to_alarm ?? null;
  if (periods !== null && points !== null && points > periods) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.datapointsToAlarm: must not exceed $.evaluationPeriods");
  }
  if (input.comparison !== undefined || !partial) {
    if (!COMPARISONS.includes(input.comparison)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.comparison: must be one of ${COMPARISONS.join(" ")}`);
    }
    out.comparison = input.comparison;
  }
  if (input.threshold !== undefined || !partial) {
    if (typeof input.threshold !== "number" || !Number.isFinite(input.threshold)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.threshold: must be a finite number");
    }
    out.threshold = input.threshold;
  }
  if (input.treatMissingData !== undefined) {
    if (!TREAT_MISSING_DATA.includes(input.treatMissingData)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.treatMissingData: must be one of ${TREAT_MISSING_DATA.join(", ")}`);
    }
    out.treat_missing_data = input.treatMissingData;
  }
  if (input.actions !== undefined) {
    if (typeof input.actions !== "object" || input.actions === null) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.actions: must be an object");
    }
    for (const key of ["ok", "alarm", "insufficientData"]) {
      if (input.actions[key] !== undefined && !Array.isArray(input.actions[key])) {
        throw new HttpError(422, "invalid_input", `Invalid request: $.actions.${key}: must be an array of channel ids`);
      }
    }
    out.actions = {
      ok: input.actions.ok ?? [],
      alarm: input.actions.alarm ?? [],
      insufficientData: input.actions.insufficientData ?? [],
    };
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.enabled: must be a boolean");
    }
    out.enabled = input.enabled;
  }
  return out;
}

/** Creates an alarm (state starts INSUFFICIENT_DATA). */
export async function createAlarm(db, actor, { projectId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.alarm.write", { projectId });
  const clean = checkAlarmInput(input ?? {});
  const row = await db.insertAlarm({
    project_id: projectId,
    description: "",
    dimensions: {},
    statistic: "Average",
    treat_missing_data: "missing",
    actions: { ok: [], alarm: [], insufficientData: [] },
    ...clean,
    state: "INSUFFICIENT_DATA",
    state_reason: "created",
    created_by: actor?.userId ?? null,
  });
  await audit(db, actor, {
    action: "alarm.create", resourceType: "alarm", resourceId: row.id,
    projectId, before: null, after: toAlarmView(row), requestId,
  }).catch(() => {});
  return toAlarmView(row);
}

/** Updates an alarm (partial input). */
export async function updateAlarm(db, actor, { projectId, alarmId, patch, requestId = null }) {
  await requirePermission(db, actor, "pods.alarm.write", { projectId });
  const current = await db.getAlarmById(alarmId);
  if (!current || current.project_id !== projectId) throw new HttpError(404, "not_found", "Alarm does not exist.");
  const clean = checkAlarmInput(patch ?? {}, { partial: true });
  if (clean.evaluation_periods !== undefined || clean.datapoints_to_alarm !== undefined) {
    const periods = clean.evaluation_periods ?? current.evaluation_periods;
    const points = clean.datapoints_to_alarm ?? current.datapoints_to_alarm;
    if (points > periods) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.datapointsToAlarm: must not exceed $.evaluationPeriods");
    }
  }
  const next = await db.updateAlarm({ id: alarmId, patch: clean });
  await audit(db, actor, {
    action: "alarm.update", resourceType: "alarm", resourceId: alarmId,
    projectId, before: toAlarmView(current), after: toAlarmView(next), requestId,
  }).catch(() => {});
  return toAlarmView(next);
}

/** Deletes an alarm. */
export async function deleteAlarm(db, actor, { projectId, alarmId, requestId = null }) {
  await requirePermission(db, actor, "pods.alarm.write", { projectId });
  const current = await db.getAlarmById(alarmId);
  if (!current || current.project_id !== projectId) throw new HttpError(404, "not_found", "Alarm does not exist.");
  await db.deleteAlarm({ id: alarmId });
  await audit(db, actor, {
    action: "alarm.delete", resourceType: "alarm", resourceId: alarmId,
    projectId, before: toAlarmView(current), after: null, requestId,
  }).catch(() => {});
  return { id: alarmId, deleted: true };
}

/** Lists alarms. */
export async function listAlarms(db, actor, { projectId }) {
  const { requireMonitoringView } = await import("./metrics.mjs");
  await requireMonitoringView(db, actor, { projectId });
  return { items: (await db.listAlarms({ projectId })).map(toAlarmView), nextCursor: null };
}

/** Alarm history (transitions, newest first). */
export async function listAlarmHistory(db, actor, { projectId, alarmId }) {
  const { requireMonitoringView } = await import("./metrics.mjs");
  await requireMonitoringView(db, actor, { projectId });
  return (await db.listAlarmHistory({ alarmId })).map((row) => ({
    id: row.id,
    alarmId: row.alarm_id,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    createdAt: row.created_at,
    idempotencyKey: row.idempotency_key,
  }));
}

function checkChannelInput(input = {}) {
  if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > 128) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
  }
  if (!CHANNEL_TYPES.includes(input.type)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.type: must be one of ${CHANNEL_TYPES.join(", ")}`);
  }
  const config = input.config ?? {};
  if (input.type === "webhook" || input.type === "slack_webhook") {
    if (typeof config.url !== "string" || !/^https:\/\//.test(config.url)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.config.url: must be an https URL");
    }
  }
  if (input.type === "email" && (typeof config.to !== "string" || !config.to.includes("@"))) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.config.to: must be an email address");
  }
  return { name: input.name, type: input.type, config };
}

/** Creates a notification channel. */
export async function createChannel(db, actor, { projectId, input, requestId = null } = {}, { mailerAvailable = true } = {}) {
  await requirePermission(db, actor, "pods.alarm.write", { projectId });
  const clean = checkChannelInput(input ?? {});
  if (clean.type === "email" && !mailerAvailable) {
    throw new HttpError(400, "unavailable", "Email notifications are hidden: no suite mailer is configured.");
  }
  const row = await db.insertChannel({ project_id: projectId, ...clean, created_by: actor?.userId ?? null });
  await audit(db, actor, {
    action: "alarm_channel.create", resourceType: "notification_channel", resourceId: row.id,
    projectId, before: null, after: toChannelView(row), requestId,
  }).catch(() => {});
  return toChannelView(row);
}

/** Lists notification channels. */
export async function listChannels(db, actor, { projectId }) {
  const { requireMonitoringView } = await import("./metrics.mjs");
  await requireMonitoringView(db, actor, { projectId });
  return { items: (await db.listChannels({ projectId })).map(toChannelView), nextCursor: null };
}

/**
 * Runs one evaluation pass over every enabled alarm.
 *
 * For each alarm the last `evaluationPeriods` period values come from
 * `fetchMinute({ alarm, periodStart })`. A state change claims the
 * idempotency key `alarmId:stateUpdatedAt` in history first — only the
 * claimer notifies, so each transition notifies exactly once even when two
 * evaluators race.
 *
 * @param {object} db - Control db.
 * @param {{ nowMs?: number, fetchMinute: (args: { alarm: object, periodStart: string }) => Promise<Array<number|null>|number|null>,
 *   notify: (args: { channel: object, alarm: object, state: string, reason: string }) => Promise<unknown> }} options
 */
export async function runAlarmEvaluation(db, {
  nowMs = Date.now(),
  fetchMinute,
  notify,
} = {}) {
  const alarms = typeof db.listAllEnabledAlarms === "function"
    ? await db.listAllEnabledAlarms()
    : (await db.listAlarms({})).filter((row) => row.enabled !== false);
  const results = [];
  for (const stored of alarms ?? []) {
    const alarm = stored.project_id !== undefined
      ? {
          id: stored.id, metric: stored.metric, dimensions: stored.dimensions ?? {},
          statistic: stored.statistic ?? "Average", periodSec: stored.period_sec ?? stored.periodSec ?? 60,
          evaluationPeriods: stored.evaluation_periods ?? stored.evaluationPeriods ?? 1,
          datapointsToAlarm: stored.datapoints_to_alarm ?? stored.datapointsToAlarm ?? 1,
          comparison: stored.comparison, threshold: stored.threshold,
          treatMissingData: stored.treat_missing_data ?? stored.treatMissingData ?? "missing",
          actions: stored.actions ?? { ok: [], alarm: [], insufficientData: [] },
          state: stored.state ?? "INSUFFICIENT_DATA", stateUpdatedAt: stored.state_updated_at ?? null,
        }
      : stored;
    const periodMs = (alarm.periodSec ?? 60) * 1000;
    const values = [];
    for (let index = alarm.evaluationPeriods - 1; index >= 0; index -= 1) {
      const periodStart = new Date(Math.floor((nowMs - index * periodMs) / periodMs) * periodMs).toISOString();
      const fetched = await fetchMinute({ alarm, periodStart });
      values.push(Array.isArray(fetched) ? fetched[fetched.length - 1] ?? null : (fetched ?? null));
    }
    const evaluated = evaluateAlarm({
      values,
      comparison: alarm.comparison,
      threshold: alarm.threshold,
      evaluationPeriods: alarm.evaluationPeriods,
      datapointsToAlarm: alarm.datapointsToAlarm,
      treatMissingData: alarm.treatMissingData,
    });
    if (evaluated.state === stored.state) {
      results.push({ alarmId: stored.id, state: stored.state, changed: false });
      continue;
    }
    const stateUpdatedAt = new Date(nowMs).toISOString();
    const key = transitionKey(stored.id, stateUpdatedAt);
    const claimed = await db.claimAlarmNotification({
      key,
      entry: {
        alarm_id: stored.id,
        project_id: stored.project_id ?? stored.projectId ?? null,
        from_state: stored.state,
        to_state: evaluated.state,
        reason: `${evaluated.breaching} of ${alarm.evaluationPeriods} datapoints ${alarm.comparison} ${alarm.threshold}`,
        idempotency_key: key,
        created_at: stateUpdatedAt,
      },
    });
    if (!claimed) {
      results.push({ alarmId: stored.id, state: evaluated.state, changed: false, raced: true });
      continue;
    }
    await db.updateAlarmState({
      id: stored.id,
      state: evaluated.state,
      stateReason: `${evaluated.breaching} of ${alarm.evaluationPeriods} datapoints breaching`,
      stateUpdatedAt,
      expectedUpdatedAt: stored.state_updated_at ?? stored.stateUpdatedAt ?? null,
    });
    const channelIds = evaluated.state === "ALARM"
      ? alarm.actions.alarm ?? []
      : evaluated.state === "OK"
        ? alarm.actions.ok ?? []
        : alarm.actions.insufficientData ?? [];
    const channels = typeof db.listChannels === "function"
      ? (await db.listChannels({})).filter((channel) => channelIds.includes(channel.id))
      : [];
    for (const channel of channels) {
      await notify({ channel, alarm: toAlarmView({ ...stored, state: evaluated.state }), state: evaluated.state, reason: evaluated.breaching });
    }
    results.push({ alarmId: stored.id, state: evaluated.state, changed: true });
  }
  return results;
}
