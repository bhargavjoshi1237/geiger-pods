/**
 * Alarm evaluation (S10 §7, CloudWatch-alarm equivalent) — pure function.
 *
 * CloudWatch "M out of N" semantics over `metrics_minute` windows:
 * the newest N datapoints (by minute) are evaluated against the threshold;
 * the alarm transitions to ALARM when at least M breach. `treatMissingData`
 * controls how missing datapoints vote: `missing` (→ INSUFFICIENT_DATA when
 * any are missing and the breach count is otherwise inconclusive),
 * `notBreaching`, `breaching`, or `ignore` (missing points don't count
 * toward N).
 *
 * @module lib/gateway/core/observe/alarm-eval
 */

export const COMPARISONS = [">", ">=", "<", "<="];
export const TREAT_MISSING = ["missing", "notBreaching", "breaching", "ignore"];

/**
 * Evaluates one datapoint against the threshold.
 *
 * @param {number|null|undefined} value
 * @param {string} comparison - `> | >= | < | <=`.
 * @param {number} threshold
 * @returns {boolean} True when breaching.
 */
export function isBreaching(value, comparison, threshold) {
  if (value === null || value === undefined) return false;
  if (comparison === ">") return value > threshold;
  if (comparison === ">=") return value >= threshold;
  if (comparison === "<") return value < threshold;
  if (comparison === "<=") return value <= threshold;
  throw new Error(`Unknown comparison "${comparison}".`);
}

/**
 * Evaluates an alarm over ordered datapoints (oldest → newest).
 *
 * @param {Array<{ ts: string, value: number|null }>} points - Newest N used.
 * @param {{ comparison?: string, threshold?: number, evaluationPeriods?: number,
 *   datapointsToAlarm?: number, treatMissingData?: string }} config
 * @returns {{ state: "OK"|"ALARM"|"INSUFFICIENT_DATA", breaching: number, evaluated: number,
 *   missing: number, reason: string }}
 */
export function evaluateAlarm(points, {
  comparison = ">",
  threshold = 0,
  evaluationPeriods = 1,
  datapointsToAlarm = null,
  treatMissingData = "missing",
} = {}) {
  const needed = datapointsToAlarm ?? evaluationPeriods;
  const window = (points ?? []).slice(-evaluationPeriods);
  const missing = window.filter((point) => point.value === null || point.value === undefined).length;
  const present = window.filter((point) => point.value !== null && point.value !== undefined);

  if (treatMissingData === "ignore") {
    const breaching = present.filter((point) => isBreaching(point.value, comparison, threshold)).length;
    // With `ignore`, missing points shrink the window; all remaining must breach.
    const effective = Math.min(needed, present.length);
    if (present.length === 0) {
      return { state: "INSUFFICIENT_DATA", breaching: 0, evaluated: 0, missing, reason: "No datapoints (ignored missing)." };
    }
    const state = breaching >= effective ? "ALARM" : "OK";
    return { state, breaching, evaluated: present.length, missing, reason: `${breaching} of ${present.length} datapoints breaching (missing ignored).` };
  }

  let votes = present.map((point) => isBreaching(point.value, comparison, threshold));
  if (treatMissingData === "breaching") votes = [...votes, ...new Array(missing).fill(true)];
  if (treatMissingData === "notBreaching") votes = [...votes, ...new Array(missing).fill(false)];

  if (treatMissingData === "missing" && missing > 0) {
    const breaching = votes.filter(Boolean).length;
    if (breaching >= needed) {
      return { state: "ALARM", breaching, evaluated: window.length, missing, reason: `${breaching} of ${window.length} datapoints breaching (${missing} missing).` };
    }
    // Missing data leaves the outcome unknown unless even all-missing-breaching
    // could not reach the threshold — then it is definitively OK.
    if (breaching + missing < needed) {
      return { state: "OK", breaching, evaluated: window.length, missing, reason: `${breaching} of ${window.length} datapoints breaching (${missing} missing, cannot reach ${needed}).` };
    }
    return { state: "INSUFFICIENT_DATA", breaching, evaluated: window.length, missing, reason: `${missing} of ${window.length} datapoints missing.` };
  }

  const breaching = votes.filter(Boolean).length;
  const state = breaching >= needed ? "ALARM" : "OK";
  return { state, breaching, evaluated: votes.length, missing, reason: `${breaching} of ${votes.length} datapoints breaching (threshold ${comparison} ${threshold}).` };
}

/**
 * Applies a state transition: returns the new alarm row fields, or null
 * when the state is unchanged (notifications fire exactly once per
 * transition — callers use `alarmId:stateUpdatedAt` as idempotency key).
 *
 * @param {{ state: string }} alarm - Current alarm row.
 * @param {"OK"|"ALARM"|"INSUFFICIENT_DATA"} next - Evaluated state.
 * @param {string} reason - Human-readable reason.
 * @param {string} [nowIso] - Transition timestamp.
 * @returns {{ state: string, state_reason: string, state_updated_at: string, transitioned: boolean }|null}
 */
export function applyTransition(alarm, next, reason, nowIso = new Date().toISOString()) {
  if (!alarm || alarm.state === next) return null;
  return { state: next, state_reason: reason, state_updated_at: nowIso, transitioned: true };
}
